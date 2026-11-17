import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { normalizeEndpoint, discoverModels, detectProtocol, generateImages, MAX_RESPONSE_BYTES } from './adapters.js';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const b64 = Buffer.from(PNG).toString('base64');
const key = 'private-test-secret';
const options = { baseUrl: 'https://provider.example', apiKey: key, protocol: 'openai-images', model: 'chosen-image-model', prompt: 'A calm landscape' };
const json = (value, init = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...init });
const generation = data => json({ data });
function mock(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.ok(init.signal instanceof AbortSignal);
    if (!responses.length) throw new Error('Unexpected extra request');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { fetch, calls };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code && !error.message.includes(key) && !error.cause);

test('normalize origin, versioned roots, proxy prefix and full endpoints', () => {
  assert.equal(normalizeEndpoint('https://provider.example/', 'openai-images'), 'https://provider.example/v1');
  assert.equal(normalizeEndpoint('https://provider.example', 'gemini'), 'https://provider.example/v1beta');
  assert.equal(normalizeEndpoint('https://provider.example/v1/', 'gemini'), 'https://provider.example/v1');
  assert.equal(normalizeEndpoint('https://provider.example/v1beta/', 'gemini'), 'https://provider.example/v1beta');
  assert.equal(normalizeEndpoint('https://provider.example/proxy/v1/images/generations/', 'openai-images'), 'https://provider.example/proxy/v1');
  assert.equal(normalizeEndpoint('https://provider.example/v1beta/models/test:generateContent', 'gemini'), 'https://provider.example/v1beta');
  assert.equal(normalizeEndpoint('http://localhost:8000', 'openai-images'), 'http://localhost:8000/v1');
  assert.equal(normalizeEndpoint('http://127.0.0.1:8000/v1', 'openai-images'), 'http://127.0.0.1:8000/v1');
  assert.equal(normalizeEndpoint('http://[::1]:8000', 'gemini'), 'http://[::1]:8000/v1beta');
});

test('reject unsafe URL inputs before any request, without echoing secrets', async () => {
  const values = ['http://provider.example', 'http://localhost.evil.example', 'file:///tmp/image', `https://user:${key}@provider.example`, `https://provider.example?api_key=${key}`, 'https://provider.example?', 'https://provider.example/#fragment', 'not a URL'];
  const network = mock([]);
  for (const baseUrl of values) {
    assert.throws(() => normalizeEndpoint(baseUrl, 'openai-images'), error => !error.message.includes(key));
    await assert.rejects(discoverModels({ ...options, baseUrl }, network.fetch));
  }
  assert.equal(network.calls.length, 0);
  assert.throws(() => normalizeEndpoint(options.baseUrl, 'unknown'), { code: 'INVALID_PROTOCOL' });
});

test('discoverModels preserves all IDs, including text models, and deduplicates', async () => {
  const network = mock([json({ data: [{ id: 'text-only' }, { id: 'image-maybe' }, { id: 'text-only' }] })]);
  assert.deepEqual(await discoverModels(options, network.fetch), ['text-only', 'image-maybe']);
  assert.equal(network.calls[0].url, 'https://provider.example/v1/models');
  assert.equal(network.calls[0].init.headers.Authorization, `Bearer ${key}`);
  assert.equal(network.calls[0].init.method, undefined);
});

test('Gemini models use header authentication and preserve models/ prefix', async () => {
  const network = mock([json({ models: [{ name: 'models/text-model', supportedGenerationMethods: ['generateContent'] }] })]);
  assert.deepEqual(await discoverModels({ ...options, protocol: 'gemini' }, network.fetch), ['models/text-model']);
  assert.equal(network.calls[0].url, 'https://provider.example/v1beta/models');
  assert.deepEqual(network.calls[0].init.headers, { 'x-goog-api-key': key });
});

