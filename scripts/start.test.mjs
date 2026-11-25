import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { shutdownProcessGroups, shutdownProcesses } from './start.mjs';

const posix = process.platform !== 'win32';
const startPath = fileURLToPath(new URL('./start.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function exists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function until(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(10);
  }
}
function kill(pid) {
  try { process.kill(pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function tracked(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const records = [];
  let buffer = '', output = '', result;
  child.stdout.on('data', data => {
    output += data; buffer += data;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      try { records.push(JSON.parse(line)); } catch { /* Non-fixture startup output. */ }
    }
  });
  child.stderr.on('data', data => { output += data; });
  child.on('error', error => { result = { error }; });
  child.on('exit', (code, signal) => { result = { code, signal }; });
  return { child, records, get result() { return result; }, get output() { return output; } };
}

const idleCode = `
  process.on('SIGTERM', () => { if (process.env.SR_FIXTURE_STUBBORN !== '1') process.exit(0); });
  console.log(JSON.stringify({kind:'child',pid:process.pid,parent:process.ppid}));
  setInterval(() => {}, 1000);
`;
async function idle(t, { detached = true, stubborn = false } = {}) {
  const fixture = tracked(process.execPath, ['-e', idleCode], {
    detached, env: { ...process.env, SR_FIXTURE_STUBBORN: stubborn ? '1' : '0' },
  });
  t.after(async () => {
    if (fixture.child.pid) kill(detached ? -fixture.child.pid : fixture.child.pid);
    await until(() => fixture.result, 'fixture failed to exit');
  });
  await until(() => fixture.records.length === 1, 'fixture failed to start: ' + fixture.output);
  return fixture;
}

// This replaces pnpm only within the test subprocess. No project services,
// sockets, credentials or database are opened.
const fakePnpm = `
  import {spawn} from 'node:child_process';
  const script=process.argv.at(-1);
  spawn(process.execPath,['-e',${JSON.stringify(idleCode)}],{stdio:'inherit'});
  process.on('SIGTERM',()=>{if(process.env.SR_FIXTURE_STUBBORN!=='1')process.exit(0);});
  process.on('SIGUSR1',()=>process.exit(7));
  console.log(JSON.stringify({kind:'leader',pid:process.pid,script,cwd:process.cwd()}));
  setInterval(()=>{},1000);
`;
async function launcher(t, mode, stubborn = false) {
  const directory = await mkdtemp(join(tmpdir(), 'sr-start-'));
  const pnpm = join(directory, 'pnpm.mjs');
  await writeFile(pnpm, fakePnpm);
  const fixture = tracked(process.execPath, [startPath, mode], {
    cwd: directory, detached: true,
    env: { ...process.env, npm_execpath: pnpm, SR_FIXTURE_STUBBORN: stubborn ? '1' : '0' },
  });
  t.after(async () => {
    for (const record of fixture.records.filter(record => record.kind === 'leader')) kill(-record.pid);
    if (fixture.child.pid) kill(-fixture.child.pid);
    await until(() => fixture.result, 'launcher failed to exit');
    await rm(directory, { recursive: true, force: true });
  });
  await until(() => fixture.records.length === 6, 'launcher fixtures failed to start: ' + fixture.output);
  return fixture;
}
function assertStopped(fixture) {
  for (const record of fixture.records) assert.equal(exists(record.pid), false, `PID ${record.pid} survived: ${fixture.output}`);
}

test('shutdown rejects unsafe IDs before sending any signal', async () => {
  await assert.rejects(shutdownProcessGroups([0]), /greater than 1/);
  await assert.rejects(shutdownProcessGroups([1]), /greater than 1/);
  await assert.rejects(shutdownProcesses([-1]), /greater than 1/);
  await assert.rejects(shutdownProcesses([1]), /greater than 1/);
});

test('single-PID cleanup leaves siblings sharing the shell group alive', { skip: !posix }, async t => {
  const first = await idle(t, { detached: false });
  const sibling = await idle(t, { detached: false });
  await shutdownProcesses([first.child.pid]);
  assert.equal(exists(first.child.pid), false);
  assert.equal(exists(sibling.child.pid), true);
});

test('graceful group cleanup is safe to repeat after a process exits', { skip: !posix }, async t => {
  const fixture = await idle(t);
  await shutdownProcessGroups([fixture.child.pid]);
  assert.equal(exists(-fixture.child.pid), false);
  await shutdownProcessGroups([fixture.child.pid]);
});

test('a departed wrapper does not hide a descendant ignoring TERM', { skip: !posix }, async t => {
  const code = `
    const {spawn}=require('node:child_process');
    spawn(process.execPath,['-e',${JSON.stringify(idleCode)}],{
      stdio:'inherit',env:{...process.env,SR_FIXTURE_STUBBORN:'1'}
    });
    process.on('SIGTERM',()=>process.exit(0));
    console.log(JSON.stringify({kind:'leader',pid:process.pid}));
    setInterval(()=>{},1000);
  `;
  const fixture = tracked(process.execPath, ['-e', code], { detached: true });
  t.after(async () => { kill(-fixture.child.pid); await until(() => fixture.result, 'wrapper failed to exit'); });
  await until(() => fixture.records.length === 2, 'descendant failed to start');
  await shutdownProcessGroups([fixture.child.pid], { timeoutMs: 80 });
  assertStopped(fixture);
  assert.equal(exists(-fixture.child.pid), false);
});

test('aborting the grace period forces cleanup immediately', { skip: !posix }, async t => {
  const fixture = await idle(t, { stubborn: true });
  const force = new AbortController();
  const started = Date.now();
  const closing = shutdownProcessGroups([fixture.child.pid], { timeoutMs: 5000, signal: force.signal });
  await delay(30); force.abort(); await closing;
  assert.equal(exists(fixture.child.pid), false);
  assert.ok(Date.now() - started < 2000, 'abort waited for the full grace period');
});

for (const [mode, signal, exitCode] of [['dev', 'SIGINT', 130], ['debug', 'SIGTERM', 143], ['start', 'SIGHUP', 129]]) {
  test(`${mode} closes all services on ${signal}, even when invoked outside the repo`, { skip: !posix }, async t => {
    const fixture = await launcher(t, mode);
    for (const record of fixture.records.filter(record => record.kind === 'leader')) assert.equal(record.cwd, repositoryRoot);
    fixture.child.kill(signal);
    await until(() => fixture.result, 'launcher did not finish cleanup: ' + fixture.output);
    assert.equal(fixture.result.code, exitCode, fixture.output);
    assertStopped(fixture);
  });
}

test('an unexpected service exit cleans its descendants and sibling services', { skip: !posix }, async t => {
  const fixture = await launcher(t, 'dev');
  const service = fixture.records.find(record => record.kind === 'leader' && record.script === 'dev:world-preview');
  process.kill(service.pid, 'SIGUSR1');
  await until(() => fixture.result, 'launcher survived a service failure: ' + fixture.output);
  assert.equal(fixture.result.code, 7, fixture.output);
  assertStopped(fixture);
});

test('a second interrupt forces cleanup before the normal deadline', { skip: !posix }, async t => {
  const fixture = await launcher(t, 'dev', true);
  const started = Date.now();
  fixture.child.kill('SIGINT');
  await delay(100);
  assert.equal(fixture.result, undefined, 'first interrupt skipped the grace period');
  fixture.child.kill('SIGINT');
  await until(() => fixture.result, 'second interrupt did not finish cleanup: ' + fixture.output, 2500);
  assert.equal(fixture.result.code, 130, fixture.output);
  assertStopped(fixture);
  assert.ok(Date.now() - started < 2500, 'second interrupt waited for the normal deadline');
});
