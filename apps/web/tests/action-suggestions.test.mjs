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

// Exercise actual TSX with React's server renderer, without a browser, network
// adapter, additional renderer or generated build output.
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

const {SR, useSRActionSuggestions, useSRSession} = await import('@sillyrealms/sdk');
const {StageProvider} = await import('../../../packages/sr-sdk/src/stage/context.tsx');
const {StageRuntime, emptyStageSnapshot} = await import('../../../packages/sr-sdk/src/stage/runtime.ts');
const {StageComposerButtons} = await import('../../../packages/sr-sdk/src/stage/composer-buttons.ts');
const {DefaultStage} = await import('../src/default-stage.tsx');
const {stageEn} = await import('../src/i18n/locales/stage.ts');
const i18n = createInstance();
await i18n.init({lng: 'en', fallbackLng: 'en', resources: {en: {stage: stageEn}}, interpolation: {escapeValue: false}});

function snapshot(items = [], fields = {}) {
  return {...emptyStageSnapshot(), sessionId: 'session', connected: true,
    history: {loading: false, loadingMore: false, hasMore: false, error: null},
    stateLoading: false, suggestions: {items}, ...fields};
}
function runtimeWith(items = [], command = async () => {}, fields = {}) {
  const runtime = new StageRuntime(command);
  runtime.acceptSnapshot(snapshot(items, fields));
  return runtime;
}
function render(runtime, element) {
  return renderToStaticMarkup(React.createElement(I18nextProvider, {i18n},
    React.createElement(StageProvider, {runtime, buttons: new StageComposerButtons(() => {})}, element)));
}
function capture(runtime, Component) {
  let tree;
  function Inspect() { tree = Component(); return tree; }
  const html = render(runtime, React.createElement(Inspect));
  return {tree, html};
}
// Captured button calls are function-level checks of real handlers. SSR does
// not assert browser effects or post-click visual rendering.
function actionButtons(tree) { return tree.props.children[0].props.children; }

test('action Hook requires the existing stage Provider instead of a disconnected empty fallback', () => {
  function Consumer() { useSRActionSuggestions(); return null; }
  assert.throws(() => renderToStaticMarkup(React.createElement(Consumer)), /SR stage provider unavailable/);
});

test('action Hook exposes only immutable items independently of WorldStory and other consumers', () => {
  const calls = [], runtime = new StageRuntime(async (...args) => calls.push(args)), reads = [];
  function Consumer() { const value = useSRActionSuggestions(); reads.push(value); return React.createElement('span', null, value.items.join('|')); }
  function Consumers() { return React.createElement(React.Fragment, null, React.createElement(Consumer), React.createElement(Consumer)); }
  render(runtime, React.createElement(Consumers));
  assert.deepEqual(Object.keys(reads[0]), ['items']);
  assert.deepEqual(reads[0], {items: []});
  assert.equal(reads[0], reads[1]);
  assert.equal(Object.isFrozen(reads[0]), true);
  assert.equal(Object.isFrozen(reads[0].items), true);
  const source = snapshot(['Inspect the door', 'Ask a question']);
  runtime.acceptSnapshot(source); source.suggestions.items.push('external mutation');
  const html = render(runtime, React.createElement(Consumers));
  assert.equal(reads[2], reads[3]);
  assert.notEqual(reads[0], reads[2]);
  assert.deepEqual(reads[2].items, ['Inspect the door', 'Ask a question']);
  assert.throws(() => reads[2].items.push('author mutation'), TypeError);
  assert.throws(() => { reads[2].items = []; }, TypeError);
  assert.match(html, /Inspect the door/);
  assert.deepEqual(calls, []);
});