test('OpenAI generates once and reads b64_json into Uint8Array', async () => {
  const network = mock([generation([{ b64_json: b64 }])]);
  const result = await generateImages({ ...options, size: '1536x1024' }, network.fetch);
  assert.equal(result.length, 1);
  assert.ok(result[0].bytes instanceof Uint8Array);
  assert.deepEqual(result[0], { bytes: PNG, mediaType: 'image/png' });
  assert.equal(network.calls.length, 1);
  assert.equal(network.calls[0].url, 'https://provider.example/v1/images/generations');
  assert.equal(network.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(network.calls[0].init.body), { model: options.model, prompt: options.prompt, n: 1, size: '1536x1024' });
});

test('Gemini generates with inlineData, image aspect ratio and no hardcoded model', async () => {
  const network = mock([json({ candidates: [{ content: { parts: [{ text: 'A picture' }, { inlineData: { mimeType: 'image/png', data: b64 } }] } }] })]);
  const result = await generateImages({ ...options, protocol: 'gemini', model: 'models/user-picked', size: '1536x1024' }, network.fetch);
  assert.deepEqual(result, [{ bytes: PNG, mediaType: 'image/png' }]);
  assert.equal(network.calls[0].url, 'https://provider.example/v1beta/models/user-picked:generateContent');
  const body = JSON.parse(network.calls[0].init.body);
  assert.deepEqual(body.generationConfig, { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '3:2' } });
  assert.equal(body.contents[0].parts[0].text, options.prompt);
});

test('Gemini supports aspect ratio, resolution, and snake_case inline data', async () => {
  for (const [size, expected] of [['16:9', { aspectRatio: '16:9' }], ['2K', { imageSize: '2K' }], ['auto', undefined]]) {
    const network = mock([json({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: b64 } }] } }] })]);
    assert.equal((await generateImages({ ...options, protocol: 'gemini', size }, network.fetch)).length, 1);
    assert.deepEqual(JSON.parse(network.calls[0].init.body).generationConfig.imageConfig, expected);
  }
});

test('URL images download without keys, including same-origin images', async () => {
  for (const url of ['https://cdn.example/result.png', 'https://provider.example/result.png']) {
    const network = mock([generation([{ url }]), new Response(PNG, { headers: { 'content-type': 'image/png' } })]);
    assert.deepEqual(await generateImages(options, network.fetch), [{ bytes: PNG, mediaType: 'image/png' }]);
    assert.equal(network.calls.length, 2);
    assert.deepEqual(network.calls[1].init.headers, { Accept: 'image/*' });
    assert.equal(network.calls[1].url, url);
    assert.ok(!JSON.stringify(network.calls[1].init).includes(key));
  }
});

test('reject credentials, insecure or data image URLs before download', async () => {
  for (const url of [`https://user:${key}@cdn.example/image.png`, 'http://cdn.example/image.png', `data:image/png;base64,${b64}`]) {
    const network = mock([generation([{ url }])]);
    await assert.rejects(generateImages(options, network.fetch), error => !error.message.includes(key) && !error.message.includes(url));
    assert.equal(network.calls.length, 1);
  }
});

test('signed HTTPS image downloads preserve queries without API keys', async () => {
  const url = 'https://blob.cdn.example/image.png?sv=2024-01-01&sig=signed%2Btoken%3D&se=tomorrow';
  const network = mock([generation([{ url }]), new Response(PNG)]);
  assert.deepEqual(await generateImages(options, network.fetch), [{ bytes: PNG, mediaType: 'image/png' }]);
  assert.equal(network.calls[1].url, url);
  assert.deepEqual(network.calls[1].init.headers, { Accept: 'image/*' });
  assert.equal(network.calls[1].init.redirect, 'error');
  assert.ok(!JSON.stringify(network.calls[1]).includes(key));
  assert.throws(() => normalizeEndpoint(url, 'openai-images'), { code: 'INVALID_URL' });
});

