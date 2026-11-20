import React, {useCallback, useEffect, useLayoutEffect, useId, useRef, useState} from 'react';
import {MessageContent} from '../message-content.js';
import {useStoryConfiguration} from '../story-context.js';
import {captureScrollAnchor, restoreScrollAnchor} from '../story-scroll.js';
import type {StageRun, Suggestions} from '../stage-contract.js';
import {useSRHistory, useSRSession, useSRStageSnapshot} from './context.js';
import {messageNotice, runNotice, streamNotice} from './feedback.js';
import {StatePanel} from './state-panel.js';

const StoryRun = React.memo(function StoryRun({run, suggestions, connected, onChoose}: {
  run: StageRun; suggestions: Suggestions | null; connected: boolean; onChoose(text: string): void;
}) {
  const {debug} = useStoryConfiguration(), notice = runNotice(run);
  return <>{run.messages.map(message => <React.Fragment key={message.id}>
    <article className={'sr-message ' + message.role} data-message-id={message.id}>
      <span className="sr-message-source">{message.role === 'user' ? '我' : '故事'}</span>
      <div className="sr-story-content"><MessageContent message={message} runId={run.runId}/>{!message.content.trim() && <p className="sr-thinking" role="status">{messageNotice(message, run.status)}</p>}</div>
    </article>
    {message.role === 'assistant' && suggestions?.messageId === message.id &&
      <section className="sr-suggestions" aria-label="行动建议">{suggestions.items.map((item, index) =>
        <button key={index} type="button" disabled={!connected} onClick={() => onChoose(item)}>{item}</button>
      )}</section>}
    {message.role === 'assistant' && debug === true && message.output &&
      <details className="sr-thinking sr-processing"><summary>数据处理结果</summary><pre>{JSON.stringify(message.output, null, 2)}</pre></details>}
  </React.Fragment>)}{notice && <p className={run.status === 'stopped' ? 'sr-error' : 'sr-thinking'} role="status">{notice}</p>}</>;
});

