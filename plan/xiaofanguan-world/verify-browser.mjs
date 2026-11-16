/**
 * Real ZIP import and UI run in the built Studio + isolated Host/Stage.
 * node plan/xiaofanguan-world/verify-browser.mjs [existing-manifest.json]
 * The default invocation starts verify-server.mts --serve and cleans it up.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'sr-xiaofanguan-browser-'));
const output = join(here, 'verification');
const manifestPath = process.argv[2] ?? join(temporary, 'manifest.json');
const children = [];
const pending = new Map();
const contexts = new Map();
const frameSessions = new Map();
const exceptions = [];
const failedResponses = [];
const urls = new Set();
const screenshots = [];
const metrics = {};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws, sequence = 0, origin, serverLogs = '';

function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, {resolve, reject, timer});
    ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
  });
}
async function evaluate(expression, sessionId, contextId) {
  const result = await call('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, ...(contextId ? {contextId} : {}),
  }, sessionId);
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}
async function until(expression, runner = evaluate) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await runner(expression)) return;
    await delay(100);
  }
  throw Error('Timed out: ' + expression);
}
async function click(label) {
  await evaluate('(() => { const e = [...document.querySelectorAll("button,a")].find(e => e.getAttribute("aria-label")===' +
    JSON.stringify(label) + ' || e.textContent.trim()===' + JSON.stringify(label) +
    '); if (!e) throw Error("Missing control"); e.focus({preventScroll:true}); e.click(); })()');
}
async function navigate(path) {
  await call('Page.navigate', {url: origin + path});
  await until('!!document.getElementById("main-content")');
}
async function frame(selector = 'iframe[title="会话页面"]') {
  const url = await evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.src');
  assert(url, 'Frame has not mounted: ' + selector);
  const targets = await call('Target.getTargets');
  const target = targets.targetInfos.find(item => item.type === 'iframe' && item.url === url);
  if (target) {
    let sessionId = frameSessions.get(target.targetId);
    if (!sessionId) {
      ({sessionId} = await call('Target.attachToTarget', {targetId: target.targetId, flatten: true}));
      frameSessions.set(target.targetId, sessionId);
      await call('Runtime.enable', {}, sessionId);
      await call('Network.enable', {}, sessionId);
    }
    return expression => evaluate(expression, sessionId);
  }
  const tree = await call('Page.getFrameTree');
  const child = tree.frameTree.childFrames?.find(item =>
    item.frame.url === url || item.frame.url + (item.frame.urlFragment ?? '') === url);
  const context = [...contexts.values()].find(item => item.auxData?.frameId === child?.frame.id && item.auxData?.isDefault);
  assert(context, 'Frame execution context not ready');
  return expression => evaluate(expression, undefined, context.id);
}
async function frameUntil(expression, selector) {
  let last;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const run = await frame(selector);
      if (await run(expression)) return run;
    } catch (error) { last = error; }
    await delay(100);
  }
  throw Error('Frame timed out: ' + expression + '; ' + String(last ?? '') +
    '; Host: ' + await evaluate('document.body.innerText'));
}
async function shot(name) {
  await delay(200);
  const result = await call('Page.captureScreenshot', {format: 'png'});
  await writeFile(join(output, name + '.png'), Buffer.from(result.data, 'base64'));
  screenshots.push(name + '.png');
}
async function viewport(width) {
  await call('Emulation.setDeviceMetricsOverride', {width, height: 900, deviceScaleFactor: 1, mobile: width < 600});
}
const introSelector = 'iframe[data-world-component]';
const readyIntro = '!!document.querySelector(".xf-world") && [...document.images].every(i => i.complete && i.naturalWidth > 0)';
async function introduction(worldId, width) {
  await viewport(width);
  await navigate('/worlds/' + worldId);
  let run = await frameUntil(readyIntro, introSelector);
  await until('[...document.querySelectorAll("[data-role-strip=expanded] img")].length===3 && [...document.querySelectorAll("[data-role-strip=expanded] img")].every(i=>i.complete&&i.naturalWidth>0)');
  assert.equal(await evaluate('document.querySelectorAll("[data-role-strip=expanded] [data-role-action=select]").length'), 1);
  await click('收起世界概览');
  await until('Number(document.querySelector("[data-collapse-progress]").dataset.collapseProgress) > .999');
  run = await frameUntil(readyIntro, introSelector);
  const before = await run('(() => { let isolated=false; try { void parent.document.body; } catch { isolated=true; } return {isolated, width:innerWidth, scrollWidth:document.documentElement.scrollWidth, images:[...document.images].map(i=>({src:i.src,width:i.naturalWidth}))}; })()');
  assert(before.isolated, 'Introduction must run in the isolated Stage');
  assert(before.scrollWidth <= before.width + 1, 'Introduction overflows at ' + width);
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Host overflows at ' + width);
  assert(before.images.every(image => new URL(image.src).origin !== origin && image.src.includes('/world-assets/' + worldId + '/assets/images/')));
  await shot('introduction-' + width);
  await run('document.querySelector(".xf-cta").click()');
  await until('document.activeElement===document.querySelector(".xf-people")', run);
  const people = [];
  for (const [id, name, asset] of [
    ['user', '掌柜', 'keeper.jpg'], ['li-yuer', '李鱼儿', 'li-yuer.jpg'], ['li-niaoer', '李鸟儿', 'li-niaoer.jpg'],
  ]) {
    await run('[...document.querySelectorAll(".xf-personbutton")].find(e=>e.textContent===' + JSON.stringify(name) + ').click()');
    await until('document.querySelector(".xf-portrait")?.dataset.person===' + JSON.stringify(id) +
      ' && document.querySelector(".xf-portrait img")?.naturalWidth>0', run);
    const person = await run('({name:document.querySelector(".xf-person h3").textContent,src:document.querySelector(".xf-portrait img").src,pressed:document.querySelectorAll(".xf-personbutton[aria-pressed=true]").length})');
    assert.equal(person.name, name);
    assert.equal(person.pressed, 1);
    assert(person.src.endsWith('/' + asset), 'Wrong character portrait');
    people.push({name, asset});
  }
  await run('document.querySelector(".xf-people").scrollIntoView({block:"start",behavior:"instant"})');
  await shot('family-' + width);
  assert(await run('document.documentElement.scrollWidth<=innerWidth+1'), 'Family panel overflows');
  metrics['introduction' + width] = {isolated: before.isolated, viewportWidth: before.width, scrollWidth: before.scrollWidth, people, ctaFocus: true};
}

try {
  await mkdir(output, {recursive: true});
  if (!process.argv[2]) {
    const server = spawn(process.execPath, ['--import', require.resolve('tsx'), join(here, 'verify-server.mts'), '--serve', '--manifest', manifestPath], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    children.push(server);
    server.stdout.on('data', data => { serverLogs += data; });
    server.stderr.on('data', data => { serverLogs += data; });
  }
  let manifest;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); break; } catch {}
    await delay(100);
  }
  assert(manifest, 'Isolated server did not start: ' + serverLogs);
  origin = manifest.origin ?? 'http://127.0.0.1:' + manifest.port;
  const chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--no-first-run', '--disable-gpu', '--no-proxy-server',
    '--disable-background-timer-throttling', '--remote-debugging-port=0',
    '--user-data-dir=' + join(temporary, 'chrome'), 'about:blank',
  ], {stdio: 'ignore'});
  children.push(chrome);
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = Number((await readFile(join(temporary, 'chrome/DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch {}
    await delay(100);
  }
  assert(port, 'Chrome did not start');
  const tab = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(item => item.type === 'page');
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true});
    ws.addEventListener('error', reject, {once: true});
  });
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text);
    if (data.method === 'Runtime.executionContextCreated') contexts.set(data.params.context.id, data.params.context);
    if (data.method === 'Runtime.executionContextDestroyed') contexts.delete(data.params.executionContextId);
    if (data.method === 'Network.requestWillBeSent') urls.add(data.params.request.url);
    if (data.method === 'Network.responseReceived' && data.params.response.status >= 400) failedResponses.push({status: data.params.response.status, url: data.params.response.url});
    if (data.id) {
      const item = pending.get(data.id);
      if (item) {
        clearTimeout(item.timer); pending.delete(data.id);
        data.error ? item.reject(Error(JSON.stringify(data.error))) : item.resolve(data.result);
      }
    }
  });
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  await call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await viewport(1280);
  await navigate('/worlds');
  await until('!!document.querySelector("input[type=file]")');
  assert(await evaluate('document.querySelector("input[type=file]").accept.includes(".zip")'));
  const fileInput = await call('Runtime.evaluate', {expression: 'document.querySelector("input[type=file]")'});
  await call('DOM.setFileInputFiles', {objectId: fileInput.result.objectId, files: [join(here, '../xiaofanguan-world.zip')]});
  await until('location.pathname.startsWith("/worlds/")');
  const worldId = await evaluate('location.pathname.split("/").at(-1)');
  const card = JSON.parse(await readFile(join(here, 'package/world.json'), 'utf8')).data;
  await introduction(worldId, 1280);
  await click('开局');
  for (let index = 0; index < card.openings.length; index++) {
    const opening = card.openings[index];
    await until('[...document.querySelectorAll("h3")].some(e=>e.textContent===' + JSON.stringify(opening.name) + ')');
    await until('(() => {const text=[document.body.innerText,...[...document.querySelectorAll("iframe[srcdoc]")].map(frame=>frame.contentDocument?.body?.innerText??"")].join("\\n"); return text.includes(' + JSON.stringify(opening.content.slice(0, 30)) + ') && text.includes(' + JSON.stringify(opening.content.slice(-30)) + ');})()');
    if (index < card.openings.length - 1) await click('下一个开局');
  }
  await click('开始会话');
  await until('!!document.querySelector("[role=dialog]")');
  assert(await evaluate('document.querySelector("[role=dialog]").innerText.includes("掌柜")'));
  await click('确认开始');
  await until('location.pathname.startsWith("/sessions/")');
  const sessionPath = await evaluate('location.pathname');
  let stage = await frameUntil('!!document.querySelector(".sr-chat-messages") && document.body.innerText.includes(' + JSON.stringify(card.openings[2].content.slice(-30)) + ')');
  assert(await stage('(() => { try { void parent.document.body; return false; } catch { return true; } })()'), 'Official Stage is not isolated');
  await evaluate('(() => {const e=document.querySelector("[contenteditable]"); e.focus(); document.execCommand("insertText",false,"把新炒的青菜端上桌，招呼鱼儿和鸟儿趁热吃饭。");})()');
  await until('!!document.querySelector("[aria-label=发送消息]") && !document.querySelector("[aria-label=发送消息]").disabled');
  await click('发送消息');
  stage = await frameUntil('document.body.innerText.includes(' + JSON.stringify(manifest.narrative) + ') && document.querySelectorAll(".sr-suggestions button").length===3');
  assert(await stage('!document.body.innerText.includes("<state_update>") && !document.body.innerText.includes("<action_suggestions>")'), 'Protocol markup leaked into story');
  await shot('session-1280');
  await viewport(375);
  stage = await frameUntil('document.querySelectorAll(".sr-suggestions button").length===3');
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Host session overflows mobile');
  assert(await stage('document.documentElement.scrollWidth<=innerWidth+1'), 'WorldStory overflows mobile');
  await shot('session-375');
  await introduction(worldId, 375);
  const remote = [...urls].filter(url => /^https?:/.test(url) && ![origin, manifest.stageOrigin].includes(new URL(url).origin));
  assert.deepEqual(remote, [], 'Card requested external resources');
  assert.deepEqual(failedResponses, [], 'Failed HTTP responses');
  assert.deepEqual(exceptions, [], 'Browser runtime errors');
  const build = JSON.parse(await readFile(join(here, 'build-report.json'), 'utf8'));
  const report = {
    status: 'pass',
    artifact: build.artifact, zipSha256: build.sha256,
    checks: {
      studioFileInputZipImport: true, readonlyFileComponentCompiledAndExecuted: true,
      isolatedStageOrigins: true, allThreeLocalPortraits: true, introductionCtaAndCharacterSwitching: true,
      allThreeOpeningPreviews: true, onlyKeeperSelectable: true,
      sessionCreatedFromThirdOriginalOpening: true, officialWorldStory: true,
      userTurnAndFakeProviderReply: true, actionSuggestions: 3,
      noProtocolMarkupInStory: true, externalResourceRequests: 0, browserExceptions: 0, failedHttpResponses: 0,
      widths: [1280, 375],
    },
    metrics, screenshots,
    limits: ['Only the model transport is fake; this verifies package loading, rendering, context transport, persistence and UI, not real-model narrative quality.'],
  };
  await writeFile(join(output, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({status: 'pass', report: 'plan/xiaofanguan-world/verification/browser-report.json', screenshots, sessionCreated: Boolean(sessionPath)}, null, 2));
} catch (error) {
  if (ws?.readyState === WebSocket.OPEN) {
    try { await shot('failure'); } catch {}
  }
  throw error;
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  ws?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGINT');
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await rm(temporary, {recursive: true, force: true});
}
