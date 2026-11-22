import { SamplingRow } from './SamplingRow';
import { samplingFields } from './sampling';
import {PageHeader} from '../../components/ui/PageHeader';
import {Switch} from '../../components/ui/Switch';
import {Select} from '../../components/ui/Select';
import {Input,Textarea} from '../../components/ui/Field';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronRight, Copy, FileText, GripVertical, Layers3, LockKeyhole, MoreHorizontal, Plus, SlidersHorizontal, Star, Trash2, Undo2 } from 'lucide-react';
import { Button,IconButton,UploadButton } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import type { ContextStrategy, PresetNode, PresetThinkingLevel, WebPreset } from './types';
import { getPresetValidationError, usePresetStore } from './PresetStore';
import { PromptEditorDialog } from './PromptEditorDialog';
import { presetMenuPlacement } from './menu-placement';
import type { PromptValue } from './PromptEditorDialog';
import styles from './Presets.module.css';

const THINKING_LEVELS: { value: PresetThinkingLevel; label: string }[] = [
  { value: 'minimal', label: '极低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中等' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '更高' },
  { value: 'max', label: '最高' },
];
const STRATEGIES: { id: ContextStrategy; label: string; hint: string }[] = [
  { id: 'rolling_summary', label: '滚动摘要', hint: '整理较早对话，保留最近内容。' },
  { id: 'sliding_window', label: '滑动窗口', hint: '保留最近对话，移出较早内容。' },
];
// Primary: node order and prompt content. Save remains the single primary action.
// Reuse Presets.module.css spacing, typography and Web theme tokens.
type Dialog = { kind: 'reloadPreset' } | { kind: 'summary' } | { kind: 'node'; node: PresetNode; isNew: boolean; insertAt?: number } | { kind: 'deletePreset' } | { kind: 'deleteNode'; node: PresetNode };
type DropTarget = { id: string; after: boolean };
type Drag = { id: string; pointerId: number; startY: number; x: number; y: number; active: boolean; target: DropTarget | null; frame: number; handle: HTMLButtonElement; dispose: () => void };

function roleLabel(role: string) {
  return role === 'auto' ? '原始角色' : role.charAt(0).toUpperCase() + role.slice(1);
}


