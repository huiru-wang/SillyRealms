import type { ChatMessage, Run, SessionRunEvent, RunMetadata } from './run-contract.js';

export function displayMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const last = result[result.length - 1];
    if (message.role === 'assistant' && last?.role === 'assistant') last.text += '\n\n' + message.text;
    else result.push({ ...message });
  }
  return result;
}
const terminal = (run?: Run) => !!run && ['completed', 'failed', 'stopped'].includes(run.status);
function metadata(value: RunMetadata): RunMetadata {
  return { ...(value.executionMode ? { executionMode: value.executionMode } : {}),
    ...(value.phase ? { phase: value.phase } : {}),
    ...(value.capabilities ? { capabilities: value.capabilities } : {}),
    ...(value.extensions ? { extensions: value.extensions } : {}) };
}
/** Terminal authority wins over late phases/deltas and reconnect preparation notifications. */
export function applyRunEvent(runs: Run[], event: SessionRunEvent): Run[] {
  const { runId } = event.data;
  const previous = runs.find(run => run.id === runId);
  if (terminal(previous) && ['run.phase', 'run.delta', 'run.created'].includes(event.event)) return runs;
  let run: Run = previous ? { ...previous, messages: [...previous.messages] } : { id: runId, status: 'running', messages: [] };
  if (event.event === 'run.phase') {
    run.phase = event.data.phase;
    if (event.data.phase === 'preparing') run.status = 'preparing';
  } else if (event.event === 'run.created') {
    for (const message of event.data.messages)
      if (!run.messages.some(item => item.id === message.id)) run.messages.push(message);
    run = { ...run, ...metadata(event.data), status: 'running' };
  } else if (event.event === 'run.delta') {
    const index = run.messages.findIndex(message => message.id === event.data.messageId);
    if (index < 0) run.messages.push({ id: event.data.messageId, role: 'assistant', text: event.data.text });
    else run.messages[index] = { ...run.messages[index]!, text: run.messages[index]!.text + event.data.text };
  } else {
    if (event.data.messages.length) run.messages = event.data.messages;
    run = { ...run, ...metadata(event.data), phase: 'finalized',
      status: event.event === 'run.completed' ? 'completed' : event.event === 'run.stopped' ? 'stopped' : 'failed' };
  }
  return previous ? runs.map(item => item.id === runId ? run : item) : [...runs, run];
}
export function mergeInitial(runs: Run[], events: SessionRunEvent[]): Run[] {
  const initialIds = new Set(runs.map(run => run.id));
  return events.reduce((items, event) => initialIds.has(event.data.runId) &&
    (event.event === 'run.created' || event.event === 'run.delta') ? items : applyRunEvent(items, event), runs);
}