test('signed download failures and redirects never expose signed URLs or retry', async () => {
  const url = 'https://cdn.example/image.png?sig=secret-signature';
  for (const response of [new Error(`failed ${url}`), new Response(null, { status: 302, headers: { location: url } }), json({ url }, { status: 403 })]) {
    const network = mock([generation([{ url }]), response]);
    await assert.rejects(generateImages(options, network.fetch), error => !error.message.includes('secret-signature') && !error.message.includes('cdn.example') && !error.message.includes(key) && !error.cause);
    assert.equal(network.calls.length, 2);
  }
});

test('cross-origin private, loopback, link-local IP image targets are blocked', async () => {
  const hosts = ['127.0.0.1', '2130706433', '0x7f000001', '127.1', '10.2.3.4', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '[::1]', '[::]', '[fc00::1]', '[fd12::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[::ffff:a00:1]', 'localhost'];
  for (const host of hosts) {
    const network = mock([generation([{ url: `https://${host}/image.png?sig=hidden` }])]);
    await rejectsCode(generateImages(options, network.fetch), 'UNSAFE_IMAGE_URL');
    assert.equal(network.calls.length, 1, host);
  }
});

test('same-origin local image providers and public IP downloads remain usable', async () => {
  for (const [baseUrl, url] of [
    ['http://localhost:8000', 'http://localhost:8000/image.png'],
    ['https://127.0.0.1:8443', 'https://127.0.0.1:8443/image.png?sig=ok'],
    [options.baseUrl, 'https://8.8.8.8/image.png?sig=ok'],
    [options.baseUrl, 'https://[2606:4700:4700::1111]/image.png?sig=ok'],
  ]) {
    const network = mock([generation([{ url }]), new Response(PNG)]);
    assert.equal((await generateImages({ ...options, baseUrl }, network.fetch)).length, 1);
    assert.deepEqual(network.calls[1].init.headers, { Accept: 'image/*' });
  }
  const changedPort = mock([generation([{ url: 'https://127.0.0.1:8444/image.png' }])]);
  await rejectsCode(generateImages({ ...options, baseUrl: 'https://127.0.0.1:8443' }, changedPort.fetch), 'UNSAFE_IMAGE_URL');
});

test('model list has 500-row and 200-character identifier limits for both protocols', async () => {
  for (const protocol of ['openai-images', 'gemini']) {
    const payload = ids => protocol === 'gemini' ? { models: ids.map(name => ({ name })) } : { data: ids.map(id => ({ id })) };
    const ids = Array.from({ length: 500 }, (_, index) => `model-${index}`);
    assert.deepEqual(await discoverModels({ ...options, protocol }, mock([json(payload(ids))]).fetch), ids);
    await rejectsCode(discoverModels({ ...options, protocol }, mock([json(payload([...ids, 'overflow']))]).fetch), 'MODEL_LIMIT_EXCEEDED');
    assert.deepEqual(await discoverModels({ ...options, protocol }, mock([json(payload(['x'.repeat(200)]))]).fetch), ['x'.repeat(200)]);
    await rejectsCode(discoverModels({ ...options, protocol }, mock([json(payload(['x'.repeat(201)]))]).fetch), 'INVALID_RESPONSE');
  }
});

test('protocol detection only performs GET models on user origin', async () => {
  const network = mock([json({ error: key }, { status: 404 }), json({ models: [{ name: 'models/user-selected' }] })]);
  assert.deepEqual(await detectProtocol({ baseUrl: options.baseUrl, key }, network.fetch), { protocol: 'gemini', models: ['models/user-selected'], baseUrl: 'https://provider.example/v1beta' });
  assert.equal(network.calls.length, 2);
  for (const { url, init } of network.calls) {
    assert.equal(new URL(url).origin, 'https://provider.example');
    assert.ok(url.endsWith('/models'));
    assert.equal(init.method, undefined);
    assert.equal(init.body, undefined);
    assert.ok(!url.includes(key));
  }
});

