import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';

export function workspaceCommands(mode) {
  if (!['dev', 'debug', 'start'].includes(mode)) {
    throw new Error('Usage: pnpm dev | pnpm debug | pnpm start');
  }
  const built = mode === 'start';
  return [
    ['@sillyrealms/server', mode],
    ['@sillyrealms/web', built ? 'preview' : 'dev'],
    ['@sillyrealms/web', built ? 'preview:world-preview' : 'dev:world-preview'],
  ];
}

function alive(target) {
  try { process.kill(target, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    // EPERM still means the target exists; group teardown can briefly pass
    // through this state on macOS. Let the bounded wait confirm disappearance.
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function signalTargets(targets, signal) {
  for (const target of targets) {
    try { process.kill(target, signal); }
    catch (error) {
      // Try every target even if one is already exiting. Persistent permission
      // failures remain live and make the final verification fail.
      if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
    }
  }
}

async function waitForExit(targets, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = targets.filter(alive);
    if (!remaining.length || signal?.aborted || Date.now() >= deadline) return remaining;
    await new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(50, Math.max(0, deadline - Date.now())));
      signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted) done();
    });
  }
}

async function killWindowsTree(groupId) {
  if (!alive(groupId)) return;
  await new Promise((resolve, reject) => {
    const child = spawn('taskkill', ['/pid', String(groupId), '/t', '/f'], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0 || !alive(groupId)) resolve();
      else reject(new Error(`taskkill failed for PID ${groupId} (exit ${code})`));
    });
  });
}

async function shutdown(processIds, { timeoutMs = 5000, signal } = {}, groups = false) {
  const ids = [...new Set(processIds)];
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 1)) {
    throw new Error('Process IDs must be integers greater than 1');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Invalid shutdown timeout');
  if (!ids.length) return;
  const targets = groups && !windows ? ids.map(id => -id) : ids;
  let remaining;
  if (groups && windows) {
    await Promise.all(ids.map(killWindowsTree));
    remaining = await waitForExit(targets, 2000);
  } else {
    signalTargets(targets, 'SIGTERM');
    remaining = await waitForExit(targets, timeoutMs, signal);
    if (remaining.length) {
      signalTargets(remaining, 'SIGKILL');
      remaining = await waitForExit(remaining, 2000);
    }
  }
  if (remaining.length) throw new Error(`Processes did not exit: ${remaining.map(Math.abs).join(', ')}`);
}

/** IDs are POSIX process-group leaders (or Windows tree roots), never port numbers. */
export function shutdownProcessGroups(groupIds, options) {
  return shutdown(groupIds, options, true);
}

/** Stop only the supplied PIDs, even when they share a group with an interactive shell. */
export function shutdownProcesses(processIds, options) {
  return shutdown(processIds, options);
}

function launch(commands) {
  const children = [];
  const force = new AbortController();
  let stopping;
  const handlers = new Map();
  function stop(code) {
    if (stopping) { force.abort(); return; }
    process.exitCode = code;
    // A pnpm wrapper can exit before its watch/server descendants. Keep the
    // launcher alive until every owned group exits, including after that exit.
    stopping = shutdownProcessGroups(children.map(child => child.pid).filter(Boolean), { signal: force.signal })
      .catch(error => { console.error('WORKSPACE_SHUTDOWN_FAILED', error.message); process.exitCode = 1; })
      .finally(() => { for (const [signal, handler] of handlers) process.off(signal, handler); });
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => stop(128 + constants.signals[signal]);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  for (const [workspace, script] of commands) {
    const args = ['--filter', workspace, 'run', script];
    // Use the pnpm that invoked the root script, including on Windows.
    const pnpm = process.env.npm_execpath;
    const jsLauncher = pnpm && /\.(?:cjs|mjs|js)$/i.test(pnpm);
    const child = spawn(jsLauncher ? process.execPath : pnpm || 'pnpm',
      jsLauncher ? [pnpm, ...args] : args,
      { cwd: repositoryRoot, stdio: 'inherit', detached: !windows });
    children.push(child);
    child.once('error', error => {
      console.error(workspace, script, error.message);
      if (!stopping) stop(1);
    });
    child.once('exit', (code, signal) => {
      if (!stopping) {
        console.error(workspace, script, 'exited', signal ?? code);
        stop(code ?? 1);
      }
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  launch(workspaceCommands(process.argv[2]));
}
