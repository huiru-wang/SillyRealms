import React from 'react';
import {useTranslation} from 'react-i18next';
import type {StageMessage, StageRun} from '../stage-contract.js';

/** Public model reasoning stays separate from story prose and author render rules. */
export function MessageReasoning({message, status}: {message: StageMessage; status: StageRun['status']}) {
  const {t} = useTranslation('stage');
  const text = message.reasoning_content;
  if (!text?.trim()) return null;
  const receiving = !message.saved && (status === 'running' || status === 'stopping')
    && !message.content.trim() && !message.tool_calls?.length;
  return <details className="sr-reasoning">
    <summary>{t(receiving ? 'reasoning.thinking' : 'reasoning.complete')}</summary>
    <div className="sr-reasoning-content" role="region" aria-label={t('reasoning.label')} tabIndex={0}>{text}</div>
  </details>;
}
