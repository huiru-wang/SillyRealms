import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, lstat, writeFile, readdir } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function testWorldDataDir(): string { return mkdtempSync(join(tmpdir(), 'sr-world-files-')); }

/** Preserve the user's original JSON file name, but never accept a path component. */
export function validateWorldSourceName(name: string): string {
  if (!name || name === '.' || name === '..' ||
      Buffer.byteLength(name, 'utf8') > 240 ||
      !/\.json$/i.test(name) ||
      /[/\\\x00-\x1f\x7f]/u.test(name)) {
    throw new Error('INVALID_WORLD_SOURCE_FILENAME');
  }
  return name;
}

/** Only server-generated world UUIDs may address local source files. */
export class WorldFileStore {
  constructor(private dataDir: string) {}
  private dir(id: string): string {
    if (!ID.test(id)) throw new Error('INVALID_WORLD_ID');
    const base = resolve(this.dataDir, 'workspaces', 'worlds');
    const path = resolve(base, id);
    if (!path.startsWith(base + sep)) throw new Error('INVALID_WORLD_PATH');
    return path;
  }
  sourcePath(id: string, originalName = 'original.json'): string {
    this.dir(id);
    return join('workspaces', 'worlds', id, 'source', validateWorldSourceName(originalName));
  }
  /** Source metadata is a stored relative path, never a caller-supplied filesystem path. */
  sourceFilename(id: string, storedPath?: string | null): string {
    this.dir(id);
    const prefix = join('workspaces', 'worlds', id, 'source') + sep;
    const relative = storedPath ?? this.sourcePath(id);
    if (!relative.startsWith(prefix)) throw new Error('INVALID_WORLD_SOURCE_PATH');
    return validateWorldSourceName(relative.slice(prefix.length));
  }
  private async sourceDir(id: string): Promise<string> {
    const dir = join(this.dir(id), 'source');
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('INVALID_WORLD_SOURCE_PATH');
    return dir;
  }
  async save(id: string, bytes: Uint8Array, originalName = 'original.json'): Promise<{path: string; sha256: string}> {
    const name = validateWorldSourceName(originalName);
    if (!bytes.length || bytes.length > 10*1024*1024) throw new Error('INVALID_WORLD_SIZE');
    const dir = join(this.dir(id), 'source');
    await mkdir(dir, { recursive:true, mode:0o700 });
    await this.sourceDir(id);
    const target=join(dir,name);
    const temp=join(dir,'.tmp-'+randomUUID());
    try {
      await writeFile(temp, bytes, { mode:0o600, flag:'wx' });
      await rename(temp,target);
    } catch (error) { await rm(temp,{force:true}).catch(()=>{}); throw error; }
    return { path:this.sourcePath(id,name), sha256:createHash('sha256').update(bytes).digest('hex') };
  }
  async read(id: string, storedPath?: string | null): Promise<Uint8Array> {
    const name = this.sourceFilename(id, storedPath);
    const file = join(await this.sourceDir(id),name);
    const st=await lstat(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('INVALID_WORLD_SOURCE');
    return readFile(file);
  }
  async remove(id: string): Promise<void> {
    const dir=this.dir(id);
    const st=await lstat(dir).catch((e:NodeJS.ErrnoException) => {
      if (e.code==='ENOENT') return null;
      throw e;
    });
    if (st?.isSymbolicLink()) throw new Error('INVALID_WORLD_PATH');
    if (st) await rm(dir,{recursive:true,force:true});
  }
  /** Called under the exclusive data-directory lock before the HTTP server starts. */
  async cleanupOrphans(knownIds:ReadonlySet<string>):Promise<number> {
    const workspace=resolve(this.dataDir,'workspaces');
    const root=resolve(workspace,'worlds');
    for (const dir of [workspace,root]) {
      const st=await lstat(dir).catch((e:NodeJS.ErrnoException)=>{
        if (e.code==='ENOENT') return null;
        throw e;
      });
      if (!st) return 0;
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('INVALID_WORLD_PATH');
    }
    let count=0;
    for (const child of await readdir(root,{withFileTypes:true})) {
      if (!child.isDirectory() || !ID.test(child.name) || knownIds.has(child.name)) continue;
      await this.remove(child.name);
      count++;
    }
    return count;
  }
}
