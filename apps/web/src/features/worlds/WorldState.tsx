import {useEffect, useMemo, useState} from 'react';
import {ChevronLeft} from 'lucide-react';
import type {StateSchema, StateScope} from '@sillyrealms/sdk/state-validation';
import {Button} from '../../components/ui/Button';
import {describeWorldState, shouldEnterStateDetail, stateDescriptionLabel, type StateDescriptionGroup, type StateDescriptionNode} from './state-description';
import {StateHelp, useStateNavigation} from './StateBrowser';
import styles from './StateBrowser.module.css';

const scopes = {
  global: {title: '全局状态', description: '同一世界的所有会话共享'},
  session: {title: '会话状态', description: '每个会话独立记录'},
  message: {title: '消息状态', description: '随剧情推进记录，可由开局设定初始内容'},
};

function StateBrowser({groups}: {groups: StateDescriptionGroup[]}) {
  const {id, root, mobile, current: visit, enter, back} = useStateNavigation<{scope: StateScope; node: StateDescriptionNode}>(groups, '[data-world-content]');
  const current = visit?.data;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => {setExpanded(new Set());}, [groups]);
  const renderNode = (node: StateDescriptionNode, scope: StateScope, depth: number, parentLabel: string) => {
    const identity = scope + ':' + node.path, label = stateDescriptionLabel(node);
    const triggerId = id + ':' + identity, panelId = triggerId + ':content';
    const drill = node.container && shouldEnterStateDetail(mobile, depth);
    const open = expanded.has(identity);
    return <div className={styles.node} key={node.path}>
      {node.container ? <>
        <div className={styles.nodeHeading}>
          <strong>{label}</strong>
          <Button id={triggerId} variant="text" size="compact" aria-label={(drill ? '查看' : open ? '收起' : '展开') + node.path + '说明'} aria-expanded={drill ? undefined : open} aria-controls={drill ? undefined : panelId} onClick={() => {
            if (drill) {enter({scope, node}, parentLabel, triggerId); return;}
            setExpanded(previous => {const next = new Set(previous); if (next.has(identity)) next.delete(identity); else next.add(identity); return next;});
          }}>{drill ? '查看' : open ? '收起' : '展开'}</Button>
        </div>
        {!drill && <div id={panelId} hidden={!open} className={styles.children}>
          {open && (node.children.length ? node.children.map(child => renderNode(child, scope, depth + 1, label)) : <p className={styles.description}>{node.description || '暂无字段说明。'}</p>)}
        </div>}
      </> : <>
        <strong className={styles.leafKey}>{label}</strong>
        <p className={styles.description}>{node.description || '暂无字段说明。'}</p>
      </>}
    </div>;
  };
  return <div ref={root} className={styles.browser}>
    <div className={styles.toolbar}><h3>状态说明</h3><StateHelp label="关于世界状态">这个世界会记录的状态与含义</StateHelp></div>
    {current ? <section className={styles.scope} data-scope={current.scope}>
      <Button variant="text" size="compact" icon={<ChevronLeft size={16}/>} onClick={back}>返回 {visit.parentLabel}</Button>
      <div className={styles.detailHeading}>
        <h3 id={id + '-detail'} tabIndex={-1}>{stateDescriptionLabel(current.node)}</h3>
        <p>{scopes[current.scope].title} · {current.node.path}</p>
      </div>
      {current.node.children.length ? current.node.children.map(node => renderNode(node, current.scope, 0, stateDescriptionLabel(current.node))) : <p className={styles.description}>{current.node.description || '暂无字段说明。'}</p>}
    </section> : groups.map(group => <section key={group.scope} className={styles.scope} data-scope={group.scope}>
      <div className={styles.scopeHeading}><h3>{scopes[group.scope].title}</h3><p>{scopes[group.scope].description}</p></div>
      {group.nodes.map(node => renderNode(node, group.scope, 0, scopes[group.scope].title))}
    </section>)}
  </div>;
}

export function WorldState({state}: {state: StateSchema | undefined}) {
  const result = useMemo(() => {
    try {return {groups: describeWorldState(state), error: ''};}
    catch (error) {return {groups: [], error: error instanceof Error ? error.message : '无法验证状态'};}
  }, [state]);
  if (result.error) return <div role="alert"><p>暂时无法展示这个世界的状态说明。</p><details><summary>查看错误详情</summary>{result.error}</details></div>;
  if (!result.groups.length) return <p>这个世界暂未设置可查看的状态。</p>;
  return <StateBrowser groups={result.groups}/>;
}
