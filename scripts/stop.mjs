import { execFile } from 'node:child_process';
import { readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { shutdownProcessGroups, shutdownProcesses } from './start.mjs';

const execute = promisify(execFile);
const rootPnpm = /^(?:run\s+)?(?:dev|debug|start|dev:server|dev:web|dev:stage)\s*$/;
const filteredPnpm = /^--filter\s+(@sillyrealms\/(?:server|web))\s+(?:run\s+)?(dev|debug|start|preview|dev:world-preview|preview:world-preview)\s*$/;
const nodeCommand = /^(?:\S*\/)?node(?:\.exe)?\s+(.+)$/;
const unquote = value => /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;

function startupEntry(command) {
  const args = command.match(nodeCommand)?.[1];
  const match = args?.match(/^(.+?)\s+(?:dev|debug|start)\s*$/);
  const entry = match && unquote(match[1]);
  return entry && /(?:^|\/)scripts\/start\.mjs$/.test(entry) ? entry : null;
}

function pnpmArguments(command) {
  const native = command.match(/^(?:\S*\/)?pnpm(?:\.exe)?\s+(.+)$/);
  if (native) return native[1];
  const args = command.match(nodeCommand)?.[1];
  const invocation = args?.match(/^("[^"]+"|'[^']+'|\S+)\s+(.+)$/);
  return invocation && /^pnpm(?:\.(?:cjs|mjs|js))?$/.test(basename(unquote(invocation[1]))) ? invocation[2] : null;
}

/** Match only our runtime entry points; cwd and the startup script's path are checked separately. */
export function serviceKind(command) {
  if (startupEntry(command)) return 'launcher';
  const pnpm = pnpmArguments(command);
  const filtered = pnpm?.match(filteredPnpm);
  if (filtered) {
    const server = filtered[1] === '@sillyrealms/server';
    return (server ? ['dev', 'debug', 'start'] : ['dev', 'preview', 'dev:world-preview', 'preview:world-preview']).includes(filtered[2])
      ? (server ? 'serverRunner' : 'webRunner') : null;
  }
  if (pnpm && rootPnpm.test(pnpm)) return 'root';
  if (!nodeCommand.test(command)) return null;
  if (/\/vite\/bin\/vite\.js(?:\s+preview)?(?:\s+--mode\s+world-preview)?\s*$/.test(command)) return 'web';
  if (/(?:^|\s|\/)src\/server\.ts(?:\s+--debug)?\s*$/.test(command)) return 'server';
  return null;
}

export function parseProcessList(output) {
  return output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || match[4].startsWith('Z')) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[5] }];
  });
}

export function parseWorkingDirectories(output) {
  const directories = new Map();
  let pid;
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) directories.set(pid, line.slice(1));
  }
  return directories;
}

function ownsService(kind, command, cwd, root) {
  if (!cwd) return false;
  if (kind === 'launcher') return resolve(cwd, startupEntry(command)) === join(root, 'scripts', 'start.mjs');
  if (kind === 'server') {
    const withoutDebug = command.replace(/\s+--debug\s*$/, '').trim();
    if (![join(root, 'apps', 'server', 'src', 'server.ts'), 'src/server.ts'].some(entry => withoutDebug.endsWith(' ' + entry))) return false;
  }
  if (kind === 'root') return cwd === root;
  const directory = join(root, 'apps', kind.startsWith('server') ? 'server' : 'web');
  return cwd === directory || (kind.endsWith('Runner') && cwd === root);
}

/** A verified service owns its descendants. An unrelated member makes its process group unsafe to signal. */
export function selectWorkspaceTargets(processes, directories, root, currentPid = process.pid) {
  const byId = new Map(processes.map(row => [row.pid, row]));
  const excluded = new Set();
  for (let pid = currentPid; pid && !excluded.has(pid); pid = byId.get(pid)?.ppid) excluded.add(pid);
  const owned = new Set(processes.filter(row => {
    const kind = serviceKind(row.command);
    return kind && !excluded.has(row.pid) && ownsService(kind, row.command, directories.get(row.pid), root);
  }).map(row => row.pid));
  let added;
  do {
    added = false;
    for (const row of processes) {
      if (!owned.has(row.pid) && !excluded.has(row.pid) && owned.has(row.ppid)) {
        owned.add(row.pid);
        added = true;
      }
    }
  } while (added);
  const groups = new Set();
  for (const row of processes) {
    if (owned.has(row.pid) && row.pgid > 1 &&
        processes.every(member => member.pgid !== row.pgid || owned.has(member.pid))) {
      groups.add(row.pgid);
    }
  }
  return {
    groupIds: [...groups],
    processIds: processes.filter(row => owned.has(row.pid) && !groups.has(row.pgid)).map(row => row.pid),
    processes: processes.filter(row => owned.has(row.pid)),
  };
}

export async function inspectWorkspace(root) {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new Error('pnpm stop currently supports macOS and Linux. On Windows, use Ctrl+C in the startup terminal.');
  }
  root = await realpath(root);
  const { stdout } = await execute('ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,stat=,command='], { maxBuffer: 4 * 1024 * 1024 });
  const processes = parseProcessList(stdout);
  const candidates = processes.filter(row => serviceKind(row.command));
  const directories = new Map();
  if (process.platform === 'linux') {
    await Promise.all(candidates.map(async row => {
      try { directories.set(row.pid, await readlink('/proc/' + row.pid + '/cwd')); }
      catch (error) { if (!['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(error.code)) throw error; }
    }));
  } else if (candidates.length) {
    let output;
    try {
      ({ stdout: output } = await execute('lsof', ['-a', '-p', candidates.map(row => row.pid).join(','), '-d', 'cwd', '-Fn'],
        { maxBuffer: 4 * 1024 * 1024 }));
    } catch (error) {
      // A process can exit between ps and lsof; lsof may still return other readable cwd records.
      if (error.code !== 1) throw error;
      output = error.stdout ?? '';
    }
    for (const [pid, cwd] of parseWorkingDirectories(output)) directories.set(pid, cwd);
  }
  return selectWorkspaceTargets(processes, directories, root);
}

export async function stopWorkspace(root, { dryRun = false } = {}) {
  const targets = await inspectWorkspace(root);
  if (!targets.processes.length) {
    console.log('没有正在运行的 SR 本地服务。');
    return;
  }
  if (dryRun) {
    console.log('当前仓库的服务进程：');
    for (const row of targets.processes) console.log('PID ' + row.pid + ' / PGID ' + row.pgid + ': ' + row.command);
    return;
  }
  console.log('正在停止当前仓库的 SR 本地服务…');
  await Promise.all([
    shutdownProcessGroups(targets.groupIds),
    shutdownProcesses(targets.processIds),
  ]);
  const remaining = await inspectWorkspace(root);
  if (remaining.processes.length) {
    throw new Error('仍有 SR 服务进程运行：' + remaining.processes.map(row => row.pid).join(', ') + '。请检查后重试 pnpm stop。');
  }
  console.log('SR 本地服务已停止。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (args.some(arg => arg !== '--dry-run')) throw new Error('Usage: pnpm stop [--dry-run]');
    await stopWorkspace(dirname(dirname(fileURLToPath(import.meta.url))), { dryRun: args.includes('--dry-run') });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
