import type {
  AcceptedRun, MessageDelta, MessageSnapshot, NarrativeEvent, RunPage, StageMessage,
  StageRun, StoredRun, Usage,
} from '../../../../../packages/sr-sdk/src/stage-contract.ts';
import type {HttpRequest} from '../../transport/http.ts';

type TerminalEvent = Extract<NarrativeEvent, {event: 'run.completed' | 'run.stopped'}>;
export type NarrativeSnapshot = {
  run: StageRun | null;
  activeRunId: string | null;
  drafts: StageMessage[];
  sending: boolean;
  stopping: boolean;
  recovering: boolean;
  /** Stream continuity was lost; only a final replacement snapshot can repair it. */
  incomplete: boolean;
  usage: Usage | null | undefined;
  error: string | null;
};
export type NarrativeOptions = {
  sessionId: string;
  request: HttpRequest;
  getSession: () => Promise<{tipEntryId: string | null}>;
  onRunSaved?: (run: StoredRun) => void;
  onTipChanged?: (tipEntryId: string | null) => void;
  onTerminal?: (event: TerminalEvent) => void;
  onRunAccepted?: (accepted: AcceptedRun) => void;
};
const terminal = (status: StageRun['status']) => status === 'completed' || status === 'stopped';
const errorText = (error: unknown) => error instanceof Error ? error.message : '叙事请求失败';

export function appendMessageDelta(current: MessageSnapshot, delta: MessageDelta): MessageSnapshot {
  const toolCalls = current.tool_calls.map(tool => structuredClone(tool));
  for (const part of delta.tool_calls ?? []) {
    let tool = toolCalls.find(item => item.index === part.index);
    if (!tool) {
      tool = {index: part.index, id: '', type: 'function', function: {name: '', arguments: ''}};
      toolCalls.push(tool);
    }
    if (part.id !== undefined) tool.id = part.id;
    if (part.function?.name !== undefined) tool.function.name = part.function.name;
    if (part.function?.arguments !== undefined) tool.function.arguments += part.function.arguments;
  }
  return {
    role: 'assistant', content: current.content + (delta.content ?? ''),
    reasoning_content: current.reasoning_content + (delta.reasoning_content ?? ''),
    tool_calls: toolCalls.sort((left, right) => left.index - right.index),
  };
}

