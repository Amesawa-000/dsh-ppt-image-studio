import Schema from '@deepseek-ai/schemastery';
import { Service } from '@deepseek-ai/cordis';
import { StudioOperations, DEFAULTS, API_PATH } from './studio.js';
export const name = 'ppt-image-studio';
export const inject = ['tools','credentials','attachments','connection','configEditor'];
export const Config = Schema.object({
  settings: Schema.object({
    baseUrl: Schema.string().default(''),
    protocol: Schema.union(['openai-images','gemini']).default('openai-images'),
    model: Schema.string().default(''),
    size: Schema.string().default('auto'),
  }).default(DEFAULTS).volatile(),
});
class ImageStudioService extends Service {
  constructor(ctx,config) {
    super(ctx,'pptImageStudio');
    this.operations = new StudioOperations({
      getSettings:()=> config.settings?.get ? config.settings.get() : config.settings ?? DEFAULTS,
      saveSettings: async settings => {
        const entry=ctx.fiber.entry;
        if(!entry) throw new Error('当前运行方式无法保存插件配置。');
        await ctx.configEditor.edit(entry,current=>({...current,settings}));
      },
      credentials:ctx.credentials, attachments:ctx.attachments,
    });
    ctx.effect(()=>()=>this.operations.dispose());
  }
  run(action,input,signal,allowKey=false){return this.operations.run(action,input,signal,allowKey);}
  preview(id,signal){return this.operations.preview(id,signal);}
}
const output = {schema:{type:'object',additionalProperties:true}, render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
const string = description => ({type:'string',description});
export function apply(ctx,config) {
  const studio=new ImageStudioService(ctx,config);
  ctx.effect(()=>ctx.connection.fetch.register({
    path:API_PATH, methods:['POST'],requestBody:'buffered',
    async fetch(request){
      try {
        if(!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({error:'需要 JSON 请求。'},{status:415});
        const text=await request.text();
        if(text.length>40000) return Response.json({error:'请求过大。'},{status:413});
        const {action,input={}}=JSON.parse(text);
        const value=await studio.run(action,input,request.signal,true);
        return Response.json(value,{headers:{'Cache-Control':'no-store'}});
      } catch(error){
        return Response.json({error:error instanceof SyntaxError?'请求 JSON 无效。':String(error.message||'操作失败。')},{status:400,headers:{'Cache-Control':'no-store'}});
      }
    },
  }));
  ctx.effect(()=>ctx.connection.fetch.register({
    path:`${API_PATH}/preview`,methods:['GET','HEAD'],requestBody:'buffered',
    async fetch(request){
      const image=await studio.preview(new URL(request.url).searchParams.get('id'),request.signal);
      if(!image) return new Response('Preview expired',{status:404});
      return new Response(request.method==='HEAD'?null:image.data,{headers:{'Content-Type':image.ref.mediaType,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    },
  }));
  ctx.effect(()=>ctx.tools.register({
    name:'ppt_image_settings',
    description:'Inspect PPT image-generation setup, detect the API protocol, list models, or save a model/size choice. API keys must be entered in Settings → PPT 配图, not chat. Detection only reads the model list and does not generate a billable image.',
    parameters:{type:'object',properties:{action:{type:'string',enum:['status','detect','models','save']},model:string('Model ID returned by the provider.'),size:string('auto, an OpenAI pixel size, or Gemini aspect ratio.')},required:['action'],additionalProperties:false},
    output,timeoutMs:65000,
    execute:async(args,exec)=>studio.run(args.action,{...(args.model!==undefined?{model:args.model}:{}),...(args.size!==undefined?{size:args.size}:{})},exec.signal),
  }));
  ctx.effect(()=>ctx.tools.register({
    name:'ppt_generate_image',
    description:'Generate a picture for a presentation from your own prompt using the saved provider. Compose the prompt from the slide subject, visual style, colors, composition and space for editable slide text. Returns local original-image paths and previews for insertion into PPTX. Each call may incur provider charges; do not silently retry a timed-out generation.',
    parameters:{type:'object',properties:{prompt:string('Full image prompt. Match the deck topic; avoid baked-in slide text unless requested. Do not fabricate charts, data or scientific evidence.'),model:string('Optional override of the saved model ID.'),size:string('Optional image size: auto, OpenAI pixel dimensions, or Gemini aspect ratio.')},required:['prompt'],additionalProperties:false},
    output:{...output,render:(args,value)=>[...output.render(args,value),...(value.images??[]).flatMap(image=>[{type:'image',attachment:image.attachment},{type:'file',attachment:image.originalAttachment}])]},
    timeoutMs:300000,isConcurrencySafe:()=>false,
    execute:async(args,exec)=>studio.run('generate',args,exec.signal),
  }));
}
