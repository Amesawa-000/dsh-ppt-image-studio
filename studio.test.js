import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioOperations, DEFAULTS, validateSettings } from './studio.js';
const key='test-secret-not-real';
function harness(){
  let settings={...DEFAULTS}; const records=new Map(); const calls=[];const saved=[];
  const credentials={describeRecord:async k=>({configured:records.has(k)}),readRecord:async k=>records.get(k),modifyRecord:async(k,fn)=>{records.set(k,await fn(records.get(k)));return records.get(k);},deleteRecord:async k=>records.delete(k)};
  const attachments={validateImage:async()=>{},saveFile:async file=>{saved.push(file);return {id:'file-1',name:file.name};},saveImage:async image=>({id:'image-1',mediaType:image.mediaType,width:1,height:1,bytes:image.data.length}),fileHostPath:()=>'/test/generated.png',readImage:async ref=>({ref,data:new Uint8Array([1,2,3])})};
  const adapters={detectProtocol:async o=>{calls.push(o);return {baseUrl:o.baseUrl+'/v1beta',protocol:'gemini',models:['model-image']};},discoverModels:async o=>{calls.push(o);return ['model-image'];},generateImages:async o=>{calls.push(o);return [{bytes:new Uint8Array([1,2,3]),mediaType:'image/png'}];}};
  const studio=new StudioOperations({getSettings:()=>settings,saveSettings:async s=>{settings=s;},credentials,attachments,adapters});
  return {studio,records,calls,saved,adapters,settings:()=>settings};
}
const config={baseUrl:'https://provider.example',protocol:'openai-images',model:'my-image-model',apiKey:key};
test('default status has no key or network side effect',async()=>{const h=harness();assert.equal((await h.studio.run('status')).hasKey,false);assert.equal(h.calls.length,0);});
test('save stores a key in credentials, never settings or status',async()=>{const h=harness();const status=await h.studio.run('save',config,undefined,true);assert.equal(status.configured,true);assert.equal(h.records.size,1);assert.ok(!JSON.stringify(h.settings()).includes(key));assert.ok(!JSON.stringify(status).includes(key));});
test('agent cannot submit an API key or delete it',async()=>{const h=harness();await assert.rejects(h.studio.run('save',config),/图形页面/);await assert.rejects(h.studio.run('forgetKey'),/设置页面/);});
test('changing the address never forwards the old credential',async()=>{const h=harness();await h.studio.run('save',config,undefined,true);await assert.rejects(h.studio.run('models',{baseUrl:'https://other.example'}),/没有密钥/);assert.equal(h.calls.length,0);});
test('detection preserves raw origin for protocol inference',async()=>{const h=harness();const result=await h.studio.run('detect',config,undefined,true);assert.equal(h.calls[0].baseUrl,'https://provider.example');assert.equal(result.protocol,'gemini');assert.equal(h.records.size,0);});
test('agent model choice and UI use the same operation',async()=>{const h=harness();await h.studio.run('save',config,undefined,true);await h.studio.run('save',{model:'other-image-model'});assert.equal((await h.studio.run('status')).settings.model,'other-image-model');});
test('generation preserves the exact prompt and produces original file path',async()=>{const h=harness();await h.studio.run('save',config,undefined,true);const result=await h.studio.run('generate',{prompt:'Wind farm, no text'});assert.equal(h.calls[0].prompt,'Wind farm, no text');assert.equal(result.images[0].path,'/test/generated.png');assert.equal(h.saved.length,1);assert.ok(!JSON.stringify(result).includes(key));assert.ok(await h.studio.preview(result.images[0].id));});
test('generation cannot override endpoint or submit a key',async()=>{const h=harness();await h.studio.run('save',config,undefined,true);await assert.rejects(h.studio.run('generate',{prompt:'test',baseUrl:'https://other.example'}),/已保存/);assert.equal(h.calls.length,0);});
test('missing configuration and empty prompts fail before generation',async()=>{const h=harness();await assert.rejects(h.studio.run('generate',{prompt:'test'}),/API 地址/);await assert.rejects(h.studio.run('generate',{prompt:' '}),/提示词/);assert.equal(h.calls.length,0);});
test('cancellation reaches the adapter and unload aborts active work',async()=>{const h=harness();await h.studio.run('save',config,undefined,true);const controller=new AbortController();let seen;h.adapters.generateImages=o=>new Promise((resolve,reject)=>{seen=o.signal;o.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});const promise=h.studio.run('generate',{prompt:'test'},controller.signal);await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(promise,/aborted/);assert.equal(seen.aborted,true);h.studio.dispose();});
test('a provider failure is not retried',async()=>{const h=harness();await h.studio.run('save',config,undefined,true);let count=0;h.adapters.generateImages=async()=>{count++;throw new Error('HTTP 429');};await assert.rejects(h.studio.run('generate',{prompt:'test'}),/429/);assert.equal(count,1);});
test('invalid settings and unknown action fail',async()=>{const h=harness();assert.throws(()=>validateSettings({protocol:'other'}));assert.throws(()=>validateSettings({baseUrl:'https://example.com?key=secret'}));await assert.rejects(h.studio.run('deleteAll'),/未知/);});

