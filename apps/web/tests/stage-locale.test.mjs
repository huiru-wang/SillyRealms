import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createInstance} from 'i18next';
import {ApiError} from '../src/api.ts';
import {errorKey} from '../src/i18n/errors.ts';
import {stageURL} from '../src/stage-url.ts';
import {FrameLocale, StageBridge} from '../src/stage-frame-protocol.ts';
import {dispatchStageCommand} from '../src/stage-host/commands.ts';
import {runNotice, streamNotice, messageNotice, stageErrorMessage} from '../../../packages/sr-sdk/src/stage/feedback.ts';
import {stageZh, stageEn, stageJa} from '../src/i18n/locales/stage.ts';
import {errorsZh, errorsEn, errorsJa} from '../src/i18n/locales/errors.ts';

function translations(language = 'zh-CN') {
  const instance = createInstance();
  void instance.init({lng: language, initAsync: false, defaultNS: 'stage', fallbackLng: 'zh-CN',
    resources: {'zh-CN': {stage: stageZh, errors: errorsZh}, en: {stage: stageEn, errors: errorsEn}, ja: {stage: stageJa, errors: errorsJa}}});
  return instance;
}

test('a frame waits for a supported Host locale and language changes never replay author rendering', async () => {
  const applied = [], rendered = [];
  const locale = new FrameLocale(value => {applied.push(value);});
  locale.render(() => rendered.push('initial'));
  assert.equal(await locale.receive('fr'), false);
  assert.equal(await locale.receive({locale: 'en'}), false);
  assert.deepEqual(rendered, []);
  assert.equal(await locale.receive('ja'), true);
  assert.deepEqual(rendered, ['initial']);
  await locale.receive('en');
  await locale.receive('zh-CN');
  await locale.receive('ja');
  assert.deepEqual(rendered, ['initial']);
  assert.deepEqual(applied, ['ja', 'en', 'zh-CN', 'ja']);
  locale.render(() => rendered.push('content update'));
  assert.deepEqual(rendered, ['initial', 'content update']);
  locale.close();
  assert.equal(await locale.receive('zh-CN'), false);
});

test('closed or superseded locale initialization cannot mount stale frame content', async () => {
  const completions = new Map(), rendered = [];
  const locale = new FrameLocale(value => new Promise(resolve => completions.set(value, resolve)));
  locale.render(() => rendered.push('old render'));
  const first = locale.receive('zh-CN');
  locale.render(() => rendered.push('latest render'));
  const second = locale.receive('ja');
  completions.get('zh-CN')();
  assert.equal(await first, false);
  assert.deepEqual(rendered, []);
  completions.get('ja')();
  assert.equal(await second, true);
  assert.deepEqual(rendered, ['latest render']);
  const closed = new FrameLocale(() => new Promise(resolve => completions.set('closed', resolve)));
  closed.render(() => rendered.push('should not mount'));
  const pending = closed.receive('ja');
  closed.close(); completions.get('closed')();
  assert.equal(await pending, false);
  assert.deepEqual(rendered, ['latest render']);
});

test('existing run notices resolve in the new language without changing narrative or outcome', async () => {
  const i18n = translations();
  const message = {id: 'a', role: 'assistant', content: '', reasoning_content: '原始思考', saved: true};
  const run = {runId: 'r', status: 'stopped', stopReason: 'output_limit_reached', messages: [message]};
  const saved = structuredClone(run);
  assert.match(i18n.t(runNotice(run)), /最大输出长度/);
  assert.match(i18n.t(messageNotice(message, run.status)), /只有思考/);
  await i18n.changeLanguage('en');
  assert.match(i18n.t(runNotice(run)), /Maximum output length/);
  assert.match(i18n.t(messageNotice(message, run.status)), /reasoning only/);
  assert.match(i18n.t(streamNotice({streamIncomplete: true})), /disconnected/);
  assert.equal(i18n.t('state.message'), 'Current story');
  await i18n.changeLanguage('ja');
  assert.match(i18n.t(runNotice(run)), /最大出力長/);
  assert.match(i18n.t(messageNotice(message, run.status)), /思考内容のみ/);
  assert.match(i18n.t(streamNotice({streamIncomplete: true})), /接続が切れている間/);
  assert.equal(i18n.t('state.message'), '現在の展開');
  assert.deepEqual(run, saved);
});

test('the same command and transport errors remain stable while the display language changes', async () => {
  const i18n = translations();
  const display = reason => stageErrorMessage(errorKey(reason), key => i18n.t(key), key => i18n.exists(key));
  const bridge = new StageBridge(1000);
  const connectionError = await bridge.command('state.read', {}).catch(reason => reason);
  const commandError = await dispatchStageCommand(async () => {}, 'state.write', {updates: [{scope: 'invalid'}]}).catch(reason => reason);
  assert.equal(connectionError.message, 'stage:bridge.notConnected');
  assert.equal(commandError.message, 'stage:commands.invalidState');
  assert.match(display(connectionError), /尚未连接/);
  assert.match(display(commandError), /状态更新参数无效/);
  await i18n.changeLanguage('en');
  assert.match(display(connectionError), /not connected/);
  assert.equal(display(commandError), 'Invalid state update');
  await i18n.changeLanguage('ja');
  assert.equal(display(connectionError), 'セッション画面に接続されていません。');
  assert.equal(display(commandError), '状態更新のパラメーターが無効です。');
  assert.equal(connectionError.message, 'stage:bridge.notConnected');
  assert.equal(commandError.message, 'stage:commands.invalidState');
  let calls = 0;
  await assert.rejects(dispatchStageCommand(async () => {calls++;}, 'appearance', {locale: 'ja'}), /stage:commands.unsupported/);
  assert.equal(calls, 0);
});

