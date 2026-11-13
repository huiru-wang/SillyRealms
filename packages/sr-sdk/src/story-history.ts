import type { ChatMessage, Run, SessionRunEvent, RunMetadata } from './run-contract.js';

export function displayMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const last = result[result.length - 1];
    if (message.role === 'assistant' && last?.role === 'assistant')
      result[result.length - 1] = { ...last, text: last.text + '\n\n' + message.text };
    else result.push(message);
  }
  return result;
}
const terminal = (run?: Run) => !!run && ['completed', 'failed', 'stopped'].includes(run.status);
const phases = { preparing: 0, narrative: 1, extensions: 2, finalized: 3 };
function metadata(value: RunMetadata): RunMetadata {
  return { ...(value.executionMode ? { executionMode: value.executionMode } : {}),
    ...(value.phase ? { phase: value.phase } : {}),
    ...(value.capabilities ? { capabilities: value.capabilities } : {}),
    ...(value.extensions ? { extensions: value.extensions } : {}) };
}
function mergeMessages(current: ChatMessage[], snapshot: ChatMessage[]) {
  const result = snapshot.map(message => {
    const existing = current.find(item => item.id === message.id);
    // Running messages are append-only. A slower HTTP response must not erase newer deltas.
    return existing && existing.text.startsWith(message.text) ? existing : message;
  });
  return [...result, ...current.filter(message => !snapshot.some(item => item.id === message.id))];
}
export function hasDeltaGap(runs: Run[], event: SessionRunEvent): boolean {
  if (event.event !== 'run.delta' || event.data.offset === undefined) return false;
  const run = runs.find(item => item.id === event.data.runId);
  if (terminal(run)) return false;
  const text = run?.messages.find(item => item.id === event.data.messageId)?.text ?? '';
  const { offset, text: delta } = event.data;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return true;
  const overlap = Math.min(text.length - offset, delta.length);
  return text.slice(offset, offset + overlap) !== delta.slice(0, overlap);
}
/** Snapshots, buffered events and live events share one reducer. Offsets are UTF-16 code units. */
export function applyRunEvent(runs: Run[], event: SessionRunEvent): Run[] {
  const { runId } = event.data;
  const previous = runs.find(run => run.id === runId);
  const nonterminal = ['run.phase', 'run.delta', 'run.created'].includes(event.event) ||
    (event.event === 'run.snapshot' && !terminal({ status: event.data.status } as Run));
  if (terminal(previous) && nonterminal) return runs;
  let run: Run = previous ? { ...previous } : { id: runId, status: 'running', messages: [] };
  if (event.event === 'run.phase') {
    if (run.phase && phases[run.phase] >= phases[event.data.phase]) return runs;
    run.phase = event.data.phase;
    run.status = event.data.phase === 'preparing' ? 'preparing' : 'running';
  } else if (event.event === 'run.created' || event.event === 'run.snapshot') {
    const snapshot = event.event === 'run.snapshot' ? event.data.status : 'running';
    run = { ...run, ...metadata(event.data), status: snapshot,
      messages: terminal({ status: snapshot } as Run) ? event.data.messages : mergeMessages(run.messages, event.data.messages) };
    if (!terminal(run) && previous?.phase && phases[previous.phase] > phases[run.phase ?? 'preparing']) {
      run.phase = previous.phase; run.status = previous.status;
    }
  } else if (event.event === 'run.delta') {
    if (hasDeltaGap(runs, event)) return runs;
    const index = run.messages.findIndex(message => message.id === event.data.messageId);
    const current = index < 0 ? '' : run.messages[index]!.text;
    const offset = event.data.offset ?? current.length;
    const suffix = event.data.text.slice(Math.max(0, current.length - offset));
    if (!suffix) return runs;
    run.messages = [...run.messages];
    if (index < 0) run.messages.push({ id: event.data.messageId, role: 'assistant', text: suffix });
    else run.messages[index] = { ...run.messages[index]!, text: current + suffix };
    run.status = 'running';
    if (!run.phase || run.phase === 'preparing') run.phase = 'narrative';
  } else {
    run = { ...run, ...metadata(event.data), messages: event.data.messages, phase: 'finalized',
      status: event.event === 'run.completed' ? 'completed' : event.event === 'run.stopped' ? 'stopped' : 'failed' };
  }
  return previous ? runs.map(item => item.id === runId ? run : item) : [...runs, run];
}
export function mergeInitial(runs: Run[], events: SessionRunEvent[]): Run[] {
  const initialIds = new Set(runs.map(run => run.id));
  return events.reduce((items, event) => initialIds.has(event.data.runId) && event.event === 'run.delta' &&
    event.data.offset === undefined ? items : applyRunEvent(items, event), runs);
}
/** Refresh the newest page while retaining already loaded older pages and newer deltas. */
export function mergeHistory(runs: Run[], snapshots: Run[]): Run[] {
  return snapshots.reduce((current, run) => applyRunEvent(current, {
    event: 'run.snapshot', data: { ...run, runId: run.id },
  }), runs);
}
