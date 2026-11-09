import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/infrastructure/database/database.js';
import type { CredentialStore } from '../src/infrastructure/credentials/store.js';

class MemoryCredentials implements CredentialStore {
  data = new Map<string, string>();
  async set(id: string, key: string) { this.data.set(id, key); }
  async get(id: string) { return this.data.get(id) ?? null; }
  async delete(id: string) { this.data.delete(id); }
}
const ids = ['main','personaInfo','characterInfo','worldState','chatHistory','userInput','postHistory'];
const preset = { name: 'Test', budget: { context_strategy:'standard', max_output_tokens: 100 }, summary_prompt: 'summary', nodes: ids.map(id => ({ id, name: id, kind: 'system', source: id, role: id === 'chatHistory' ? 'auto' : id === 'userInput' ? 'user' : 'system', enabled: true, ...(id === 'main' ? { content: 'old' } : {}) })) };
describe('preset and model configuration', () => {
  it('accepts the three strategies and rejects old numeric budgets and invalid strategies', async () => {
    const db=openDatabase(':memory:'),app=createApp(db,new MemoryCredentials());
    try {
      for (const strategy of ['compact','standard','extended']) {
        const input={...preset,name:strategy,budget:{context_strategy:strategy,max_output_tokens:100}};
        const response=await app.request('/api/v1/presets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
        expect(response.status).toBe(201);
        expect((await response.json() as {data:{item:{budget:unknown}}}).data.item.budget).toEqual(input.budget);
      }
      for (const budget of [{max_output_tokens:100,max_context_tokens:32000},{context_strategy:'large',max_output_tokens:100}]) {
        const response=await app.request('/api/v1/presets/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...preset,budget})});
        expect(response.status).toBe(422);
      }
    } finally {db.close();}
  });
  it('updates one node without changing the others and permits deletion', async () => {
    const db = openDatabase(':memory:'), store = new MemoryCredentials(), app = createApp(db, store);
    const response = await app.request('/api/v1/presets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(preset) });
    expect(response.status).toBe(201);
    const created = await response.json() as { data: { item: { id: string } } };
    const updated = await app.request(`/api/v1/presets/${created.data.item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodes: [{ id: 'main', content: 'new' }] }) });
    expect(updated.status).toBe(200);
    const value = await updated.json() as { data: { item: typeof preset } };
    expect(value.data.item.nodes[0]?.content).toBe('new');
    expect(value.data.item.nodes.slice(1)).toEqual(preset.nodes.slice(1));
    expect((await app.request(`/api/v1/presets/${created.data.item.id}`, { method: 'DELETE' })).status).toBe(200);
    db.close();
  });
  it('normalizes the legacy main label on import, read and export without changing its ID or prompt', async () => {
    const db=openDatabase(':memory:'),app=createApp(db,new MemoryCredentials());
    try {
      const input=structuredClone(preset);
      input.nodes[0]!.name='主要提示';
      const created=await app.request('/api/v1/presets/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      expect(created.status).toBe(201);
      const item=(await created.json() as {data:{item:{id:string;nodes:Array<{id:string;name:string;content?:string}>}}}).data.item;
      expect(item.nodes[0]).toMatchObject({id:'main',name:'叙事风格',content:'old'});
      const read=(await (await app.request('/api/v1/presets/'+item.id)).json() as {data:{item:{nodes:Array<{name:string}>}}}).data.item;
      expect(read.nodes[0]?.name).toBe('叙事风格');
      const exported=await (await app.request('/api/v1/presets/'+item.id+'/export')).json() as {nodes:Array<{id:string;name:string;content?:string}>};
      expect(exported.nodes[0]).toMatchObject({id:'main',name:'叙事风格',content:'old'});
    } finally {db.close();}
  });
  it('restores the old credential if updating its configuration fails', async () => {
    const db=openDatabase(':memory:'),store=new MemoryCredentials(),app=createApp(db,store);
    const directory=await (await app.request('/api/v1/providers/models')).json() as {data:{providers:Array<{providerId:string;models:Array<{id:string}>}>}};
    const provider=directory.data.providers.find(p=>p.models.length)!;
    const created=await app.request('/api/v1/api-model-configs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'config',providerId:provider.providerId,modelId:provider.models[0]!.id,apiKey:'old-key'})});
    const id=(await created.json() as {data:{item:{id:string}}}).data.item.id;
    db.exec("CREATE TRIGGER fail_config BEFORE UPDATE ON api_model_configs BEGIN SELECT RAISE(ABORT,'fail'); END");
    const response=await app.request(`/api/v1/api-model-configs/${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({apiKey:'new-key'})});
    expect(response.status).toBe(422);expect(await store.get(id)).toBe('old-key');db.close();
  });
  it('saves separate credentials for configurations of the same catalog model', async () => {
    const db = openDatabase(':memory:'), store = new MemoryCredentials(), app = createApp(db, store);
    const directory = await (await app.request('/api/v1/providers/models')).json() as { data: { providers: Array<{ providerId: string; models: Array<{id:string}> }> } };
    const provider = directory.data.providers.find(p => p.models.length)!;
    const create = (apiKey: string) => app.request('/api/v1/api-model-configs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Config', providerId: provider.providerId, modelId: provider.models[0]!.id, apiKey }) });
    expect((await create('secret-one')).status).toBe(201);
    expect((await create('secret-two')).status).toBe(201);
    expect([...store.data.values()].sort()).toEqual(['secret-one','secret-two']);
    expect(JSON.stringify(db.prepare('SELECT * FROM api_model_configs').all())).not.toContain('secret-');
    const list = await (await app.request('/api/v1/api-model-configs')).text();
    expect(list).not.toContain('secret-');
    db.close();
  });
});
