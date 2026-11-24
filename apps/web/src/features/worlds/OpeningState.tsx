import {errorMessage} from '../../i18n/errors.ts';
import {useTranslation} from 'react-i18next';
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
  const {t} = useTranslation('worlds');
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
      {remaining > 0 && <div className={styles.more}><Button variant="text" size="compact" onClick={() => setLimits(previous => new Map(previous).set(node.path, limit + INITIAL_ARRAY_PAGE_SIZE))}>{t('worlds:showRemaining',{count:remaining})}</Button></div>}
    </>;
  };
  const renderNode = (node: InitialValueNode, depth: number, parentLabel: string, overridden?: boolean): ReactNode => {
    const container = initialValueSize(node.value) > 0;
    const triggerId = id + ':' + node.path, panelId = triggerId + ':content';
    const drill = container && shouldEnterStateDetail(mobile, depth), open = expanded.has(node.path);
    const key = <div className={styles.key}><strong>{node.key}</strong>{overridden !== undefined && <Badge>{overridden ? t('openingOverride') : t('worldDefault')}</Badge>}</div>;
    if (container) return <div key={node.path} className={styles.node}>
      <div className={styles.containerRow}>
        {key}
        <div className={styles.actions}>
          {Array.isArray(node.value) && <span className={styles.count}>{t('worlds:itemCount',{count:node.value.length})}</span>}
          <Button id={triggerId} variant="text" size="compact" aria-label={t(drill?'worlds:viewPath':open?'worlds:collapsePath':'worlds:expandPath',{path:node.path})} aria-expanded={drill ? undefined : open} aria-controls={drill ? undefined : panelId} onClick={() => {
            if (drill) {enter(node, parentLabel, triggerId); return;}
            setExpanded(previous => {const next = new Set(previous); if (next.has(node.path)) next.delete(node.path); else next.add(node.path); return next;});
          }}>{drill ? t('view') : open ? t('collapse') : t('expand')}</Button>
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
          {preview.shortened && <Button variant="text" size="compact" aria-expanded={showFull} aria-controls={panelId} aria-label={t(showFull?'worlds:collapseFullText':'worlds:expandFullText',{path:node.path})} onClick={() => setFullText(previous => {const next = new Set(previous); if (next.has(node.path)) next.delete(node.path); else next.add(node.path); return next;})}>{showFull ? t('collapseFullText2') : t('expandFullText2')}</Button>}
        </div>
      </div>
    </div>;
  };
  return <div ref={root} className={shared.browser}>
    <div className={shared.toolbar}>
      <h3 className={styles.openingName}>{openingName}</h3>
      <StateHelp label={t('aboutOpeningState')}>{t('theseAreTheInitialStoryValuesUsed')}</StateHelp>
    </div>
    {rows.length === 0 ? <p>{t('thisWorldHasNoDeclaredMessageState')}</p> : <section className={shared.scope} data-scope="message">
      {current ? <>
        <Button variant="text" size="compact" icon={<ChevronLeft size={16}/>} onClick={back}>{t('worlds:backTo',{name:current.parentLabel})}</Button>
        <div className={shared.detailHeading}><h3 id={id + '-detail'} tabIndex={-1}>{current.data.key}</h3><p>{t('worlds:messageStatePath',{path:current.data.path})}</p></div>
        {renderChildren(current.data, 0)}
      </> : <>
        <div className={shared.scopeHeading}><h3>{t('messageState')}</h3></div>
        {rows.map(row => renderNode({key: row.name, path: row.name, value: row.value}, 0, t('messageState'), row.overridden))}
      </>}
    </section>}
  </div>;
}

export function OpeningState({state, override, openingName}: {state: StateSchema | undefined; override: unknown; openingName: string}) {
  const {t} = useTranslation('worlds');
  const result = useMemo(() => {
    try {return {rows: openingStateRows(state, override), error: null};}
    catch (reason) {return {rows: [], error: {reason}};}
  }, [state, override]);
  if (result.error) return <div role="alert"><p>{t('theInitialStateForThisOpeningIs')}</p><details><summary>{t('viewErrorDetails')}</summary>{errorMessage(result.error.reason,'worlds:couldNotValidateState')}</details></div>;
  return <InitialValues rows={result.rows} openingName={openingName}/>;
}