test('official actions render without story messages and empty items have no visual wrapper', () => {
  const runtime = runtimeWith();
  assert.equal(render(runtime, React.createElement(SR.ActionSuggestions)), '');
  runtime.acceptSnapshot(snapshot(['Inspect <the door>', 'Ask a question']));
  const {tree, html} = capture(runtime, SR.ActionSuggestions);
  assert.match(html, /class="sr-action-suggestions"/);
  assert.equal(tree.props['aria-label'], stageEn.story.suggestions);
  assert.match(html, /Inspect &lt;the door&gt;/);
  assert.equal((html.match(/class="sr-action-suggestion"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /sr-story/);
});

test('DefaultStage conditionally mounts the whole action area as a sibling of the reading area', () => {
  const runtime = runtimeWith();
  let result = capture(runtime, DefaultStage);
  assert.match(result.html, /class="sr-story"/);
  assert.doesNotMatch(result.html, /sr-default-stage-actions|sr-action-suggestions/);
  assert.equal(result.tree.props.children[0].props.className, 'sr-default-stage-story');
  assert.equal(result.tree.props.children[1], false);
  runtime.acceptSnapshot(snapshot(['Inspect the door']));
  result = capture(runtime, DefaultStage);
  const [story, actions] = result.tree.props.children;
  assert.equal(story.props.className, 'sr-default-stage-story');
  assert.equal(story.props.children.type, SR.WorldStory);
  assert.equal(actions.props.className, 'sr-default-stage-actions');
  assert.equal(actions.props.children.type, SR.ActionSuggestions);
  assert.equal((result.html.match(/class="sr-action-suggestions"/g) ?? []).length, 1);
  assert.doesNotMatch(render(runtime, React.createElement(SR.WorldStory)), /sr-action-suggestions|Inspect the door/);
});

test('default action fills the draft once while pending and leaves Host suggestions intact', async () => {
  const calls = []; let finish;
  const runtime = runtimeWith(['Inspect the door'], (method, input) => {
    calls.push({method, input}); return new Promise(resolve => { finish = resolve; });
  });
  const displayed = runtime.getSnapshot(), {tree} = capture(runtime, SR.ActionSuggestions);
  const button = actionButtons(tree)[0];
  button.props.onClick(); button.props.onClick();
  assert.deepEqual(calls, [{method: 'composer.setDraft', input: {text: 'Inspect the door'}}]);
  assert.equal(runtime.getSnapshot(), displayed);
  finish(); await Promise.resolve();
  button.props.onClick();
  assert.equal(calls.length, 2);
  finish(); await Promise.resolve();
});

test('official action honors connection and submission state without changing its data', () => {
  for (const fields of [{connected: false}, {sending: true}]) {
    const calls = [], runtime = runtimeWith(['Inspect the door'], async (...args) => calls.push(args), fields);
    const {tree} = capture(runtime, SR.ActionSuggestions), button = actionButtons(tree)[0];
    assert.equal(button.props.disabled, true);
    button.props.onClick();
    assert.deepEqual(calls, []);
    assert.deepEqual(runtime.getSnapshot().suggestions, {items: ['Inspect the door']});
  }
});

test('failed draft command is handled locally and retried without clearing suggestions', async () => {
  const calls = [], runtime = runtimeWith(['Inspect the door'], async (...args) => { calls.push(args); throw Error('bridge.disconnected'); });
  const displayed = runtime.getSnapshot(), {tree} = capture(runtime, SR.ActionSuggestions), button = actionButtons(tree)[0];
  button.props.onClick(); await Promise.resolve();
  button.props.onClick(); await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.equal(runtime.getSnapshot(), displayed);
});

test('authors can combine the Hook with direct send without a prior draft command', async () => {
  const calls = [], accepted = {runId: 'next', assistantEntryId: 'assistant-next'};
  const runtime = runtimeWith(['Inspect the door'], async (method, input) => { calls.push({method, input}); return accepted; });
  let send;
  function CustomActions() {
    const {items} = useSRActionSuggestions(), session = useSRSession();
    send = () => session.send(items[0]);
    return React.createElement('button', {onClick: send}, items[0]);
  }
  render(runtime, React.createElement(CustomActions));
  assert.equal(await send(), accepted);
  assert.deepEqual(calls, [{method: 'narrative.send', input: {text: 'Inspect the door'}}]);
  assert.deepEqual(runtime.getSnapshot().suggestions, {items: ['Inspect the door']});
});

test('changing rendered component selections never writes or restores action data', () => {
  const calls = [], runtime = runtimeWith(['Inspect the door'], async (...args) => calls.push(args));
  const displayed = runtime.getSnapshot();
  render(runtime, React.createElement(SR.ActionSuggestions));
  render(runtime, React.createElement(SR.WorldStory));
  render(runtime, React.createElement(React.Fragment, null, React.createElement(SR.ActionSuggestions), React.createElement(SR.ActionSuggestions)));
  assert.equal(runtime.getSnapshot(), displayed);
  assert.deepEqual(calls, []);
});
