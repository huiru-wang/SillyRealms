import {useEffect, useMemo, useState, type ReactNode} from 'react';
import {ChevronLeft} from 'lucide-react';
import type {StateSchema} from '@sillyrealms/sdk/state-validation';
import {Button} from '../../components/ui/Button';
import {Badge} from '../../components/ui/Field';
import {StateHelp, useStateNavigation} from './StateBrowser';
import {openingStateRows, type Row} from './opening-state';
import {shouldEnterStateDetail} from './state-description';
import {INITIAL_ARRAY_PAGE_SIZE, initialTextPreview, initialValueChildren, initialValueSize, initialValueText, type InitialValueNode} from './initial-state-values';
import shared from './StateBrowser.module.css';
import styles from './OpeningState.module.css';

function InitialValues({rows, openingName}: {rows: Row[]; openingName: string}) {
  const {id, root, mobile, current, enter, back} = useStateNavigation<InitialValueNode>(rows, '[data-modal-body]');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [limits, setLimits] = useState<Map<string, number>>(() => new Map());
  const [fullText, setFullText] = useState<Set<string>>(() => new Set());
  useEffect(() => {setExpanded(new Set()); setLimits(new Map()); setFullText(new Set());}, [rows]);

  const renderChildren = (node: InitialValueNode, depth: number): ReactNode => {
    const limit = limits.get(node.path) ?? INITIAL_ARRAY_PAGE_SIZE;
    const children = initialValueChildren(node, limit);
    const remaining = Array.isArray(node.value) ? node.value.length - children.length : 0;
    return <>
      {children.map(child => renderNode(child, depth, node.key))}
      {remaining > 0 && <div className={styles.more}><Button variant="text" size="compact" onClick={() => setLimits(previous => new Map(previous).set(node.path, limit + INITIAL_ARRAY_PAGE_SIZE))}>显示更多（剩余 {remaining} 项）</Button></div>}
    </>;
  };
  const renderNode = (node: InitialValueNode, depth: number, parentLabel: string, overridden?: boolean): ReactNode => {
    const container = initialValueSize(node.value) > 0;
    const triggerId = id + ':' + node.path, panelId = triggerId + ':content';
    const drill = container && shouldEnterStateDetail(mobile, depth), open = expanded.has(node.path);
    const key = <div className={styles.key}><strong>{node.key}</strong>{overridden !== undefined && <Badge>{overridden ? '开局设定' : '世界默认'}</Badge>}</div>;
    if (container) return <div key={node.path} className={styles.node}>
      <div className={styles.containerRow}>
        {key}
        <div className={styles.actions}>
          {Array.isArray(node.value) && <span className={styles.count}>{node.value.length} 项</span>}
          <Button id={triggerId} variant="text" size="compact" aria-label={(drill ? '查看' : open ? '收起' : '展开') + node.path} aria-expanded={drill ? undefined : open} aria-controls={drill ? undefined : panelId} onClick={() => {
            if (drill) {enter(node, parentLabel, triggerId); return;}
            setExpanded(previous => {const next = new Set(previous); if (next.has(node.path)) next.delete(node.path); else next.add(node.path); return next;});
          }}>{drill ? '查看' : open ? '收起' : '展开'}</Button>
        </div>
      </div>
      {!drill && <div id={panelId} className={styles.children} hidden={!open}>{open && renderChildren(node, depth + 1)}</div>}
    </div>;
    const text = initialValueText(node.value), preview = initialTextPreview(text), showFull = fullText.has(node.path);
    return <div key={node.path} className={styles.node}>
      <div className={styles.valueRow}>
        {key}
        <div className={styles.value}>
          <span id={panelId} className={styles.valueText}>{showFull ? text : preview.text}</span>
          {preview.shortened && <Button variant="text" size="compact" aria-expanded={showFull} aria-controls={panelId} aria-label={(showFull ? '收起' : '展开') + node.path + '全文'} onClick={() => setFullText(previous => {const next = new Set(previous); if (next.has(node.path)) next.delete(node.path); else next.add(node.path); return next;})}>{showFull ? '收起全文' : '展开全文'}</Button>}
        </div>
      </div>
    </div>;
  };
  return <div ref={root} className={shared.browser}>
    <div className={shared.toolbar}>
      <h3 className={styles.openingName}>{openingName}</h3>
      <StateHelp label="关于开局初始状态">这里展示该开局创建会话时使用的剧情初始状态。</StateHelp>
    </div>
    {rows.length === 0 ? <p>这个世界没有声明消息状态。</p> : <section className={shared.scope} data-scope="message">
      {current ? <>
        <Button variant="text" size="compact" icon={<ChevronLeft size={16}/>} onClick={back}>返回 {current.parentLabel}</Button>
        <div className={shared.detailHeading}><h3 id={id + '-detail'} tabIndex={-1}>{current.data.key}</h3><p>消息状态 · {current.data.path}</p></div>
        {renderChildren(current.data, 0)}
      </> : <>
        <div className={shared.scopeHeading}><h3>消息状态</h3></div>
        {rows.map(row => renderNode({key: row.name, path: row.name, value: row.value}, 0, '消息状态', row.overridden))}
      </>}
    </section>}
  </div>;
}

export function OpeningState({state, override, openingName}: {state: StateSchema | undefined; override: unknown; openingName: string}) {
  const result = useMemo(() => {
    try {return {rows: openingStateRows(state, override), error: ''};}
    catch (error) {return {rows: [], error: error instanceof Error ? error.message : '无法验证状态'};}
  }, [state, override]);
  if (result.error) return <div role="alert"><p>暂时无法展示这个开局的初始状态。</p><details><summary>查看错误详情</summary>{result.error}</details></div>;
  return <InitialValues rows={result.rows} openingName={openingName}/>;
}
