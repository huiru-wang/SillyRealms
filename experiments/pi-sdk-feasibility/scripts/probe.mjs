import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, SessionManager, DefaultResourceLoader, SettingsManager, ModelRuntime } from '@earendil-works/pi-coding-agent';

const tmp = mkdtempSync(join(tmpdir(), 'sillyrealms-pi-probe-'));
const cwd = join(tmp,'workspace');
const agentDir = join(tmp,'agent');
const settingsManager = SettingsManager.inMemory({compaction:{enabled:false}});
const loader = new DefaultResourceLoader({cwd,agentDir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noContextFiles:true,noThemes:true,systemPrompt:'SILLYREALMS_CUSTOM_SYSTEM'});
await loader.reload();
const runtime = await ModelRuntime.create({authPath:join(tmp,'auth.json'),modelsPath:null,refreshOnCreate:false});
const sm = SessionManager.inMemory(cwd);
const entryId=sm.appendMessage({role:'user',content:'OPENING_MESSAGE',timestamp:Date.now()});
const results={};
let session;
try {
  ({session}=await createAgentSession({cwd,agentDir,settingsManager,resourceLoader:loader,sessionManager:sm,modelRuntime:runtime,noTools:'all'}));
  results.sessionCreated=true;
  results.activeTools=session.getActiveToolNames();
  results.systemPrompt=session.systemPrompt;
  results.sessionFile=session.sessionFile??null;
  results.seededEntryId=entryId;
  results.sessionManagerContext=sm.buildSessionContext().messages.map(x=>({role:x.role,content:typeof x.content==='string'?x.content:'non-string'}));
  results.sessionMessagesCount=session.messages.length;
  results.loader={extensions:loader.getExtensions().extensions.length,skills:loader.getSkills().skills.length,prompts:loader.getPrompts().prompts.length,agentsFiles:loader.getAgentsFiles().agentsFiles.length};
  console.log(JSON.stringify(results,null,2));
} finally { session?.dispose();rmSync(tmp,{recursive:true,force:true}); }
