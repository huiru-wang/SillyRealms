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
const preset = { name: 'Test', api_model_config_id: null, budget: { max_output_tokens: 100 }, summary_prompt: 'summary', nodes: ids.map(id => ({ id, name: id, kind: 'system', source: id, role: id === 'chatHistory' ? 'auto' : id === 'userInput' ? 'user' : 'system', enabled: true, ...(id === 'main' ? { content: 'old' } : {}) })) };
describe('preset and model configuration', () => {
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
