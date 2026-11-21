import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CONFIG_KEYS, loadConfig, renderEnvironment, renderNginx, renderSystemd } from './config.mjs';

const managed = '# Managed by SillyRealms deploy/start.sh.';
const service = 'sillyrealms.service';
const unitPath = '/etc/systemd/system/' + service;
const log = message => console.log('[SR deploy] ' + message);

async function optionalStat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function atomicWrite(path, content, mode = 0o600) {
  const temporary = path + '.tmp-' + randomBytes(8).toString('hex');
  try {
    const file = await open(temporary, 'wx', mode);
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function makePublicDirectory(path) {
  const stat = await optionalStat(path);
  if (stat) {
    if (!stat.isDirectory()) throw new Error('公共静态目录不能是符号链接或文件：' + path);
    return;
  }
  await makePublicDirectory(dirname(path));
  await mkdir(path, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function filesIn(root, prefix = '') {
  const items = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = join(prefix, item.name);
    if (item.isDirectory()) files.push(...await filesIn(root, name));
    else if (item.isFile()) files.push(name);
    else throw new Error('静态产物不能包含符号链接或特殊文件：' + name);
  }
  return files;
}

async function digest(root) {
  const hash = createHash('sha256');
  for (const file of await filesIn(root)) {
    const bytes = await readFile(join(root, file));
    hash.update(file).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return hash.digest('hex');
}

async function publicPermissions(root) {
  await chmod(root, 0o755);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await publicPermissions(path);
    else if (entry.isFile()) await chmod(path, 0o644);
    else throw new Error('静态产物包含特殊文件');
  }
}

/** Content-addressed static releases: a repeated build reuses the same directory. */
export async function publishStatic(projectDir, staticRoot) {
  for (const name of ['dist', 'dist-preview']) {
    const stat = await lstat(join(projectDir, 'apps/web', name));
    if (!stat.isDirectory()) throw new Error('构建产物根目录不能是符号链接或文件：' + name);
  }
  const rootStat = await optionalStat(staticRoot);
  if (rootStat && !rootStat.isDirectory()) throw new Error('STATIC_ROOT 必须是普通目录');
  await makePublicDirectory(staticRoot);
  const marker = join(staticRoot, '.sillyrealms-deploy');
  const markerStat = await optionalStat(marker);
  if (markerStat && !markerStat.isFile()) throw new Error('STATIC_ROOT 管理标记必须是普通文件');
  if (!markerStat) {
    if ((await readdir(staticRoot)).length) throw new Error('STATIC_ROOT 已有非本脚本管理的文件，请使用独立目录');
    await writeFile(marker, 'SillyRealms static releases\n', { flag: 'wx', mode: 0o644 });
  } else if ((await readFile(marker, 'utf8')) !== 'SillyRealms static releases\n') {
    throw new Error('STATIC_ROOT 管理标记无效');
  }
  await chmod(staticRoot, 0o755);
  const releases = join(staticRoot, 'releases');
  const releaseStat = await optionalStat(releases);
  if (releaseStat && !releaseStat.isDirectory()) throw new Error('releases 必须是普通目录');
  await mkdir(releases, { recursive: true, mode: 0o755 });
  await chmod(releases, 0o755);
  const temporary = await mkdtemp(join(releases, '.pending-'));
  try {
    for (const [source, surface] of [['dist', 'web'], ['dist-preview', 'stage']]) {
      const sourceRoot = join(projectDir, 'apps/web', source);
      for (const file of await filesIn(sourceRoot)) {
        const destination = join(temporary, surface, file);
        await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
        await copyFile(join(sourceRoot, file), destination);
      }
    }
    for (const file of ['web/index.html', 'stage/frame.html', 'stage/world-component.html']) {
      await access(join(temporary, file));
    }
    await publicPermissions(temporary);
    const hash = await digest(temporary);
    const release = join(releases, hash);
    const existingRelease = await optionalStat(release);
    if (existingRelease) {
      if (!existingRelease.isDirectory()) throw new Error('静态发布必须是普通目录');
      if (await digest(release) !== hash) throw new Error('已有静态发布目录内容被修改，拒绝覆盖');
    } else {
      await rename(temporary, release);
    }
    return release;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function switchCurrent(staticRoot, target) {
  const current = join(staticRoot, 'current');
  const previous = await optionalStat(current);
  if (previous && !previous.isSymbolicLink()) throw new Error('静态 current 已存在且不是发布符号链接');
  if (target === null) {
    await unlink(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return;
  }
  const temporary = current + '.tmp-' + randomBytes(8).toString('hex');
  try {
    await symlink(target, temporary);
    await rename(temporary, current);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Never replace a master key, especially when encrypted credentials already exist. */
export async function provisionKey(config) {
  const stat = await optionalStat(config.keyFile);
  if (stat) {
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size !== 32) {
      throw new Error('已有 credential.key 必须为当前用户拥有、0600 权限的 32 字节普通文件');
    }
    return;
  }
  const entries = await readdir(config.credentialsDir).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  if (entries.length) throw new Error('已有加密凭据但主密钥缺失，请恢复 credential.key，不能生成新密钥');
  const file = await open(config.keyFile, 'wx', 0o600);
  try { await file.writeFile(randomBytes(32)); await file.sync(); }
  finally { await file.close(); }
}

function command(commandName, args, options = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(commandName, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      signal: options.signal,
    });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0 || options.allowFailure) resolveCommand({ code, stdout, stderr });
      else reject(new Error(commandName + ' 执行失败（' + (signal ?? code) + '）' + (stderr ? '\n' + stderr.trim() : '')));
    });
  });
}

async function resolvedPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await resolvedPath(dirname(path)), basename(path));
  }
}

