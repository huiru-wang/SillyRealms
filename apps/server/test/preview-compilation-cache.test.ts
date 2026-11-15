import {expect,it,vi} from 'vitest';
import {createPreviewCompiler} from '../../studio/src/features/worlds/preview-compilation-cache.js';

const sources=[{id:'Intro',component:'intro'},{id:'Opening',component:'opening'}];
const result={code:{Intro:'compiled'},errors:{}};

it('shares in-flight and completed compilation across preview switches and refetched world objects',async()=>{
  const compile=vi.fn(async()=>result),preview=createPreviewCompiler(compile);
  const first=preview('world',sources),second=preview('world',structuredClone(sources));
  expect(second).toBe(first);
  await first;
  expect(await preview('world',structuredClone(sources))).toBe(result);
  expect(compile).toHaveBeenCalledTimes(1);
  await preview('other-world',sources);
  expect(compile).toHaveBeenCalledTimes(2);
});

it('snapshots inputs and recompiles changed source, IDs and module sets',async()=>{
  const compile=vi.fn(async()=>result),preview=createPreviewCompiler(compile),input=structuredClone(sources);
  const original=preview('world',input);
  input[1]!.component='changed';
  await original;
  expect(compile.mock.calls[0]).toEqual([sources]);
  await preview('world',input);
  input[1]!.id='Renamed';await preview('world',input);
  input.pop();await preview('world',input);
  expect(compile).toHaveBeenCalledTimes(4);
});

it('retries failures without allowing an older failure to evict a newer successful result',async()=>{
  const compile=vi.fn<Parameters<typeof createPreviewCompiler>[0]>()
    .mockRejectedValueOnce(Error('compiler unavailable'))
    .mockResolvedValueOnce({code:{},errors:{Intro:'syntax error'}})
    .mockResolvedValue(result);
  const preview=createPreviewCompiler(compile);
  await expect(preview('world',sources)).rejects.toThrow('compiler unavailable');
  expect((await preview('world',sources)).errors).toHaveProperty('Intro');
  expect(await preview('world',sources)).toBe(result);
  expect(compile).toHaveBeenCalledTimes(3);
  let reject!:(reason:Error)=>void;
  compile.mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
  const old=preview('world',[{id:'old',component:'old'}]);
  await Promise.resolve();
  const newer=preview('world',sources);await newer;
  reject(Error('stale failure'));await expect(old).rejects.toThrow('stale failure');
  expect(preview('world',sources)).toBe(newer);
});

it('evicts least recently used worlds after four entries',async()=>{
  const compile=vi.fn(async()=>result),preview=createPreviewCompiler(compile);
  for(const id of ['a','b','c','d'])await preview(id,sources);
  await preview('a',sources);await preview('e',sources);
  await preview('a',sources);expect(compile).toHaveBeenCalledTimes(5);
  await preview('b',sources);expect(compile).toHaveBeenCalledTimes(6);
});