/** Rendering and reading position only. The Host supplies history, live output and recovery results. */
export function WorldStory({showState = true}: {showState?: boolean} = {}) {
  const snapshot = useSRStageSnapshot(), history = useSRHistory(), session = useSRSession();
  const {runs, connected, suggestions} = snapshot;
  const continuityNotice = streamNotice(snapshot);
  const panelId = useId(), [actionError, setActionError] = useState('');
  const [stateOpen, setStateOpen] = useState(false), [docked, setDocked] = useState(false), [showLatest, setShowLatest] = useState(false);
  const root = useRef<HTMLDivElement>(null), view = useRef<HTMLDivElement>(null), stateButton = useRef<HTMLButtonElement>(null);
  const dockedMode = useRef<boolean | null>(null), dockedPreference = useRef(true);
  const showStateRef = useRef(showState); showStateRef.current = showState;
  const stickToEnd = useRef(true), initialPositionPending = useRef(true);
  const readingPosition = useRef<{anchor: ReturnType<typeof captureScrollAnchor>; width: number; height: number; scrollHeight: number} | null>(null);
  const userScrollIntent = useRef(false), latestRequested = useRef(false), restoredScrollTop = useRef<number | null>(null);
  const repairFrame = useRef<number | undefined>(undefined);

  const rememberReading = useCallback(() => {
    const element = view.current;
    if (!element || initialPositionPending.current) return;
    readingPosition.current = {anchor: captureScrollAnchor(element), width: element.clientWidth, height: element.clientHeight, scrollHeight: element.scrollHeight};
  }, []);
  const restoreReading = useCallback(() => {
    const element = view.current;
    if (!element || initialPositionPending.current) return;
    const previousTop = element.scrollTop;
    if (stickToEnd.current) { element.scrollTop = element.scrollHeight; setShowLatest(false); }
    else if (readingPosition.current) restoreScrollAnchor(element, readingPosition.current.anchor);
    if (element.scrollTop !== previousTop) restoredScrollTop.current = element.scrollTop;
    rememberReading();
  }, [rememberReading]);
  const scheduleRestore = useCallback(() => {
    if (repairFrame.current !== undefined) return;
    repairFrame.current = requestAnimationFrame(() => { repairFrame.current = undefined; restoreReading(); });
  }, [restoreReading]);
  const focusStateTrigger = useCallback(() => {
    requestAnimationFrame(() => { (stateButton.current ?? view.current)?.focus({preventScroll: true}); });
  }, []);
  const closeState = useCallback(() => {
    rememberReading();
    if (dockedMode.current) dockedPreference.current = false;
    setStateOpen(false); focusStateTrigger();
  }, [rememberReading, focusStateTrigger]);
  const chooseSuggestion = useCallback((text: string) => {
    setActionError('');
    void session.setDraft(text).catch(error => setActionError(error instanceof Error ? error.message : '草稿填入失败'));
  }, [session]);

  useLayoutEffect(() => {
    initialPositionPending.current = true; stickToEnd.current = true;
    readingPosition.current = null; latestRequested.current = false; restoredScrollTop.current = null;
    userScrollIntent.current = false; setShowLatest(false); setActionError('');
  }, [snapshot.sessionId]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const next = element.clientWidth >= 960;
      if (next === dockedMode.current) return;
      const panelHadFocus = !!element.querySelector('.sr-story-state')?.contains(document.activeElement);
      dockedMode.current = next; setDocked(next);
      setStateOpen(showStateRef.current && next && dockedPreference.current);
      if (panelHadFocus) focusStateTrigger();
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [focusStateTrigger]);
  useLayoutEffect(() => {
    if (!showState) {
      const hadFocus = !!root.current?.querySelector('.sr-story-state')?.contains(document.activeElement);
      setStateOpen(false); if (hadFocus) focusStateTrigger();
    } else setStateOpen(!!dockedMode.current && dockedPreference.current);
  }, [showState, focusStateTrigger]);
  useLayoutEffect(() => { restoreReading(); }, [stateOpen, docked, showState, restoreReading]);
  useEffect(() => {
    const before = () => rememberReading(), after = () => restoreReading();
    window.addEventListener('sr:font-size-will-change', before);
    window.addEventListener('sr:font-size-changed', after);
    return () => {
      window.removeEventListener('sr:font-size-will-change', before);
      window.removeEventListener('sr:font-size-changed', after);
    };
  }, [rememberReading, restoreReading]);
  useLayoutEffect(() => {
    const element = view.current;
    if (!element) return;
    if (initialPositionPending.current) {
      if (history.loading) return;
      element.scrollTop = element.scrollHeight;
      initialPositionPending.current = false; stickToEnd.current = true; setShowLatest(false);
      rememberReading(); return;
    }
    restoreReading();
  }, [runs, history.loading, rememberReading, restoreReading]);
  useEffect(() => {
    const element = view.current;
    if (!element) return;
    const resize = new ResizeObserver(scheduleRestore);
    const observe = () => { resize.disconnect(); resize.observe(element); for (const child of element.children) resize.observe(child); };
    const mutations = new MutationObserver(observe); mutations.observe(element, {childList: true}); observe();
    return () => {
      resize.disconnect(); mutations.disconnect();
      if (repairFrame.current !== undefined) cancelAnimationFrame(repairFrame.current);
      repairFrame.current = undefined;
    };
  }, [scheduleRestore]);

  function userScroll() {
    restoredScrollTop.current = null;
    if (latestRequested.current && view.current) view.current.scrollTo({top: view.current.scrollTop, behavior: 'auto'});
    latestRequested.current = false; userScrollIntent.current = true;
  }
  function scrolled() {
    const element = view.current;
    if (!element || initialPositionPending.current) return;
    const saved = readingPosition.current, restoredTop = restoredScrollTop.current; restoredScrollTop.current = null;
    const geometryChanged = saved && (saved.width !== element.clientWidth || saved.height !== element.clientHeight || saved.scrollHeight !== element.scrollHeight);
    if (geometryChanged && !userScrollIntent.current) { scheduleRestore(); return; }
    if (!userScrollIntent.current && restoredTop !== null && element.scrollTop === restoredTop) return;
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    if (latestRequested.current && !atEnd && !userScrollIntent.current) return;
    latestRequested.current = false; userScrollIntent.current = false;
    stickToEnd.current = atEnd; setShowLatest(!atEnd); rememberReading();
  }
  function latest() {
    restoredScrollTop.current = null; stickToEnd.current = true; latestRequested.current = true; setShowLatest(false);
    view.current?.focus({preventScroll: true});
    view.current?.scrollTo({top: view.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  }
  function loadMore() {
    if (!history.hasMore || history.loadingMore) return;
    stickToEnd.current = false; rememberReading(); setActionError('');
    void history.loadMore().catch(error => setActionError(error instanceof Error ? error.message : '加载历史失败'));
  }
  function refreshHistory() {
    setActionError('');
    void history.refresh().catch(error => setActionError(error instanceof Error ? error.message : '读取历史失败'));
  }

  return <div ref={root} className="sr-story" data-state-mode={docked ? 'docked' : 'overlay'}>
    <div className="sr-story-main">
      <div className="sr-story-toolbar"><span className="sr-story-heading">故事</span>
        {showState && <button ref={stateButton} type="button" onClick={() => {
          rememberReading(); const next = !stateOpen; if (docked) dockedPreference.current = next; setStateOpen(next);
        }} aria-controls={panelId} aria-expanded={stateOpen}>状态 <span aria-hidden="true">{stateOpen ? '−' : '+'}</span></button>}
      </div>
      <div className="sr-chat-messages" ref={view} tabIndex={0} role="region" aria-label="故事内容" aria-busy={history.loading || undefined}
        onScroll={scrolled} onWheel={userScroll} onTouchMove={userScroll}
        onPointerDown={event => { if (event.target === event.currentTarget) userScroll(); }}
        onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) userScroll(); }}>
        {history.hasMore && <button className="sr-more" type="button" disabled={history.loadingMore} onClick={loadMore}>{history.loadingMore ? '正在加载…' : '加载更早消息'}</button>}
        {history.error && <p className="sr-error" role="alert">{history.error} <button type="button" onClick={refreshHistory}>重新加载历史</button></p>}
        {actionError && <p className="sr-error" role="alert">{actionError}</p>}
        {history.loading && !runs.length && <p className="sr-thinking" role="status">正在读取故事…</p>}
        {!history.loading && !history.error && !runs.length && <p className="sr-thinking">暂无消息。</p>}
        {runs.map(run => <StoryRun key={run.runId} run={run} suggestions={suggestions?.runId === run.runId ? suggestions : null} connected={connected} onChoose={chooseSuggestion}/>)}
        {continuityNotice && <p className="sr-thinking" role="status">{continuityNotice}</p>}
      </div>
      {showLatest && <div className="sr-story-latest"><button className="sr-more" type="button" onClick={latest}>回到最新 <span aria-hidden="true">↓</span></button></div>}
    </div>
    {showState && stateOpen && <StatePanel id={panelId} overlay={!docked} close={closeState} restoreFocus={focusStateTrigger}/>}
  </div>;
}
