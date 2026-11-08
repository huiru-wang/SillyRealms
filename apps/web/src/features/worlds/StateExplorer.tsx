import React, {useRef, useState} from 'react';
import {Braces, Check, ChevronLeft, ChevronRight, Copy, Database, Layers3} from 'lucide-react';
import './state-explorer.css';

type Definition = {
  type?: string;
  description?: string;
  initial?: unknown;
  properties?: Record<string, Definition>;
  items?: Definition;
  values?: unknown[];
  min?: number;
  max?: number;
  nullable?: boolean;
  load?: {mode?: string; keywords?: string[]; keyword_logic?: string; exclude_keywords?: string[]; when?: string};
};
type Scope = 'global' | 'session' | 'message';
type StateSchema = {scopes?: Partial<Record<Scope, Record<string, Definition>>>};
type Child = {key: string; name: string; definition: Definition};
const ITEM_KEY = '\u0000array-item';
const scopes: {id: Scope; title: string; description: string}[] = [
  {id: 'global', title: '世界状态', description: '同一世界卡下的会话共享，记录长期存在的信息。'},
  {id: 'session', title: '会话状态', description: '仅属于当前会话，不影响其他故事线。'},
  {id: 'message', title: '消息状态', description: '随剧情、消息历史与分支变化。'},
];
const types: Record<string, string> = {string: 'String', number: 'Number', boolean: 'Boolean', json: 'JSON', object: 'Object', array: 'Array'};
const modes: Record<string, string> = {always: '始终加载', on_mention: '命中关键词时加载', never: '不自动加载'};

