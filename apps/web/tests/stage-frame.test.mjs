import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StageRuntime, emptyStageSnapshot} from '../../../packages/sr-sdk/src/stage/runtime.ts';
import {messageNotice, runNotice, streamNotice} from '../../../packages/sr-sdk/src/stage/feedback.ts';
import {StageBridge, stageHostOrigin} from '../src/stage-frame-protocol.ts';

const fields = {sessionId: 'session', runId: 'run', provider: 'provider', model: 'model', timestamp: 1};
function snapshot() {
  return {
    ...emptyStageSnapshot(), sessionId: 'session', connected: true, activeRunId: 'run',
    runs: [{runId: 'run', status: 'running', phase: 'generating', messages: [{
      id: 'assistant', runId: 'run', role: 'assistant', content: '正文', timestamp: 1, saved: false,
    }]}],
    state: {global: {weather: 'clear'}, session: {}, message: {coins: 8}},
    stateLoading: false,
    history: {loading: false, loadingMore: false, hasMore: false, error: null},
  };
}

test('frame events preserve native names without reducing or declaring unsaved messages durable', () => {
  const runtime = new StageRuntime(async () => {});
  runtime.acceptSnapshot(snapshot());
  const observed = [];
  runtime.session.subscribe(event => { event.data.savedMessageIds?.push('modified'); throw Error('author callback'); });
  runtime.session.subscribe(event => observed.push(event));
  runtime.acceptEvent({event: 'run.completed', data: {...fields, savedMessageIds: ['assistant'], tipEntryId: 'assistant'}});
  assert.equal(observed[0].event, 'run.completed');
  assert.deepEqual(observed[0].data.savedMessageIds, ['assistant']);
  assert.equal(runtime.getSnapshot().runs[0].status, 'running');
  assert.equal(runtime.getSnapshot().runs[0].messages[0].saved, false);
  const saved = snapshot(); saved.activeRunId = null; saved.runs[0].status = 'completed'; saved.runs[0].messages[0].saved = true;
  runtime.acceptSnapshot(saved);
  assert.equal(runtime.getSnapshot().runs[0].messages[0].saved, true);
});

test('state commands read the Host and successful writes never optimistically change the display mirror', async () => {
  const requests = [];
  const runtime = new StageRuntime(async (method, input) => {
    requests.push({method, input});
    if (method === 'state.read') return {global: {}, session: {}, message: {coins: 12}};
    return input.updates.map(update => ({path: update.path, scope: update.scope, success: true, errorCode: null, errorMessage: ''}));
  });
  runtime.acceptSnapshot(snapshot());
  assert.equal(await runtime.state.getState('coins'), 12);
  assert.equal(runtime.getSnapshot().state.message.coins, 8);
  await runtime.state.updateState('undeclared', 99);
  assert.equal(Object.hasOwn(runtime.getSnapshot().state.message, 'undeclared'), false);
  assert.deepEqual(requests[1], {method: 'state.write', input: {updates: [{path: 'undeclared', value: 99, scope: 'message'}]}});
  let event;
  runtime.state.subscribe(value => { event = value; });
  runtime.acceptEvent({event: 'state.changed', data: {path: '', scope: 'message', value: {coins: 12}}});
  assert.equal(event.data.path, '');
  assert.equal(runtime.getSnapshot().state.message.coins, 8);
  const updated = snapshot(); updated.state.message = {coins: 12}; runtime.acceptSnapshot(updated);
  assert.deepEqual(runtime.getSnapshot().state.message, {coins: 12});
});

test('author snapshots cannot mutate the Host projection or another observer', () => {
  const runtime = new StageRuntime(async () => {});
  let notifications = 0;
  runtime.observe(() => { throw Error('author observer'); });
  const dispose = runtime.observe(() => { notifications++; });
  const source = snapshot();
  runtime.acceptSnapshot(source);
  source.state.message.coins = 100;
  assert.equal(runtime.getSnapshot().state.message.coins, 8);
  assert.throws(() => { runtime.getSnapshot().runs[0].messages[0].content = 'modified'; }, TypeError);
  assert.equal(notifications, 1);
  dispose(); runtime.reset();
  assert.equal(notifications, 1);
  assert.equal(runtime.getSnapshot().sessionId, '');
});

test('V2 session commands return acceptance IDs, the saved user and raw history items without legacy fields', async () => {
  const accepted = {runId: 'run', userEntryId: 'user', assistantEntryId: 'assistant',
    userMessage: {id: 'user', role: 'user', content: '继续', timestamp: 1}};
  const page = {items: [], hasMore: false, nextCursor: null, nextAfterSeq: 2, activeRunId: null};
  const requests = [];
  const runtime = new StageRuntime(async (method, input) => {
    requests.push({method, input});
    if (method === 'narrative.send') return accepted;
    if (method === 'history.query') return page;
    if (method === 'narrative.stop') return {runId: input.runId, stopping: true};
  });
  assert.deepEqual(await runtime.session.send('继续'), accepted);
  assert.deepEqual(await runtime.session.getRuns({afterSeq: 1}), page);
  await runtime.history.loadMore(); await runtime.session.setDraft('查看线索');
  assert.deepEqual(requests.map(request => request.method), ['narrative.send', 'history.query', 'history.loadMore', 'composer.setDraft']);
  assert.equal(Object.hasOwn(accepted, 'requestId'), false);
  assert.equal(Object.hasOwn(page, 'runs'), false);
});

