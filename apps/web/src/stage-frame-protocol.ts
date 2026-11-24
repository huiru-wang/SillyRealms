import {isAppLocale, type AppLocale} from '@sillyrealms/sdk/locale';
import type {StageCommand, StageCommandMap} from '../../../packages/sr-sdk/src/stage-contract.js';

type Port = Pick<MessagePort, 'postMessage' | 'close'>;
type Pending = {resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>};

/** Frame command transport. It has no API access and does not own feature state. */
export class StageBridge {
  private port: Port | null = null;
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly timeout: number;
  constructor(timeout = 30_000) { this.timeout = timeout; }

  connect(port: Port): void {
    this.disconnect();
    this.port = port;
  }

  command: StageCommand = <K extends keyof StageCommandMap>(
    method: K, input: StageCommandMap[K]['input'],
  ): Promise<StageCommandMap[K]['output']> => {
    const port = this.port;
    if (!port) return Promise.reject(Error('stage:bridge.notConnected'));
    if (this.pending.size >= 100) return Promise.reject(Error('stage:bridge.pendingLimit'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(Error('stage:bridge.timeout'));
      }, this.timeout);
      this.pending.set(id, {resolve: resolve as (value: unknown) => void, reject, timer});
      try { port.postMessage({type: 'request', id, method, data: input}); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(id);
        reject(error instanceof Error ? error : Error('stage:bridge.sendFailed'));
      }
    });
  };

  receive(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const response = payload as {type?: unknown; id?: unknown; data?: unknown; error?: unknown};
    if (response.type !== 'response' || !Number.isSafeInteger(response.id)) return false;
    const request = this.pending.get(response.id as number);
    if (!request) return false;
    this.pending.delete(response.id as number); clearTimeout(request.timer);
    if (typeof response.error === 'string') request.reject(Error(response.error));
    else request.resolve(response.data);
    return true;
  }

  disconnect(message = 'stage:bridge.disconnected'): void {
    this.port?.close(); this.port = null;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(Error(message)); }
    this.pending.clear();
  }
}

/** Deployment and the parent handshake must agree on the exact trusted Web origin. */
export function stageHostOrigin(search: string, frameOrigin: string, allowedOrigin: string): string | null {
  try {
    const raw = new URLSearchParams(search).get('hostOrigin'), host = new URL(raw ?? ''), frame = new URL(frameOrigin);
    return raw === allowedOrigin && raw === host.origin && ['http:', 'https:'].includes(host.protocol) &&
      host.origin !== frame.origin && !(host.protocol === 'https:' && frame.protocol !== 'https:') ? host.origin : null;
  } catch { return null; }
}


/** Wait for a validated Host locale before mounting content; later changes never replay the render. */
export class FrameLocale {
  private ready = false;
  private active = true;
  private revision = 0;
  private pending: (() => void) | undefined;
  private readonly apply: (locale: AppLocale) => unknown | Promise<unknown>;
  constructor(apply: (locale: AppLocale) => unknown | Promise<unknown>) { this.apply = apply; }

  render(render: () => void): void {
    if (!this.active) return;
    if (this.ready) render();
    else this.pending = render;
  }

  async receive(value: unknown): Promise<boolean> {
    if (!this.active || !isAppLocale(value)) return false;
    const revision = ++this.revision;
    await this.apply(value);
    if (!this.active || revision !== this.revision) return false;
    this.ready = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.();
    return true;
  }

  close(): void { this.active = false; this.ready = false; this.pending = undefined; this.revision++; }
}
