import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProcessList, parseWorkingDirectories, selectWorkspaceTargets, serviceKind } from './stop.mjs';

const root = '/work/Silly Realms';
const pnpm = 'node /opt/pnpm/bin/pnpm.cjs';
const row = (pid, ppid, pgid, command) => ({ pid, ppid, pgid, command });
const runner = (workspace, script) => pnpm + ' --filter @sillyrealms/' + workspace + ' run ' + script;

test('process discovery preserves paths with spaces and ignores already dead processes', () => {
  assert.deepEqual(parseProcessList(
    ' 20 10 20 S+ node /work/Silly Realms/scripts/start.mjs debug\n' +
    ' 21 20 21 Z node <defunct>\n'),
  [row(20, 10, 20, 'node /work/Silly Realms/scripts/start.mjs debug')]);
  assert.deepEqual([...parseWorkingDirectories('p20\nfcwd\nn/work/Silly Realms\np30\nfcwd\nn/work/other\n')],
    [[20, root], [30, '/work/other']]);
});

test('only development and local preview entry points qualify as service seeds', () => {
  assert.equal(serviceKind('node scripts/start.mjs debug'), 'launcher');
  assert.equal(serviceKind('node ' + root + '/scripts/start.mjs dev'), 'launcher');
  assert.equal(serviceKind(pnpm + ' start'), 'root');
  assert.equal(serviceKind(pnpm + ' run dev:server'), 'root');
  assert.equal(serviceKind(runner('server', 'debug')), 'serverRunner');
  assert.equal(serviceKind(runner('web', 'dev:world-preview')), 'webRunner');
  assert.equal(serviceKind('node ' + root + '/apps/web/node_modules/.bin/../vite/bin/vite.js --mode world-preview'), 'web');
  assert.equal(serviceKind('node --watch --inspect=127.0.0.1:9229 --import tsx src/server.ts --debug'), 'server');
  for (const command of [
    pnpm + ' stop', pnpm + ' build', pnpm + ' test', runner('server', 'preview'),
    'node /tmp/vite/bin/vite.js build', 'node scripts/world-card.mts check',
    'node scripts/start.test.mjs', 'node unrelated.js', 'echo pnpm debug',
    'node unrelated.js /opt/pnpm/pnpm.cjs dev',
  ]) assert.equal(serviceKind(command), null, command);
});

test('stop selects the current checkout and its complete child groups, never another checkout', () => {
  const rows = [
    row(10, 1, 10, '/bin/zsh'),
    row(20, 10, 20, pnpm + ' debug'),
    row(21, 20, 20, 'node scripts/start.mjs debug'),
    row(30, 21, 30, runner('server', 'debug')),
    row(31, 30, 30, 'node --watch --import tsx src/server.ts --debug'),
    row(32, 31, 30, 'node --import tsx src/server.ts --debug'),
    row(40, 21, 40, runner('web', 'dev')),
    row(41, 40, 40, 'node /tmp/vite/bin/vite.js'),
    row(42, 41, 40, '/work/esbuild --service=1'),
    row(50, 10, 50, pnpm + ' debug'),
    row(51, 50, 50, 'node scripts/start.mjs debug'),
    row(52, 51, 52, runner('web', 'dev')),
  ];
  const directories = new Map([
    [20, root], [21, root], [30, root], [31, root + '/apps/server'], [32, root + '/apps/server'],
    [40, root], [41, root + '/apps/web'], [50, root + '-other'], [51, root + '-other'], [52, root + '-other'],
  ]);
  const targets = selectWorkspaceTargets(rows, directories, root, 999);
  assert.deepEqual(targets.groupIds, [20, 30, 40]);
  assert.deepEqual(targets.processIds, []);
  assert.deepEqual(targets.processes.map(item => item.pid), [20, 21, 30, 31, 32, 40, 41, 42]);
});

test('a shared terminal process group is never killed wholesale', () => {
  const rows = [
    row(10, 1, 10, '/bin/zsh'),
    row(20, 10, 10, 'node scripts/start.mjs dev'),
    row(30, 20, 30, runner('web', 'dev')),
    row(31, 30, 30, 'node /tmp/vite/bin/vite.js'),
    row(40, 10, 10, 'node unrelated.js'),
  ];
  const targets = selectWorkspaceTargets(rows, new Map([[20, root], [30, root]]), root, 999);
  assert.deepEqual(targets.groupIds, [30]);
  assert.deepEqual(targets.processIds, [20]);
  assert.ok(!targets.processes.some(item => [10, 40].includes(item.pid)));
});

test('recognizes legacy service groups even when their original launcher has disappeared', () => {
  const rows = [
    row(40, 1, 40, runner('web', 'dev:world-preview')),
    row(41, 40, 40, 'node /tmp/vite/bin/vite.js --mode world-preview'),
    row(60, 1, 59, 'node --import tsx src/server.ts --debug'),
    row(70, 1, 70, 'node /tmp/vite/bin/vite.js build'),
  ];
  const targets = selectWorkspaceTargets(rows, new Map([
    [40, root], [41, root + '/apps/web'], [60, root + '/apps/server'], [70, root + '/apps/web'],
  ]), root, 999);
  assert.deepEqual(targets.groupIds, [40, 59]);
  assert.deepEqual(targets.processIds, []);
  assert.deepEqual(targets.processes.map(item => item.pid), [40, 41, 60]);
});

test('unverified working directories and similarly named sibling folders are excluded', () => {
  const rows = [
    row(20, 1, 20, 'node scripts/start.mjs dev'),
    row(30, 1, 30, runner('web', 'dev')),
    row(40, 1, 40, 'node --import tsx src/server.ts'),
  ];
  assert.deepEqual(selectWorkspaceTargets(rows, new Map([[30, root + '-backup'], [40, root]]), root, 999),
    { groupIds: [], processIds: [], processes: [] });
});

test('the stop command and its ancestors are excluded even when invoked underneath a service', () => {
  const rows = [
    row(20, 1, 20, 'node scripts/start.mjs dev'),
    row(30, 20, 30, runner('web', 'dev')),
    row(31, 30, 30, 'node scripts/stop.mjs'),
  ];
  const targets = selectWorkspaceTargets(rows, new Map([[20, root], [30, root]]), root, 31);
  assert.deepEqual(targets, { groupIds: [], processIds: [], processes: [] });
});

test('an absolute startup entry belongs to its own repo even when invoked from another cwd', () => {
  const other = '/work/other';
  const rows = [
    row(20, 1, 20, 'node ' + other + '/scripts/start.mjs dev'),
    row(21, 20, 21, runner('web', 'dev')),
    row(30, 1, 30, 'node ' + root + '/scripts/start.mjs debug'),
    row(31, 30, 31, runner('server', 'debug')),
    row(40, 1, 40, 'node --import tsx ' + other + '/apps/server/src/server.ts'),
  ];
  const directories = new Map([[20, root], [21, other], [30, other], [31, root], [40, root + '/apps/server']]);
  const targets = selectWorkspaceTargets(rows, directories, root, 999);
  assert.deepEqual(targets.groupIds, [30, 31]);
  assert.deepEqual(targets.processes.map(item => item.pid), [30, 31]);
});
