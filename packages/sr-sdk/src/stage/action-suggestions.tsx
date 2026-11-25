import {useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useSRActionSuggestions, useSRSession, useSRStageSnapshot} from './context.js';
import {stageErrorMessage} from './feedback.js';

/** Optional official view. Authors can render the same data with their own session actions. */
export function ActionSuggestions() {
  const {items} = useSRActionSuggestions();
  const session = useSRSession(), {connected, sending} = useSRStageSnapshot();
  const {t, i18n} = useTranslation('stage');
  const busy = useRef(false), [pending, setPending] = useState(false), [error, setError] = useState('');

  async function choose(text: string) {
    if (busy.current || !connected || sending) return;
    busy.current = true; setPending(true); setError('');
    try { await session.setDraft(text); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'story.draftFailed'); }
    finally { busy.current = false; setPending(false); }
  }

  if (items.length === 0) return null;
  return <section className="sr-action-suggestions" aria-label={t('story.suggestions')} aria-busy={pending || undefined}>
    <div className="sr-action-suggestions-items">{items.map((item, index) =>
      <button key={index} className="sr-action-suggestion" type="button" disabled={!connected || sending || pending}
        onClick={() => void choose(item)}>{item}</button>
    )}</div>
    {error && <p className="sr-action-suggestions-error" role="alert">{
      stageErrorMessage(error, key => t(key), key => i18n.exists(key, {ns: 'stage'}))
    }</p>}
  </section>;
}
