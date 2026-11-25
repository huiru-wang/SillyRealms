import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createInstance} from 'i18next';
import {I18nextProvider} from 'react-i18next';

// Render real SDK components and Host snapshots at function level, without a browser or service.
const sourceRoots = [new URL('../../../packages/', import.meta.url).href, new URL('../src/', import.meta.url).href];
const isSource = url => sourceRoots.some(root => url.startsWith(root));
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && isSource(context.parentURL) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const original = new URL(specifier, context.parentURL);
      if (!existsSync(original)) {
        for (const extension of ['.ts', '.tsx']) {
          const candidate = new URL(specifier.slice(0, -3) + extension, context.parentURL);
          if (existsSync(candidate)) return nextResolve(candidate.href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (isSource(url) && url.endsWith('.tsx')) {
      const {outputText} = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: fileURLToPath(url),
        compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX},
      });
      return {format: 'module', source: outputText, shortCircuit: true};
    }
    return nextLoad(url, context);
  },
});
after(() => loader.deregister());

const {LoadingText, SR} = await import('@sillyrealms/sdk');
const {StageProvider} = await import('../../../packages/sr-sdk/src/stage/context.tsx');
const {StageRuntime, emptyStageSnapshot} = await import('../../../packages/sr-sdk/src/stage/runtime.ts');
const {StageComposerButtons} = await import('../../../packages/sr-sdk/src/stage/composer-buttons.ts');
const {StatePanel} = await import('../../../packages/sr-sdk/src/stage/state-panel.tsx');
const {MessageReasoning} = await import('../../../packages/sr-sdk/src/stage/message-reasoning.tsx');
const {stageEn} = await import('../src/i18n/locales/stage.ts');
const i18n = createInstance();
await i18n.init({lng: 'en', fallbackLng: 'en', resources: {en: {stage: stageEn}}, interpolation: {escapeValue: false}});

function render(fields, element = React.createElement(SR.WorldStory)) {
  const runtime = new StageRuntime(async () => {});
  runtime.acceptSnapshot({...emptyStageSnapshot(), sessionId: 'session', connected: true,
    history: {loading: false, loadingMore: false, hasMore: false, error: null}, stateLoading: false, ...fields});
  return renderToStaticMarkup(React.createElement(I18nextProvider, {i18n},
    React.createElement(StageProvider, {runtime, buttons: new StageComposerButtons(() => {})}, element)));
}
function waitingLabels(html) {
  return [...html.matchAll(/<span class="sr-loading-accessible">([^<]*)<\/span>/g)].map(match => match[1]);
}
function run(status, phase) { return {runId: 'run', status, phase, messages: []}; }

test('LoadingText is reusable outside the stage and preserves complete accessible text and Unicode graphemes', () => {
  assert.equal(SR.LoadingText, LoadingText);
  assert.equal(renderToStaticMarkup(React.createElement(LoadingText, {text: ''})), '');
  const text = 'A 👩🏽‍🚀 e\u0301 中';
  const html = renderToStaticMarkup(React.createElement(LoadingText, {text}));
  assert.deepEqual(waitingLabels(html), [text]);
  assert.match(html, /class="sr-loading-visual" aria-hidden="true"/);
  const glyphs = [...html.matchAll(/class="sr-loading-glyph sr-loading-char"[^>]*>([^<]*)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(glyphs, ['A', ' ', '👩🏽‍🚀', ' ', 'e\u0301', ' ', '中']);
});

test('WorldStory active phases use LoadingText while terminal notices remain static', () => {
  for (const phase of ['preparing', 'summarizing', 'generating']) {
    assert.deepEqual(waitingLabels(render({runs: [run('running', phase)]})),
      [stageEn.notices[phase]]);
  }
  assert.deepEqual(waitingLabels(render({runs: [run('stopping')]})),
    [stageEn.notices.stopping]);
  for (const status of ['completed', 'stopped', 'unknown']) {
    assert.deepEqual(waitingLabels(render({runs: [run(status)]})), []);
  }
});

test('history reads, paging, reasoning and state reads share LoadingText only while pending', () => {
  assert.deepEqual(waitingLabels(render({history: {loading: true, loadingMore: false, hasMore: false, error: null}})), [stageEn.story.reading]);
  assert.deepEqual(waitingLabels(render({history: {loading: false, loadingMore: true, hasMore: true, error: null}})), [stageEn.common.loading]);
  assert.deepEqual(waitingLabels(render({history: {loading: false, loadingMore: false, hasMore: true, error: null}})), []);
  const message = {id: 'assistant', runId: 'run', role: 'assistant', content: '', timestamp: 1, saved: false, reasoning_content: 'Thinking.'};
  assert.deepEqual(waitingLabels(render({}, React.createElement(MessageReasoning, {message, status: 'running'}))), [stageEn.reasoning.thinking]);
  assert.deepEqual(waitingLabels(render({}, React.createElement(MessageReasoning, {message: {...message, saved: true}, status: 'completed'}))), []);
  const panel = React.createElement(StatePanel, {close() {}, restoreFocus() {}, overlay: false, id: 'state'});
  assert.deepEqual(waitingLabels(render({stateLoading: true}, panel)), [stageEn.state.loading]);
  assert.deepEqual(waitingLabels(render({stateLoading: false}, panel)), []);
});
