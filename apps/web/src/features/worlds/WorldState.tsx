import {errorMessage} from '../../i18n/errors.ts';
import {useTranslation} from 'react-i18next';
import {useEffect, useMemo, useState} from 'react';
import {ChevronLeft} from 'lucide-react';
import type {StateSchema, StateScope} from '@sillyrealms/sdk/state-validation';
import {Button} from '../../components/ui/Button';
import {Badge} from '../../components/ui/Field';
import {describeWorldState, shouldEnterStateDetail, stateDescriptionLabel, type StateDescriptionGroup, type StateDescriptionNode} from './state-description';
import {StateHelp, useStateNavigation} from './StateBrowser';
import styles from './StateBrowser.module.css';

function StateName({node}: {node: StateDescriptionNode}) {
  const {t} = useTranslation('worlds');
  const typeLabels: Record<StateDescriptionNode['type'], string> = {
  string: t('string'), number: t('number'), boolean: t('boolean'), json: 'JSON', object: t('object'),
  array: t('array'), null: t('null'), mixed: t('mixed'), unknown: t('unspecified'),
};
  return <span className={styles.stateName}><span>{stateDescriptionLabel(node)}</span><Badge>{typeLabels[node.type]}</Badge></span>;
}

function StateBrowser({groups}: {groups: StateDescriptionGroup[]}) {
  const {t} = useTranslation('worlds');
  const scopes = {
  global: {title: t('globalState'), description: t('sharedByAllSessionsInThisWorld')},
  session: {title: t('sessionState'), description: t('storedSeparatelyForEachSession')},
  message: {title: t('messageState'), description: t('changesAsTheStoryProgressesInitialValues')},
};
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
          <strong><StateName node={node}/></strong>
          <Button id={triggerId} variant="text" size="compact" aria-label={t(drill?'worlds:viewDescription':open?'worlds:collapseDescription':'worlds:expandDescription',{path:node.path})} aria-expanded={drill ? undefined : open} aria-controls={drill ? undefined : panelId} onClick={() => {
            if (drill) {enter({scope, node}, parentLabel, triggerId); return;}
            setExpanded(previous => {const next = new Set(previous); if (next.has(identity)) next.delete(identity); else next.add(identity); return next;});
          }}>{drill ? t('view') : open ? t('collapse') : t('expand')}</Button>
        </div>
        {!drill && <div id={panelId} hidden={!open} className={styles.children}>
          {open && (node.children.length ? node.children.map(child => renderNode(child, scope, depth + 1, label)) : <p className={styles.description}>{node.description || t('noFieldDescription')}</p>)}
        </div>}
      </> : <>
        <strong className={styles.leafKey}><StateName node={node}/></strong>
        <p className={styles.description}>{node.description || t('noFieldDescription')}</p>
      </>}
    </div>;
  };
  return <div ref={root} className={styles.browser}>
    <div className={styles.toolbar}><h3>{t('stateDescriptions')}</h3><StateHelp label={t('aboutWorldState')}>{t('rootFieldsShowTheirDeclaredTypesChild')}</StateHelp></div>
    {current ? <section className={styles.scope} data-scope={current.scope}>
      <Button variant="text" size="compact" icon={<ChevronLeft size={16}/>} onClick={back}>{t('worlds:backTo',{name:visit.parentLabel})}</Button>
      <div className={styles.detailHeading}>
        <h3 id={id + '-detail'} tabIndex={-1}><StateName node={current.node}/></h3>
        <p>{scopes[current.scope].title} · {current.node.path}</p>
      </div>
      {current.node.children.length ? current.node.children.map(node => renderNode(node, current.scope, 0, stateDescriptionLabel(current.node))) : <p className={styles.description}>{current.node.description || t('noFieldDescription')}</p>}
    </section> : groups.map(group => <section key={group.scope} className={styles.scope} data-scope={group.scope}>
      <div className={styles.scopeHeading}><h3>{scopes[group.scope].title}</h3><p>{scopes[group.scope].description}</p></div>
      {group.nodes.map(node => renderNode(node, group.scope, 0, scopes[group.scope].title))}
    </section>)}
  </div>;
}

export function WorldState({state}: {state: StateSchema | undefined}) {
  const {t} = useTranslation('worlds');
  const result = useMemo(() => {
    try {return {groups: describeWorldState(state), error: null};}
    catch (reason) {return {groups: [], error: {reason}};}
  }, [state]);
  if (result.error) return <div role="alert"><p>{t('stateDescriptionsForThisWorldAreCurrently')}</p><details><summary>{t('viewErrorDetails')}</summary>{errorMessage(result.error.reason,'worlds:couldNotValidateState')}</details></div>;
  if (!result.groups.length) return <p>{t('thisWorldHasNoStateToDisplay')}</p>;
  return <StateBrowser groups={result.groups}/>;
}
