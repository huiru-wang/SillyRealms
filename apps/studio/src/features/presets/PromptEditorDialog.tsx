import {useEffect, useId, useState} from 'react';
import type {FormEvent} from 'react';
import {Modal} from '../../components/ui/Modal';
import {Button} from '../../components/ui/Button';
import type {PresetRole} from '../../fixtures/presets';
import styles from './Presets.module.css';

export type PromptValue = {name: string; role: PresetRole; content: string};
type Props = {
  title: string;
  initialValue: PromptValue;
  metadata?: boolean;
  description: string;
  onApply: (value: PromptValue) => void;
  onClose: () => void;
};

export function PromptEditorDialog({title, initialValue, metadata = false, description, onApply, onClose}: Props) {
  const [value, setValue] = useState(initialValue);
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState('');
  const formId = useId();
  const dirty = JSON.stringify(value) !== JSON.stringify(initialValue);
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
  function apply(event: FormEvent) {
    event.preventDefault();
    if (metadata && !value.name.trim()) {setError('请输入节点名称。'); return;}
    onApply({...value, name: value.name.trim()});
    onClose();
  }
  return <Modal title={title} size="editor" onClose={onClose} onBeforeClose={requestClose} closeOnBackdrop={false}
    footer={<div className={styles.dialogActions}>
      {discard ? <>
        <span className={styles.discardMessage} role="alert">修改尚未应用，确定放弃吗？</span>
        <Button onClick={() => setDiscard(false)}>继续编辑</Button>
        <Button onClick={onClose}>放弃修改</Button>
      </> : <>
        <span className={styles.dialogHint}>应用后，记得保存预设</span>
        <Button onClick={cancel}>取消</Button>
        <Button tone="accent" type="submit" form={formId}>应用</Button>
      </>}
    </div>}>
    <form id={formId} onSubmit={apply} className={styles.promptForm}>
      <p className={styles.dialogDescription}>{description}</p>
      {error && <p className={styles.formError} role="alert">{error}</p>}
      {metadata && <div className={styles.nodeFields}>
        <label className={styles.field}>节点名称
          <input aria-label="节点名称" required maxLength={80} value={value.name}
            onChange={event => {setValue({...value, name: event.target.value}); setDiscard(false); setError('');}}/>
        </label>
        <label className={styles.field}>消息角色
          <select aria-label="消息角色" value={value.role}
            onChange={event => setValue({...value, role: event.target.value as PresetRole})}>
            <option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option>
          </select>
        </label>
      </div>}
      <label className={styles.field}>提示词正文
        <textarea className={styles.promptInput} aria-label="提示词正文" rows={14}
          placeholder="在这里编写提示词…" value={value.content}
          onChange={event => {setValue({...value, content: event.target.value}); setDiscard(false);}}
          onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault(); event.currentTarget.form?.requestSubmit();
            }
          }}/>
      </label>
      <div className={styles.promptMeta}><span>保留换行与原文格式</span><span>{Array.from(value.content).length.toLocaleString()} 字符</span></div>
    </form>
  </Modal>;
}
