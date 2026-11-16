/** Explicit offline conversion only; runtime readers never accept the v2 format. */
import { z } from 'zod';
import { presetSchema } from './schema.js';

const legacyPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string() }).strict(),
  z.object({ type: z.literal('source'), name: z.string().min(1) }).strict(),
]);
const legacyNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['system', 'postprocess', 'text']),
  role: z.enum(['system', 'user', 'assistant', 'auto']),
  enabled: z.boolean(),
  prompt: z.object({ parts: z.array(legacyPartSchema).min(1) }).strict(),
}).strict();
const tags = z.array(z.string().trim().min(1)).optional();
const legacyPresetSchema = presetSchema.omit({ config_json: true }).extend({
  config_json: z.object({ schemaVersion: z.literal(2), nodes: z.array(legacyNodeSchema) }).strict(),
  tags,
}).strict();
const importPresetSchema = presetSchema.extend({ tags }).strict();
export type LegacyPreset = z.infer<typeof legacyPresetSchema>;
type LegacyPart = z.infer<typeof legacyPartSchema>;
type Segment = { type: 'literal'; value: string; part: number } | { type: 'variable'; name: string; part: number };

export class PresetMigrationError extends Error {
  override name = 'PresetMigrationError';
}

function fail(location: string, message: string): never {
  throw new PresetMigrationError(location + ': ' + message);
}

function withoutSessionBackground(parts: LegacyPart[], nodeId: string, location: string): LegacyPart[] {
  const copy = parts.map(part => ({ ...part }));
  const indices = copy.flatMap((part, index) => part.type === 'source' && part.name === 'session.background' ? [index] : []);
  if (!indices.length) return copy;
  if (nodeId !== 'chatHistory' || indices.length !== 1) fail(location, 'session.background must occur once in chatHistory');
  const index = indices[0]!, before = copy[index - 1], after = copy[index + 1];
  const opening = before?.type === 'text' ? /<会话背景>\r?\n$/.exec(before.value) : null;
  const closing = after?.type === 'text' ? /^\r?\n<\/会话背景>/.exec(after.value) : null;
  if (!opening || !closing || before?.type !== 'text' || after?.type !== 'text') {
    fail(location + '.prompt.parts[' + index + ']', 'Cannot safely remove the customized session.background wrapper; edit this node explicitly before conversion');
  }
  before.value = before.value.slice(0, -opening[0].length);
  after.value = after.value.slice(closing[0].length);
  // Remove only the default separator when this background was the opening block.
  if (!before.value && /^\r?\n\r?\n<已有摘要>/.test(after.value)) after.value = after.value.replace(/^\r?\n\r?\n/, '');
  copy.splice(index, 1);
  return copy;
}

function template(parts: LegacyPart[], location: string): string {
  const segments: Segment[] = [];
  const literal = (value: string, part: number) => {
    if (!value) return;
    const previous = segments.at(-1);
    if (previous?.type === 'literal') previous.value += value;
    else segments.push({ type: 'literal', value, part });
  };
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part.type === 'source') {
      segments.push({ type: 'variable', name: part.name, part: index });
      continue;
    }
    // Only the exact legacy {{user}} macro keeps its previous substitution behavior.
    let offset = 0;
    for (const match of part.value.matchAll(/\{\{user\}\}/g)) {
      literal(part.value.slice(offset, match.index), index);
      segments.push({ type: 'variable', name: 'user', part: index });
      offset = match.index + match[0].length;
    }
    literal(part.value.slice(offset), index);
  }
  for (let index = 0; index < segments.length - 1; index++) {
    const current = segments[index]!, next = segments[index + 1]!;
    if (current.type === 'literal' && current.value.endsWith('{') && next.type === 'variable') {
      fail(location + '.prompt.parts[' + next.part + ']', 'A literal opening brace touches a variable; separate it explicitly before conversion');
    }
  }
  return segments.map(segment => segment.type === 'variable'
    ? '{{' + segment.name + '}}'
    : segment.value.replaceAll('\\', '\\\\').replaceAll('{{', '\\{{')).join('');
}

export function migratePresetV2(raw: unknown, location = 'preset') {
  try {
    const version = (raw as { config_json?: { schemaVersion?: unknown } } | null)?.config_json?.schemaVersion;
    if (version === 3) return { changed: false, preset: importPresetSchema.parse(raw) };
    if (version !== 2) fail(location + '.config_json.schemaVersion', 'Expected preset schemaVersion 2 or 3');
    const previous = legacyPresetSchema.parse(raw);
    const nodes = previous.config_json.nodes.map(node => {
      const nodeLocation = location + '.nodes[' + node.id + ']';
      let prompt = template(withoutSessionBackground(node.prompt.parts, node.id, nodeLocation), nodeLocation);
      if (node.id === 'chatHistory' && prompt === '<已有摘要>\n{{history.summary}}\n</已有摘要>{{history.messages}}') {
        prompt = '<已有摘要>\n{{history.summary}}\n</已有摘要>\n{{history.messages}}';
      }
      return { ...node, prompt };
    });
    return { changed: true, preset: importPresetSchema.parse({ ...previous, config_json: { schemaVersion: 3, nodes } }) };
  } catch (error) {
    if (error instanceof PresetMigrationError) throw error;
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      fail(location + (issue?.path.length ? '.' + issue.path.join('.') : ''), issue?.message ?? 'Invalid preset');
    }
    throw error;
  }
}
