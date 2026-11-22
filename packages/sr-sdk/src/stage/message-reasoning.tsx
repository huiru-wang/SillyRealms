import React from 'react';
import type {StageMessage, StageRun} from '../stage-contract.js';

/** Public model reasoning stays separate from story prose and author render rules. */
export function MessageReasoning({message, status}: {message: StageMessage; status: StageRun['status']}) {
  const text = message.reasoning_content;
  if (!text?.trim()) return null;
  const receiving = !message.saved && (status === 'running' || status === 'stopping')
    && !message.content.trim() && !message.tool_calls?.length;
  return <details className="sr-reasoning">
    <summary>{receiving ? '思考中' : '思考完成'}</summary>
    <div className="sr-reasoning-content" role="region" aria-label="模型思考内容" tabIndex={0}>{text}</div>
  </details>;
}
