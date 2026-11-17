import test from 'node:test';
import assert from 'node:assert/strict';
import {apply,Config} from './index.js';
function mount(){
  const routes=new Map(),tools=new Map(),cleanup=[];let current={};const records=new Map();
  const ctx={fiber:{entry:{id:'test-plugin'}},reflect:{provide(name,value){ctx[name]=value;}},effect(fn){cleanup.push(fn());},
    connection:{fetch:{register(route){routes.set(route.path,route);return()=>routes.delete(route.path);}}},
    tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name);}},
    credentials:{describeRecord:async k=>({configured:records.has(k)}),readRecord:async k=>records.get(k),modifyRecord:async(k,fn)=>records.set(k,await fn()),deleteRecord:async k=>records.delete(k)},
    attachments:{validateImage:async()=>{},saveImage:async i=>({id:'test-image',mediaType:i.mediaType,width:1,height:1,bytes:i.data.length}),saveFile:async i=>({id:'test-file',name:i.name,bytes:i.data.length}),fileHostPath:()=>'/test/file.png',readImage:async ref=>({ref,data:new Uint8Array([1,2,3])})},
    configEditor:{edit:async(entry,fn)=>{current=fn(current);}},
  };
  apply(ctx,{settings:{get:()=>current.settings??{}}});
  async function post(body,headers={'content-type':'application/json'}){return routes.get('/api/ppt-image-studio').fetch(new Request('http://localhost/api/ppt-image-studio',{method:'POST',headers,body:typeof body==='string'?body:JSON.stringify(body)}));}
  return {ctx,routes,tools,post,cleanup};
}
test('Host registers both tools and routes with output contracts',()=>{const h=mount();assert.equal(h.tools.size,2);assert.equal(h.routes.size,2);assert.ok(Config({}));for(const tool of h.tools.values()){assert.equal(typeof tool.output.render,'function');assert.ok(tool.output.schema);}});
test('settings route returns no secret and supports persisted config',async()=>{const h=mount();const r=await h.post({action:'save',input:{baseUrl:'https://provider.example',model:'test-model',apiKey:'not-real'}});assert.equal(r.status,200);const result=await r.json();assert.equal(result.configured,true);assert.ok(!JSON.stringify(result).includes('not-real'));const toolStatus=await h.tools.get('ppt_image_settings').execute({action:'status'},{signal:new AbortController().signal});assert.equal(toolStatus.settings.model,'test-model');});
test('Host rejects malformed requests and expired previews',async()=>{const h=mount();assert.equal((await h.post('{bad')).status,400);assert.equal((await h.post('{}',{'content-type':'text/plain'})).status,415);assert.equal((await h.post(' '.repeat(40001))).status,413);assert.equal((await h.routes.get('/api/ppt-image-studio/preview').fetch(new Request('http://localhost/api/ppt-image-studio/preview?id=unknown'))).status,404);});
test('generation output includes original file and image attachments',async()=>{const h=mount();await h.post({action:'save',input:{baseUrl:'https://provider.example',model:'test-model',apiKey:'not-real'}});h.ctx.pptImageStudio.operations.adapters={generateImages:async()=>[{bytes:new Uint8Array([1,2,3]),mediaType:'image/png'}]};const tool=h.tools.get('ppt_generate_image');const result=await tool.execute({prompt:'An illustration'},{signal:new AbortController().signal});const rendered=tool.output.render({},result);assert.deepEqual(rendered.map(x=>x.type),['text','image','file']);assert.equal(rendered[2].attachment.id,'test-file');const preview=await h.routes.get('/api/ppt-image-studio/preview').fetch(new Request('http://localhost'+result.images[0].previewUrl));assert.equal(preview.headers.get('content-type'),'image/png');assert.equal((await preview.arrayBuffer()).byteLength,3);});
test('registered resources dispose cleanly',async()=>{const h=mount();for(const fn of h.cleanup.reverse())if(fn)await fn();assert.equal(h.routes.size,0);assert.equal(h.tools.size,0);assert.equal(h.ctx.pptImageStudio.operations.controller.signal.aborted,true);});
