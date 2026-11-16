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
  description: string;
  nodeId?: string;
  onRestore?: () => Promise<string>;
  onApply: (value: PromptValue) => void;
  onClose: () => void;
};
const textVariables = [
  ['user', '当前玩家名'],
  ['persona.prompt', '玩家设定'],
  ['characters.prompts', '已加载角色'],
  ['world.lore', '已激活世界书'],
  ['history.summary', '已有摘要'],
  ['state.currentValues', '可写状态当前值'],
  ['state.updateRules', '状态更新规则'],
] as const;

export function PromptEditorDialog({title, initialValue, metadata = false, description, nodeId, onRestore, onApply, onClose}: Props) {
  const [value, setValue] = useState(initialValue);
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const formId = useId();
  const dirty = JSON.stringify(value) !== JSON.stringify(initialValue);
  const variables: ReadonlyArray<readonly [string, string]> = [
    ...textVariables,
    ...(nodeId === 'chatHistory' ? [['history.messages', '原生历史消息'] as const] : []),
    ...(nodeId === 'userInput' ? [['input.text', '本轮输入'] as const] : []),
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
      if (alive.current) setError(reason instanceof Error ? reason.message : '默认提示词加载失败，请重试。');
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
        <Button tone="accent" type="submit" form={formId} disabled={restoring}>应用</Button>
      </>}
    </div>}>
    <form id={formId} onSubmit={apply} className={styles.promptForm}>
      <div className={styles.promptIntro}>
        <p className={styles.dialogDescription}>{description}</p>
        {onRestore && <Button type="button" disabled={restoring} onClick={() => void restore()}>{restoring ? '正在恢复…' : '恢复默认提示词'}</Button>}
      </div>
      {error && <p className={styles.formError} role="alert">{error}</p>}
      {metadata && <div className={styles.nodeFields}>
        <label className={styles.field}>节点名称
          <input aria-label="节点名称" required maxLength={80} value={value.name}
            onChange={event => {setValue({...value, name: event.target.value}); setDiscard(false); setError('');}}/>
        </label>
        <label className={styles.field}>消息角色
          <Select aria-label="消息角色" value={value.role}
            onChange={event => setValue({...value, role: event.target.value as PresetRole})}>
            <option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option>
          </Select>
        </label>
      </div>}
      <label className={styles.field}>提示词正文
        <textarea ref={inputRef} className={styles.promptInput} aria-label="提示词正文" rows={14} disabled={restoring}
          placeholder="在这里编写提示词…" value={value.prompt}
          onChange={event => {setValue({...value, prompt: event.target.value}); setDiscard(false);}}
          onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault(); event.currentTarget.form?.requestSubmit();
            }
          }}/>
      </label>
      <div className={styles.promptMeta}><span>保留换行与原文格式</span><span>{Array.from(value.prompt).length.toLocaleString()} 字符</span></div>
      {nodeId && <details className={styles.variableHelp}>
        <summary>系统变量</summary>
        <div className={styles.variableList}>{variables.map(([name, label]) => <button key={name} type="button" disabled={restoring} onClick={() => insertVariable(name)} aria-label={'插入变量：' + name}>
          <span>{label}</span><code>{'{{' + name + '}}'}</code>
        </button>)}</div>
        <p>点击变量插入光标处。变量内容在每轮生成时填入。{nodeId === 'chatHistory' ? '历史消息变量需保留一次，并保留原有消息角色。' : nodeId === 'userInput' ? '本轮输入变量需保留一次，可在前后添加说明。' : ''}</p>
      </details>}
    </form>
  </Modal>;
}