async function validateStaticLocation(config) {
  const destination = await resolvedPath(config.staticRoot);
  for (const directory of [config.projectDir, config.dataRoot, config.configDir, config.nginxDir]) {
    const protectedPath = await resolvedPath(directory);
    if (destination === protectedPath || destination.startsWith(protectedPath + '/') || protectedPath.startsWith(destination + '/')) {
      throw new Error('静态目录的真实路径与源码、数据或配置目录重叠');
    }
  }
}

async function checkStaticTraversal(staticRoot) {
  for (let path = await realpath(staticRoot); path !== '/'; path = dirname(path)) {
    if (!((await lstat(path)).mode & 0o001)) {
      throw new Error('Nginx 无法遍历静态目录的上级目录：' + path + '；请改用 /var/www/sillyrealms 等公共静态目录');
    }
  }
}

async function validateEnvironment(config) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('需要 Node.js >= 22.19.0');
  await validateStaticLocation(config);
  const manifest = JSON.parse(await readFile(join(config.projectDir, 'package.json'), 'utf8'));
  const expected = manifest.packageManager?.replace(/^pnpm@/, '');
  const actual = (await command('pnpm', ['--version'], { capture: true })).stdout.trim();
  if (!expected || actual !== expected) throw new Error('需要仓库声明的 pnpm ' + expected + '，当前为 ' + actual);
  await command('nginx', ['-v'], { capture: true });
  for (const file of [
    'pnpm-lock.yaml', 'apps/server/package.json', 'apps/web/package.json',
    'deploy/nginx.conf.template', 'deploy/server.mjs',
  ]) await access(join(config.projectDir, file));
  for (const file of [config.webTlsCert, config.webTlsKey, config.stageTlsCert, config.stageTlsKey, config.tlsCaFile].filter(Boolean)) {
    await access(file, constants.R_OK);
  }
}

async function waitForBackend(config, signal) {
  for (let attempt = 0; attempt < 60; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch('http://127.0.0.1:' + config.serverPort + '/health', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
      });
      const value = await response.json();
      if (response.ok && value.success === true && value.data?.ok === true) return;
    } catch { signal.throwIfAborted(); }
    await delay(500, undefined, { signal });
  }
  throw new Error('后端健康检查未通过，请运行 journalctl -u sillyrealms -n 80');
}

