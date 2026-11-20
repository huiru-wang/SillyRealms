import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dispatchStageCommand} from '../src/stage-host/commands.ts';

test('bridge forwards supported domain commands without accepting arbitrary HTTP targets',async()=>{
  const calls=[],command=async(method,input)=>{calls.push({method,input});return {runId:'r',userEntryId:'u',assistantEntryId:'a'};};
  const accepted=await dispatchStageCommand(command,'narrative.send',{text:'Hello'});
  assert.deepEqual(accepted,{runId:'r',userEntryId:'u',assistantEntryId:'a'});
  await assert.rejects(dispatchStageCommand(command,'fetch',{url:'/api/v1/app-settings'}));
  await assert.rejects(dispatchStageCommand(command,'state.write',{sessionId:'other',updates:[{path:'coins',value:8}]}));
  assert.equal(calls.length,1);
});
test('history accepts ServerV2 page semantics and rejects mixed cursor modes',async()=>{
  const calls=[],command=async(method,input)=>calls.push({method,input});
  await dispatchStageCommand(command,'history.query',{limit:5,afterSeq:6});
  await dispatchStageCommand(command,'history.query',{limit:1});
  await assert.rejects(dispatchStageCommand(command,'history.query',{limit:6}));
  await assert.rejects(dispatchStageCommand(command,'history.query',{cursor:'older',afterSeq:6}));
  assert.deepEqual(calls,[{method:'history.query',input:{limit:5,afterSeq:6}},{method:'history.query',input:{limit:1}}]);
});
test('malformed command cannot prevent a later valid state command',async()=>{
  const calls=[],command=async(method,input)=>{calls.push({method,input});return [];};
  await assert.rejects(dispatchStageCommand(command,'state.write',{updates:[{scope:'other',path:'coins',value:8}]}));
  await dispatchStageCommand(command,'state.write',{updates:[{scope:'message',path:'coins',value:null}]});
  assert.equal(calls.length,1);assert.equal(calls[0].input.updates[0].value,null);
});