function childrenOf(definition: Definition): Child[] {
  const properties = Object.entries(definition.properties ?? {}).map(([key, value]) => ({key, name: key, definition: value}));
  return definition.items ? [...properties, {key: ITEM_KEY, name: '数组元素', definition: definition.items}] : properties;
}
function definitionAt(modules: Record<string, Definition>, path: string[]): Definition | undefined {
  let current: Definition | undefined = modules[path[0]];
  for (const segment of path.slice(1)) {
    current = current && childrenOf(current).find(child => child.key === segment)?.definition;
  }
  return current;
}
function labelAt(modules: Record<string, Definition>, path: string[]): string[] {
  const names: string[] = [];
  let current: Definition | undefined;
  path.forEach((segment, i) => {
    const child: Child | undefined = i === 0 ? {key: segment, name: segment, definition: modules[segment]} : current && childrenOf(current).find(item => item.key === segment);
    if (!child) return;
    names.push(child.name);
    current = child.definition;
  });
  return names;
}
function initialText(value: unknown) {
  try { return JSON.stringify(value, null, 2) ?? String(value); }
  catch { return String(value); }
}
function JsonCode({value}: {value: unknown}) {
  const source = initialText(value);
  const token = /("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  const parts: React.ReactNode[] = [];
  let start = 0;
  for (const match of source.matchAll(token)) {
    const index = match.index;
    if (index > start) parts.push(source.slice(start, index));
    parts.push(<span className={match[1] ? 'sr-state-json-key' : match[2] ? 'sr-state-json-string' : match[3] ? 'sr-state-json-bool' : 'sr-state-json-number'} key={index}>{match[0]}</span>);
    start = index + match[0].length;
  }
  if (start < source.length) parts.push(source.slice(start));
  return <pre className="sr-state-json"><code>{parts}</code></pre>;
}

type TreeRowProps = {
  name: string;
  definition: Definition;
  path: string[];
  depth: number;
  selected: string;
  expanded: Set<string>;
  onChoose: (path: string[]) => void;
  onExpand: (key: string) => void;
};
function TreeRow({name, definition, path, depth, selected, expanded, onChoose, onExpand}: TreeRowProps) {
  const key = JSON.stringify(path);
  const children = childrenOf(definition);
  const isExpanded = expanded.has(key);
  const Icon = definition.type === 'json' || definition.type === 'object' || children.length ? Braces : Database;
  return <div className="sr-state-branch">
    <div className={'sr-state-row' + (selected === key ? ' is-selected' : '')} style={{'--state-depth': depth} as React.CSSProperties}>
      {children.length > 0 ? <button type="button" className="sr-state-expand" aria-label={`${isExpanded ? '收起' : '展开'}${name}`} aria-expanded={isExpanded} onClick={() => onExpand(key)}><ChevronRight size={14} className={isExpanded ? 'is-open' : ''}/></button> : <span className="sr-state-expand-placeholder"/>}
      <button type="button" className="sr-state-row-choice" aria-current={selected === key ? 'true' : undefined} onClick={() => onChoose(path)}>
        <Icon size={15} className="sr-state-row-icon" strokeWidth={1.7}/>
        <span className="sr-state-row-copy"><strong>{name}</strong><small>{definition.description || (definition.type === 'json' ? 'JSON 数据' : types[definition.type ?? ''] || '结构定义')}</small></span>
        <span className="sr-state-row-type">{types[definition.type ?? ''] ?? definition.type ?? 'Object'}</span>
        <ChevronRight size={14} className="sr-state-row-arrow"/>
      </button>
    </div>
    {children.length > 0 && isExpanded && <div className="sr-state-children">{children.map(child => <TreeRow key={child.key} name={child.name} definition={child.definition} path={[...path, child.key]} depth={depth + 1} selected={selected} expanded={expanded} onChoose={onChoose} onExpand={onExpand}/>)}</div>}
  </div>;
}

function Detail({name, path, definition, modules, scope, copied, onBack, onChoose, onCopy}: {
  name: string; path: string[]; definition: Definition; modules: Record<string, Definition>;
  scope: string; copied: boolean; onBack: () => void; onChoose: (path: string[]) => void; onCopy: (value: unknown) => void;
}) {
  const children = childrenOf(definition);
  const hasInitial = Object.hasOwn(definition, 'initial');
  const labels = labelAt(modules, path);
  const rows: [string, string][] = [
    ['数据类型', types[definition.type ?? ''] ?? definition.type ?? 'Object'],
    ['所属作用域', scope],
  ];
  if (definition.load?.mode) rows.push(['加载策略', modes[definition.load.mode] ?? definition.load.mode]);
  if (definition.nullable !== undefined) rows.push(['允许空值', definition.nullable ? '是' : '否']);
  if (definition.min !== undefined) rows.push(['最小值', String(definition.min)]);
  if (definition.max !== undefined) rows.push(['最大值', String(definition.max)]);
  if (definition.values?.length) rows.push(['可选值', definition.values.map(initialText).join('、')]);
  if (definition.load?.keywords?.length) rows.push(['触发关键词', definition.load.keywords.join('、')]);
  if (definition.load?.keyword_logic) rows.push(['关键词逻辑', definition.load.keyword_logic]);
  if (definition.load?.exclude_keywords?.length) rows.push(['排除关键词', definition.load.exclude_keywords.join('、')]);
  if (definition.load?.when) rows.push(['加载条件', definition.load.when]);
  return <section className="sr-state-detail" aria-label={`${name}字段详情`}>
    <div className="sr-state-detail-back"><button type="button" onClick={onBack}><ChevronLeft size={16}/> {path.length > 1 ? '返回上级字段' : '返回字段列表'}</button></div>
    <div className="sr-state-detail-content">
      <div className="sr-state-breadcrumb">{scope}{labels.map((label, i) => <React.Fragment key={i}><ChevronRight size={12}/><span>{label}</span></React.Fragment>)}</div>
      <div className="sr-state-detail-heading"><div className="sr-state-detail-icon"><Braces size={19} strokeWidth={1.65}/></div><div><h3>{name}</h3><p>{definition.description || '此字段未添加描述。'}</p></div></div>
      <div className="sr-state-section-heading">字段属性</div>
      <dl className="sr-state-properties">{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      <div className="sr-state-section-heading sr-state-initial-heading"><span>初始值</span>{hasInitial && <button type="button" onClick={() => onCopy(definition.initial)} aria-label="复制初始值">{copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? '已复制' : '复制'}</button>}</div>
      {hasInitial ? <JsonCode value={definition.initial}/> : <div className="sr-state-placeholder">未设置独立初始值{path.length > 1 ? '，可能由父级 JSON 提供。' : '。'}</div>}
      {children.length > 0 && <><div className="sr-state-section-heading">子字段 <span>{children.length}</span></div><div className="sr-state-child-list">{children.map(child => <button type="button" key={child.key} onClick={() => onChoose([...path, child.key])}><span>{child.name}</span><small>{types[child.definition.type ?? ''] || child.definition.type || 'Object'}</small><ChevronRight size={15}/></button>)}</div></>}
    </div>
  </section>;
}

/** A read-only schema explorer. Actual runtime values are intentionally not shown here. */
export function WorldState({state, hideHeading = false}: {state?: StateSchema; hideHeading?: boolean}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<Scope>(() => scopes.find(item => Object.keys(state?.scopes?.[item.id] ?? {}).length > 0)?.id ?? 'global');
  const [selected, setSelected] = useState<string[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [copiedKey, setCopiedKey] = useState('');
  const modules = state?.scopes?.[scope] ?? {};
  const fields = Object.entries(modules);
  const scopeInfo = scopes.find(item => item.id === scope)!;
  const activePath = selected && definitionAt(modules, selected) ? selected : fields.length ? [fields[0][0]] : null;
  const active = activePath ? definitionAt(modules, activePath) : undefined;
  const activeKey = JSON.stringify(activePath);
  const scrollToInspector = () => window.requestAnimationFrame(() => { if ((rootRef.current?.clientWidth ?? Infinity) <= 680) rootRef.current?.scrollIntoView({block: 'start', behavior: 'auto'}); });
  const choose = (path: string[]) => { setSelected(path); setCopiedKey(''); scrollToInspector(); };
  const back = () => { setSelected(selected && selected.length > 1 ? selected.slice(0, -1) : null); scrollToInspector(); };
  const changeScope = (next: Scope) => { setScope(next); setSelected(null); setExpanded(new Set()); setCopiedKey(''); };
  const toggle = (key: string) => setExpanded(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const copy = async (value: unknown) => { try { await navigator.clipboard.writeText(initialText(value)); setCopiedKey(activeKey); } catch { setCopiedKey(''); } };
  return <div ref={rootRef} className="sr-state" data-detail-open={selected ? 'true' : 'false'}>
    <header className="sr-state-header">
      <div>{!hideHeading && <div className="eyebrow">STATE SCHEMA</div>}<h2>状态定义</h2><p>浏览世界卡声明的字段及初始值，实际状态随剧情变化。</p></div>
    </header>
    <div className="sr-state-scopes" role="tablist" aria-label="状态作用域">{scopes.map(item => <button type="button" role="tab" key={item.id} aria-selected={scope === item.id} className={scope === item.id ? 'is-active' : ''} onClick={() => changeScope(item.id)}>{item.title}<span>{Object.keys(state?.scopes?.[item.id] ?? {}).length}</span></button>)}</div>
    <div className="sr-state-explorer">
      <section className="sr-state-list" aria-label="状态字段列表">
        <div className="sr-state-list-heading"><span>字段结构</span><span>{fields.length} 项</span></div>
        <div className="sr-state-tree">{fields.map(([name, definition]) => <TreeRow key={name} name={name} definition={definition} path={[name]} depth={0} selected={activeKey} expanded={expanded} onChoose={choose} onExpand={toggle}/>)}</div>
        {fields.length === 0 && <div className="sr-state-list-empty">此作用域尚无状态定义</div>}
      </section>
      {active && activePath ? <Detail key={activeKey} name={labelAt(modules, activePath).at(-1) ?? activePath.at(-1)!} path={activePath} definition={active} modules={modules} scope={scopeInfo.title} copied={copiedKey === activeKey} onBack={back} onChoose={choose} onCopy={value => { void copy(value); }}/> : <section className="sr-state-detail sr-state-detail-empty"><Layers3 size={29} strokeWidth={1.35}/><h3>暂无状态定义</h3><p>{scopeInfo.description}<br/>此作用域尚未声明字段。</p></section>}
    </div>
  </div>;
}
