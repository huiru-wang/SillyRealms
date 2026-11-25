import {errorMessage} from '../../i18n/errors.ts';
import {i18n} from '../../i18n/instance.ts';
import {useTranslation} from 'react-i18next';
import {useManagement} from '../../app/ManagementData';
import {usePagedResource} from '../../data';
import type {ModelConfig} from '../models/types';
import type {PresetType} from './types';
import { SamplingRow } from './SamplingRow';
import { samplingFields } from './sampling';
import {PageHeader} from '../../components/ui/PageHeader';
import {Switch} from '../../components/ui/Switch';
import {Select} from '../../components/ui/Select';
import {Badge,Input,Textarea} from '../../components/ui/Field';
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

// Primary: node order and prompt content. Save remains the single primary action.
// Reuse Presets.module.css spacing, typography and Web theme tokens.
type Dialog = { kind: 'createPreset' } | { kind: 'reloadPreset' } | { kind: 'summary' } | { kind: 'node'; node: PresetNode; isNew: boolean; insertAt?: number } | { kind: 'deletePreset' } | { kind: 'deleteNode'; node: PresetNode };
type DropTarget = { id: string; after: boolean };
type Drag = { id: string; pointerId: number; startY: number; x: number; y: number; active: boolean; target: DropTarget | null; frame: number; handle: HTMLButtonElement; dispose: () => void };

function roleLabel(role: string) {
  return role === 'auto' ? i18n.t('presets:originalRoles') : role.charAt(0).toUpperCase() + role.slice(1);
}

