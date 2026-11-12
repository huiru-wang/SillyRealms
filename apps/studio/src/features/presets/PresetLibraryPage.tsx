import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, Copy, FileText, GripVertical, Layers3, LockKeyhole, MoreHorizontal, Plus, SlidersHorizontal, Star, Trash2, Undo2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import type { ContextStrategy, PresetCustomNode, StudioPreset } from '../../fixtures/presets';
import { getPresetValidationError, usePresetStore } from './PresetStore';
import { PromptEditorDialog } from './PromptEditorDialog';
import type { PromptValue } from './PromptEditorDialog';
import styles from './Presets.module.css';

const STRATEGIES: { id: ContextStrategy; label: string; hint: string }[] = [
  { id: 'compact', label: '轻量对话', hint: '更及时地整理历史，适合轻快的短篇对话。' },
  { id: 'standard', label: '标准叙事', hint: '平衡故事记忆与上下文长度，适合日常叙事。' },
  { id: 'extended', label: '长篇沉浸', hint: '保留更多故事细节，适合长篇与多角色叙事。' },
];
const SOURCES = [
  { id: 'platform', name: '平台叙事规则', role: 'System', detail: '平台提供的叙事与输出约定，始终位于第一条消息，保证各世界采用一致的基础规则。' },
  { id: 'persona', name: '玩家设定', role: 'System', detail: '来自当前世界中选定的玩家角色。角色正文在世界卡的角色配置中维护，运行时按当前选择注入。' },
  { id: 'characters', name: '角色设定', role: 'System', detail: '来自当前激活的其他角色。运行时按各角色的加载规则选择内容，每轮可能不同。' },
  { id: 'lore', name: '世界书', role: 'System', detail: '来自世界卡内已激活的世界书条目，按配置顺序组成独立的世界信息消息。' },
  { id: 'summary', name: '历史摘要', role: 'Assistant', detail: '由上下文压缩生成，存在时加入。可通过本页的压缩提示词调整摘要方式，已经产生的摘要属于会话数据。' },
  { id: 'history', name: '对话历史', role: 'Auto', detail: '使用会话中保留的历史消息，维持每条消息的 User / Assistant 角色与时间顺序。' },
  { id: 'state', name: '当前状态与输出规则', role: 'System', detail: '平台在历史之后注入本轮权威状态和输出约定。内容由当前世界状态生成，位置固定。' },
  { id: 'input', name: '当前输入', role: 'User', detail: '来自玩家本轮输入，始终只出现一次，并位于消息序列的最后。' },
] as const;
type Source = typeof SOURCES[number];
type Dialog = { kind: 'style' | 'summary' } | { kind: 'custom'; node: PresetCustomNode; isNew: boolean } | { kind: 'source'; source: Source } | { kind: 'deletePreset' } | { kind: 'deleteNode'; node: PresetCustomNode };
type DropTarget = { id: string; after: boolean };
type Drag = { id: string; pointerId: number; startY: number; x: number; y: number; active: boolean; target: DropTarget | null; frame: number; handle: HTMLButtonElement; dispose: () => void };

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={styles.switchButton} onClick={onChange}>
    <span className={styles.switchTrack}><span /></span>
  </button>;
}

