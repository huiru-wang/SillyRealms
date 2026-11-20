import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { CredentialService } from '../modules/credentials/service.js';
import type { ModelService } from '../modules/models/service.js';

const inputSchema = z.object({
  name: z.string().trim().min(1), providerId: z.string().trim().min(1), modelId: z.string().trim().min(1),
  apiKey: z.string().trim().min(1).max(16384).regex(/^[^\r\n\0]+$/),
}).strict();
const patchSchema = inputSchema.partial().refine(value => Object.keys(value).length > 0, '更新不能为空');
export type CreateModelConfig = z.input<typeof inputSchema>;
export type UpdateModelConfig = z.input<typeof patchSchema>;

/** Serialize each model's external credential workflow; no secret operation is inside a DB transaction. */
export function createModelConfigUsecases({ models, credentials }: {
  models: ModelService; credentials: CredentialService;
}) {
  const pending = new Map<string, Promise<unknown>>();
  function serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (pending.get(id) ?? Promise.resolve()).catch(() => undefined).then(work);
    pending.set(id, next);
    void next.finally(() => { if (pending.get(id) === next) pending.delete(id); }).catch(() => undefined);
    return next;
  }
  async function withCredential<T>(reference: string, secret: string, persist: () => T): Promise<T> {
    const previous = await credentials.get(reference);
    try {
      await credentials.set(reference, secret);
      return persist();
    } catch (error) {
      try {
        if (previous === null) await credentials.delete(reference);
        else await credentials.set(reference, previous);
      } catch { throw new AppError('CREDENTIAL_COMPENSATION_FAILED'); }
      throw error;
    }
  }
  return {
    async create(input: CreateModelConfig) {
      const { apiKey, ...value } = inputSchema.parse(input);
      const id = randomUUID(), credentialRef = credentials.referenceFor(id);
      return serialize(id, () => withCredential(credentialRef, apiKey, () => models.create({ id, ...value, credentialRef })));
    },
    update(id: string, input: UpdateModelConfig) {
      const { apiKey, ...patch } = patchSchema.parse(input);
      return serialize(id, async () => {
        const current = models.require(id);
        if (patch.providerId !== undefined && patch.providerId !== current.providerId && apiKey === undefined) {
          throw new AppError('INVALID_REQUEST', '更换服务商时请提供对应的 API Key');
        }
        const persist = (credentialRef = current.credentialRef) => {
          const updated = models.update(id, { ...patch, credentialRef });
          if (!updated) throw new AppError('MODEL_CONFIG_NOT_FOUND');
          return updated;
        };
        if (apiKey === undefined) return persist();
        const credentialRef = credentials.referenceFor(id);
        return withCredential(credentialRef, apiKey, () => persist(credentialRef));
      });
    },
    delete(id: string) {
      return serialize(id, async () => {
        const current = models.get(id);
        const reference = credentials.referenceFor(id);
        if (current) {
          // A failed FK delete must never touch the credential.
          if (credentials.owns(current.credentialRef) && current.credentialRef !== reference) throw new AppError('INVALID_REQUEST');
          models.delete(id);
          if (!credentials.owns(current.credentialRef)) return true;
        } else if (await credentials.get(reference) === null) return false;
        try { await credentials.delete(reference); }
        catch { throw new AppError('CREDENTIAL_DELETE_FAILED'); }
        return true;
      });
    },
  };
}
export type ModelConfigUsecases = ReturnType<typeof createModelConfigUsecases>;