export function PresetLibraryPage() {
  const {t} = useTranslation('presets');
  const STRATEGIES: { id: ContextStrategy; label: string; hint: string }[] = [
  { id: 'rolling_summary', label: t('rollingSummary'), hint: t('summarizeEarlierConversationAndKeepRecentTurns') },
  { id: 'sliding_window', label: t('slidingWindow'), hint: t('keepRecentTurnsAndRemoveEarlierOnes') },
];
  const THINKING_LEVELS: { value: PresetThinkingLevel; label: string }[] = [
  { value: 'minimal', label: t('minimal') },
  { value: 'low', label: t('low') },
  { value: 'medium', label: t('medium') },
  { value: 'high', label: t('high') },
  { value: 'xhigh', label: t('extraHigh') },
  { value: 'max', label: t('maximum') },
];
  const store = usePresetStore();
  const { draftById, isDirty, editPreset, savePreset, revertPreset, createPreset, duplicatePreset, deletePreset, setDefaultPreset, getDefaultPrompt } = store;
  const { presetId } = useParams<{ presetId?: string }>();
  const presets = [...store.presets, ...store.replyPresets].sort((a,b)=>b.updatedAt-a.updatedAt || a.id.localeCompare(b.id));
  const loading = store.loading || store.replyCatalog.loading;
  const {modelsRevision}=useManagement();
  const models=usePagedResource<ModelConfig>('v1/api-model-configs?limit=100',modelsRevision,true);
  const selectedId = presetId ?? store.defaultPresetId ?? store.replyDefaultId ?? presets[0]?.id;
  const preset = selectedId && Object.hasOwn(draftById, selectedId) ? draftById[selectedId] : undefined;
  const type = preset?.type ?? presets.find(item=>item.id===selectedId)?.type ?? 'narrative';
  const reply = type === 'reply_assist';
  const defaultPresetId = reply ? store.replyDefaultId : store.defaultPresetId;
  useEffect(()=>{if(selectedId)void store.loadDetail(selectedId);},[selectedId,store.loadDetail]);
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{key:string;values?:Record<string,string|number>}|null>(null);
  const statusText = status ? t(status.key,status.values ?? {}) : '';
  const [error, setError] = useState<Error|string>('');
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
    setDialog(null); setMenu(null); setError(''); setStatus(null);
    return () => { if (element && selectedId) positions.current.set(selectedId, element.scrollTop); };
  }, [selectedId]);
  useEffect(() => {
    if (!error) return;
    setStatus(null);
    contentRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [error]);
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), 3200);
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
  async function perform(fn:()=>Promise<unknown>){try{await fn();}catch(error){setError(error instanceof Error?error:t('operationFailed'));}}
  async function save(event: FormEvent) {
    event.preventDefault();if(!preset)return;
    const validation=getPresetValidationError(preset);if(validation){setError(validation);return;}
    await perform(async()=>{await savePreset(preset.id);setError('');setStatus({key:'presetSaved'});});
  }
  function select(id:string){navigate('/presets/'+encodeURIComponent(id));}
  function create(){setError('');setDialog({kind:'createPreset'});}
  function createForType(type:PresetType){void perform(async()=>{const id=await createPreset(type);setDialog(null);select(id);requestAnimationFrame(()=>nameRef.current?.select());});}
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
    setStatus({key:'nodeMoved',values:{name:node.name,position:to+1}});
    setMenu(null);
    requestAnimationFrame(() => {
      const moved = groupRef.current?.querySelector<HTMLElement>('[data-custom-node="' + CSS.escape(id) + '"]');
      moved?.querySelector<HTMLButtonElement>('button[data-node-drag-handle]')?.focus({ preventScroll: true });
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
        update({ nodes }); setStatus({key:'nodeOrderUpdated'});
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
      {custom ? <button type="button" className={styles.dragHandle} data-node-drag-handle aria-label={t('presets:dragNode',{name:node.name})} title={t('dragToReorderOrUseTheArrow')}
        onPointerDown={event => beginDrag(event, node.id)}
        onKeyDown={event => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {event.preventDefault(); cancelCurrentDrag(); moveNode(node.id, event.key === 'ArrowUp' ? -1 : 1);}
          if (event.key === 'Escape' && drag.current) {event.preventDefault(); cancelCurrentDrag();}
        }}><GripVertical size={16} /></button>
        : <span className={styles.nodeLead} aria-hidden="true">{node.id === 'main' ? <SlidersHorizontal size={16} /> : <FileText size={16} />}</span>}
      <button type="button" className={styles.nodeMain} data-node-edit aria-label={node.id === 'main' ? t('presets:editNarrativeStyle') : t('presets:editNode',{name:node.name})}
        onClick={() => setDialog({kind: 'node', node, isNew: false})}>
        <span title={node.name}>{node.name}</span>
        <small>{roleLabel(node.role)} · {custom ? t('custom') : optional ? t('postprocessing') : reply && node.id !== 'main' ? t('sessions:optional') : t('alwaysEnabled')}{!node.enabled && t('disabled')}</small>
      </button>
      {custom || optional || (reply && node.id !== 'main')
        ? <Switch checked={node.enabled} label={t('presets:enableNode',{name:node.name})}
          onChange={() => changeNode(node.id, current => ({...current, enabled: !current.enabled}))} />
        : <span className={styles.nodeFixed} title={t('alwaysEnabled')} aria-hidden="true"><LockKeyhole size={14} /></span>}
      <div className={styles.menuAnchor} data-preset-menu>
        <IconButton size="compact" icon={<MoreHorizontal size={16}/>} aria-label={t('presets:moreNodeActions',{name:node.name})} aria-expanded={menu === menuKey} data-menu-trigger={menuKey} onClick={() => setMenu(menu === menuKey ? null : menuKey)}/>
        {menu === menuKey && <div ref={menuPanelRef} className={styles.menuPanel} role="group" aria-label={t('nodeActions')}>
          {custom && <>
            <button type="button" autoFocus disabled={index === 0} onClick={() => moveNode(node.id, -1)}><ArrowUp size={14} />{t('moveUp')}</button>
            <button type="button" disabled={index === preset!.nodes.length - 1} onClick={() => moveNode(node.id, 1)}><ArrowDown size={14} />{t('moveDown')}</button>
            <div className={styles.menuDivider} />
          </>}
          <button type="button" autoFocus={!custom} onClick={() => {focusMenuTrigger(menuKey); setMenu(null); openCustom(index);}}><Plus size={14} />{t('insertAbove')}</button>
          <button type="button" onClick={() => {focusMenuTrigger(menuKey); setMenu(null); openCustom(index + 1);}}><Plus size={14} />{t('insertBelow')}</button>
          {custom && <>
            <div className={styles.menuDivider} />
            <button type="button" onClick={() => {focusMenuTrigger(menuKey); setDialog({kind: 'deleteNode', node}); setMenu(null);}}><Trash2 size={14} />{t('deleteNode')}</button>
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
    <PageHeader title={t('presets')} className={styles.pageHeader} identityClassName={styles.pageIdentity} actions={<>

      <UploadButton aria-label={t('importPreset')} accept=".json,application/json" disabled={store.busy} onChange={event=>{const file=event.target.files?.[0];if(file)void perform(async()=>select(await store.importPreset(await file.text())));}}>{t('import')}</UploadButton>
      <Button variant={presetId?'secondary':'primary'} disabled={store.busy} aria-label={t('newPreset')} icon={<Plus size={16}/>} onClick={create}>{t('newPreset')}</Button>
    </>}/>

    <div className={styles.workspace}>
      <section className={styles.library} aria-label={t('presetLibrary')}>
        {loading&&<p role="status">{t('loadingPresets')}</p>}
        {store.error&&<p role="alert">{t('sessions:narrativePreset')}: {errorMessage(store.error)}<Button size="compact" onClick={()=>store.reload()}>{t('retry')}</Button></p>}
        {store.replyCatalog.error&&<p role="alert">{t('sessions:assistPreset')}: {errorMessage(store.replyCatalog.error)}<Button size="compact" onClick={()=>store.replyCatalog.reload()}>{t('retry')}</Button></p>}
        <div className={styles.presetList} data-preset-list tabIndex={0} aria-label={t('presetList')}>
          {presets.map(item => <button key={item.id} type="button" className={styles.presetItem}
            data-preset-item={item.id} aria-pressed={item.id === selectedId} onClick={() => select(item.id)}>
            <span className={styles.itemHeading}><strong data-preset-title title={item.name}>{item.name || t('untitledPreset')}</strong>
              {isDirty(item.id) && <span className={styles.dirtyDot} title={t('unsaved')} aria-label={t('unsaved')} />}
              {item.id === (item.type === 'reply_assist' ? store.replyDefaultId : store.defaultPresetId) && <span className={styles.defaultState}>{t('default')}</span>}
            </span>
            <span className={styles.itemMeta}>
              <span data-preset-description className={styles.itemDescription} title={item.description || undefined}>{item.description || t('noDescription')}</span>
              <span className={styles.itemType}><Badge>{t(item.type === 'reply_assist' ? 'sessions:assistPreset' : 'sessions:narrativePreset')}</Badge></span>
            </span>
          </button>)}
          {!loading && !store.error && !store.replyCatalog.error && !presets.length && <div className={styles.emptyList}><Layers3 size={24} /><p>{t('noPresetsYet')}</p>
            <Button size="compact" variant="ghost" onClick={create}>{t('createYourFirstPreset')}</Button>
          </div>}
        </div>
      </section>

      <section className={styles.editor} aria-label={t('presetConfiguration')}>
        {selectedId&&store.detailsLoading[selectedId]&&<p role="status">{t('loadingPresetDetails')}</p>}
        {selectedId&&store.detailErrors[selectedId]&&<p role="alert">{errorMessage(store.detailErrors[selectedId])}<Button onClick={()=>void store.loadDetail(selectedId,true)}>{t('retry')}</Button></p>}
        {preset&&store.conflicts[preset.id]&&<div role="alert"><p>{t('thisPresetChangedElsewhereYourDraftIs')}</p><Button onClick={()=>setDialog({kind:'reloadPreset'})}>{t('loadServerVersion')}</Button></div>}
        <div className={styles.editorHeader}>
          <button type="button" className={styles.listBack} aria-label={t('backToPresets')} onClick={() => navigate('/presets')}><ArrowLeft size={16} /><span>{t('presetList')}</span></button>
          {preset && <>
            <div className={styles.editorIdentity}><h2 title={preset.name}>{preset.name || t('untitledPreset')}</h2>
              <span className={styles.saveState} data-dirty={dirty}>{dirty ? <><span className={styles.dirtyDot} />{t('unsaved')}</> : <><Check size={12} />{t('saved')}</>}</span>
            </div>
            <div className={styles.editorActions}>
              <div className={styles.menuAnchor} data-preset-menu>
                <IconButton icon={<MoreHorizontal size={19}/>} aria-label={t('morePresetActions')} aria-expanded={menu === 'preset'} data-menu-trigger="preset" onClick={() => setMenu(menu === 'preset' ? null : 'preset')}/>
                {menu === 'preset' && <div ref={menuPanelRef} className={styles.menuPanel} role="group" aria-label={t('presetActions')}>
                  <button type="button" autoFocus disabled={preset.id === defaultPresetId} onClick={() => { void perform(async()=>{await setDefaultPreset(preset.id);closeMenu('preset');setStatus({key:'setAsTheDefaultPreset'});}); }}><Star size={14} />{t('setAsDefault')}</button>
                  <button type="button" onClick={() => { void perform(async()=>{const id=await duplicatePreset(preset.id);setMenu(null);select(id);}); }}><Copy size={14} />{t('duplicatePreset')}</button>
                  <button type="button" disabled={!dirty} onClick={() => { revertPreset(preset.id); closeMenu('preset'); setError(''); setStatus({key:'restoredTheSavedVersion'}); }}><Undo2 size={14} />{t('discardChanges')}</button>
                  <a href={'/api/v1/presets/'+encodeURIComponent(preset.id)+'/export'}>{t('exportSavedPreset')}</a><div className={styles.menuDivider} />
                  <button type="button" onClick={() => { focusMenuTrigger('preset'); setDialog({ kind: 'deletePreset' }); setMenu(null); }}><Trash2 size={14} />{t('deletePreset')}</button>
                </div>}
              </div>
              <Button type="submit" form={formId} variant="primary" aria-label={t('savePreset')} disabled={!dirty||store.busy}>{t('savePreset')}</Button>
            </div>
          </>}
        </div>
        {preset ? <form id={formId} key={preset.id} ref={contentRef} noValidate onSubmit={save} className={styles.editorContent} data-preset-content tabIndex={0} aria-label={t('presetConfigurationContent')}>
          {error && <p className={styles.formError} role="alert">{errorMessage(error)}</p>}
          <section className={styles.formSection} aria-labelledby={formId + '-basic'} data-preset-section="basic">
            <div className={styles.sectionHeading}><h3 id={formId + '-basic'}>{t('basicInformation')}</h3></div>
            <div className={styles.basicFields}>
              <label className={styles.field}>{t('presetName')}<Input ref={nameRef} aria-label={t('presetName')} required value={preset.name} onChange={event => update({ name: event.target.value })} /></label>
              <label className={styles.field}>{t('presetDescription')}<Input aria-label={t('presetDescription')} placeholder={t('brieflyDescribeThisPresetSStorytellingStyle')} value={preset.description} onChange={event => update({ description: event.target.value })} /></label>
            </div>
          </section>
          <section className={styles.formSection} aria-labelledby={formId + '-model'} data-preset-section="model">
            <div className={styles.sectionHeading}><h3 id={formId + '-model'}>{t('modelParameters')}</h3></div>
            {reply ? <label className={styles.field}>{t('sessions:apiModel')}
              <Select aria-label={t('sessions:apiModel')} value={preset.apiModelConfigId??''} onChange={event=>update({apiModelConfigId:event.target.value||null})}>
                <option value="">{t('settings:unset')}</option>{preset.apiModelConfigId&&!models.page?.items.some(item=>item.id===preset.apiModelConfigId)&&<option value={preset.apiModelConfigId}>{t('sessions:currentModel')}</option>}{models.page?.items.map(model=><option key={model.id} value={model.id}>{model.name} · {model.modelId}</option>)}
              </Select></label> : <p className={styles.samplingHint}>{t('presetsCanBeUsedAcrossModelsOnly')}</p>}
            <div className={styles.settingsGroup}>
              {samplingFields.map(field => <SamplingRow key={field.key} field={field} value={preset[field.key]}
                onChange={value => update({ [field.key]: value })} />)}
              <div className={styles.parameterRow}>
                <div className={styles.settingCopy}>
                  <label htmlFor={formId + '-thinking'}>{t('reasoning')}</label>
                  <p id={formId + '-thinking-help'}>{t('appliesToModelsWithReasoningSupportAnd')}</p>
                </div>
                <Switch id={formId + '-thinking'} checked={preset.thinkingEnabled} label={t('enableReasoning')} describedBy={formId + '-thinking-help'} onChange={() => update({ thinkingEnabled: !preset.thinkingEnabled })} />
              </div>
              {preset.thinkingEnabled && <div className={styles.parameterRow}>
                <div className={styles.settingCopy}>
                  <label htmlFor={formId + '-thinking-level'}>{t('reasoningLevel')}</label>
                  <p id={formId + '-thinking-level-help'}>{t('appliesWhenReasoningIsEnabledUnsupportedLevels')}</p>
                </div>
                <Select className={styles.parameterInput} id={formId + '-thinking-level'} aria-label={t('reasoningLevel')} aria-describedby={formId + '-thinking-level-help'} value={preset.thinkingLevel??''} onChange={event => update({ thinkingLevel: event.target.value ? event.target.value as PresetThinkingLevel : undefined })}>
                  <option value="">{t('default')}</option>
                  {THINKING_LEVELS.map(level => <option key={level.value} value={level.value}>{level.label}</option>)}
                </Select>
              </div>}
            </div>
          </section>
          <section className={styles.formSection} aria-labelledby={formId + '-context'} data-preset-section="context">
            <div className={styles.sectionHeading}><h3 id={formId + '-context'}>{t('context')}</h3></div>
            {!reply && <fieldset className={styles.strategyField}><legend>{t('historyStrategy')}</legend>
              <div className={styles.strategies}>{STRATEGIES.map(strategy => <label key={strategy.id} className={styles.strategyChoice}>
                <input type="radio" name={'strategy-' + preset.id} value={strategy.id} checked={preset.contextStrategy === strategy.id} onChange={() => update({ contextStrategy: strategy.id })} />
                <span className={styles.strategyBody}>
                  <span className={styles.strategyTitle}><strong>{strategy.label}</strong><span className={styles.strategyCheck} aria-hidden="true"><Check size={12} /></span></span>
                  <small>{strategy.hint}</small>
                </span>
              </label>)}</div>
            </fieldset>}
            <div className={styles.budgetRow}>
              <label className={styles.field}>{t('maximumInputContext')}<div className={styles.numberField}><Input aria-label={t('maximumInputContext')} type="number" required min={2} step={1} value={preset.maxContextTokens || ''} onChange={event => update({ maxContextTokens: Number(event.target.value) })} /><span>tokens</span></div></label>
              <label className={styles.field}>{t('maximumOutputLength')}<div className={styles.numberField}><Input aria-label={t('maximumOutputLength')} type="number" required min={1} step={1} value={preset.maxOutputTokens || ''} onChange={event => update({ maxOutputTokens: Number(event.target.value) })} /><span>tokens</span></div></label>
            </div>
            {!reply && <button type="button" className={styles.summaryButton} onClick={() => setDialog({ kind: 'summary' })}>
              <FileText size={16} aria-hidden="true" /><span><strong>{t('summaryPrompt')}</strong><small>{preset.contextStrategy === 'sliding_window' ? t('slidingWindowsDoNotUseSummaries') : t('editThePromptUsedToSummarizeHistory')}</small></span><ChevronRight size={16} aria-hidden="true" />
            </button>}
          </section>
          <section className={styles.formSection} aria-labelledby={formId + '-nodes'} data-preset-section="nodes">
            <div className={styles.sectionHeading}>
              <h3 id={formId + '-nodes'}>{t('promptArrangement')}</h3>
              <Button size="compact" variant="ghost" icon={<Plus size={15}/>} data-add-node aria-label={t('addCustomNode')} onClick={() => openCustom()}>{t('customNode')}</Button>
            </div>
            <div className={styles.nodeStack} ref={groupRef} data-preset-nodes>
              {preset.nodes.map(nodeRow)}
            </div>
            <p className={styles.fieldHelp}>{t('promptsFollowTheListOrderCustomNodes')}</p>
          </section>
        </form> : <div className={styles.emptyEditor}><Layers3 size={32} /><h2>{presetId ? t('presetNotFound') : t('startWithAPreset')}</h2><p>{presetId ? t('thisPresetMayHaveBeenDeletedReturn') : t('createAPresetToDefineYourStorytelling')}</p><Button onClick={presetId ? () => navigate('/presets') : create}>{presetId ? t('backToPresets') : t('newPreset')}</Button></div>}
      </section>
    </div>
    <div className={styles.srOnly} role="status" aria-live="polite">{statusText}</div>
    {status && <div className={styles.toast} aria-hidden="true"><Check size={14} />{statusText}</div>}

    {dialog?.kind === 'createPreset' && <Modal title={t('newPreset')} onClose={()=>setDialog(null)} onBeforeClose={()=>!store.busy}
      footer={<Button disabled={store.busy} onClick={()=>setDialog(null)}>{t('cancel')}</Button>}>
      {error&&<p className={styles.formError} role="alert">{errorMessage(error)}</p>}
      <div className={styles.presetTypeChoices} role="group" aria-label={t('sessions:presetType')}>
        <Button disabled={store.busy} onClick={()=>createForType('narrative')}>{t('sessions:narrativePreset')}</Button>
        <Button disabled={store.busy} onClick={()=>createForType('reply_assist')}>{t('sessions:assistPreset')}</Button>
      </div>
    </Modal>}
    {preset && dialog && (dialog.kind === 'summary' || dialog.kind === 'node') && <PromptEditorDialog
      replyAssist={reply}
      key={dialog.kind === 'node' ? dialog.node.id : dialog.kind}
      title={dialog.kind === 'summary' ? t('summaryPrompt') : dialog.isNew ? t('addCustomNode') : dialog.node.name}
      metadata={dialog.kind === 'node' && dialog.node.kind === 'text'}
      nodeId={dialog.kind === 'node' ? dialog.node.id : undefined}
      initialValue={dialog.kind === 'node' ? dialog.node : {name: '', role: 'system', prompt: preset.summaryPrompt}}
      description={dialog.kind === 'summary' ? t('summarizeEarlierStoryContentWhilePreservingRelationships')
        : dialog.node.kind === 'text' ? t('chooseAMessageRoleWriteThePrompt') : t('editThisNodeSPromptSystemVariables')}
      onRestore={dialog.kind === 'node' && dialog.node.kind !== 'text' ? () => getDefaultPrompt(dialog.node.id,type) : undefined}
      onApply={applyPrompt} onClose={() => setDialog(null)} />}
    {preset&&dialog?.kind==='reloadPreset'&&<Modal title={t('loadServerVersion')} onClose={()=>setDialog(null)} footer={<><Button onClick={()=>setDialog(null)}>{t('cancel')}</Button><Button variant="primary" onClick={()=>{void store.loadDetail(preset.id,true);setDialog(null);setError('');}}>{t('discardDraftAndLoad')}</Button></>}><p>{t('unsavedEditsToThisPresetWillBe')}</p></Modal>}
    {preset && dialog?.kind === 'deletePreset'  && <Modal title={t('deletePreset')} onClose={() => setDialog(null)}
      footer={<div className={styles.dialogActions}><Button onClick={() => setDialog(null)}>{t('cancel')}</Button><Button variant="primary" intent="danger" onClick={() => {
        const remaining = presets.filter(item => item.id !== preset.id);
        const next = remaining[Math.min(presets.findIndex(item => item.id === preset.id), remaining.length - 1)];
        void perform(async()=>{await deletePreset(preset.id);setDialog(null);navigate(next?'/presets/'+next.id:'/presets');setStatus({key:'presetDeleted'});});
      }}>{t('deletePreset')}</Button></div>}>
      {error&&<p role="alert">{errorMessage(error)}</p>}<p>{t('presets:deleteConfirmation',{name:preset.name})}</p>{preset.id === defaultPresetId && <p>{t('changeTheDefaultPresetInSettingsFirst')}</p>}
    </Modal>}
    {preset && dialog?.kind === 'deleteNode' && <Modal title={t('deleteNode')} onClose={() => setDialog(null)}
      footer={<div className={styles.dialogActions}><Button onClick={() => setDialog(null)}>{t('cancel')}</Button><Button variant="primary" intent="danger" onClick={() => {
        const index = preset.nodes.findIndex(node => node.id === dialog.node.id);
        const remaining = preset.nodes.filter(node => node.id !== dialog.node.id);
        const next = remaining[index] ?? remaining.at(-1);
        update({ nodes: remaining }); setDialog(null);
        requestAnimationFrame(() => {
          const target = next
            ? groupRef.current?.querySelector<HTMLButtonElement>('[data-preset-node="' + CSS.escape(next.id) + '"] button[data-node-edit]')
            : document.querySelector<HTMLButtonElement>('button[data-add-node]');
          target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        });
      }}>{t('deleteNode')}</Button></div>}>
      <p>{t('presets:deleteNodeConfirmation',{name:dialog.node.name})}</p>
    </Modal>}
  </section>;
}
