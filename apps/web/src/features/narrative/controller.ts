import type {
  AcceptedRun, MessageDelta, MessageSnapshot, NarrativeEvent, StageMessage,
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
  /** Stream continuity was lost; only a final replacement snapshot can repair it. */
  incomplete: boolean;
  usage: Usage | null | undefined;
  error: string | null;
};
export type NarrativeOptions = {
  sessionId: string;
  request: HttpRequest;
  getSession: () => Promise<{tipEntryId: string | null}>;
  onTipChanged?: (tipEntryId: string | null) => void;
  onTerminal?: (event: TerminalEvent) => void;
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
  let disposed = false, eventRevision = 0, continuous = false;
  let snapshot: NarrativeSnapshot = {
    run: null, activeRunId: null, drafts: [], sending: false, stopping: false,
    incomplete: false, usage: undefined, error: null,
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
  const withUserMessage = (runId: string, message: AcceptedRun['userMessage']): StageMessage[] => [
    {...message, runId, saved: true},
    ...snapshot.drafts.filter(item => item.runId === runId && item.id !== message.id),
  ];
  // A paged read can finish after a newer live event. Only reconcile its matching revision.
  const reconcile = (stored: StoredRun | undefined, checkpoint: number) => {
    if (disposed || checkpoint !== eventRevision || !stored) return;
    const current = snapshot.run?.runId === stored.runId ? snapshot.run : null;
    if (current && terminal(current.status) && !terminal(stored.status) && stored.status !== 'unknown') return;
    const active = stored.status === 'running' || stored.status === 'stopping';
    if (!current) continuous = false;
    const saved = new Set(stored.entries.map(entry => entry.id));
    if (terminal(stored.status)) settled.add(stored.runId);
    const run = current && terminal(current.status) && stored.status === 'unknown' ? current : {
      runId: stored.runId, status: stored.status, messages: [], finishedAt: stored.finishedAt, stopReason: stored.stopReason,
      ...(active && current?.phase ? {phase: current.phase} : {}),
    };
    emit({run, activeRunId: active ? stored.runId : null, stopping: stored.status === 'stopping',
      drafts: active && current ? snapshot.drafts.filter(message => !saved.has(message.id)) : [],
      incomplete: active && !continuous});
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reconcile,
    checkpoint: () => eventRevision,
    clearError() { if (!disposed) emit({error: null}); },
    setConnected(connected: boolean) {
      if (!connected) {
        continuous = false;
        if (snapshot.activeRunId) emit({incomplete: true});
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
        const current = snapshot.run?.runId === id ? snapshot.run : null;
        continuous = true;
        emit({...(current ? {} : {
          run: {runId: id, status: 'running', phase: 'preparing', messages: []},
          activeRunId: id, stopping: false, usage: undefined,
        }), drafts: withUserMessage(id, event.data.messages[0]), incomplete: false, error: null});
        if (!current) callback(() => options.onTipChanged?.(event.data.messages[0].id));
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
          drafts: snapshot.drafts.filter(message => event.data.savedMessageIds.includes(message.id)),
          activeRunId: null, stopping: false, incomplete: false});
        callback(() => options.onTipChanged?.(event.data.tipEntryId));
        callback(() => options.onTerminal?.(event));
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
            activeRunId: accepted.runId, drafts: withUserMessage(accepted.runId, accepted.userMessage), incomplete: false, usage: undefined});
          callback(() => options.onTipChanged?.(accepted.userEntryId));
        } else if (snapshot.run?.runId === accepted.runId && !settled.has(accepted.runId)) {
          // Confirm the user without replacing newer stream output or run state.
          emit({drafts: withUserMessage(accepted.runId, accepted.userMessage)});
        }
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
      disposed = true;
      for (const controller of pending) controller.abort();
      pending.clear(); listeners.clear();
    },
  };
}
export type NarrativeController = ReturnType<typeof createNarrativeController>;