export function PresetLibraryPage() {
  const store = usePresetStore();
  const { presets, draftById, defaultPresetId, isDirty, editPreset, savePreset, revertPreset, createPreset, duplicatePreset, deletePreset, setDefaultPreset } = store;
  const { presetId } = useParams<{ presetId?: string }>();
  const selectedId = presetId ?? defaultPresetId ?? presets[0]?.id;
  const preset = selectedId && Object.hasOwn(draftById, selectedId) ? draftById[selectedId] : undefined;
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [menuAbove, setMenuAbove] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const contentRef = useRef<HTMLFormElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const positions = useRef(new Map<string, number>());
  const drag = useRef<Drag | null>(null);
  const formId = useId();
  const dirty = !!preset && isDirty(preset.id);

  useLayoutEffect(() => {
    document.getElementById('main-content')?.scrollTo({ top: 0 });
  }, []);
  useLayoutEffect(() => {
    cancelCurrentDrag();
    const element = contentRef.current;
    if (element) element.scrollTop = positions.current.get(selectedId ?? '') ?? 0;
    setDialog(null); setMenu(null); setError(''); setStatus('');
    return () => { if (element && selectedId) positions.current.set(selectedId, element.scrollTop); };
  }, [selectedId]);
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(''), 3200);
    return () => window.clearTimeout(timer);
  }, [status]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('[data-preset-menu]')) setMenu(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); setMenu(null);
        document.querySelector<HTMLButtonElement>('[data-menu-trigger="' + CSS.escape(menu) + '"]')?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [menu]);
  useEffect(() => {
    const cancel = () => cancelCurrentDrag();
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      const current = drag.current; drag.current = null;
      if (current) { cancelAnimationFrame(current.frame); current.dispose(); }
    };
  }, []);

  function cancelCurrentDrag() {
    const current = drag.current; drag.current = null;
    if (current) { cancelAnimationFrame(current.frame); current.dispose(); }
    setDragId(null); setDrop(null);
  }

  function focusMenuTrigger(id: string) {
    document.querySelector<HTMLButtonElement>('[data-menu-trigger="' + CSS.escape(id) + '"]')?.focus({ preventScroll: true });
  }
  function closeMenu(id: string) { setMenu(null); requestAnimationFrame(() => focusMenuTrigger(id)); }

  function update(patch: Partial<StudioPreset>) {
    if (preset) editPreset(preset.id, current => ({ ...current, ...patch }));
    setError('');
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!preset) return;
    const validation = getPresetValidationError(preset);
    if (validation || !savePreset(preset.id)) { setError(validation ?? '请检查预设配置后再保存。'); contentRef.current?.scrollTo({ top: 0 }); return; }
    setError(''); setStatus('预设已保存');
  }
  function select(id: string) { navigate('/presets/' + id); }
  function create() {
    const id = createPreset();
    select(id);
    requestAnimationFrame(() => nameRef.current?.select());
  }
  function changeNode(id: string, transform: (node: PresetCustomNode) => PresetCustomNode) {
    if (preset) editPreset(preset.id, current => ({ ...current, customNodes: current.customNodes.map(node => node.id === id ? transform(node) : node) }));
  }
  function moveNode(id: string, offset: number) {
    if (!preset) return;
    const from = preset.customNodes.findIndex(node => node.id === id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= preset.customNodes.length) return;
    const next = [...preset.customNodes];
    const [node] = next.splice(from, 1); next.splice(to, 0, node);
    update({ customNodes: next });
    setStatus(node.name + '已移至第 ' + (to + 1) + ' 位');
    setMenu(null);
    requestAnimationFrame(() => {
      const moved = groupRef.current?.querySelector<HTMLElement>('[data-custom-node="' + CSS.escape(id) + '"]');
      moved?.querySelector<HTMLButtonElement>('button[aria-label^="拖动节点："]')?.focus({ preventScroll: true });
      moved?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
  }
  function inDragArea(x: number, y: number) {
    const group = groupRef.current?.getBoundingClientRect();
    const pane = contentRef.current?.getBoundingClientRect();
    return !!group && !!pane && x >= Math.max(group.left, pane.left) && x <= Math.min(group.right, pane.right)
      && y >= Math.max(group.top - 6, pane.top) && y <= Math.min(group.bottom + 6, pane.bottom);
  }
  function targetAt(x: number, y: number, id: string): DropTarget | null {
    if (!inDragArea(x, y)) return null;
    const rows = [...(groupRef.current?.querySelectorAll<HTMLElement>('[data-custom-node]') ?? [])].filter(row => row.dataset.customNode !== id);
    if (!rows.length) return null;
    const before = rows.find(row => y < row.getBoundingClientRect().top + row.offsetHeight / 2);
    return before ? { id: before.dataset.customNode!, after: false } : { id: rows.at(-1)!.dataset.customNode!, after: true };
  }
  function trackPointer(event: PointerEvent) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    current.x = event.clientX; current.y = event.clientY;
    if (!current.active && Math.abs(event.clientY - current.startY) < 5) return;
    current.active = true;
    event.preventDefault();
    setDragId(current.id);
    current.target = targetAt(event.clientX, event.clientY, current.id);
    setDrop(current.target);
  }
  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (!event.isPrimary || event.button !== 0) return;
    cancelCurrentDrag();
    event.preventDefault(); event.currentTarget.focus();
    setMenu(null);
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const current: Drag = { id, pointerId: event.pointerId, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, target: null, frame: 0, handle, dispose: () => { } };
    drag.current = current;
    // Document listeners also finish a drag if pointer capture is lost or the
    // release lands outside the handle/custom group.
    const move = (pointer: PointerEvent) => trackPointer(pointer);
    const up = (pointer: PointerEvent) => endDrag(pointer);
    const cancel = (pointer: PointerEvent) => endDrag(pointer, true);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    current.dispose = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (handle.hasPointerCapture(current.pointerId)) handle.releasePointerCapture(current.pointerId);
    };
    const scroll = () => {
      if (drag.current !== current) return;
      const pane = contentRef.current;
      if (pane && current.active && inDragArea(current.x, current.y)) {
        const bounds = pane.getBoundingClientRect();
        const speed = current.y < bounds.top + 48 ? -9 : current.y > bounds.bottom - 48 ? 9 : 0;
        if (speed) { pane.scrollTop += speed; current.target = targetAt(current.x, current.y, id); setDrop(current.target); }
      }
      current.frame = requestAnimationFrame(scroll);
    };
    current.frame = requestAnimationFrame(scroll);
  }
  function endDrag(event: PointerEvent, cancel = false) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    cancelAnimationFrame(current.frame); drag.current = null;
    current.dispose();
    if (current.active) {
      // A release must not activate whichever control lies below the pointer.
      const suppressClick = (click: MouseEvent) => { click.preventDefault(); click.stopPropagation(); };
      window.addEventListener('click', suppressClick, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', suppressClick, true), 0);
    }
    const target = !cancel && current.active ? targetAt(event.clientX, event.clientY, current.id) : null;
    if (target && preset) {
      const nodes = preset.customNodes.filter(node => node.id !== current.id);
      const item = preset.customNodes.find(node => node.id === current.id);
      const targetIndex = nodes.findIndex(node => node.id === target.id);
      if (item && targetIndex >= 0) {
        nodes.splice(targetIndex + (target.after ? 1 : 0), 0, item);
        update({ customNodes: nodes }); setStatus('节点顺序已更新');
      }
    }
    setDragId(null); setDrop(null);
  }
  function openCustom() {
    setDialog({ kind: 'custom', isNew: true, node: { id: globalThis.crypto?.randomUUID?.() ?? 'node-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), name: '', role: 'system', content: '', enabled: true } });
  }
  function sourceRow(source: Source) {
    return <button type="button" className={styles.sourceRow} key={source.id} onClick={() => setDialog({ kind: 'source', source })}>
      <LockKeyhole size={13} className={styles.lockIcon} aria-hidden="true" />
      <span className={styles.sourceName}>{source.name}</span>
      <span className={styles.nodeRole}>{source.role}</span>
      <span className={styles.sourceMeta}>{source.id === 'platform' ? '固定' : '动态'}</span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>;
  }
  function applyPrompt(value: PromptValue) {
    if (!preset || !dialog) return;
    if (dialog.kind === 'style') update({ style: { ...preset.style, content: value.content } });
    if (dialog.kind === 'summary') update({ summaryPrompt: value.content });
    if (dialog.kind === 'custom') {
      const next = { ...dialog.node, ...value };
      if (dialog.isNew) update({ customNodes: [...preset.customNodes, next] });
      else changeNode(next.id, () => next);
      if (dialog.isNew) requestAnimationFrame(() => groupRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));
    }
  }

  return <section className={styles.page} data-preset-workspace data-detail={!!presetId}>
    <header className={styles.pageHeader}>
      <div className={styles.pageIdentity}><h1>预设</h1></div>
      <Button className={styles.createButton} type="button" aria-label="新建预设" icon={<Plus size={17} />} onClick={create}>新建预设</Button>
    </header>
    <div className={styles.workspace}>
      <section className={styles.library} aria-label="预设库">
        <div className={styles.presetList} data-preset-list tabIndex={0} aria-label="预设列表">
          {presets.map(item => <button key={item.id} type="button" className={styles.presetItem}
            data-preset-item={item.id} aria-pressed={item.id === selectedId} onClick={() => select(item.id)}>
            <span className={styles.itemHeading}><strong data-preset-title title={item.name}>{item.name || '未命名预设'}</strong>
              {isDirty(item.id) && <span className={styles.dirtyDot} title="未保存" aria-label="未保存" />}
              {item.id === defaultPresetId && <span className={styles.defaultState}>默认</span>}
            </span>
            <span data-preset-description className={styles.itemDescription} title={item.description || undefined}>{item.description || '暂无描述'}</span>
          </button>)}
          {!presets.length && <div className={styles.emptyList}><Layers3 size={24} /><p>还没有预设</p>
            <button type="button" onClick={create}>创建第一个预设</button>
          </div>}
        </div>
      </section>

      <section className={styles.editor} aria-label="预设配置">
        <div className={styles.editorHeader}>
          <button type="button" className={styles.listBack} aria-label="返回预设列表" onClick={() => navigate('/presets')}><ArrowLeft size={16} /><span>预设列表</span></button>
          {preset && <>
            <div className={styles.editorIdentity}><h2 title={preset.name}>{preset.name || '未命名预设'}</h2>
              <span className={styles.saveState} data-dirty={dirty}>{dirty ? <><span className={styles.dirtyDot} />未保存</> : <><Check size={12} />已保存</>}</span>
            </div>
            <div className={styles.editorActions}>
              <div className={styles.menuAnchor} data-preset-menu>
                <button type="button" className={styles.iconButton} aria-label="更多预设操作" aria-expanded={menu === 'preset'} data-menu-trigger="preset" onClick={() => setMenu(menu === 'preset' ? null : 'preset')}><MoreHorizontal size={19} /></button>
                {menu === 'preset' && <div className={styles.menuPanel} role="group" aria-label="预设操作">
                  <button type="button" autoFocus disabled={preset.id === defaultPresetId} onClick={() => { setDefaultPreset(preset.id); closeMenu('preset'); setStatus('已设为默认预设'); }}><Star size={14} />设为默认</button>
                  <button type="button" onClick={() => { const id = duplicatePreset(preset.id); setMenu(null); select(id); }}><Copy size={14} />复制预设</button>
                  <button type="button" disabled={!dirty} onClick={() => { revertPreset(preset.id); closeMenu('preset'); setError(''); setStatus('已恢复保存的版本'); }}><Undo2 size={14} />放弃更改</button>
                  <div className={styles.menuDivider} />
                  <button type="button" onClick={() => { focusMenuTrigger('preset'); setDialog({ kind: 'deletePreset' }); setMenu(null); }}><Trash2 size={14} />删除预设</button>
                </div>}
              </div>
              <Button type="submit" form={formId} tone="accent" aria-label="保存预设" disabled={!dirty}>保存预设</Button>
            </div>
          </>}
        </div>
        {preset ? <form id={formId} key={preset.id} ref={contentRef} noValidate onSubmit={save} className={styles.editorContent} data-preset-content tabIndex={0} aria-label="预设配置内容">
          {error && <p className={styles.formError} role="alert">{error}</p>}
          <section className={styles.formSection}>
            <h3>基本信息</h3>
            <div className={styles.basicFields}>
              <label className={styles.field}>预设名称<input ref={nameRef} aria-label="预设名称" required value={preset.name} onChange={event => update({ name: event.target.value })} /></label>
              <label className={styles.field}>预设描述<input aria-label="预设描述" placeholder="简短描述这个预设的叙事方式" value={preset.description} onChange={event => update({ description: event.target.value })} /></label>
            </div>
          </section>
          <section className={styles.formSection}>
            <h3>上下文</h3>
            <fieldset className={styles.strategyField}><legend>上下文策略</legend>
              <div className={styles.strategies}>{STRATEGIES.map(strategy => <label key={strategy.id} className={styles.strategyChoice}>
                <input type="radio" name={'strategy-' + preset.id} value={strategy.id} checked={preset.contextStrategy === strategy.id} onChange={() => update({ contextStrategy: strategy.id })} />
                <span>{strategy.label}</span>
              </label>)}</div>
              <p className={styles.fieldHelp}>{STRATEGIES.find(strategy => strategy.id === preset.contextStrategy)?.hint}</p>
            </fieldset>
            <div className={styles.budgetRow}>
              <label className={styles.field}>最大输出长度<div className={styles.numberField}><input aria-label="最大输出长度" type="number" required min={1} step={1} value={preset.maxOutputTokens || ''} onChange={event => update({ maxOutputTokens: Number(event.target.value) })} /><span>tokens</span></div></label>
              <button type="button" className={styles.summaryButton} onClick={() => setDialog({ kind: 'summary' })}><FileText size={16} /><span><strong>压缩提示词</strong><small>{preset.summaryPrompt.trim() ? '已配置' : '未填写'}</small></span><ChevronRight size={15} /></button>
            </div>
          </section>
          <section className={styles.formSection}>
            <div className={styles.sectionHeading}><h3>提示词编排</h3><button type="button" className={styles.textButton} aria-label="添加自定义节点" onClick={openCustom}><Plus size={15} />自定义节点</button></div>
            <div className={styles.nodeStack}>
              {sourceRow(SOURCES[0])}
              <div className={styles.nodeRow} data-disabled={!preset.style.enabled}>
                <span className={styles.nodeLead}><SlidersHorizontal size={15} /></span>
                <button type="button" className={styles.nodeMain} aria-label="编辑叙事风格" onClick={() => setDialog({ kind: 'style' })}><span>叙事风格</span><small>{preset.style.enabled ? (preset.style.content.trim() ? '编辑提示词' : '空内容') : '已关闭'}</small></button>
                <span className={styles.nodeRole}>System</span>
                <Switch checked={preset.style.enabled} label="启用叙事风格" onChange={() => update({ style: { ...preset.style, enabled: !preset.style.enabled } })} />
              </div>
              <div className={styles.customGroup} ref={groupRef} data-custom-group>
                {preset.customNodes.map((node, index) => <div key={node.id} className={styles.customRow} data-custom-node={node.id} data-disabled={!node.enabled}
                  data-dragging={dragId === node.id} data-drop={drop?.id === node.id ? (drop.after ? 'after' : 'before') : undefined}>
                  <button type="button" className={styles.dragHandle} aria-label={'拖动节点：' + node.name} title="拖动排序，或使用方向键上移、下移"
                    onPointerDown={event => beginDrag(event, node.id)}
                    onKeyDown={event => {
                      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); cancelCurrentDrag(); moveNode(node.id, event.key === 'ArrowUp' ? -1 : 1); }
                      if (event.key === 'Escape' && drag.current) { event.preventDefault(); cancelCurrentDrag(); }
                    }}><GripVertical size={16} /></button>
                  <button type="button" className={styles.nodeMain} aria-label={'编辑节点：' + node.name} onClick={() => setDialog({ kind: 'custom', node, isNew: false })}>
                    <span title={node.name}>{node.name}</span><small>{!node.enabled ? '已关闭' : node.content.trim() ? '自定义' : '空内容'}</small>
                  </button>
                  <span className={styles.nodeRole}>{node.role[0].toUpperCase() + node.role.slice(1)}</span>
                  <Switch checked={node.enabled} label={'启用节点：' + node.name} onChange={() => changeNode(node.id, current => ({ ...current, enabled: !current.enabled }))} />
                  <div className={styles.menuAnchor} data-preset-menu>
                    <button type="button" className={styles.nodeMore} aria-label={'更多节点操作：' + node.name} aria-expanded={menu === node.id} data-menu-trigger={node.id} onClick={event => {
                      const edge = contentRef.current?.getBoundingClientRect().bottom ?? innerHeight;
                      setMenuAbove(event.currentTarget.getBoundingClientRect().bottom + 154 > edge);
                      setMenu(menu === node.id ? null : node.id);
                    }}><MoreHorizontal size={16} /></button>
                    {menu === node.id && <div className={styles.menuPanel} data-placement={menuAbove ? 'above' : 'below'} role="group" aria-label="节点操作">
                      <button type="button" autoFocus disabled={index === 0} onClick={() => moveNode(node.id, -1)}><ArrowUp size={14} />上移</button>
                      <button type="button" disabled={index === preset.customNodes.length - 1} onClick={() => moveNode(node.id, 1)}><ArrowDown size={14} />下移</button>
                      <button type="button" onClick={() => { focusMenuTrigger(node.id); setDialog({ kind: 'deleteNode', node }); setMenu(null); }}><Trash2 size={14} />删除节点</button>
                    </div>}
                  </div>
                </div>)}
                {!preset.customNodes.length && <button type="button" className={styles.emptyNodes} onClick={openCustom}><Plus size={15} />添加自定义提示词</button>}
              </div>
              {SOURCES.slice(1).map(sourceRow)}
            </div>
            <p className={styles.fieldHelp}>自定义节点在叙事风格之后生效，可拖动排序。内置消息位置固定。</p>
          </section>
          <details className={styles.advanced}><summary><span>高级设置</span><ChevronDown size={15} /></summary>
            <label className={styles.field}>温度<input aria-label="温度" type="number" min={0} max={2} step="any" value={preset.temperature} onChange={event => update({ temperature: Number(event.target.value) })} /></label>
            <p className={styles.fieldHelp}>较低的值让表达更稳定，较高的值增加变化。</p>
          </details>
        </form> : <div className={styles.emptyEditor}><Layers3 size={32} /><h2>{presetId ? '找不到这个预设' : '从一个预设开始'}</h2><p>{presetId ? '预设可能已被删除，请返回列表选择。' : '创建预设，设置你的叙事风格。'}</p><Button onClick={presetId ? () => navigate('/presets') : create}>{presetId ? '返回预设列表' : '新建预设'}</Button></div>}
      </section>
    </div>
    <div className={styles.srOnly} role="status" aria-live="polite">{status}</div>
    {status && <div className={styles.toast} aria-hidden="true"><Check size={14} />{status}</div>}

    {preset && dialog && (dialog.kind === 'style' || dialog.kind === 'summary' || dialog.kind === 'custom') && <PromptEditorDialog
      key={dialog.kind === 'custom' ? dialog.node.id : dialog.kind}
      title={dialog.kind === 'style' ? '叙事风格' : dialog.kind === 'summary' ? '压缩提示词' : dialog.kind === 'custom' && dialog.isNew ? '添加自定义节点' : '编辑自定义节点'}
      metadata={dialog.kind === 'custom'}
      initialValue={dialog.kind === 'custom' ? dialog.node : { name: '', role: 'system', content: dialog.kind === 'style' ? preset.style.content : preset.summaryPrompt }}
      description={dialog.kind === 'style' ? '设定叙事的人称、节奏与表达方式。留空时沿用世界与故事自身的风格。' : dialog.kind === 'summary' ? '用于整理较早的故事内容，保留人物关系、关键事件与尚未完成的线索。' : '自定义提示词位于叙事风格之后，按列表中的顺序参与编排。'}
      onApply={applyPrompt} onClose={() => setDialog(null)} />}
    {dialog?.kind === 'source' && <Modal title={dialog.source.name} onClose={() => setDialog(null)}>
      <p>{dialog.source.detail}</p><div className={styles.sourceInfo}><span>消息角色</span><strong>{dialog.source.role}</strong></div>
      <div className={styles.sourceInfo}><span>编排位置</span><strong>固定</strong></div>
    </Modal>}
    {preset && dialog?.kind === 'deletePreset' && <Modal title="删除预设" onClose={() => setDialog(null)}
      footer={<div className={styles.dialogActions}><Button onClick={() => setDialog(null)}>取消</Button><Button onClick={() => {
        const remaining = presets.filter(item => item.id !== preset.id);
        const next = remaining[Math.min(presets.findIndex(item => item.id === preset.id), remaining.length - 1)];
        deletePreset(preset.id); setDialog(null); navigate(next ? '/presets/' + next.id : '/presets'); setStatus('预设已删除');
      }}>删除预设</Button></div>}>
      <p>删除“{preset.name}”及其编辑草稿？</p>{preset.id === defaultPresetId && <p>删除后将使用下一个预设作为默认项。</p>}
    </Modal>}
    {preset && dialog?.kind === 'deleteNode' && <Modal title="删除节点" onClose={() => setDialog(null)}
      footer={<div className={styles.dialogActions}><Button onClick={() => setDialog(null)}>取消</Button><Button onClick={() => {
        const index = preset.customNodes.findIndex(node => node.id === dialog.node.id);
        const remaining = preset.customNodes.filter(node => node.id !== dialog.node.id);
        const next = remaining[index] ?? remaining.at(-1);
        update({ customNodes: remaining }); setDialog(null);
        requestAnimationFrame(() => {
          const target = next
            ? groupRef.current?.querySelector<HTMLButtonElement>('[data-custom-node="' + CSS.escape(next.id) + '"] button[aria-label^="拖动节点："]')
            : document.querySelector<HTMLButtonElement>('button[aria-label="添加自定义节点"]');
          target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        });
      }}>删除节点</Button></div>}>
      <p>从当前预设中删除“{dialog.node.name}”？保存预设后生效。</p>
    </Modal>}
  </section>;
}
