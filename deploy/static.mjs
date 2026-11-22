import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function optionalStat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
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


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [staticRoot, dataRoot, configDir, nginxDir] = process.argv.slice(2);
  const projectDir = process.cwd();
  await validateStaticLocation({ staticRoot, projectDir, dataRoot, configDir, nginxDir });
  const release = await publishStatic(projectDir, staticRoot);
  await checkStaticTraversal(staticRoot);
  await switchCurrent(staticRoot, release);
}
