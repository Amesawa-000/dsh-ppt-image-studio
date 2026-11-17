import { Buffer } from 'node:buffer';
import { isIP } from 'node:net';

// Pure Node ESM. No DSH APIs, persisted state, network retries or implicit generation.
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGES = 4;
const DEFAULT_TIMEOUT_MS = 120_000;
const PROTOCOLS = ['openai-images', 'gemini'];
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);

function fail(code, message) {
  const error = new Error(message);
  error.name = 'AdapterError';
  error.code = code;
  return error;
}
function checkedUrl(value, allowQuery = false) {
  if (typeof value !== 'string' || !value || /[\s#]/u.test(value) || (!allowQuery && value.includes('?'))) {
    throw fail('INVALID_URL', 'URL must be absolute with no credentials, whitespace or fragment; API queries are not allowed.');
  }
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_URL', 'Invalid absolute URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw fail('INSECURE_URL', 'HTTPS is required except on localhost.');
  }
  if (url.username || url.password || /^[a-z]+:\/\/[^/]*@/iu.test(value)) {
    throw fail('INVALID_URL', 'URL credentials are not allowed.');
  }
  return url;
}
function restrictedIp(hostname) {
  const host = hostname.replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 198 && [18, 19].includes(b)) || a >= 224;
  }
  if (family !== 6) return false; // No DNS resolution: ordinary CDN names remain usable.
  const halves = host.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = (halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left).map(part => parseInt(part, 16));
  if (words.slice(0, 6).every(word => word === 0) || (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff)) {
    return restrictedIp(`${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`);
  }
  return (words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xffc0) === 0xfec0 || (words[0] & 0xff00) === 0xff00;
}
function checkedDownloadUrl(value, apiOrigin) {
  const url = checkedUrl(value, true);
  if (url.protocol !== 'https:' && url.search) throw fail('INSECURE_URL', 'Signed image URLs require HTTPS.');
  if (url.origin !== apiOrigin && restrictedIp(url.hostname)) {
    throw fail('UNSAFE_IMAGE_URL', 'Cross-origin private or loopback image targets are not allowed.');
  }
  return url;
}
function checkProtocol(protocol) {
  if (!PROTOCOLS.includes(protocol)) throw fail('INVALID_PROTOCOL', 'Unsupported image API protocol.');
}

/** Return the API root, not the generation route. Explicit version prefixes are preserved. */
export function normalizeEndpoint(baseUrl, protocol) {
  checkProtocol(protocol);
  const url = checkedUrl(baseUrl);
  let path = url.pathname.replace(/\/+$/u, '');
  path = path.replace(/\/images\/generations$/u, '')
    .replace(/\/models(?:\/[^/]+:generateContent)?$/u, '');
  if (!path) path = protocol === 'gemini' ? '/v1beta' : '/v1';
  url.pathname = path;
  return url.href.replace(/\/$/u, '');
}
function authentication(apiKey, protocol) {
  if (apiKey == null || apiKey === '') return {};
  if (typeof apiKey !== 'string' || /[\r\n\u0000]/u.test(apiKey)) {
    throw fail('INVALID_KEY', 'Invalid API key.');
  }
  return protocol === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };
}

