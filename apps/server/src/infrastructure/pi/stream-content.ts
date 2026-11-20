import type { AssistantMessage, AssistantMessageEvent, ToolCall } from '@earendil-works/pi-ai';
import type { ModelDelta, ModelSnapshot, ModelToolCall, ModelToolCallDelta } from '../model/client.js';

type TextBlock = { type: 'text' | 'thinking'; text: string };
type ToolBlock = {
  type: 'toolCall'; index: number; id: string; name: string; arguments: string;
  rawArguments: string; ended: boolean;
};
type Block = TextBlock | ToolBlock;

/** Copies public fields as events are consumed. Never retains the SDK's mutable partial objects. */
export class PiContent {
  private blocks = new Map<number, Block>();
  private toolIndexes = new Map<number, number>();
  private nextToolIndex = 0;
  invalidArguments = false;

  private tool(contentIndex: number, source?: ToolCall): ToolBlock {
    const existing = this.blocks.get(contentIndex);
    if (existing?.type === 'toolCall') return existing;
    let index = this.toolIndexes.get(contentIndex);
    if (index === undefined) {
      index = this.nextToolIndex++;
      this.toolIndexes.set(contentIndex, index);
    }
    const hadInitialArguments = source !== undefined && Object.keys(source.arguments).length > 0;
    const block: ToolBlock = {
      type: 'toolCall', index, id: '', name: '',
      arguments: hadInitialArguments ? JSON.stringify(source.arguments) : '',
      rawArguments: '', ended: false,
    };
    this.blocks.set(contentIndex, block);
    return block;
  }

  private identity(block: ToolBlock, source?: ToolCall): ModelToolCallDelta {
    const delta: ModelToolCallDelta = { index: block.index, type: 'function' };
    if (source?.id && source.id !== block.id) { block.id = source.id; delta.id = source.id; }
    if (source?.name && source.name !== block.name) {
      block.name = source.name;
      delta.function = { name: source.name };
    }
    return delta;
  }

  accept(event: AssistantMessageEvent): ModelDelta | undefined {
    if (event.type === 'text_delta' || event.type === 'thinking_delta') {
      const type = event.type === 'text_delta' ? 'text' : 'thinking';
      const previous = this.blocks.get(event.contentIndex);
      const block: TextBlock = previous?.type === type ? previous : { type, text: '' };
      block.text += event.delta;
      this.blocks.set(event.contentIndex, block);
      return event.delta ? type === 'text' ? { content: event.delta } : { reasoning_content: event.delta } : undefined;
    }
    if (event.type === 'text_end' || event.type === 'thinking_end') {
      this.blocks.set(event.contentIndex, { type: event.type === 'text_end' ? 'text' : 'thinking', text: event.content });
      return undefined;
    }
    if (event.type === 'toolcall_start' || event.type === 'toolcall_delta' || event.type === 'toolcall_end') {
      const part = event.type === 'toolcall_end' ? event.toolCall : event.partial.content[event.contentIndex];
      const source = part?.type === 'toolCall' ? part : undefined;
      const block = this.tool(event.contentIndex, source);
      const delta = this.identity(block, source);
      if (event.type === 'toolcall_delta' && event.delta) {
        block.rawArguments += event.delta;
        // partial may already contain future queued arguments. Fallback uses only consumed fragments;
        // authoritative end/done snapshots restore any provider-private initial prefix.
        block.arguments = block.rawArguments;
        delta.function = { ...delta.function, arguments: event.delta };
      }
      if (event.type === 'toolcall_end' && source) this.finishTool(block, source, false);
      return { tool_calls: [delta] };
    }
    // Starts cannot be copied as text: partial may already contain future queued deltas.
    return undefined;
  }

  private finishTool(block: ToolBlock, source: ToolCall, interrupted: boolean): void {
    this.identity(block, source);
    if (source.argumentsError) {
      this.invalidArguments = true;
      block.arguments = block.rawArguments || block.arguments || '';
    } else if (!interrupted || block.ended || !block.rawArguments) {
      block.arguments = JSON.stringify(source.arguments);
    }
    if (!interrupted) block.ended = true;
  }

  /** Full terminal provider messages are authoritative; errors retain observed blocks omitted by the provider. */
  finish(message: AssistantMessage, interrupted: boolean): ModelSnapshot {
    const previous = this.blocks;
    if (!interrupted) this.blocks = new Map();
    message.content.forEach((part, contentIndex) => {
      if (part.type === 'text' || part.type === 'thinking') {
        const value = part.type === 'text' ? part.text : part.thinking;
        const old = previous.get(contentIndex);
        // A truncated error snapshot must not erase content already received.
        const text = interrupted && old?.type === part.type && old.text.startsWith(value) ? old.text : value;
        this.blocks.set(contentIndex, { type: part.type, text });
      } else if (part.type === 'toolCall') {
        const old = previous.get(contentIndex);
        if (old?.type === 'toolCall') this.blocks.set(contentIndex, old);
        const block = this.tool(contentIndex, part);
        this.finishTool(block, part, interrupted);
      }
    });
    return this.snapshot();
  }

  snapshot(): ModelSnapshot {
    const entries = [...this.blocks.entries()].sort(([left], [right]) => left - right);
    const tool_calls: ModelToolCall[] = entries.flatMap(([, block]) => block.type === 'toolCall' ? [{
      index: block.index, id: block.id, type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }] : []).sort((left, right) => left.index - right.index);
    return {
      role: 'assistant',
      content: entries.flatMap(([, block]) => block.type === 'text' ? [block.text] : []).join(''),
      reasoning_content: entries.flatMap(([, block]) => block.type === 'thinking' ? [block.text] : []).join(''),
      tool_calls,
    };
  }
}
