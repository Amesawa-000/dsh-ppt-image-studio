import { createHash, randomUUID } from 'node:crypto';
import { normalizeEndpoint, detectProtocol, discoverModels, generateImages } from './adapters.js';

export const DEFAULTS = {baseUrl:'', protocol:'openai-images', model:'', size:'auto'};
export const API_PATH = '/api/ppt-image-studio';
export const PROTOCOLS = ['openai-images','gemini'];
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置必须是对象。');
  const protocol = value.protocol ?? 'openai-images';
  if (!PROTOCOLS.includes(protocol)) throw new Error('请选择 OpenAI Images 或 Gemini 协议。');
  const baseUrl = value.baseUrl ? normalizeEndpoint(value.baseUrl, protocol) : '';
  const model = String(value.model ?? '').trim();
  const size = String(value.size ?? 'auto').trim();
  if (model.length > 200 || /[\r\n]/.test(model)) throw new Error('模型名称格式无效。');
  if (!['auto','1024x1024','1536x1024','1024x1536','1792x1024','1024x1792','1:1','16:9','9:16','4:3','3:4'].includes(size)) throw new Error('图片尺寸或比例无效。');
  return {baseUrl,protocol,model,size};
}
function recordKey(settings) {
  // Bind the stored secret to the precise API root; never forward a saved key to a changed address.
  return 'ppt-image-studio/' + createHash('sha256').update(settings.baseUrl).digest('hex').slice(0,32);
}
export class StudioOperations {
  constructor({getSettings,saveSettings,credentials,attachments,adapters={detectProtocol,discoverModels,generateImages}}) {
    Object.assign(this,{getSettings,saveSettings,credentials,attachments,adapters});
    this.previews = new Map(); this.controller = new AbortController(); this.generating = false; this.saving = false;
  }
  dispose() { this.controller.abort(); this.previews.clear(); }
  settings() { return validateSettings(this.getSettings()); }
  revision(settings=this.settings()) { return createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0,24); }
  assertRevision(expected) { if(expected !== undefined && expected !== this.revision()) throw new Error('配置已在其他位置更改，请重新读取配置后确认。'); }
  async status() {
    const settings = this.settings();
    const info = settings.baseUrl ? await this.credentials.describeRecord(recordKey(settings)) : {configured:false};
    return {settings,revision:this.revision(settings),hasKey:info.configured,configured:Boolean(settings.baseUrl && settings.model && info.configured)};
  }
  async withKey(input, signal, allowKey) {
    const settings = validateSettings({...this.settings(),...input});
    if (!settings.baseUrl) throw new Error('请先填写 API 地址。');
    if (!allowKey && Object.hasOwn(input,'apiKey')) throw new Error('请在图形页面输入密钥，不要通过 agent 工具提交。');
    const typed = allowKey && typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const record = typed ? undefined : await this.credentials.readRecord(recordKey(settings));
    const apiKey = typed || (record?.kind === 'api-key' ? record.key : '');
    if (!apiKey) throw new Error('当前 API 地址没有密钥。请在设置 → PPT 配图中填写。');
    if (apiKey.length > 8192 || /[\r\n]/.test(apiKey)) throw new Error('API Key 格式无效。');
    return {...settings,apiKey,signal:AbortSignal.any([this.controller.signal,...(signal?[signal]:[])])};
  }
  async run(action,input={},signal,allowKey=false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须是对象。');
    if (action === 'status') return this.status();
    this.assertRevision(input.expectedRevision);
    signal?.throwIfAborted();
    if (action === 'forgetKey') {
      if (!allowKey) throw new Error('删除密钥只可在设置页面操作。');
      const settings = this.settings();
      if(settings.baseUrl) await this.credentials.deleteRecord(recordKey(settings));
      return this.status();
    }
    if (action === 'save') {
      if (this.saving) throw new Error('正在保存，请稍后再试。');
      this.saving=true;
      try {
        const options = await this.withKey(input,signal,allowKey);
        const settings = validateSettings(options);
        if (!settings.model) throw new Error('请选择模型，或填写服务商提供的模型 ID。');
        this.assertRevision(input.expectedRevision);
        signal?.throwIfAborted();
        if (allowKey && input.apiKey?.trim()) await this.credentials.modifyRecord(recordKey(settings),async()=>({kind:'api-key',key:options.apiKey}));
        await this.saveSettings(settings);
        return this.status();
      } finally {this.saving=false;}
    }
    if (action === 'detect' || action === 'models') {
      const options = await this.withKey(input,signal,allowKey);
      if(action==='detect') return this.adapters.detectProtocol({...options,baseUrl:input.baseUrl || options.baseUrl,timeoutMs:30000});
      return {protocol:options.protocol,baseUrl:options.baseUrl,models:await this.adapters.discoverModels(options)};
    }
    if(action !== 'generate') throw new Error('未知操作。');
    // Generation always uses saved configuration, never a secret or address supplied by the agent.
    if ('apiKey' in input || 'baseUrl' in input || 'protocol' in input) throw new Error('生图使用已保存的 API 配置。请先保存设置。');
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt || prompt.length > 16000) throw new Error('提示词不能为空，且不得超过 16000 字符。');
    if(this.generating) throw new Error('已有生图任务在运行，请等待完成。');
    const options = await this.withKey({model:input.model ?? this.settings().model,size:input.size ?? this.settings().size},signal,false);
    if(!options.model) throw new Error('请先选择并保存模型。');
    this.assertRevision(input.expectedRevision);
    if(this.generating) throw new Error('已有生图任务在运行，请等待完成。');
    this.generating=true;
    try {
      const images = await this.adapters.generateImages({...options,prompt});
      const inputs=images.map((image,index)=>({data:image.bytes,mediaType:image.mediaType,name:`ppt-image-${Date.now()}-${index+1}.${({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'})[image.mediaType]||'png'}`}));
      for (const image of inputs) await this.attachments.validateImage(image);
      const results=[];
      for (const image of inputs) {
        const raw = await this.attachments.saveFile({data:image.data,name:image.name});
        const attachment = await this.attachments.saveImage(image);
        const id=randomUUID(); this.previews.set(id,{attachment,raw});
        while(this.previews.size>24) this.previews.delete(this.previews.keys().next().value);
        results.push({id,name:image.name,path:this.attachments.fileHostPath(raw) ?? null,attachment,originalAttachment:raw,previewUrl:`${API_PATH}/preview?id=${id}`});
      }
      return {model:options.model,prompt,images:results};
    } finally {this.generating=false;}
  }
  async preview(id,signal) {
    const item=this.previews.get(id);
    if(!item) return null;
    return this.attachments.readImage(item.attachment,signal);
  }
}