async function withOperation(options, fetchImpl, run) {
  if (typeof fetchImpl !== 'function') throw fail('INVALID_FETCH', 'A fetch implementation is required.');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw fail('INVALID_TIMEOUT', 'timeoutMs must be a positive integer within the timer range.');
  }
  const controller = new AbortController();
  const external = options.signal;
  let timedOut = false;
  const abort = () => controller.abort(); // Never copy a potentially secret-bearing abort reason.
  if (external?.aborted) abort();
  external?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  const signal = controller.signal;
  const abortError = () => fail(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut ? 'Image API operation timed out.' : 'Image API operation aborted.');
  async function wait(promise) {
    if (signal.aborted) {
      void Promise.resolve(promise).catch(() => {});
      throw abortError();
    }
    let listener;
    const cancelled = new Promise((_, reject) => {
      listener = () => reject(abortError());
      signal.addEventListener('abort', listener, { once: true });
    });
    try { return await Promise.race([promise, cancelled]); }
    finally { signal.removeEventListener('abort', listener); }
  }
  async function request(url, init = {}, imageDownload = false) {
    if (signal.aborted) throw abortError();
    const safeUrl = (imageDownload ? checkedDownloadUrl(url, checkedUrl(options.baseUrl).origin) : checkedUrl(url)).href;
    let response;
    try {
      response = await wait(fetchImpl(safeUrl, {
        ...init, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
      }));
    } catch (error) {
      if (signal.aborted) throw abortError();
      // Do not retain fetch's message/cause: it may contain keys, bodies or signed URLs.
      throw fail('NETWORK_ERROR', 'Image API network request failed.');
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel?.().catch(() => {});
      throw fail('REDIRECT_BLOCKED', 'Redirects are not allowed.');
    }
    if (!response.ok) {
      void response.body?.cancel?.().catch(() => {});
      const error = fail('HTTP_ERROR', `Image API request failed (HTTP ${Number.isInteger(response.status) ? response.status : 0}).`);
      error.status = Number.isInteger(response.status) ? response.status : 0;
      throw error;
    }
    return response;
  }
  async function bytes(response) {
    const advertised = response.headers?.get('content-length');
    if (advertised && /^\d+$/u.test(advertised) && Number(advertised) > MAX_RESPONSE_BYTES) {
      void response.body?.cancel?.().catch(() => {});
      throw fail('RESPONSE_TOO_LARGE', 'Response exceeds the 32 MiB limit.');
    }
    // Streaming is mandatory so an absent/lying Content-Length cannot bypass the cap.
    if (!response.body?.getReader) throw fail('INVALID_RESPONSE', 'Response does not provide a readable body.');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let finished = false;
    try {
      while (true) {
        const { value, done } = await wait(reader.read());
        if (done) { finished = true; break; }
        if (!(value instanceof Uint8Array)) throw fail('INVALID_RESPONSE', 'Response contains invalid bytes.');
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw fail('RESPONSE_TOO_LARGE', 'Response exceeds the 32 MiB limit.');
        chunks.push(value);
      }
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      return result;
    } finally {
      if (!finished) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function json(response) {
    const raw = await bytes(response);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { throw fail('INVALID_RESPONSE', 'Provider returned invalid JSON.'); }
  }
  try { return await run({ request, bytes, json, signal }); }
  catch (error) {
    if (signal.aborted) throw abortError();
    if (error?.name === 'AdapterError') throw error;
    throw fail('INVALID_RESPONSE', 'Image API operation failed.');
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', abort);
  }
}
function modelIds(payload, protocol) {
  const rows = protocol === 'gemini' ? payload?.models : payload?.data;
  if (!Array.isArray(rows)) throw fail('INVALID_RESPONSE', 'Provider returned no valid model list.');
  if (rows.length > 500) throw fail('MODEL_LIMIT_EXCEEDED', 'Provider returned more than 500 models.');
  const ids = rows.map(row => protocol === 'gemini' ? row?.name : row?.id);
  if (ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) throw fail('INVALID_RESPONSE', 'Provider returned an invalid model identifier (maximum 200 characters).');
  return [...new Set(ids)];
}

/** Return <=500 string IDs (<=200 chars each), without inferring image support.
 * Reads one model-list response only; provider pagination links/tokens are not followed.
 */
export async function discoverModels(options, fetchImpl = fetch) {
  const { baseUrl, apiKey, protocol } = options;
  const root = normalizeEndpoint(baseUrl, protocol);
  const headers = authentication(apiKey, protocol);
  return withOperation(options, fetchImpl, async ({ request, json }) => {
    return modelIds(await json(await request(`${root}/models`, { headers })), protocol);
  });
}

/** Only GET /models on the supplied origin. Never generates or follows redirects. */
export async function detectProtocol(options, fetchImpl = fetch) {
  const origin = checkedUrl(options.baseUrl).origin;
  return withOperation(options, fetchImpl, async ({ request, json }) => {
    const matches = [];
    let authenticationError;
    const preferred = /\/v1beta(?:\/|$)/u.test(new URL(options.baseUrl).pathname)
      ? ['gemini', 'openai-images'] : PROTOCOLS;
    for (const protocol of preferred) {
      const root = normalizeEndpoint(options.baseUrl, protocol);
      const url = `${root}/models`;
      if (new URL(url).origin !== origin) throw fail('INVALID_URL', 'Protocol discovery must remain on the supplied origin.');
      try {
        const payload = await json(await request(url, { headers: authentication(options.apiKey ?? options.key, protocol) }));
        const models = modelIds(payload, protocol);
        matches.push({ protocol, models, baseUrl: root });
      } catch (error) {
        // Different protocols authenticate differently; a rejected probe is not proof
        // that the other protocol is unsupported. Keep the error if neither succeeds.
        if (error.code === 'HTTP_ERROR' && [401, 403].includes(error.status)) {
          authenticationError = error;
          continue;
        }
        if (error.code === 'INVALID_RESPONSE' || (error.code === 'HTTP_ERROR' && [404, 405].includes(error.status))) continue;
        throw error;
      }
    }
    if (!matches.length && authenticationError) throw authenticationError;
    if (matches.length !== 1) throw fail(matches.length ? 'AMBIGUOUS_PROTOCOL' : 'PROTOCOL_NOT_FOUND', matches.length ? 'Multiple protocols found; choose a protocol explicitly.' : 'No supported model-list protocol found; choose a protocol explicitly.');
    return matches[0];
  });
}
function decodeImage(data, declaredType) {
  if (typeof data !== 'string' || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
    throw fail('INVALID_IMAGE', 'Provider returned invalid base64 image data.');
  }
  if (data.length > Math.ceil(MAX_RESPONSE_BYTES / 3) * 4) throw fail('RESPONSE_TOO_LARGE', 'Image exceeds the 32 MiB limit.');
  const bytes = new Uint8Array(Buffer.from(data, 'base64'));
  return imageResult(bytes, declaredType);
}
function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes[0] === 137 && Buffer.from(bytes.subarray(1, 8)).equals(Buffer.from([80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const head = Buffer.from(bytes.subarray(0, 16)).toString('ascii');
  if (/^GIF8[79]a/u.test(head)) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(head.slice(8, 12))) return 'image/avif';
  if (head.startsWith('BM')) return 'image/bmp';
  throw fail('INVALID_IMAGE', 'Provider did not return a supported raster image.');
}
function imageResult(bytes, declaredType) {
  if (!bytes.length || bytes.byteLength > MAX_RESPONSE_BYTES) throw fail('INVALID_IMAGE', 'Invalid image size.');
  const mediaType = sniffImage(bytes);
  const declared = declaredType?.split(';')[0].trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && (!IMAGE_TYPES.has(declared) || declared !== mediaType)) {
    throw fail('INVALID_IMAGE', 'Image media type does not match its bytes.');
  }
  return { bytes, mediaType };
}
function geminiImageConfig(size) {
  if (!size || size === 'auto') return undefined;
  const ratios = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
  if (['1K', '2K', '4K'].includes(size)) return { imageSize: size };
  if (ratios.has(size)) return { aspectRatio: size };
  const dimensions = /^(\d{1,5})x(\d{1,5})$/u.exec(size);
  if (dimensions) {
    const width = Number(dimensions[1]), height = Number(dimensions[2]);
    const ratio = [...ratios].find(value => {
      const [a, b] = value.split(':').map(Number);
      return width > 0 && height > 0 && width * b === height * a;
    });
    if (ratio) return { aspectRatio: ratio };
  }
  throw fail('INVALID_SIZE', 'Gemini size must be a supported aspect ratio, matching dimensions, or 1K/2K/4K.');
}

/** Return Array<{bytes: Uint8Array, mediaType: string}>. Exactly one generation POST, never retried. */
export async function generateImages(options, fetchImpl = fetch) {
  const { baseUrl, apiKey, protocol, prompt, size } = options;
  const root = normalizeEndpoint(baseUrl, protocol);
  if (typeof options.model !== 'string' || !options.model.trim() || typeof prompt !== 'string' || !prompt.trim()) {
    throw fail('INVALID_INPUT', 'A model and nonempty prompt are required.');
  }
  const model = options.model.trim();
  const headers = { ...authentication(apiKey, protocol), 'Content-Type': 'application/json' };
  let url, body;
  if (protocol === 'openai-images') {
    if (size !== undefined && (typeof size !== 'string' || !/^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(size))) {
      throw fail('INVALID_SIZE', 'OpenAI image size must be auto or WIDTHxHEIGHT.');
    }
    url = `${root}/images/generations`;
    // response_format is omitted: some newer image models reject it but return b64_json by default.
    body = { model, prompt, n: 1, ...(size ? { size } : {}) };
  } else {
    const id = model.replace(/^models\//u, '');
    if (!/^[A-Za-z0-9_.-]+$/u.test(id)) throw fail('INVALID_MODEL', 'Invalid Gemini model identifier.');
    url = `${root}/models/${encodeURIComponent(id)}:generateContent`;
    const imageConfig = geminiImageConfig(size);
    body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(imageConfig ? { imageConfig } : {}) },
    };
  }
  return withOperation(options, fetchImpl, async ({ request, json, bytes }) => {
    const payload = await json(await request(url, { method: 'POST', headers, body: JSON.stringify(body) }));
    let entries;
    if (protocol === 'openai-images') {
      entries = payload?.data;
      if (!Array.isArray(entries)) throw fail('INVALID_RESPONSE', 'Provider returned no image array.');
    } else {
      if (!Array.isArray(payload?.candidates)) throw fail('INVALID_RESPONSE', 'Provider returned no image candidates.');
      entries = payload.candidates.flatMap(candidate => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
        .filter(part => part?.inlineData || part?.inline_data)
        .map(part => ({ inline: part.inlineData ?? part.inline_data }));
    }
    if (entries.length === 0) throw fail('NO_IMAGES', 'Provider returned no images.');
    if (entries.length > MAX_IMAGES) throw fail('TOO_MANY_IMAGES', 'Provider returned more than 4 images.');
    const results = [];
    let total = 0;
    for (const entry of entries) {
      let image;
      if (entry?.inline) image = decodeImage(entry.inline.data, entry.inline.mimeType ?? entry.inline.mime_type);
      else if (entry?.b64_json) image = decodeImage(entry.b64_json);
      else if (typeof entry?.url === 'string') {
        // Deliberately no Authorization or x-goog-api-key, including same-origin image downloads.
        const response = await request(entry.url, { headers: { Accept: 'image/*' } }, true);
        image = imageResult(await bytes(response), response.headers?.get('content-type'));
      } else throw fail('INVALID_IMAGE', 'Provider returned an unsupported image entry.');
      total += image.bytes.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw fail('RESPONSE_TOO_LARGE', 'Combined images exceed the 32 MiB limit.');
      results.push(image);
    }
    return results;
  });
}