export async function verifyNginx(config, run) {
  const request = async (surface, path, statusOnly = false) => {
    const loopback = surface.hostname.startsWith('[') ? '[::1]' : '127.0.0.1';
    const args = ['--noproxy', '*', '--silent', '--show-error', '--max-time', '10',
      '--connect-to', '::' + loopback + ':' + surface.port];
    if (config.tlsCaFile && surface.protocol === 'https:') args.push('--cacert', config.tlsCaFile);
    if (statusOnly) args.push('--output', '/dev/null', '--write-out', '%{http_code}');
    else args.push('--fail');
    return (await run('curl', [...args, surface.origin + path], { capture: true })).stdout;
  };
  const runtime = JSON.parse(await request(config.web, '/api/v1/runtime/config'));
  if (runtime.data?.stage?.origin !== config.stageOrigin) throw new Error('Nginx 转发的运行配置与舞台来源不一致');
  await request(config.web, '/');
  await request(config.stage, '/frame.html');
  await request(config.stage, '/world-component.html');
  for (const [surface, path] of [
    [config.web, '/frame.html'], [config.web, '/world-component.html'],
    [config.stage, '/api'], [config.stage, '/api/v1/runtime/config'],
  ]) {
    if (await request(surface, path, true) !== '404') throw new Error('静态来源隔离校验失败：' + path);
  }
}

/** Nginx reload returns after HUP, before replacement workers necessarily accept traffic. */
export async function waitForNginx(config, run, signal, { attempts = 10, intervalMs = 500 } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error('Invalid Nginx readiness retry options');
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted();
    try {
      await verifyNginx(config, run);
      signal?.throwIfAborted();
      return;
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt + 1 === attempts) throw error;
    }
    await delay(intervalMs, undefined, { signal });
  }
}

async function requireAvailablePort(port) {
  await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error('API 端口 ' + port + ' 已被其他进程占用或不可绑定')));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolvePort()));
  });
}