/** Run commands and transient model output; durable entries are handed to history. */
export function createNarrativeController(options: NarrativeOptions) {
  const {sessionId, request} = options;
  const base = 'v1/sessions/' + encodeURIComponent(sessionId) + '/narrative/runs';
  const listeners = new Set<() => void>(), pending = new Set<AbortController>();
  const settled = new Set<string>();
  let disposed = false, eventRevision = 0, recoveryVersion = 0, continuous = false;
  let snapshot: NarrativeSnapshot = {
    run: null, activeRunId: null, drafts: [], sending: false, stopping: false,
    recovering: false, incomplete: false, usage: undefined, error: null,
  };
  const emit = (patch: Partial<NarrativeSnapshot>) => {
    if (disposed) return;
    snapshot = {...snapshot, ...patch};
    if (snapshot.run) snapshot = {...snapshot, run: {...snapshot.run, messages: snapshot.drafts}};
    for (const listener of listeners) try { listener(); } catch { /* Isolate views. */ }
  };
  const callback = (action: (() => void) | undefined) => {
    if (!action || disposed) return;
    try { action(); } catch (error) { emit({error: errorText(error)}); }
  };
  const call = async <T,>(path: string, init: RequestInit = {}) => {
    if (disposed) throw new DOMException('Narrative controller disposed', 'AbortError');
    const controller = new AbortController(); pending.add(controller);
    try {
      const result = await request<T>(path, {...init, signal: controller.signal});
      if (disposed) throw new DOMException('Narrative controller disposed', 'AbortError');
      return result;
    } finally { pending.delete(controller); }
  };
  const handoff = (run: StoredRun) => {
    options.onRunSaved?.(structuredClone(run));
    if (snapshot.run?.runId !== run.runId) return;
    const saved = new Set(run.entries.map(entry => entry.id));
    const drafts = snapshot.drafts.filter(message => !saved.has(message.id));
    if (drafts.length !== snapshot.drafts.length) emit({drafts});
  };
  const acceptStored = (run: StoredRun, revision: number, adopt = false) => {
    handoff(run);
    if (revision !== eventRevision || (snapshot.run?.runId !== run.runId && !adopt)) return;
    const current = snapshot.run?.runId === run.runId ? snapshot.run : null;
    if (current && terminal(current.status) && !terminal(run.status)) return;
    if (terminal(run.status)) settled.add(run.runId);
    const active = run.status === 'running' || run.status === 'stopping';
    emit({
      run: {runId: run.runId, status: run.status, messages: [], stopReason: run.stopReason, finishedAt: run.finishedAt,
        ...(active && current?.phase ? {phase: current.phase} : {})},
      activeRunId: active ? run.runId : null,
      drafts: current ? snapshot.drafts : [],
      stopping: run.status === 'stopping',
      incomplete: active && !continuous,
    });
  };
  const loadRun = async (runId: string) => {
    const revision = eventRevision;
    try {
      const result = await call<{item: StoredRun}>(base + '/' + encodeURIComponent(runId));
      acceptStored(result.item, revision);
      return result.item;
    } catch (error) {
      if (!disposed) emit({error: errorText(error)});
      throw error;
    }
  };
  const recover = async (input: {page?: RunPage; knownActiveRunId?: string | null; checkpoint?: number} = {}) => {
    const version = ++recoveryVersion, revision = input.checkpoint ?? eventRevision;
    const known = input.knownActiveRunId ?? snapshot.activeRunId;
    emit({recovering: true, error: null});
    try {
      const page = input.page ?? await call<RunPage>(base);
      if (disposed || version !== recoveryVersion) return page;
      for (const run of page.items) handoff(run);
      // The previous active run may only have gained an outcome, with no new seq.
      const ids = new Set([known, page.activeRunId].filter((id): id is string => !!id));
      const refreshed = new Map<string, StoredRun>();
      for (const id of ids) {
        const result = await call<{item: StoredRun}>(base + '/' + encodeURIComponent(id));
        if (disposed || version !== recoveryVersion) return page;
        refreshed.set(id, result.item);
        handoff(result.item);
      }
      if (revision === eventRevision) {
        const selected = page.activeRunId
          ? refreshed.get(page.activeRunId) ?? page.items.find(run => run.runId === page.activeRunId)
          : known && refreshed.has(known) ? refreshed.get(known)
          : [...page.items].sort((a, b) => b.firstSeq - a.firstSeq)[0];
        if (selected) acceptStored(selected, revision, true);
        else emit({activeRunId: page.activeRunId, run: null, drafts: [], stopping: false});
      }
      emit({recovering: false});
      return page;
    } catch (error) {
      if (!disposed && version === recoveryVersion) emit({recovering: false, error: errorText(error)});
      throw error;
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    loadRun,
    recover,
    checkpoint: () => eventRevision,
    clearError() { if (!disposed) emit({error: null}); },
    setConnected(connected: boolean) {
      if (!connected && snapshot.activeRunId) {
        continuous = false;
        emit({incomplete: true});
      }
    },
    accept(event: NarrativeEvent) {
      if (disposed || event.data.sessionId !== sessionId) return;
      const id = event.data.runId;
      if (settled.has(id) && !['run.completed', 'run.stopped', 'run.usage'].includes(event.event)) return;
      // A delayed event for a previously completed run must not replace a newer run.
      if (snapshot.run && snapshot.run.runId !== id && event.event !== 'run.created') return;
      eventRevision++;
      if (event.event === 'run.created') {
        continuous = true;
        emit({run: {runId: id, status: 'running', phase: 'preparing', messages: []},
          activeRunId: id, drafts: [], stopping: false, incomplete: false, usage: undefined, error: null});
        callback(() => options.onTipChanged?.(event.data.messages[0].id));
        void loadRun(id).catch(() => {});
        return;
      }
      const run = snapshot.run ?? {runId: id, status: 'running' as const, messages: []};
      if (event.event === 'run.summarizing') {
        emit({run: {...run, phase: 'summarizing'}, activeRunId: id});
      } else if (event.event === 'run.summarized') {
        emit({run: {...run, phase: 'preparing'}, activeRunId: id});
        callback(() => options.onTipChanged?.(event.data.entryId));
      } else if (event.event === 'run.delta') {
        const value = event.data.messages[0];
        const existing = snapshot.drafts.find(message => message.id === event.data.messageId);
        if (!value.snapshot && !continuous) {
          emit({run: {...run, phase: 'generating'}, activeRunId: id, incomplete: true});
          return;
        }
        const current: MessageSnapshot = {
          role: 'assistant', content: existing?.content ?? '', reasoning_content: existing?.reasoning_content ?? '',
          tool_calls: existing?.tool_calls ?? [],
        };
        const result = value.snapshot ? structuredClone(value.snapshot) : appendMessageDelta(current, value.delta);
        if (value.snapshot) continuous = true;
        const draft: StageMessage = {
          id: event.data.messageId, runId: id, role: 'assistant', content: result.content,
          reasoning_content: result.reasoning_content, tool_calls: result.tool_calls,
          timestamp: existing?.timestamp ?? event.data.timestamp, saved: false,
        };
        emit({run: {...run, phase: 'generating'}, activeRunId: id, incomplete: false,
          drafts: [...snapshot.drafts.filter(message => message.id !== draft.id), draft]});
      } else if (event.event === 'run.usage') {
        emit({usage: event.data.usage === null ? null : {...event.data.usage}});
      } else {
        settled.add(id);
        emit({run: {runId: id, status: event.event === 'run.completed' ? 'completed' : 'stopped',
          messages: [], finishedAt: event.data.timestamp,
          ...(event.event === 'run.stopped' ? {stopReason: event.data.stop_reason} : {})},
          activeRunId: null, stopping: false});
        callback(() => options.onTipChanged?.(event.data.tipEntryId));
        callback(() => options.onTerminal?.(event));
        // A fresh read is essential even if the run.created read is still in flight.
        void loadRun(id).catch(() => {});
      }
    },
    async send(text: string): Promise<AcceptedRun> {
      if (disposed) throw new Error('叙事客户端已关闭');
      if (!text.trim()) throw new Error('输入不能为空');
      if (snapshot.sending || snapshot.activeRunId) throw new Error('当前会话仍在生成');
      emit({sending: true, error: null});
      try {
        const session = await options.getSession();
        if (disposed) throw new DOMException('Narrative controller disposed', 'AbortError');
        const revision = eventRevision;
        const accepted = await call<AcceptedRun>(base, {
          method: 'POST', body: JSON.stringify({input: {text}, expectedTipEntryId: session.tipEntryId}),
        });
        // The complete SSE lifecycle can precede the POST response.
        if (revision === eventRevision && !settled.has(accepted.runId)) {
          continuous = false;
          emit({run: {runId: accepted.runId, status: 'running', phase: 'preparing', messages: []},
            activeRunId: accepted.runId, drafts: [], incomplete: false, usage: undefined});
          callback(() => options.onTipChanged?.(accepted.userEntryId));
        }
        callback(() => options.onRunAccepted?.(accepted));
        return accepted;
      } catch (error) {
        if (!disposed) emit({error: errorText(error)});
        throw error; // Never resubmit an uncertain request.
      } finally { if (!disposed) emit({sending: false}); }
    },
    async stop(runId = snapshot.activeRunId) {
      if (!runId || runId !== snapshot.activeRunId) throw new Error('当前没有可停止的生成');
      emit({stopping: true, error: null});
      try {
        const result = await call<{runId: string; stopping: true}>(base + '/' + encodeURIComponent(runId) + '/stop', {method: 'POST'});
        if (snapshot.activeRunId === runId && snapshot.run) emit({run: {...snapshot.run, status: 'stopping'}});
        return result;
      } catch (error) {
        if (!disposed && snapshot.activeRunId === runId) emit({stopping: false, error: errorText(error)});
        throw error;
      }
    },
    dispose() {
      disposed = true; recoveryVersion++;
      for (const controller of pending) controller.abort();
      pending.clear(); listeners.clear();
    },
  };
}
export type NarrativeController = ReturnType<typeof createNarrativeController>;
