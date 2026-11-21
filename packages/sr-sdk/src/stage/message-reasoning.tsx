import React from 'react';

/** Public model reasoning stays separate from story prose and author render rules. */
export function MessageReasoning({text}: {text?: string}) {
  if (!text?.trim()) return null;
  return <details className="sr-reasoning">
    <summary>思考内容</summary>
    <div className="sr-reasoning-content" role="region" aria-label="模型思考内容" tabIndex={0}>{text}</div>
  </details>;
}