function deferred(){
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

for(const action of ['generate','save','forgetKey']){
  test(`stale revision rejects ${action} without generation, settings or credential changes`,async()=>{
    const h=harness();
    const original=await h.studio.run('save',config,undefined,true);
    const current=await h.studio.run('save',{model:'agent-updated-model'});
    assert.notEqual(original.revision,current.revision);
    assert.equal(current.revision,(await h.studio.run('status')).revision);
    const records=Array.from(h.records.entries());
    const settings={...h.settings()};
    const input={expectedRevision:original.revision,...(action==='generate'?{prompt:'stale UI prompt'}:action==='save'?{model:'stale-ui-model',apiKey:'replacement-test-key'}:{})};
    await assert.rejects(h.studio.run(action,input,undefined,true),/配置已在其他位置更改/);
    assert.deepEqual(h.settings(),settings);
    assert.deepEqual(Array.from(h.records.entries()),records);
    assert.equal(h.calls.length,0);
    assert.equal(h.saved.length,0);
  });
}

for(const action of ['generate','save']){
  test(`${action} rechecks revision after awaiting credential lookup`,async()=>{
    const h=harness();
    const original=await h.studio.run('save',config,undefined,true);
    const entered=deferred(),release=deferred();
    const readRecord=h.studio.credentials.readRecord;
    h.studio.credentials.readRecord=async record=>{
      entered.resolve();
      await release.promise;
      return readRecord(record);
    };
    const operation=h.studio.run(action,{expectedRevision:original.revision,...(action==='generate'?{prompt:'test'}:{model:'stale-ui-model'})});
    const rejected=assert.rejects(operation,/配置已在其他位置更改/);
    await entered.promise;
    await h.studio.saveSettings({...h.settings(),model:'concurrent-model'});
    release.resolve();
    await rejected;
    assert.equal(h.settings().model,'concurrent-model');
    assert.equal(h.calls.length,0);
    assert.equal(h.saved.length,0);
  });
}

test('concurrent generations crossing credential awaits invoke the adapter only once',async()=>{
  const h=harness();
  await h.studio.run('save',config,undefined,true);
  const bothReading=deferred(),releaseReads=deferred(),adapterStarted=deferred(),releaseAdapter=deferred();
  const readRecord=h.studio.credentials.readRecord;
  let reads=0,adapterCalls=0;
  h.studio.credentials.readRecord=async record=>{
    if(++reads===2)bothReading.resolve();
    await releaseReads.promise;
    return readRecord(record);
  };
  h.adapters.generateImages=async()=>{
    adapterCalls++;
    adapterStarted.resolve();
    await releaseAdapter.promise;
    return [{bytes:new Uint8Array([1,2,3]),mediaType:'image/png'}];
  };
  const first=h.studio.run('generate',{prompt:'first'});
  const second=h.studio.run('generate',{prompt:'second'});
  const rejected=assert.rejects(second,/已有生图任务在运行/);
  await bothReading.promise;
  assert.equal(reads,2);
  releaseReads.resolve();
  await adapterStarted.promise;
  await rejected;
  assert.equal(adapterCalls,1);
  releaseAdapter.resolve();
  const result=await first;
  assert.equal(result.images.length,1);
  assert.equal(h.saved.length,1);
  assert.equal(h.studio.generating,false);
});

test('deleting a saved endpoint key leaves another endpoint credential intact',async()=>{
  const h=harness();
  await h.studio.run('save',config,undefined,true);
  const firstRecord=Array.from(h.records.keys())[0];
  await h.studio.run('save',{...config,baseUrl:'https://other.example',apiKey:'other-test-key'},undefined,true);
  const otherRecord=Array.from(h.records.keys()).find(record=>record!==firstRecord);
  const current=await h.studio.run('save',{baseUrl:config.baseUrl,model:config.model},undefined,true);
  assert.equal(current.hasKey,true);
  const result=await h.studio.run('forgetKey',{expectedRevision:current.revision},undefined,true);
  assert.equal(result.hasKey,false);
  assert.equal(result.configured,false);
  assert.equal(h.records.has(firstRecord),false);
  assert.equal(h.records.get(otherRecord).key,'other-test-key');
  assert.equal(h.records.size,1);
  await assert.rejects(h.studio.run('generate',{prompt:'test'}),/没有密钥/);
  assert.equal(h.calls.length,0);
});

test('dispose aborts active generation, clears previews and releases the generation lock',async()=>{
  const h=harness();
  await h.studio.run('save',config,undefined,true);
  const previous=await h.studio.run('generate',{prompt:'existing preview'});
  const id=previous.images[0].id;
  assert.ok(await h.studio.preview(id));
  const started=deferred();
  let adapterSignal;
  h.adapters.generateImages=({signal})=>new Promise((resolve,reject)=>{
    adapterSignal=signal;
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    started.resolve();
  });
  const pending=h.studio.run('generate',{prompt:'cancel on disposal'});
  const rejected=assert.rejects(pending,{name:'AbortError'});
  await started.promise;
  h.studio.dispose();
  await rejected;
  assert.equal(adapterSignal.aborted,true);
  assert.equal(h.studio.generating,false);
  assert.equal(await h.studio.preview(id),null);
  assert.equal(h.saved.length,1);
});

test('status revision matches its captured settings when configuration changes during credential lookup',async()=>{
  const h=harness();
  const original=await h.studio.run('save',config,undefined,true);
  const entered=deferred(),release=deferred();
  const describeRecord=h.studio.credentials.describeRecord;
  h.studio.credentials.describeRecord=async record=>{
    entered.resolve();
    await release.promise;
    return describeRecord(record);
  };
  const pending=h.studio.run('status');
  await entered.promise;
  await h.studio.saveSettings({...h.settings(),model:'concurrent-model'});
  release.resolve();
  const result=await pending;
  assert.deepEqual(result.settings,original.settings);
  assert.equal(result.revision,original.revision);
  assert.notEqual(result.revision,h.studio.revision());
  assert.equal(h.settings().model,'concurrent-model');
  await assert.rejects(h.studio.run('generate',{prompt:'stale UI prompt',expectedRevision:result.revision}),/配置已在其他位置更改/);
  assert.equal(h.calls.length,0);
});
