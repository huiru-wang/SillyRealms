import {ApiError, api} from '../../api.ts';
import type {HttpRequest} from '../../transport/http.ts';
import type {ReplyAssistEvent} from '../../transport/session-events.ts';

type View = {draft(text: string): void; busy(value: boolean): void; error(reason: unknown): void};
type Active = {
  id: string; original: string; content: string; accepted: boolean;
  stopping: boolean; retryStopOnAccept: boolean; abandoned: boolean;
};

// getRandomValues also works on local HTTP origins used by LAN clients.
function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function createReplyAssistController(sessionId: string, view: View, request: HttpRequest = api) {
  const base = 'v1/sessions/' + encodeURIComponent(sessionId) + '/reply-assist';
  let active: Active | null = null, frame: number | null = null;
  const cancel = (id: string) => request(base + '/' + encodeURIComponent(id) + '/stop', {method: 'POST'});

  function finish(run: Active) {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    active = null;
    view.draft(run.content.trim() ? run.content : run.original);
    view.busy(false);
  }

  async function stop() {
    const run = active;
    if (!run || run.stopping) return;
    run.stopping = true;
    const beforeAcceptance = !run.accepted;
    try { await cancel(run.id); }
    catch (error) {
      if (active !== run) return;
      run.stopping = false;
      if (error instanceof ApiError && error.errorCode === 'REPLY_ASSIST_NOT_FOUND') {
        // The stop can reach the server before submit. Retry once admission is known.
        if (beforeAcceptance && run.accepted) void stop();
        else run.retryStopOnAccept = beforeAcceptance;
      } else view.error(error);
    }
  }

  async function start(original: string) {
    if (active) return;
    const run: Active = {id: requestId(), original, content: '', stopping: false, accepted: false,
      retryStopOnAccept: false, abandoned: false};
    active = run;
    view.busy(true);
    try {
      const receipt = await request<{accepted: boolean; sessionId: string; requestId: string}>(base, {
        method: 'POST', body: JSON.stringify({requestId: run.id, draftText: original}), signal: AbortSignal.timeout(30000),
      });
      if (active !== run) {
        if (run.abandoned) void cancel(run.id).catch(() => {});
        return;
      }
      if (!receipt?.accepted || receipt.sessionId !== sessionId || receipt.requestId !== run.id) throw new ApiError('INVALID_RESPONSE', '');
      run.accepted = true;
      if (run.retryStopOnAccept) void stop();
    } catch (error) {
      if (active !== run) return;
      finish(run);
      if (!(error instanceof ApiError && error.status)) void cancel(run.id).catch(() => {});
      view.error(error);
    }
  }

  function accept(event: ReplyAssistEvent) {
    const run = active;
    if (!run || event.data.sessionId !== sessionId || event.data.requestId !== run.id) return;
    run.accepted = true;
    if (event.event === 'reply_assist.delta') {
      run.content += event.data.delta.content;
      if (frame === null) frame = requestAnimationFrame(() => {
        frame = null;
        if (active === run) view.draft(run.content);
      });
      return;
    }
    run.content = event.data.snapshot.content;
    finish(run);
    if (event.event === 'reply_assist.stopped' && event.data.stop_reason !== 'cancelled') view.error('stage:notices.' + event.data.stop_reason);
  }

  function interrupt(notify: boolean) {
    const run = active;
    if (!run) return;
    run.abandoned = true;
    finish(run);
    void cancel(run.id).catch(() => {});
    if (notify) view.error('sessions:assistDisconnected');
  }

  return {isActive: () => active !== null, start, stop, accept, interrupt};
}
