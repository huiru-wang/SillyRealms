import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, lstat, writeFile, readdir, realpath, mkdtemp } from 'node:fs/promises';
import { mkdtempSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, relative } from 'node:path';
import { validatePackagePath } from '@sillyrealms/sdk/assets';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WORLD_JSON_LIMIT = 10 * 1024 * 1024;
export const WORLD_ZIP_LIMIT = 256 * 1024 * 1024;
export function testWorldDataDir(): string { return mkdtempSync(join(tmpdir(), 'sr-world-files-')); }

export function validateWorldSourceName(name: string): string {
  if (!name || name === '.' || name === '..' ||
      Buffer.byteLength(name, 'utf8') > 240 ||
      !/\.(json|zip)$/i.test(name) ||
      /[/\\\x00-\x1f\x7f]/u.test(name)) {
    throw new Error('INVALID_WORLD_SOURCE_FILENAME');
  }
  return name;
}

export type PackageFile = { path: string; stat: Stats };

/** Resolve regular package files without following any package-owned symlink. */
export async function resolvePackagePath(root: string, relativePath: string): Promise<PackageFile> {
  const safe = validatePackagePath(relativePath);
  const baseStat = await lstat(root);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('INVALID_WORLD_PACKAGE');
  const base = await realpath(root);
  let current = root;
  const parts = safe.split('/');
  let stat = baseStat;
  for (let i = 0; i < parts.length; i++) {
    // Preserve package case sensitivity on macOS/Windows while accepting NFC-equivalent names.
    const segment = parts[i]!.normalize('NFC');
    const matches = (await readdir(current)).filter(name => name.normalize('NFC') === segment);
    if (!matches.length) throw Object.assign(new Error('WORLD_PACKAGE_FILE_NOT_FOUND'), { code:'ENOENT' });
    if (matches.length !== 1) throw new Error('AMBIGUOUS_WORLD_PACKAGE_PATH');
    current = join(current, matches[0]!);
    stat = await lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('INVALID_WORLD_PACKAGE_FILE');
    }
  }
  const actual = await realpath(current);
  if (!actual.startsWith(base + sep)) throw new Error('INVALID_WORLD_PACKAGE_PATH');
  return { path: actual, stat };
}