test('detection returns explicit ambiguity or unsupported errors', async () => {
  await rejectsCode(detectProtocol({ baseUrl: options.baseUrl }, mock([json({ data: [] }), json({ models: [] })]).fetch), 'AMBIGUOUS_PROTOCOL');
  await rejectsCode(detectProtocol({ baseUrl: options.baseUrl }, mock([json({}, { status: 404 }), json({}, { status: 405 })]).fetch), 'PROTOCOL_NOT_FOUND');
});

test('detection does not hide auth errors or follow provider pagination URLs', async () => {
  const network = mock([json({ error: key }, { status: 401 }), json({}, { status: 404 })]);
  await rejectsCode(detectProtocol({ baseUrl: options.baseUrl, apiKey: key }, network.fetch), 'HTTP_ERROR');
  assert.equal(network.calls.length, 2);
  const models = mock([json({ data: [{ id: 'id' }], next: 'https://evil.example/models' })]);
  assert.deepEqual(await discoverModels(options, models.fetch), ['id']);
  assert.equal(models.calls.length, 1);
});

test('detection tolerates a rejected alternate authentication mechanism', async () => {
  const network = mock([json({ data: [{ id: 'user-model' }] }), json({}, { status: 401 })]);
  assert.deepEqual(await detectProtocol({ baseUrl: options.baseUrl, apiKey: key }, network.fetch), {
    protocol: 'openai-images', models: ['user-model'], baseUrl: 'https://provider.example/v1',
  });
  const gemini = mock([json({}, { status: 401 }), json({ models: [{ name: 'models/user-model' }] })]);
  assert.equal((await detectProtocol({ baseUrl: options.baseUrl, apiKey: key }, gemini.fetch)).protocol, 'gemini');
});

test('generation never retries 429/500/network failure and sanitizes errors', async () => {
  for (const response of [json({ error: { message: key } }, { status: 429 }), json({ error: key }, { status: 500 }), new Error(`request failed https://provider.example?key=${key}`)]) {
    const network = mock([response]);
    await assert.rejects(generateImages(options, network.fetch), error => !error.message.includes(key) && !error.message.includes('provider.example') && !error.cause);
    assert.equal(network.calls.length, 1);
  }
});

test('redirect responses are blocked without another request', async () => {
  const network = mock([new Response(null, { status: 302, headers: { location: `https://evil.example?key=${key}` } })]);
  await rejectsCode(generateImages(options, network.fetch), 'REDIRECT_BLOCKED');
  assert.equal(network.calls.length, 1);
});

test('limit image count to four before downloads', async () => {
  const network = mock([generation(Array.from({ length: 5 }, () => ({ url: 'https://cdn.example/x.png' })))]);
  await rejectsCode(generateImages(options, network.fetch), 'TOO_MANY_IMAGES');
  assert.equal(network.calls.length, 1);
  const accepted = mock([generation(Array.from({ length: 4 }, () => ({ b64_json: b64 })))]);
  assert.equal((await generateImages(options, accepted.fetch)).length, 4);
  const gemini = mock([json({ candidates: [{ content: { parts: Array.from({ length: 5 }, () => ({ inlineData: { data: b64 } })) } }] })]);
  await rejectsCode(generateImages({ ...options, protocol: 'gemini' }, gemini.fetch), 'TOO_MANY_IMAGES');
});

test('reject oversized Content-Length before reading provider response', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } });
  await rejectsCode(discoverModels(options, mock([response]).fetch), 'RESPONSE_TOO_LARGE');
  assert.equal(cancelled, true);
});