async function deploy(config) {
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error('部署已中断'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const run = (name, args, options = {}) => command(name, args, { ...options, signal: abort.signal });
  const snapshots = new Map();
  let appChanged = false, nginxChanged = false, currentChanged = false, enableAttempted = false;
  let oldCurrent = null, appWasActive = false, nginxWasActive = false;
  let appWasEnabled = false, nginxWasEnabled = false;
  const nginxConfig = join(config.nginxDir, 'conf.d/sillyrealms.conf');
  const nginxMain = join(config.nginxDir, 'nginx.conf');
  let nginxBinary = 'nginx';
  async function remember(path, requireManaged = false) {
    const stat = await optionalStat(path);
    if (stat && !stat.isFile()) throw new Error('不能覆盖非普通文件：' + path);
    const data = stat ? await readFile(path) : null;
    if (data && requireManaged && !data.toString('utf8').startsWith(managed)) {
      throw new Error('已有同名文件不是本脚本生成，请先人工备份并迁移：' + path);
    }
    snapshots.set(path, data === null ? null : { data, mode: stat.mode & 0o777 });
  }
  const state = async (verb, name) => (await run('systemctl', [verb, '--quiet', name], {
    capture: true, allowFailure: true,
  })).code === 0;

  try {
    await access('/run/systemd/system');
    await access(nginxMain);
    await run('curl', ['--version'], { capture: true });
    await run('systemctl', ['show', 'nginx.service', '--property=LoadState', '--value'], { capture: true })
      .then(result => { if (result.stdout.trim() !== 'loaded') throw new Error('需要已安装的 nginx.service'); });
    const nginxStart = (await run('systemctl', ['show', 'nginx.service', '--property=ExecStart', '--value'], { capture: true })).stdout;
    nginxBinary = nginxStart.match(/\bpath=([^\s;]+)/)?.[1];
    if (!nginxBinary || !nginxBinary.startsWith('/')) throw new Error('无法识别 nginx.service 的直接启动程序');
    const nginxVersion = await run(nginxBinary, ['-V'], { capture: true });
    const configuredMain = nginxStart.match(/\s-c\s*([^\s;]+)/)?.[1] ??
      (nginxVersion.stdout + nginxVersion.stderr).match(/--conf-path=([^\s]+)/)?.[1];
    if (configuredMain !== nginxMain) throw new Error('NGINX_DIR 与 nginx.service 实际配置路径不一致：' + configuredMain);
    await run(nginxBinary, ['-t', '-c', nginxMain], { capture: true });
    for (const [path, marker] of [
      [unitPath, true], [nginxConfig, true], [join(config.configDir, 'server.env'), true],
      [join(config.configDir, 'deploy.json'), false],
    ]) await remember(path, marker);
    const loadedUnit = (await run('systemctl', ['show', service, '--property=FragmentPath', '--value'], { capture: true })).stdout.trim();
    if (loadedUnit && loadedUnit !== unitPath) throw new Error('已存在其他来源的 sillyrealms.service：' + loadedUnit);
    appWasActive = await state('is-active', service);
    nginxWasActive = await state('is-active', 'nginx.service');
    appWasEnabled = await state('is-enabled', service);
    nginxWasEnabled = await state('is-enabled', 'nginx.service');
    const previousPort = snapshots.get(join(config.configDir, 'server.env'))?.data.toString('utf8').match(/^SERVER_PORT=(\d+)$/m)?.[1];
    if (!appWasActive || Number(previousPort) !== config.serverPort) await requireAvailablePort(config.serverPort);

    log('安装锁定依赖并构建 Web / Stage');
    await run('pnpm', ['install', '--frozen-lockfile', '--prod=false'], {
      cwd: config.projectDir, env: { CI: 'true', NODE_ENV: 'development' },
    });
    await run('pnpm', ['build'], { cwd: config.projectDir, env: {
      NODE_ENV: 'production', VITE_WEB_ORIGIN: config.webOrigin, VITE_WORLD_PREVIEW_ORIGIN: config.stageOrigin,
    } });
    const loaderPath = join(config.projectDir, 'apps/server/node_modules/tsx/dist/loader.mjs');
    await access(loaderPath);
    const release = await publishStatic(config.projectDir, config.staticRoot);
    await checkStaticTraversal(config.staticRoot);
    const current = await optionalStat(join(config.staticRoot, 'current'));
    if (current && !current.isSymbolicLink()) throw new Error('静态 current 不是发布符号链接');
    oldCurrent = current ? await readlink(join(config.staticRoot, 'current')) : null;
    if (oldCurrent !== null) {
      const target = resolve(config.staticRoot, oldCurrent);
      const within = relative(join(config.staticRoot, 'releases'), target);
      if (!within || within.startsWith('..') || within.startsWith('/')) throw new Error('current 指向管理目录之外');
    }

    log('准备运行配置和首次部署密钥');
    const configStat = await optionalStat(config.configDir);
    if (configStat && !configStat.isDirectory()) throw new Error('配置目录不能是符号链接或文件');
    await mkdir(config.configDir, { recursive: true, mode: 0o700 });
    await chmod(config.configDir, 0o700);
    await mkdir(config.dataRoot, { recursive: true, mode: 0o700 });
    await makePublicDirectory(join(config.nginxDir, 'conf.d'));
    await provisionKey(config);
    abort.signal.throwIfAborted();
    await atomicWrite(join(config.configDir, 'server.env'), renderEnvironment(config));
    await atomicWrite(unitPath, renderSystemd(config, { nodePath: process.execPath, loaderPath }), 0o644);
    await atomicWrite(nginxConfig, await renderNginx(config), 0o644);
    log('校验 Nginx 配置及 include 路径');
    await run(nginxBinary, ['-t', '-c', nginxMain], { capture: true });
    const fullConfig = (await run(nginxBinary, ['-T', '-c', nginxMain], { capture: true })).stdout;
    if (!fullConfig.includes('# configuration file ' + nginxConfig + ':')) {
      throw new Error('nginx.conf 的 http 块需要 include ' + config.nginxDir + '/conf.d/*.conf');
    }

    await run('systemctl', ['daemon-reload']);
    appChanged = true;
    log('启动同一个 systemd 后端并等待健康检查');
    await run('systemctl', ['restart', service]);
    await waitForBackend(config, abort.signal);
    if (!await state('is-active', service)) throw new Error('后端服务未保持运行');
    currentChanged = true;
    await switchCurrent(config.staticRoot, release);
    nginxChanged = true;
    await run('systemctl', [nginxWasActive ? 'reload' : 'start', 'nginx.service']);
    await waitForNginx(config, run, abort.signal);
    enableAttempted = true;
    await run('systemctl', ['enable', service, 'nginx.service']);
    await atomicWrite(join(config.configDir, 'deploy.json'), JSON.stringify(
      Object.fromEntries(CONFIG_KEYS.map(key => [key, config[key]])), null, 2) + '\n');
    if (process.env.SR_DEPLOY_REVISION) log('已部署 origin/main：' + process.env.SR_DEPLOY_REVISION);
    log('部署完成：' + config.webOrigin);
    log('隔离舞台：' + config.stageOrigin);
    log('后续重复执行 bash deploy/start.sh 即可；日志：journalctl -u sillyrealms -f');
  } catch (error) {
    log('部署失败，恢复本次改动的服务配置和静态入口');
    const recoveryErrors = [];
    const recover = async action => { try { await action(); } catch (failure) { recoveryErrors.push(failure.message); } };
    // Stop/disable newly introduced services while their unit files still exist.
    if (appChanged && !appWasActive) await recover(() => command('systemctl', ['stop', service]));
    if (nginxChanged && !nginxWasActive) await recover(() => command('systemctl', ['stop', 'nginx.service']));
    if (enableAttempted && !appWasEnabled) await recover(() => command('systemctl', ['disable', service], { capture: true }));
    if (enableAttempted && !nginxWasEnabled) await recover(() => command('systemctl', ['disable', 'nginx.service'], { capture: true }));
    for (const [path, snapshot] of [...snapshots].reverse()) {
      await recover(async () => {
        if (snapshot) await atomicWrite(path, snapshot.data, snapshot.mode);
        else await unlink(path).catch(failure => { if (failure.code !== 'ENOENT') throw failure; });
      });
    }
    if (currentChanged) await recover(() => switchCurrent(config.staticRoot, oldCurrent));
    if (appChanged) {
      await recover(() => command('systemctl', ['daemon-reload']));
      if (appWasActive) await recover(() => command('systemctl', ['restart', service]));
    }
    if (nginxChanged && nginxWasActive) await recover(() => command('systemctl', ['reload', 'nginx.service']));
    if (recoveryErrors.length) console.error('部分恢复操作未完成：\n' + recoveryErrors.join('\n'));
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

async function main(args) {
  if (args.length > 1 || (args.length === 1 && !['--help', '--check'].includes(args[0]))) {
    throw new Error('用法：bash deploy/start.sh [--check|--help]');
  }
  if (args[0] === '--help') {
    console.log('首次：WEB_ORIGIN=http://服务器IP STAGE_ORIGIN=http://服务器IP:8081 bash deploy/start.sh\n' +
      '后续：bash deploy/start.sh（自动拉取 origin/main，再构建部署）\n' +
      '部署目录需为 main 分支的 Git 克隆；存在本地改动、分叉或拉取失败时停止部署。\n' +
      '--check 只检查配置和已安装的 Node/pnpm/Nginx，不拉取代码、不构建、不启动服务、不写入配置。\n' +
      '默认配置 /etc/sillyrealms/deploy.json；SR_CONFIG_DIR 可覆盖配置目录。\n' +
      '详见 deploy/README.md。');
    return;
  }
  if (args[0] !== '--check' && (process.platform !== 'linux' || process.getuid?.() !== 0 || process.env.SR_DEPLOY_LOCK_HELD !== '1')) {
    throw new Error('请在 Linux 服务器以 root 身份通过 bash deploy/start.sh 运行');
  }
  const projectDir = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const config = await loadConfig({ projectDir, configDir: process.env.SR_CONFIG_DIR ?? '/etc/sillyrealms' });
  await validateEnvironment(config);
  // Render before mutation as a final validation of paths, origins and TLS pairing.
  await renderNginx(config);
  renderSystemd(config, { nodePath: process.execPath, loaderPath: join(projectDir, 'apps/server/node_modules/tsx/dist/loader.mjs') });
  if (args[0] === '--check') {
    log('配置和工具检查通过。实际部署要求 Linux + systemd + root。');
    console.log(JSON.stringify(Object.fromEntries(CONFIG_KEYS.map(key => [key, config[key]])), null, 2));
    return;
  }
  process.umask(0o077);
  await deploy(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error('[SR deploy] ' + error.message); process.exitCode = 1; });
}