export function PresetLibraryPage() {
  const store = usePresetStore();
  const { presets, draftById, defaultPresetId, isDirty, editPreset, savePreset, revertPreset, createPreset, duplicatePreset, deletePreset, setDefaultPreset, getDefaultPrompt } = store;
  const { presetId } = useParams<{ presetId?: string }>();
  const selectedId = presetId ?? defaultPresetId ?? presets[0]?.id;
  const preset = selectedId && Object.hasOwn(draftById, selectedId) ? draftById[selectedId] : undefined;
  useEffect(()=>{if(selectedId)void store.loadDetail(selectedId);},[selectedId,store.loadDetail]);
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
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
    if (!error) return;
    setStatus('');
    contentRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [error]);
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(''), 3200);
    return () => window.clearTimeout(timer);
  }, [status]);
  useLayoutEffect(() => {
    const panel = menuPanelRef.current, anchor = panel?.parentElement;
    const boundary = menu === 'preset' ? contentRef.current?.parentElement : contentRef.current;
    if (!menu || !panel || !anchor || !boundary) return;
    const place = () => {
      const viewport = window.visualViewport, top = viewport?.offsetTop ?? 0;
      const height = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
      const position = presetMenuPlacement(anchor.getBoundingClientRect(), boundary.getBoundingClientRect(),
        {top, bottom: top + (viewport?.height ?? innerHeight)}, height);
      if (!position) {setMenu(null); return;}
      panel.dataset.placement = position.above ? 'above' : 'below';
      panel.style.maxHeight = position.maxHeight + 'px';
    };
    const scroll = (event: Event) => {if (!panel.contains(event.target as Node)) place();};
    place();
    const observer = new ResizeObserver(place); observer.observe(anchor); observer.observe(boundary);
    window.addEventListener('resize', place); window.addEventListener('scroll', scroll, true);
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', scroll, true);
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [menu]);
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

  function update(patch: Partial<WebPreset>) {
    if (preset) editPreset(preset.id, current => ({ ...current, ...patch }));
    setError('');
  }
  async function perform(fn:()=>Promise<unknown>){try{await fn();}catch(error){setError(error instanceof Error?error.message:'操作失败');}}
  async function save(event: FormEvent) {
    event.preventDefault();if(!preset)return;
    const validation=getPresetValidationError(preset);if(validation){setError(validation);return;}
    await perform(async()=>{await savePreset(preset.id);setError('');setStatus('预设已保存');});
  }
  function select(id:string){navigate('/presets/'+encodeURIComponent(id));}
  function create(){void perform(async()=>{const id=await createPreset();select(id);requestAnimationFrame(()=>nameRef.current?.select());});}
  function changeNode(id: string, transform: (node: PresetNode) => PresetNode) {
    if (preset) editPreset(preset.id, current => ({ ...current, nodes: current.nodes.map(node => node.id === id ? transform(node) : node) }));
  }
  function moveNode(id: string, offset: number) {
    if (!preset) return;
    const from = preset.nodes.findIndex(node => node.id === id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= preset.nodes.length || preset.nodes[from].kind !== 'text') return;
    const next = [...preset.nodes];
    const [node] = next.splice(from, 1); next.splice(to, 0, node);
    update({ nodes: next });
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
    const rows = [...(groupRef.current?.querySelectorAll<HTMLElement>('[data-preset-node]') ?? [])].filter(row => row.dataset.presetNode !== id);
    if (!rows.length) return null;
    const before = rows.find(row => y < row.getBoundingClientRect().top + row.offsetHeight / 2);
    return before ? { id: before.dataset.presetNode!, after: false } : { id: rows.at(-1)!.dataset.presetNode!, after: true };
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
    // release lands outside the handle/node list.
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
      const nodes = preset.nodes.filter(node => node.id !== current.id);
      const item = preset.nodes.find(node => node.id === current.id);
      const targetIndex = nodes.findIndex(node => node.id === target.id);
      if (item?.kind === 'text' && targetIndex >= 0) {
        nodes.splice(targetIndex + (target.after ? 1 : 0), 0, item);
        update({ nodes }); setStatus('节点顺序已更新');
      }
    }
    setDragId(null); setDrop(null);
  }
  function openCustom(insertAt = preset?.nodes.length ?? 0) {
    setDialog({ kind: 'node', isNew: true, insertAt, node: {
      id: globalThis.crypto?.randomUUID?.() ?? 'node-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
      name: '', kind: 'text', role: 'system', prompt: '', enabled: true,
    } });
  }
  function nodeRow(node: PresetNode, index: number) {
    const custom = node.kind === 'text', optional = node.kind === 'postprocess', menuKey = 'node:' + node.id;
    return <div className={styles.nodeRow} key={node.id} data-preset-node={node.id}
      data-custom-node={custom ? node.id : undefined} data-disabled={!node.enabled}
      data-dragging={dragId === node.id} data-drop={drop?.id === node.id ? (drop.after ? 'after' : 'before') : undefined}>
      {custom ? <button type="button" className={styles.dragHandle} aria-label={'拖动节点：' + node.name} title="拖动排序，或使用方向键上移、下移"
        onPointerDown={event => beginDrag(event, node.id)}
        onKeyDown={event => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {event.preventDefault(); cancelCurrentDrag(); moveNode(node.id, event.key === 'ArrowUp' ? -1 : 1);}
          if (event.key === 'Escape' && drag.current) {event.preventDefault(); cancelCurrentDrag();}
        }}><GripVertical size={16} /></button>
        : <span className={styles.nodeLead} aria-hidden="true">{node.id === 'main' ? <SlidersHorizontal size={16} /> : <FileText size={16} />}</span>}
      <button type="button" className={styles.nodeMain} aria-label={node.id === 'main' ? '编辑叙事风格' : '编辑节点：' + node.name}
        onClick={() => setDialog({kind: 'node', node, isNew: false})}>
        <span title={node.name}>{node.name}</span>
        <small>{roleLabel(node.role)} · {custom ? '自定义' : optional ? '后置处理' : '始终启用'}{!node.enabled && ' · 已关闭'}</small>
      </button>
      {custom || optional
        ? <Switch checked={node.enabled} label={custom ? '启用节点：' + node.name : '启用' + node.name}
          onChange={() => changeNode(node.id, current => ({...current, enabled: !current.enabled}))} />
        : <span className={styles.nodeFixed} title="始终启用" aria-hidden="true"><LockKeyhole size={14} /></span>}
      <div className={styles.menuAnchor} data-preset-menu>
        <IconButton size="compact" icon={<MoreHorizontal size={16}/>} aria-label={'更多节点操作：' + node.name} aria-expanded={menu === menuKey} data-menu-trigger={menuKey} onClick={() => setMenu(menu === menuKey ? null : menuKey)}/>
        {menu === menuKey && <div ref={menuPanelRef} className={styles.menuPanel} role="group" aria-label="节点操作">
          {custom && <>
            <button type="button" autoFocus disabled={index === 0} onClick={() => moveNode(node.id, -1)}><ArrowUp size={14} />上移</button>
            <button type="button" disabled={index === preset!.nodes.length - 1} onClick={() => moveNode(node.id, 1)}><ArrowDown size={14} />下移</button>
            <div className={styles.menuDivider} />
          </>}
          <button type="button" autoFocus={!custom} onClick={() => {focusMenuTrigger(menuKey); setMenu(null); openCustom(index);}}><Plus size={14} />在上方插入</button>
          <button type="button" onClick={() => {focusMenuTrigger(menuKey); setMenu(null); openCustom(index + 1);}}><Plus size={14} />在下方插入</button>
          {custom && <>
            <div className={styles.menuDivider} />
            <button type="button" onClick={() => {focusMenuTrigger(menuKey); setDialog({kind: 'deleteNode', node}); setMenu(null);}}><Trash2 size={14} />删除节点</button>
          </>}
        </div>}
      </div>
    </div>;
  }

  function applyPrompt(value: PromptValue) {
    if (!preset || !dialog) return;
    if (dialog.kind === 'summary') update({ summaryPrompt: value.prompt });
    if (dialog.kind === 'node') {
      const next = dialog.node.kind === 'text' ? {...dialog.node, ...value} : {...dialog.node, prompt: value.prompt};
      if (dialog.isNew) {
        const nodes = [...preset.nodes];
        nodes.splice(dialog.insertAt ?? nodes.length, 0, next);
        update({nodes});
        requestAnimationFrame(() => groupRef.current?.querySelector<HTMLElement>('[data-preset-node="' + CSS.escape(next.id) + '"]')?.scrollIntoView({
          block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        }));
      } else changeNode(next.id, () => next);
    }
  }

  return <section className={styles.page} data-preset-workspace data-detail={!!presetId}>
    <PageHeader title="预设" className={styles.pageHeader} identityClassName={styles.pageIdentity} actions={<>
      <UploadButton aria-label="导入预设" accept=".json,application/json" disabled={store.busy} onChange={event=>{const file=event.target.files?.[0];if(file)void perform(async()=>select(await store.importPreset(await file.text())));}}>导入</UploadButton>
      <Button variant={presetId?'secondary':'primary'} disabled={store.busy} aria-label="新建预设" icon={<Plus size={16}/>} onClick={create}>新建预设</Button>
    </>}/>

    <div className={styles.workspace}>
      <section className={styles.library} aria-label="预设库">{store.loading&&<p role="status">正在加载预设…</p>}{store.error&&<p role="alert">{store.error}<button onClick={()=>void store.reload()}>重试</button></p>}
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
            <Button size="compact" variant="ghost" onClick={create}>创建第一个预设</Button>
          </div>}
        </div>
      </section>

      <section className={styles.editor} aria-label="预设配置">
        {selectedId&&store.detailsLoading[selectedId]&&<p role="status">正在加载预设详情…</p>}
        {selectedId&&store.detailErrors[selectedId]&&<p role="alert">{store.detailErrors[selectedId]}<Button onClick={()=>void store.loadDetail(selectedId,true)}>重试</Button></p>}
        {preset&&store.conflicts[preset.id]&&<div role="alert"><p>预设已被其他操作修改。草稿已保留，可复制为新预设或读取服务端版本。</p><Button onClick={()=>setDialog({kind:'reloadPreset'})}>读取服务端版本</Button></div>}
        <div className={styles.editorHeader}>
          <button type="button" className={styles.listBack} aria-label="返回预设列表" onClick={() => navigate('/presets')}><ArrowLeft size={16} /><span>预设列表</span></button>
          {preset && <>
            <div className={styles.editorIdentity}><h2 title={preset.name}>{preset.name || '未命名预设'}</h2>
              <span className={styles.saveState} data-dirty={dirty}>{dirty ? <><span className={styles.dirtyDot} />未保存</> : <><Check size={12} />已保存</>}</span>
            </div>
            <div className={styles.editorActions}>
              <div className={styles.menuAnchor} data-preset-menu>
                <IconButton icon={<MoreHorizontal size={19}/>} aria-label="更多预设操作" aria-expanded={menu === 'preset'} data-menu-trigger="preset" onClick={() => setMenu(menu === 'preset' ? null : 'preset')}/>
                {menu === 'preset' && <div ref={menuPanelRef} className={styles.menuPanel} role="group" aria-label="预设操作">
                  <button type="button" autoFocus disabled={preset.id === defaultPresetId} onClick={() => { void perform(async()=>{await setDefaultPreset(preset.id);closeMenu('preset');setStatus('已设为默认预设');}); }}><Star size={14} />设为默认</button>
                  <button type="button" onClick={() => { void perform(async()=>{const id=await duplicatePreset(preset.id);setMenu(null);select(id);}); }}><Copy size={14} />复制预设</button>
                  <button type="button" disabled={!dirty} onClick={() => { revertPreset(preset.id); closeMenu('preset'); setError(''); setStatus('已恢复保存的版本'); }}><Undo2 size={14} />放弃更改</button>
                  <a href={'/api/v1/presets/'+encodeURIComponent(preset.id)+'/export'}>导出已保存预设</a><div className={styles.menuDivider} />
                  <button type="button" onClick={() => { focusMenuTrigger('preset'); setDialog({ kind: 'deletePreset' }); setMenu(null); }}><Trash2 size={14} />删除预设</button>
                </div>}
              </div>
              <Button type="submit" form={formId} variant="primary" aria-label="保存预设" disabled={!dirty||store.busy}>保存预设</Button>
            </div>
          </>}
        </div>
        {preset ? <form id={formId} key={preset.id} ref={contentRef} noValidate onSubmit={save} className={styles.editorContent} data-preset-content tabIndex={0} aria-label="预设配置内容">
          {error && <p className={styles.formError} role="alert">{error}</p>}
          <section className={styles.formSection} aria-labelledby={formId + '-basic'} data-preset-section="basic">
            <div className={styles.sectionHeading}><h3 id={formId + '-basic'}>基本信息</h3></div>
            <div className={styles.basicFields}>
              <label className={styles.field}>预设名称<Input ref={nameRef} aria-label="预设名称" required value={preset.name} onChange={event => update({ name: event.target.value })} /></label>
              <label className={styles.field}>预设描述<Input aria-label="预设描述" placeholder="简短描述这个预设的叙事方式" value={preset.description} onChange={event => update({ description: event.target.value })} /></label>
            </div>
          </section>
          <section className={styles.formSection} aria-labelledby={formId + '-model'} data-preset-section="model">
            <div className={styles.sectionHeading}><h3 id={formId + '-model'}>模型参数</h3></div>
            <p className={styles.samplingHint}>预设可跨模型使用。调用时仅应用当前模型支持的值。</p>
            <div className={styles.settingsGroup}>
              {samplingFields.map(field => <SamplingRow key={field.key} field={field} value={preset[field.key]}
                onChange={value => update({ [field.key]: value })} />)}
              <div className={styles.parameterRow}>
                <div className={styles.settingCopy}>
                  <label htmlFor={formId + '-thinking'}>深度思考</label>
                  <p id={formId + '-thinking-help'}>对支持思考的模型生效，通常需要更长时间。</p>
                </div>
                <Switch id={formId + '-thinking'} checked={preset.thinkingEnabled} label="开启深度思考" describedBy={formId + '-thinking-help'} onChange={() => update({ thinkingEnabled: !preset.thinkingEnabled })} />
              </div>
              <div className={styles.parameterRow}>
                <div className={styles.settingCopy}>
                  <label htmlFor={formId + '-thinking-level'}>思考深度</label>
                  <p id={formId + '-thinking-level-help'}>开启深度思考后生效；不支持所选级别时使用默认深度。</p>
                </div>
                <Select className={styles.parameterInput} id={formId + '-thinking-level'} aria-label="思考深度" aria-describedby={formId + '-thinking-level-help'} disabled={!preset.thinkingEnabled} value={preset.thinkingLevel??''} onChange={event => update({ thinkingLevel: event.target.value ? event.target.value as PresetThinkingLevel : undefined })}>
                  <option value="">默认</option>
                  {THINKING_LEVELS.map(level => <option key={level.value} value={level.value}>{level.label}</option>)}
                </Select>
              </div>
            </div>
          </section>
          <section className={styles.formSection} aria-labelledby={formId + '-context'} data-preset-section="context">
            <div className={styles.sectionHeading}><h3 id={formId + '-context'}>上下文</h3></div>
            <fieldset className={styles.strategyField}><legend>历史整理方式</legend>
              <div className={styles.strategies}>{STRATEGIES.map(strategy => <label key={strategy.id} className={styles.strategyChoice}>
                <input type="radio" name={'strategy-' + preset.id} value={strategy.id} checked={preset.contextStrategy === strategy.id} onChange={() => update({ contextStrategy: strategy.id })} />
                <span className={styles.strategyBody}>
                  <span className={styles.strategyTitle}><strong>{strategy.label}</strong><span className={styles.strategyCheck} aria-hidden="true"><Check size={12} /></span></span>
                  <small>{strategy.hint}</small>
                </span>
              </label>)}</div>
            </fieldset>
            <div className={styles.budgetRow}>
              <label className={styles.field}>最大上下文输入<div className={styles.numberField}><Input aria-label="最大上下文输入" type="number" required min={2} step={1} value={preset.maxContextTokens || ''} onChange={event => update({ maxContextTokens: Number(event.target.value) })} /><span>tokens</span></div></label>
              <label className={styles.field}>最大输出长度<div className={styles.numberField}><Input aria-label="最大输出长度" type="number" required min={1} step={1} value={preset.maxOutputTokens || ''} onChange={event => update({ maxOutputTokens: Number(event.target.value) })} /><span>tokens</span></div></label>
            </div>
            <button type="button" className={styles.summaryButton} onClick={() => setDialog({ kind: 'summary' })}>
              <FileText size={16} aria-hidden="true" /><span><strong>压缩提示词</strong><small>{preset.contextStrategy === 'sliding_window' ? '滑动窗口不使用摘要' : '编辑整理历史时使用的提示词'}</small></span><ChevronRight size={16} aria-hidden="true" />
            </button>
          </section>
          <section className={styles.formSection} aria-labelledby={formId + '-nodes'} data-preset-section="nodes">
            <div className={styles.sectionHeading}>
              <h3 id={formId + '-nodes'}>提示词编排</h3>
              <Button size="compact" variant="ghost" icon={<Plus size={15}/>} aria-label="添加自定义节点" onClick={() => openCustom()}>自定义节点</Button>
            </div>
            <div className={styles.nodeStack} ref={groupRef} data-preset-nodes>
              {preset.nodes.map(nodeRow)}
            </div>
            <p className={styles.fieldHelp}>按列表顺序构建提示词。自定义节点可插入任意位置，系统节点保持先后顺序。</p>
          </section>
        </form> : <div className={styles.emptyEditor}><Layers3 size={32} /><h2>{presetId ? '找不到这个预设' : '从一个预设开始'}</h2><p>{presetId ? '预设可能已被删除，请返回列表选择。' : '创建预设，设置你的叙事风格。'}</p><Button onClick={presetId ? () => navigate('/presets') : create}>{presetId ? '返回预设列表' : '新建预设'}</Button></div>}
      </section>
    </div>
    <div className={styles.srOnly} role="status" aria-live="polite">{status}</div>
    {status && <div className={styles.toast} aria-hidden="true"><Check size={14} />{status}</div>}

    {preset && dialog && (dialog.kind === 'summary' || dialog.kind === 'node') && <PromptEditorDialog
      key={dialog.kind === 'node' ? dialog.node.id : dialog.kind}
      title={dialog.kind === 'summary' ? '压缩提示词' : dialog.isNew ? '添加自定义节点' : dialog.node.name}
      metadata={dialog.kind === 'node' && dialog.node.kind === 'text'}
      nodeId={dialog.kind === 'node' ? dialog.node.id : undefined}
      initialValue={dialog.kind === 'node' ? dialog.node : {name: '', role: 'system', prompt: preset.summaryPrompt}}
      description={dialog.kind === 'summary' ? '整理较早的故事内容，保留人物关系、关键事件与尚未完成的线索。'
        : dialog.node.kind === 'text' ? '设置消息角色，编写提示词并插入所需的系统变量。' : '编辑此节点的提示词，系统变量会在每轮生成时填入。'}
      onRestore={dialog.kind === 'node' && dialog.node.kind !== 'text' ? () => getDefaultPrompt(dialog.node.id) : undefined}
      onApply={applyPrompt} onClose={() => setDialog(null)} />}
    {preset&&dialog?.kind==='reloadPreset'&&<Modal title="读取服务端版本" onClose={()=>setDialog(null)} footer={<><Button onClick={()=>setDialog(null)}>取消</Button><Button variant="primary" onClick={()=>{void store.loadDetail(preset.id,true);setDialog(null);setError('');}}>放弃草稿并读取</Button></>}><p>此预设未保存的编辑将被替换。需要保留时，请先复制预设。</p></Modal>}
    {preset && dialog?.kind === 'deletePreset'  && <Modal title="删除预设" onClose={() => setDialog(null)}
      footer={<div className={styles.dialogActions}><Button onClick={() => setDialog(null)}>取消</Button><Button variant="primary" intent="danger" onClick={() => {
        const remaining = presets.filter(item => item.id !== preset.id);
        const next = remaining[Math.min(presets.findIndex(item => item.id === preset.id), remaining.length - 1)];
        void perform(async()=>{await deletePreset(preset.id);setDialog(null);navigate(next?'/presets/'+next.id:'/presets');setStatus('预设已删除');});
      }}>删除预设</Button></div>}>
      {error&&<p role="alert">{error}</p>}<p>删除“{preset.name}”及其编辑草稿？</p>{preset.id === defaultPresetId && <p>当前为默认项，请先在设置中更换默认预设。被世界或会话引用的预设不能删除。</p>}
    </Modal>}
    {preset && dialog?.kind === 'deleteNode' && <Modal title="删除节点" onClose={() => setDialog(null)}
      footer={<div className={styles.dialogActions}><Button onClick={() => setDialog(null)}>取消</Button><Button variant="primary" intent="danger" onClick={() => {
        const index = preset.nodes.findIndex(node => node.id === dialog.node.id);
        const remaining = preset.nodes.filter(node => node.id !== dialog.node.id);
        const next = remaining[index] ?? remaining.at(-1);
        update({ nodes: remaining }); setDialog(null);
        requestAnimationFrame(() => {
          const target = next
            ? groupRef.current?.querySelector<HTMLButtonElement>('[data-preset-node="' + CSS.escape(next.id) + '"] button[aria-label^="编辑"]')
            : document.querySelector<HTMLButtonElement>('button[aria-label="添加自定义节点"]');
          target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        });
      }}>删除节点</Button></div>}>
      <p>从当前预设中删除“{dialog.node.name}”？保存预设后生效。</p>
    </Modal>}
  </section>;
}