test('enforce streaming size cap even when Content-Length lies', async () => {
  let cancelled = false;
  let count = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const response = new Response(new ReadableStream({
    pull(controller) { count++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-length': '1' } });
  await rejectsCode(discoverModels(options, mock([response]).fetch), 'RESPONSE_TOO_LARGE');
  assert.equal(cancelled, true);
  assert.ok(count <= 35);
});

test('cap downloaded images and combined returned bytes', async () => {
  const overlarge = mock([generation([{ url: 'https://cdn.example/image.png' }]), new Response(PNG, { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } })]);
  await rejectsCode(generateImages(options, overlarge.fetch), 'RESPONSE_TOO_LARGE');
  const large = new Uint8Array(17 * 1024 * 1024);
  large.set(PNG);
  const combined = mock([generation([{ url: 'https://cdn.example/1.png' }, { url: 'https://cdn.example/2.png' }]), new Response(large), new Response(large)]);
  await rejectsCode(generateImages(options, combined.fetch), 'RESPONSE_TOO_LARGE');
});

test('abort before sending, during fetch, and during stream reading', async () => {
  const early = new AbortController(); early.abort(new Error(key));
  const network = mock([]);
  await rejectsCode(generateImages({ ...options, signal: early.signal }, network.fetch), 'ABORTED');
  assert.equal(network.calls.length, 0);
  const during = new AbortController();
  const stalled = mock([() => { queueMicrotask(() => during.abort(key)); return new Promise(() => {}); }]);
  await rejectsCode(generateImages({ ...options, signal: during.signal }, stalled.fetch), 'ABORTED');
  assert.equal(stalled.calls.length, 1);
  const reading = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({ start() { setTimeout(() => reading.abort(key), 5); }, cancel() { cancelled = true; } });
  await rejectsCode(discoverModels({ ...options, signal: reading.signal }, mock([new Response(stream)]).fetch), 'ABORTED');
  assert.equal(cancelled, true);
});

test('timeout works even when mock fetch ignores signal, without retry', async () => {
  const network = mock([() => new Promise(() => {})]);
  await rejectsCode(generateImages({ ...options, timeoutMs: 10 }, network.fetch), 'TIMEOUT');
  assert.equal(network.calls.length, 1);
  assert.equal(network.calls[0].init.signal.aborted, true);
});

test('timeout covers response body, not only headers', async () => {
  let cancelled = false;
  const network = mock([new Response(new ReadableStream({ cancel() { cancelled = true; } }))]);
  await rejectsCode(discoverModels({ ...options, timeoutMs: 10 }, network.fetch), 'TIMEOUT');
  assert.equal(cancelled, true);
});

test('invalid inputs are rejected without generation', async () => {
  for (const invalid of [{ model: '' }, { prompt: '  ' }, { size: 'oops' }, { apiKey: `a\r\n${key}` }, { timeoutMs: 0 }, { protocol: 'gemini', model: '../evil' }, { protocol: 'gemini', size: '7:11' }]) {
    const network = mock([]);
    await assert.rejects(generateImages({ ...options, ...invalid }, network.fetch));
    assert.equal(network.calls.length, 0);
  }
});

test('invalid JSON, invalid image bytes, MIME mismatch and text-only outputs fail safely', async () => {
  const cases = [
    [new Response(`not JSON ${key}`), 'INVALID_RESPONSE'],
    [generation([{ b64_json: '!!!' }]), 'INVALID_IMAGE'],
    [generation([{ b64_json: Buffer.from(`<svg>${key}</svg>`).toString('base64') }]), 'INVALID_IMAGE'],
    [generation([]), 'NO_IMAGES'],
    [json({ error: key }), 'INVALID_RESPONSE'],
  ];
  for (const [response, code] of cases) await rejectsCode(generateImages(options, mock([response]).fetch), code);
  const mime = mock([json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: b64 } }] } }] })]);
  await rejectsCode(generateImages({ ...options, protocol: 'gemini' }, mime.fetch), 'INVALID_IMAGE');
  const text = mock([json({ candidates: [{ content: { parts: [{ text: key }] } }] })]);
  await rejectsCode(generateImages({ ...options, protocol: 'gemini' }, text.fetch), 'NO_IMAGES');
});
