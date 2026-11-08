import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Download, Play, Trash2 } from 'lucide-react';
import { WorldDocumentRenderer } from '@sillyrealms/sdk';
import { api, json } from '../../api';
import { WorldState } from '../../world-details';
import { OpeningStateInspector } from './OpeningStateInspector';
import { Empty, ErrorNotice, Loading, useLoad } from '../../app/ui';

type Character = { id: string; name: string; avatar?: string; description?: string; player_selectable?: boolean };
type Opening = { id: string; name: string; content: string; initial_state?: unknown };
type WorldData = { name: string; summary?: string; description?: string; cover?: string; tags?: string[]; characters: Character[]; openings: Opening[]; lorebook?: { entries?: Array<{ id: string; title?: string; content?: string; load?: { mode?: string } }> }; state?: any; message_render?: unknown; ui?: unknown };
type WorldItem = { id: string; data: WorldData; defaultPresetId: string | null; defaultApiModelConfigId: string | null };

/**
 * Product hierarchy (§2.1, §2.8):
 * Primary: start the world using inherited defaults and a preselected character/opening.
 * Secondary: browse story information. Tertiary: export, delete, edit future defaults.
 * Layout: full-width reading with configuration in its own tab; use existing design tokens.
 */
export function WorldDetailPage() {
  const { id } = useParams(); const navigate = useNavigate();
  const worldRequest = useLoad('v1/worlds/' + id);
  const presets = useLoad('v1/presets?limit=100');
  const models = useLoad('v1/api-model-configs');
  const defaults = useLoad('v1/app-settings');
  const [selected, setSelected] = useState(''), [openingId, setOpeningId] = useState('');
  const [tab, setTab] = useState<'intro' | 'opening' | 'lore' | 'state' | 'config'>('intro');
  const characterRail = useRef<HTMLDivElement>(null);
  const [character, setCharacter] = useState<Character | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [expanded, setExpanded] = useState('');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const closeInspector = useCallback(() => setInspectorOpen(false), []);
  const world: WorldItem | undefined = worldRequest.value?.item;
  const data = world?.data;
  useEffect(() => {
    if (!world) return;
    setSelected(world.data.characters?.find(c => c.player_selectable)?.id ?? '');
    setOpeningId(world.data.openings?.[0]?.id ?? '');
  }, [world?.id]);
  useEffect(() => { if (!character) return; const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCharacter(null); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [character]);

  if (!data || !world) return <main className="page">{worldRequest.error ? <ErrorNotice message={worldRequest.error} onRetry={worldRequest.reload} /> : <Loading text="正在打开世界…" />}</main>;

  const activeCharacter = data.characters.find(c => c.id === selected);
  const opening = data.openings.find(o => o.id === openingId);
  const openingIndex = data.openings.findIndex(o => o.id === openingId);
  const model = models.value?.items?.find((v: any) => v.id === world.defaultApiModelConfigId);
  const missingPreset = !world.defaultPresetId;
  const missingModel = !world.defaultApiModelConfigId;
  const invalidModel = !!world.defaultApiModelConfigId && !!models.value && !model?.credentialConfigured;
  const ready = !!activeCharacter && !!opening && !missingPreset && !missingModel && !invalidModel && !!models.value;
  const defaultPresetId = defaults.value?.item?.defaultPresetId as string | undefined;
  const defaultModelId = defaults.value?.item?.defaultApiModelConfigId as string | undefined;
  const canRepair = !!((missingPreset && defaultPresetId) || (missingModel && defaultModelId));

  const changeDefault = async (field: 'defaultPresetId' | 'defaultApiModelConfigId', value: string) => {
    setBusy(true); setMessage('');
    try { await api('v1/worlds/' + id, { method: 'PATCH', body: json({ [field]: value || null }) }); await worldRequest.reload(); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const repair = async () => {
    if (!canRepair) return; setBusy(true); setMessage('');
    try {
      const patch: any = {};
      if (missingPreset && defaultPresetId) patch.defaultPresetId = defaultPresetId;
      if (missingModel && defaultModelId) patch.defaultApiModelConfigId = defaultModelId;
      await api('v1/worlds/' + id, { method: 'PATCH', body: json(patch) });
      await worldRequest.reload();
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const start = async () => {
    if (!ready || busy) return; setBusy(true); setMessage('');
    try {
      const response = await api('v1/sessions', { method: 'POST', body: json({ worldId: id, openingId, userCharacterId: selected }) });
      navigate('/sessions/' + response.item.id);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); await worldRequest.reload(); }
    finally { setBusy(false); }
  };
  const deleteWorld = async () => {
    if (!confirm('删除此世界卡及其全部会话？此操作无法撤销。')) return;
    setBusy(true); try { await api('v1/worlds/' + id, { method: 'DELETE' }); navigate('/worlds'); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  const tabs = [['intro', '世界介绍'], ['opening', '开局'], ['lore', '世界书'], ['state', '世界状态'], ['config', '运行配置']] as const;
  return <main className="page world-detail-page">
    <div className="detail-back"><Link to="/worlds"><ArrowLeft size={16} /> 返回世界库</Link><span>/</span><span>{data.name}</span></div>
    <section className="world-detail-hero">
      <div className="world-detail-cover" style={data.cover ? { backgroundImage: `url(${JSON.stringify(data.cover)})` } : undefined}>{!data.cover && <BookOpen size={38} strokeWidth={1.3} />}</div>
      <div className="world-detail-headline"><h1>{data.name}</h1><p>{data.summary || '选择一个角色，开启属于你的故事。'}</p>
        <div className="inline-tags">{(data.tags ?? []).slice(0, 5).map(t => <span key={t}>{t}</span>)}</div>
      </div>
      <div className="world-detail-more"><a className="button tertiary" href={'/api/v1/worlds/' + id + '/export'}><Download size={15} /> 导出</a><button className="button icon-only" aria-label="删除世界卡" title="删除世界卡" disabled={busy} onClick={() => void deleteWorld()}><Trash2 size={16} /></button></div>
    </section>

    {data.characters.length > 0 && <section className="world-cast" aria-label="世界角色">
      <div className="world-cast-header">
        <div><h2>世界角色<span>{data.characters.length}</span></h2></div>
        <div className="world-cast-controls">
          <button className="icon-button" aria-label="向左查看角色" onClick={() => characterRail.current?.scrollBy({ left: -340, behavior: 'smooth' })}><ChevronLeft size={18} /></button>
          <button className="icon-button" aria-label="向右查看角色" onClick={() => characterRail.current?.scrollBy({ left: 340, behavior: 'smooth' })}><ChevronRight size={18} /></button>
        </div>
      </div>
      <div className="world-cast-rail" ref={characterRail} role="group" aria-label="左右滑动浏览角色" tabIndex={0}>
        {data.characters.map(c => <div className="world-cast-item" key={c.id}>
          <button type="button" className="world-cast-person" aria-pressed={c.player_selectable ? selected === c.id : undefined} aria-label={c.player_selectable ? `选择扮演${c.name}` : `查看${c.name}的角色详情`} onClick={() => c.player_selectable ? setSelected(c.id) : setCharacter(c)}>
            <span className="world-cast-portrait" style={c.avatar ? { backgroundImage: `url(${JSON.stringify(c.avatar)})` } : undefined}>{!c.avatar && <span>{c.name.slice(0, 1)}</span>}</span><strong title={c.name}>{c.name}</strong><small>{c.player_selectable ? (selected === c.id ? '已选择 · 可扮演' : '可扮演') : '故事角色'}</small>
          </button>{c.player_selectable && <button type="button" className="world-cast-detail" onClick={() => setCharacter(c)} aria-label={`查看${c.name}的角色详情`}>查看详情</button>}
        </div>)}
      </div>
    </section>}

    <div className="world-detail-columns">
      <section className="world-detail-reading">
        <nav className="detail-tabs" aria-label="世界详情">{tabs.map(([key, label]) => <button type="button" key={key} className={tab === key ? 'active' : ''} aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}>{label}</button>)}</nav>
        <div className="world-tab-surface">
          {tab === 'intro' && <WorldDocumentRenderer title="世界介绍" presentation="isolated" content={data.description || '这个世界还没有介绍。'} />}
          {tab === 'opening' && (opening ? <>
            <div className="opening-selector"><div className="opening-selector-title"><strong title={opening.name}>{opening.name}</strong></div><div className="opening-selector-controls"><button type="button" aria-label="上一个开局" disabled={openingIndex <= 0} onClick={() => setOpeningId(data.openings[openingIndex - 1].id)}><ChevronLeft size={17} /></button><span aria-live="polite">{openingIndex + 1} / {data.openings.length}</span><button type="button" aria-label="下一个开局" disabled={openingIndex >= data.openings.length - 1} onClick={() => setOpeningId(data.openings[openingIndex + 1].id)}><ChevronRight size={17} /></button></div></div>
            <button type="button" className="button tertiary opening-state-entry" onClick={() => setInspectorOpen(true)}>开局状态</button>
            <div className="opening-preview"><WorldDocumentRenderer title={opening.name} presentation="isolated" content={opening.content} /></div>
            {(!ready && !!models.value) && <div className="start-warning">{missingPreset || missingModel ? '请先在运行配置中选择预设和模型。' : invalidModel ? '模型凭据不可用，请先更新模型连接。' : '请先选择可扮演角色。'}{canRepair && <button onClick={() => void repair()} disabled={busy}>使用应用默认配置</button>}{invalidModel && <Link to="/providers">前往模型连接 <ArrowRight size={13} /></Link>}{(missingPreset || missingModel) && <button type="button" onClick={() => setTab('config')}>前往运行配置 <ArrowRight size={13} /></button>}</div>}
            {models.error && <ErrorNotice message={models.error} onRetry={models.reload} />}{message && <ErrorNotice message={message} />}
            <button className="button primary opening-start" disabled={!ready || busy} onClick={() => void start()}><Play size={17} fill="currentColor" />{busy ? '正在创建…' : '开始会话'}<ArrowRight size={17} /></button>
          </> : <Empty text="暂时没有开局内容" />)}

          {tab === 'lore' && <>{data.lorebook?.entries?.length ? data.lorebook.entries.map(l => <div className="lore" key={l.id}><button onClick={() => setExpanded(expanded === l.id ? '' : l.id)}><b>{l.title || l.id}</b><ChevronDown size={16} /></button>{expanded === l.id && <div className="lore-content"><WorldDocumentRenderer title={l.title || l.id} presentation="isolated" content={l.content || ''} /></div>}</div>) : <Empty text="还没有世界书条目" />}</>}
          {tab === 'state' && <WorldState state={data.state} hideHeading />}
          {tab === 'config' && <div className="world-config-tab"><h2>运行配置</h2><p>选择此世界新会话使用的预设和模型，已有会话不受影响。</p>{message && <ErrorNotice message={message} />}<div className="world-config-fields"><label>预设<select disabled={busy || !presets.value} value={world.defaultPresetId ?? ''} onChange={e => void changeDefault('defaultPresetId', e.target.value)}><option value="">未配置</option>{presets.value?.items?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>API 模型<select disabled={busy || !models.value} value={world.defaultApiModelConfigId ?? ''} onChange={e => void changeDefault('defaultApiModelConfigId', e.target.value)}><option value="">未配置</option>{models.value?.items?.map((m: any) => <option key={m.id} value={m.id}>{m.name} · {m.modelId}{m.credentialConfigured === false ? '（缺少密钥）' : ''}</option>)}</select></label></div>{presets.error && <ErrorNotice message={presets.error} onRetry={presets.reload} />}{models.error && <ErrorNotice message={models.error} onRetry={models.reload} />}<div className="world-config-links"><Link to="/presets">管理预设 <ArrowRight size={13} /></Link><Link to="/providers">管理模型连接 <ArrowRight size={13} /></Link></div></div>}
        </div>
      </section>

    </div>

    {inspectorOpen && opening && <OpeningStateInspector state={data.state} override={opening.initial_state} onClose={closeInspector} />}
    {character && <div className="overlay" onClick={() => setCharacter(null)}><section className="modal character-detail-modal" role="dialog" aria-modal="true" aria-label={character.name} onClick={e => e.stopPropagation()}><button className="close" aria-label="关闭角色详情" onClick={() => setCharacter(null)}>×</button><div className="modal-person"><div className="avatar large" style={character.avatar ? { backgroundImage: `url(${JSON.stringify(character.avatar)})` } : undefined}>{!character.avatar && character.name.slice(0, 1)}</div><div><div className="eyebrow">CHARACTER</div><h2>{character.name}</h2><p>{character.player_selectable ? '可以扮演' : '故事角色'}</p></div></div><WorldDocumentRenderer title={`${character.name}的角色介绍`} presentation="isolated" content={character.description || '暂无角色介绍。'} />{character.player_selectable && <button className="button primary" onClick={() => { setSelected(character.id); setCharacter(null); }}>扮演这个角色 <Check size={16} /></button>}</section></div>}
  </main>;
}
