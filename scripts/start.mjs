import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { pathToFileURL } from 'node:url';

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

function launch(commands) {
  const children = [];
  const windows = process.platform === 'win32';
  let stopping = false;
  function stop(code) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of children) {
      if (!child.pid) continue;
      if (windows) {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => stop(128 + constants.signals[signal]));
  }
  for (const [workspace, script] of commands) {
    const args = ['--filter', workspace, 'run', script];
    // Use the pnpm that invoked the root script, including on Windows.
    const pnpm = process.env.npm_execpath;
    const jsLauncher = pnpm && /\.(?:cjs|mjs|js)$/i.test(pnpm);
    const child = spawn(jsLauncher ? process.execPath : pnpm || 'pnpm',
      jsLauncher ? [pnpm, ...args] : args, { stdio: 'inherit', detached: !windows });
    children.push(child);
    child.once('error', error => {
      console.error(workspace, script, error.message);
      stop(1);
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