test('frame command transport revokes pending requests and ignores late responses after reconnect', async () => {
  const sent = []; let closed = 0;
  const bridge = new StageBridge();
  const port = {postMessage(value) { sent.push(value); }, close() { closed++; }};
  await assert.rejects(bridge.command('history.query', {}), /bridge.notConnected/);
  bridge.connect(port);
  const first = bridge.command('state.read', {});
  const rejected = assert.rejects(first, /bridge.disconnected/);
  bridge.disconnect(); await rejected;
  bridge.connect(port);
  const second = bridge.command('history.query', {});
  assert.equal(bridge.receive({type: 'response', id: sent[0].id, data: 'stale'}), false);
  assert.equal(bridge.receive({type: 'response', id: sent[1].id, data: 'fresh'}), true);
  assert.equal(await second, 'fresh');
  bridge.disconnect(); assert.equal(closed, 2);
});

test('frame request timeouts settle callers instead of retaining pending commands forever', async () => {
  const bridge = new StageBridge(5);
  bridge.connect({postMessage() {}, close() {}});
  await assert.rejects(bridge.command('history.query', {}), /bridge.timeout/);
  assert.equal(bridge.receive({type: 'response', id: 1, data: {}}), false);
  bridge.disconnect();
});

test('frame handshake accepts only the configured distinct Web origin', () => {
  const web = 'http://127.0.0.1:5176', stage = 'http://127.0.0.1:5177';
  assert.equal(stageHostOrigin('?hostOrigin=' + encodeURIComponent(web), stage, web), web);
  assert.equal(stageHostOrigin('?hostOrigin=' + encodeURIComponent(web), web, web), null);
  assert.equal(stageHostOrigin('?hostOrigin=https://other.test', stage, web), null);
  assert.equal(stageHostOrigin('?hostOrigin=https://web.test', stage, 'https://web.test'), null);
  assert.equal(stageHostOrigin('?hostOrigin=https://web.test/path', 'https://stage.test', 'https://web.test/path'), null);
  assert.equal(stageHostOrigin('?hostOrigin=javascript:alert(1)', stage, 'javascript:alert(1)'), null);
});

test('capability failures do not turn completed narrative into a failed run presentation', () => {
  const run = {runId: 'run', status: 'completed', messages: [{
    id: 'assistant', role: 'assistant', runId: 'run', content: '正文', timestamp: 1, saved: true,
    output: {stateUpdate: {status: 'invalid_tag'}, actionSuggestions: {status: 'processing_error'}},
  }]};
  assert.equal(runNotice(run), null);
  assert.equal(runNotice({...run, status: 'stopping'}), 'notices.stopping');
  assert.equal(runNotice({...run, status: 'unknown'}), 'notices.unknown');
});

test('only an explicit output limit prompts a preset length adjustment', () => {
  const run = {runId: 'run', status: 'stopped', messages: []};
  assert.equal(runNotice({...run, stopReason: 'output_limit_reached'}), 'notices.output_limit_reached');
  assert.equal(runNotice({...run, stopReason: 'output_incomplete'}), 'notices.output_incomplete');
});

test('stream gaps and reasoning-only messages remain visible without fabricated narrative text', () => {
  assert.equal(streamNotice({streamIncomplete: false}), null);
  assert.equal(streamNotice({streamIncomplete: true}), 'notices.streamIncomplete');
  const message = {id: 'assistant', runId: 'run', role: 'assistant', content: '', reasoning_content: 'thinking',
    timestamp: 1, saved: false};
  assert.equal(messageNotice(message, 'running'), null);
  assert.equal(messageNotice({...message, saved: true}, 'stopped'), 'notices.reasoningOnly');
  assert.equal(messageNotice({...message, content: '正文'}, 'completed'), null);
  assert.equal(message.content, '');
});

test('frame regeneration is a command proxy and never removes a message optimistically',async()=>{
 const calls=[],runtime=new StageRuntime(async(method,input)=>{calls.push({method,input});return {runId:'run',assistantEntryId:'next'};});
 runtime.acceptSnapshot(snapshot());
 await runtime.session.regenerate({userEntryId:'user',assistantEntryId:'assistant'});
 await runtime.session.stop('run','next');
 assert.deepEqual(calls,[{method:'narrative.regenerate',input:{userEntryId:'user',assistantEntryId:'assistant'}},{method:'narrative.stop',input:{runId:'run',assistantEntryId:'next'}}]);
 assert.equal(runtime.getSnapshot().runs[0].messages[0].id,'assistant');
});
