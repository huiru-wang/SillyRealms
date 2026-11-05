import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacKeychainStore } from '../src/infrastructure/credentials/store.js';

it.skipIf(process.platform !== 'darwin')('stores independent dummy credentials in an isolated macOS keychain', async () => {
  const dir=mkdtempSync(join(tmpdir(),'sr-keychain-')); const path=join(dir,'test.keychain-db');
  try {
    execFileSync('/usr/bin/security',['create-keychain','-p','temporary-test-password',path],{stdio:'ignore',timeout:5000});
    execFileSync('/usr/bin/security',['unlock-keychain','-p','temporary-test-password',path],{stdio:'ignore',timeout:5000});
    const store=new MacKeychainStore(path);
    await store.set('test-1','dummy-one'); await store.set('test-2','dummy-two');
    expect(await store.get('test-1')).toBe('dummy-one'); expect(await store.get('test-2')).toBe('dummy-two');
    const special = 'quote: \" slash: \\ space'; await store.set('test-special',special); expect(await store.get('test-special')).toBe(special);
    await store.delete('test-1'); expect(await store.get('test-1')).toBeNull(); expect(await store.get('test-2')).toBe('dummy-two');
  } finally {
    try { execFileSync('/usr/bin/security',['delete-keychain',path],{stdio:'ignore',timeout:5000}); } catch { /* also remove temporary files below */ }
    rmSync(dir,{recursive:true,force:true});
  }
},15000);