/** Only server-generated world UUIDs may address stored files. */
export class WorldFileStore {
  constructor(private dataDir: string) {}
  private root(): string { return resolve(this.dataDir, 'workspaces', 'worlds'); }
  private dir(id: string): string {
    if (!ID.test(id)) throw new Error('INVALID_WORLD_ID');
    const base = this.root();
    const path = resolve(base, id);
    if (!path.startsWith(base + sep)) throw new Error('INVALID_WORLD_PATH');
    return path;
  }
  private async directory(id: string, create = false): Promise<string> {
    const target = this.dir(id);
    for (const dir of [resolve(this.dataDir, 'workspaces'), this.root(), target]) {
      if (create) await mkdir(dir, { recursive:true, mode:0o700 });
      const st = await lstat(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('INVALID_WORLD_PATH');
    }
    return target;
  }
  sourcePath(id: string, originalName = 'original.json'): string {
    this.dir(id);
    return join('workspaces', 'worlds', id, 'source', validateWorldSourceName(originalName));
  }
  sourceFilename(id: string, storedPath?: string | null): string {
    this.dir(id);
    const prefix = join('workspaces', 'worlds', id, 'source') + sep;
    const stored = storedPath ?? this.sourcePath(id);
    if (!stored.startsWith(prefix)) throw new Error('INVALID_WORLD_SOURCE_PATH');
    return validateWorldSourceName(stored.slice(prefix.length));
  }
  private async sourceDir(id: string): Promise<string> {
    const dir = join(await this.directory(id), 'source');
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('INVALID_WORLD_SOURCE_PATH');
    return dir;
  }
  async save(id: string, bytes: Uint8Array, originalName = 'original.json'): Promise<{path: string; sha256: string}> {
    const name = validateWorldSourceName(originalName);
    const limit = /\.zip$/i.test(name) ? WORLD_ZIP_LIMIT : WORLD_JSON_LIMIT;
    if (!bytes.length || bytes.length > limit) throw new Error('INVALID_WORLD_SIZE');
    const dir = join(await this.directory(id, true), 'source');
    await mkdir(dir, { recursive:true, mode:0o700 });
    await this.sourceDir(id);
    const target=join(dir,name), temp=join(dir,'.tmp-'+randomUUID());
    try {
      await writeFile(temp, bytes, { mode:0o600, flag:'wx' });
      await rename(temp,target);
    } catch (error) { await rm(temp,{force:true}).catch(()=>{}); throw error; }
    return { path:this.sourcePath(id,name), sha256:createHash('sha256').update(bytes).digest('hex') };
  }
  async resolveSourceFile(id: string, storedPath?: string | null): Promise<PackageFile> {
    const name = this.sourceFilename(id, storedPath);
    const file = join(await this.sourceDir(id),name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INVALID_WORLD_SOURCE');
    return {path:file,stat};
  }
  async read(id: string, storedPath?: string | null): Promise<Uint8Array> {
    const file = await this.resolveSourceFile(id,storedPath);
    const limit = /\.zip$/i.test(file.path) ? WORLD_ZIP_LIMIT : WORLD_JSON_LIMIT;
    if (file.stat.size > limit) throw new Error('INVALID_WORLD_SIZE');
    return readFile(file.path);
  }
  async createPackageStage(id: string): Promise<string> {
    return mkdtemp(join(await this.directory(id, true), '.package-'));
  }
  async publishPackage(id: string, staged: string): Promise<void> {
    const directory = await this.directory(id);
    if (!relative(directory, staged).match(/^\.package-[^/\\]+$/)) throw new Error('INVALID_WORLD_PACKAGE_PATH');
    const stat = await lstat(staged);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('INVALID_WORLD_PACKAGE');
    const target = join(directory, 'package');
    const existing = await lstat(target).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
    if (existing) throw new Error('WORLD_PACKAGE_ALREADY_EXISTS');
    await rename(staged, target);
  }
  async resolvePackageFile(id: string, relativePath: string): Promise<PackageFile> {
    return resolvePackagePath(join(await this.directory(id), 'package'), relativePath);
  }
  async listPackageFiles(id: string): Promise<string[]> {
    // Generated legacy/test definitions without an import UUID cannot own a package.
    if (!ID.test(id)) return [];
    const world = this.dir(id);
    // A JSON-only or generated card does not need a package directory.
    const root = join(world,'package');
    const existing = await lstat(root).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
    if (!existing) return [];
    await this.directory(id);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('INVALID_WORLD_PACKAGE');
    const files:string[]=[];
    let entries=0;
    const walk=async(prefix:string):Promise<void>=>{
      for (const entry of await readdir(join(root,prefix),{withFileTypes:true})) {
        if(++entries>10000)throw new Error('WORLD_PACKAGE_TOO_MANY_FILES');
        const name = prefix ? prefix+'/'+entry.name : entry.name;
        validatePackagePath(name);
        if(entry.isSymbolicLink())throw new Error('INVALID_WORLD_PACKAGE_FILE');
        if(entry.isDirectory()) {
          if(!name.startsWith('assets/')&&!name.startsWith('components/')&&!['assets','components'].includes(name))throw new Error('INVALID_WORLD_PACKAGE_FILE');
          await walk(name);
        } else if(entry.isFile()) {
          if(name!=='world.json'&&!name.startsWith('assets/')&&!name.startsWith('components/'))throw new Error('INVALID_WORLD_PACKAGE_FILE');
          files.push(name);
        } else throw new Error('INVALID_WORLD_PACKAGE_FILE');
        if(files.length>10000)throw new Error('WORLD_PACKAGE_TOO_MANY_FILES');
      }
    };
    await walk('');
    return files.sort();
  }
  async createExportStage(): Promise<string> {
    const root=this.root();
    await mkdir(root,{recursive:true,mode:0o700});
    for(const dir of [resolve(this.dataDir,'workspaces'),root]){
      const stat=await lstat(dir);
      if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('INVALID_WORLD_PATH');
    }
    return mkdtemp(join(root,'.export-'));
  }
  async remove(id: string): Promise<void> {
    const dir=this.dir(id);
    const st=await lstat(dir).catch((e:NodeJS.ErrnoException) => {if(e.code==='ENOENT')return null;throw e;});
    if(st?.isSymbolicLink())throw new Error('INVALID_WORLD_PATH');
    if(st){await this.directory(id);await rm(dir,{recursive:true,force:true});}
  }
  /** Called under the exclusive data-directory lock before the HTTP server starts. */
  async cleanupOrphans(knownIds:ReadonlySet<string>):Promise<number> {
    const workspace=resolve(this.dataDir,'workspaces'), root=this.root();
    for (const dir of [workspace,root]) {
      const st=await lstat(dir).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});
      if(!st)return 0;
      if(!st.isDirectory()||st.isSymbolicLink())throw new Error('INVALID_WORLD_PATH');
    }
    let count=0;
    for(const child of await readdir(root,{withFileTypes:true})){
      if(!child.isDirectory()||child.isSymbolicLink())continue;
      if(child.name.startsWith('.export-')){await rm(join(root,child.name),{recursive:true,force:true});count++;continue;}
      if(!ID.test(child.name))continue;
      if(!knownIds.has(child.name)){await this.remove(child.name);count++;continue;}
      for(const staged of await readdir(join(root,child.name),{withFileTypes:true})){
        if(staged.isDirectory()&&!staged.isSymbolicLink()&&staged.name.startsWith('.package-'))await rm(join(root,child.name,staged.name),{recursive:true,force:true});
      }
    }
    return count;
  }
}