test('a real API error keeps its code across the bridge and can be translated again later', async () => {
  const i18n = translations();
  const apiError = new ApiError('SESSION_WRITE_LOCKED', '会话正在运行，暂不允许修改', 409);
  const sent = [];
  const bridge = new StageBridge(1000);
  bridge.connect({postMessage(value) {sent.push(value);}, close() {}});
  const pending = bridge.command('state.read', {}).catch(reason => reason);
  bridge.receive({type: 'response', id: sent[0].id, error: errorKey(apiError, 'stage:host.operationFailed')});
  const retainedError = await pending;
  assert.equal(retainedError.message, 'SESSION_WRITE_LOCKED');
  const display = () => stageErrorMessage(retainedError.message, key => i18n.t(key), key => i18n.exists(key));
  assert.equal(display(), '会话正在运行，暂不允许修改');
  await i18n.changeLanguage('en');
  assert.equal(display(), 'This session is running. Wait before making changes.');
  await i18n.changeLanguage('ja');
  assert.equal(display(), 'セッションの実行中は変更できません。');
  assert.equal(retainedError.message, 'SESSION_WRITE_LOCKED');
  bridge.disconnect();
});


test('stage errors translate codes and namespaced keys while leaving unknown diagnostics literal', async () => {
  const i18n = translations();
  const display = value => stageErrorMessage(value, key => i18n.t(key), key => i18n.exists(key));
  assert.equal(display('SESSION_NOT_FOUND'), '会话不存在');
  assert.equal(display('errors:loadFailed'), '读取失败，请重试。');
  await i18n.changeLanguage('en');
  assert.equal(display('SESSION_NOT_FOUND'), 'Session not found.');
  assert.equal(display('errors:loadFailed'), 'Could not load. Try again.');
  assert.equal(display('story.draftFailed'), 'The draft could not be filled');
  await i18n.changeLanguage('ja');
  assert.equal(display('SESSION_NOT_FOUND'), 'セッションが見つかりません。');
  assert.equal(display('errors:loadFailed'), '読み込みに失敗しました。もう一度お試しください。');
  assert.equal(display('story.draftFailed'), '下書きを入力欄に反映できませんでした。');
  const originalDiagnostics = ['Author component diagnostic: 原始文本', '作者组件诊断；世界状态.角色.生命; 原始值=普通'];
  for (const language of ['ja', 'zh-CN', 'en']) {
    await i18n.changeLanguage(language);
    for (const diagnostic of originalDiagnostics) assert.equal(display(diagnostic), diagnostic);
  }
});


test('stage address failures retain distinct codes and localize invalid URLs, isolation, and HTTPS requirements', async () => {
  const host = 'https://web.test';
  const config = origin => ({stage: {origin, entryPath: '/frame.html'}});
  const error = origin => {try {stageURL(config(origin), host, 'nonce');} catch (reason) {return reason.message;}};
  assert.equal(error('not a URL'), 'stage:host.invalidAddress');
  assert.equal(error('https://stage.test/path'), 'stage:host.invalidAddress');
  assert.equal(error(host), 'stage:host.separateOrigin');
  assert.equal(error('http://stage.test'), 'stage:host.httpsRequired');
  const i18n = translations();
  const display = value => stageErrorMessage(value, key => i18n.t(key), key => i18n.exists(key));
  assert.equal(display(error(host)), '故事舞台必须使用独立地址');
  await i18n.changeLanguage('en');
  assert.equal(display(error(host)), 'The story stage must use a separate origin');
  assert.equal(display(error('http://stage.test')), 'An HTTPS site requires an HTTPS story stage address');
  assert.equal(display(error('not a URL')), 'Invalid story stage address configuration');
  await i18n.changeLanguage('ja');
  assert.equal(display(error(host)), 'ストーリー画面には別のオリジンを使用する必要があります。');
  assert.equal(display(error('http://stage.test')), 'メインサイトが HTTPS の場合、ストーリー画面にも HTTPS のアドレスが必要です。');
  assert.equal(display(error('not a URL')), 'ストーリー画面のアドレス設定が無効です。');
  const valid = stageURL(config('https://stage.test'), host, 'nonce');
  assert.equal(valid.origin, 'https://stage.test');
  assert.equal(valid.searchParams.get('hostOrigin'), host);
  assert.equal(valid.hash, '#nonce');
});


test('aggregated state errors translate every stable key without losing details', async () => {
  const i18n = translations();
  const stored = 'STATE_WRITE_LOCKED；stage:commands.invalidState';
  const display = () => stageErrorMessage(stored, key => i18n.t(key), key => i18n.exists(key));
  assert.equal(display(), '关联会话正在运行，暂不允许修改状态；状态更新参数无效');
  await i18n.changeLanguage('en');
  assert.equal(display(), 'A related session is running. Wait before changing state.; Invalid state update');
  await i18n.changeLanguage('ja');
  assert.equal(display(), '関連するセッションの実行中は状態を変更できません。 状態更新のパラメーターが無効です。');
  assert.equal(stored, 'STATE_WRITE_LOCKED；stage:commands.invalidState');
});
