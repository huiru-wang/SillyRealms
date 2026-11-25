import {errorMessage} from '../../i18n/errors.ts';
import {i18n} from '../../i18n/instance.ts';
import {useTranslation} from 'react-i18next';
import {Input,Textarea} from '../../components/ui/Field';
import {Select} from '../../components/ui/Select';
import {useEffect, useId, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {Modal} from '../../components/ui/Modal';
import {Button} from '../../components/ui/Button';
import type {PresetRole} from './types';
import styles from './Presets.module.css';

export type PromptValue = {name: string; role: PresetRole; prompt: string};
type Props = {
  title: string;
  initialValue: PromptValue;
  metadata?: boolean;
  replyAssist?: boolean;
  description: string;
  nodeId?: string;
  onRestore?: () => Promise<string>;
  onApply: (value: PromptValue) => void;
  onClose: () => void;
};

export function PromptEditorDialog({title, initialValue, metadata = false, replyAssist = false, description, nodeId, onRestore, onApply, onClose}: Props) {
  const {t} = useTranslation('presets');
  const textVariables = [
  ['system.language', t('presets:applicationLanguage')],
  ['user', t('currentPlayerName')],
  ['persona.prompt', t('playerPersona')],
  ['characters.prompts', t('loadedCharacters')],
  ['world.lore', t('activeLorebook')],
  ['history.summary', t('existingSummary')],
  ['state.global', t('globalStateReadOnly')],
  ['state.session', t('sessionStateReadOnly')],
  ['state.message', t('messageState')],
] as const;
  const [value, setValue] = useState(initialValue);
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState<Error|string>('');
  const [restoring, setRestoring] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const formId = useId();
  const dirty = JSON.stringify(value) !== JSON.stringify(initialValue);
  const variables: ReadonlyArray<readonly [string, string]> = [
    ...textVariables.filter(([name])=>!replyAssist || name!=='history.summary' || nodeId==='chatHistory'),
    ...(replyAssist ? [['session.reply.assist.goal', t('sessions:assistGoal')] as const] : []),
    ...(nodeId === 'stateUpdate' ? [['state.update.message', t('messageUpdateRules')] as const] : []),
    ...(nodeId === 'chatHistory' ? [['history.messages', t('originalHistoryMessages')] as const] : []),
    ...(nodeId === 'userInput' ? [['input.text', t('currentTurnInput')] as const] : []),
  ];
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';};
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const requestClose = () => {
    if (dirty) {setDiscard(true); return false;}
    return true;
  };
  const cancel = () => {if (requestClose()) onClose();};
  async function restore() {
    if (!onRestore || restoring) return;
    setRestoring(true); setError('');
    try {
      const prompt = await onRestore();
      if (alive.current) {setValue(current => ({...current, prompt})); setDiscard(false);}
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error?reason: t('couldNotLoadTheDefaultPromptTry'));
    } finally {
      if (alive.current) setRestoring(false);
    }
  }
  function insertVariable(name: string) {
    const input = inputRef.current;
    if (!input) return;
    const start = input.selectionStart, end = input.selectionEnd, token = '{{' + name + '}}';
    setValue(current => ({...current, prompt: current.prompt.slice(0, start) + token + current.prompt.slice(end)}));
    setDiscard(false); setError('');
    requestAnimationFrame(() => {input.focus(); input.setSelectionRange(start + token.length, start + token.length);});
  }
  function apply(event: FormEvent) {
    event.preventDefault();
    if (restoring) return;
    if (metadata && !value.name.trim()) {setError(t('enterANodeName')); return;}
    onApply({...value, name: value.name.trim()});
    onClose();
  }
  return <Modal title={title} size="editor" onClose={onClose} onBeforeClose={requestClose} closeOnBackdrop={false}
    footer={<div className={styles.dialogActions}>
      {discard ? <>
        <span className={styles.discardMessage} role="alert">{t('discardUnappliedChanges')}</span>
        <Button onClick={() => setDiscard(false)}>{t('keepEditing')}</Button>
        <Button onClick={onClose}>{t('discardChanges')}</Button>
      </> : <>
        <span className={styles.dialogHint}>{t('saveThePresetAfterApplying')}</span>
        <Button onClick={cancel}>{t('cancel')}</Button>
        <Button variant="primary" type="submit" form={formId} disabled={restoring}>{t('apply')}</Button>
      </>}
    </div>}>
    <form id={formId} onSubmit={apply} className={styles.promptForm}>
      <div className={styles.promptIntro}>
        <p className={styles.dialogDescription}>{description}</p>
        {onRestore && <Button size="compact" type="button" disabled={restoring} onClick={() => void restore()}>{restoring ? t('restoring') : t('restoreDefaultPrompt')}</Button>}
      </div>
      {error && <p className={styles.formError} role="alert">{errorMessage(error)}</p>}
      {metadata && <div className={styles.nodeFields}>
        <label className={styles.field}>{t('nodeName')}<Input aria-label={t('nodeName')} required maxLength={80} value={value.name}
            onChange={event => {setValue({...value, name: event.target.value}); setDiscard(false); setError('');}}/>
        </label>
        <label className={styles.field}>{t('messageRole')}<Select aria-label={t('messageRole')} value={value.role}
            onChange={event => setValue({...value, role: event.target.value as PresetRole})}>
            <option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option>
          </Select>
        </label>
      </div>}
      <label className={styles.field}>{t('promptText')}<Textarea ref={inputRef} className={styles.promptInput} aria-label={t('promptText')} rows={14} disabled={restoring}
          placeholder={t('writeYourPromptHere')} value={value.prompt}
          onChange={event => {setValue({...value, prompt: event.target.value}); setDiscard(false);}}
          onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault(); event.currentTarget.form?.requestSubmit();
            }
          }}/>
      </label>
      <div className={styles.promptMeta}><span>{t('lineBreaksAndFormattingArePreserved')}</span><span>{t('presets:characterCount',{count:Array.from(value.prompt).length,value:Array.from(value.prompt).length.toLocaleString(i18n.resolvedLanguage)})}</span></div>
      {nodeId && <details className={styles.variableHelp}>
        <summary>{t('systemVariablesAndStateFields')}</summary>
        <div className={styles.variableList}>{variables.map(([name, label]) => <button key={name} type="button" disabled={restoring} onClick={() => insertVariable(name)} aria-label={t('presets:insertVariable',{name})}>
          <span>{label}</span><code>{'{{' + name + '}}'}</code>
        </button>)}</div>
        <p>{t('stateGroupsIncludeFieldDescriptionsToUse')}<code>{'{{state.session.人设.姓名}}'}</code>{t('supportsGlobalSessionAndMessageMissingOr')}</p>
        <p>{t('presets:languageVariableHelp')}</p>
        <p>{t('clickAVariableToInsertItAt')}{nodeId === 'chatHistory' ? t('keepTheHistoryVariableOncePreservingThe') : nodeId === 'userInput' ? t('keepTheCurrentInputVariableOnceYou') : ''}</p>
      </details>}
    </form>
  </Modal>;
}
