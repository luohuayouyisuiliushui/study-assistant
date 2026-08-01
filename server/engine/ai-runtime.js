/**
 * Shared AI runtime: Provider lifetime and cache diagnostics.
 * Learning engines depend on this module instead of depending on each other.
 */

import { CacheMonitor } from './cache-diagnostics.js';
import AgentDispatcher from './agent-dispatcher.js';
import OpenAI from 'openai';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Readable } from 'node:stream';
import { KeyPool, getKeyPool } from './key-pool.js';
import { Provider, isRelayBlockedError, isUnsupportedParameterError } from './provider.js';

export const engineCacheMonitor = new CacheMonitor();

const providerCache = new Map();
const dispatcherCache = new Map();

function providerKey(apiKey, baseURL, model) {
  return `${apiKey || ''}::${baseURL || ''}::${model || ''}`;
}

export function createProviderFromConfig(apiKey, baseURL, model) {
  const key = providerKey(apiKey, baseURL, model);
  if (!providerCache.has(key)) {
    providerCache.set(key, new Provider({
      apiKey,
      baseURL,
      model,
      debugCache: process.env.DEBUG_CACHE === 'true',
    }));
  }
  return providerCache.get(key);
}

function createDispatcherFromConfig(apiKey, baseURL, model) {
  const key = providerKey(apiKey, baseURL, model);
  if (!dispatcherCache.has(key)) {
    dispatcherCache.set(key, new AgentDispatcher({
      apiKey,
      baseURL,
      defaultModel: model,
      debug: process.env.DEBUG_CACHE === 'true',
    }));
  }
  return dispatcherCache.get(key);
}

function requestSetting(req, header, bodyField, environment, environmentField, fallback = '') {
  return req?.headers?.[header]
    || req?.body?.[bodyField]
    || environment?.[environmentField]
    || fallback;
}

/**
 * Resolve everything needed for one route-level AI operation.
 * Routes receive one stable context instead of composing configuration helpers.
 */
export function createAIInvocationFromRequest(req, options = {}) {
  const environment = options.environment || process.env;
  const rawKey = requestSetting(
    req,
    'x-api-key',
    'apiKey',
    environment,
    'OPENAI_API_KEY',
  );
  const keyPoolFactory = options.keyPoolFactory || getKeyPool;
  const apiKey = keyPoolFactory(rawKey).next();
  const baseURL = requestSetting(
    req,
    'x-api-base',
    'baseURL',
    environment,
    'OPENAI_BASE_URL',
    'https://api.openai.com/v1',
  );
  const model = requestSetting(
    req,
    'x-api-model',
    'model',
    environment,
    'OPENAI_MODEL',
    'gpt-4o-mini',
  );
  const providerFactory = options.providerFactory || createProviderFromConfig;
  const dispatcherFactory = options.dispatcherFactory || createDispatcherFromConfig;
  const provider = providerFactory(apiKey, baseURL, model);
  const dispatcher = dispatcherFactory(apiKey, baseURL, model);
  const dispatched = (
    req?.headers?.['x-use-agent-dispatch'] === 'true'
    || req?.body?.useAgentDispatch === true
  );

  return {
    model,
    provider,
    dispatcher,
    dispatched,
    async run(kind, operation) {
      if (typeof operation !== 'function') {
        throw new TypeError('AI invocation operation must be a function');
      }
      if (!dispatched) return operation(provider, model);
      const dispatchedResult = await dispatcher.dispatch(kind, operation);
      return dispatchedResult.result;
    },
  };
}

export function resolveProvider(providerOrConfig, model) {
  if (providerOrConfig instanceof Provider) return providerOrConfig;
  return createProviderFromConfig(
    providerOrConfig?.apiKey,
    providerOrConfig?.baseURL,
    model,
  );
}

// ═══════════════════════════════════════════════════════
//  Image / audio invocation adapters
//
//  Provider-side request configuration, key fallback, relay-compatibility
//  retries, response normalization, pinned downloads, TTS and cache
//  diagnostics. Learning engines compose these primitives but never
//  re-implement them.
// ═══════════════════════════════════════════════════════

/**
 * Build the OpenAI-compatible image client for one key/base URL.
 * Request configuration lives here so engines never construct clients.
 */
export function createImageClient(apiKey, baseUrl) {
  return new OpenAI({
    apiKey,
    baseURL: baseUrl,
    maxRetries: 2,
    timeout: 60_000,
  });
}

export function buildRelaySafeImagePrompt(title) {
  const topicTitle = String(title).replace(/\s+/g, ' ').trim().slice(0, 160);
  return `Create a simple, neutral educational illustration of the topic "${topicTitle}". Use clear shapes, a light background, and a diagram-like composition.`;
}

export const DEFAULT_IMAGE_MODEL = 'black-forest-labs/FLUX.1-pro';
const SILICONFLOW_IMAGE_MODEL_FALLBACKS = [
  'black-forest-labs/FLUX.1-dev',
  'Kwai-Kolors/Kolors',
  'stabilityai/stable-diffusion-xl-base-1.0',
];

export function getImageFallbackModels(imageModel, imageBaseUrl, configuredFallbackModel = '') {
  const primaryModel = String(imageModel || '').trim();
  const configuredModel = String(configuredFallbackModel || '').trim();
  const candidates = configuredModel
    ? [configuredModel]
    : /^https:\/\/api\.siliconflow\.cn(?:\/|$)/i.test(String(imageBaseUrl || ''))
      ? SILICONFLOW_IMAGE_MODEL_FALLBACKS
      : [];

  return [...new Set(candidates.filter(candidate => candidate && candidate !== primaryModel))];
}

export function getImageApiKeys(imageApiKey) {
  return [...new Set(KeyPool.parse(imageApiKey))];
}

function shouldRetryImageChannel(err) {
  return isRelayBlockedError(err) || [401, 403, 429].includes(Number(err?.status));
}
export async function generateImageWithKeyFallback(imageKeys, generate) {
  let lastError;
  for (const [index, apiKey] of imageKeys.entries()) {
    try {
      return await generate(apiKey);
    } catch (err) {
      lastError = err;
      if (index === imageKeys.length - 1 || !shouldRetryImageChannel(err)) throw err;
      console.warn('[generateTopicImage] Image channel rejected the request; trying the next configured image key');
    }
  }
  throw lastError;
}
export function extractGeneratedImage(response) {
  const image = response?.data?.[0] || response?.images?.[0] || response?.output?.[0];
  if (!image || typeof image !== 'object') return null;

  const base64 = image.b64_json || image.b64 || image.image_base64;
  if (typeof base64 === 'string' && base64.trim()) {
    return { kind: 'base64', value: base64.trim() };
  }

  const candidates = [image.url, image.image_url, image.uri, image.image?.url];
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate : candidate?.url;
    if (typeof value === 'string' && value.trim()) {
      return { kind: 'url', value: value.trim() };
    }
  }
  return null;
}
export async function generateImageWithFallback(client, request, relaySafePrompt, fallbackModels = []) {
  try {
    return await generateImageRequest(client, request);
  } catch (err) {
    if (!relaySafePrompt || !isRelayBlockedError(err) || relaySafePrompt === request.prompt) {
      throw err;
    }
    // Some relays block verbose prompts before the image model evaluates them.
    // Keep the topic title intact, but retry once without generated detail or restrictive clauses.
    console.warn('[generateTopicImage] Image request blocked by relay; retrying with a compact educational prompt');
    try {
      return await generateImageRequest(client, { ...request, prompt: relaySafePrompt });
    } catch (safePromptErr) {
      if (!isRelayBlockedError(safePromptErr)) throw safePromptErr;

      let lastError = safePromptErr;
      for (const model of [...new Set(fallbackModels)].filter(candidate => candidate && candidate !== request.model)) {
        try {
          console.warn(`[generateTopicImage] Image model ${request.model} was blocked; retrying with fallback model ${model}`);
          return await generateImageRequest(client, { ...request, model, prompt: relaySafePrompt });
        } catch (fallbackErr) {
          lastError = fallbackErr;
          if (!isRelayBlockedError(fallbackErr)) throw fallbackErr;
        }
      }
      throw lastError;
    }
  }
}

async function generateImageRequest(client, request) {
  try {
    return await client.images.generate(request);
  } catch (err) {
    if (!request.response_format || !isUnsupportedParameterError(err, 'response_format')) {
      throw err;
    }
    console.warn('[generateTopicImage] Image API does not support response_format; retrying without it');
    const fallbackRequest = { ...request };
    delete fallbackRequest.response_format;
    return client.images.generate(fallbackRequest);
  }
}
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function decodeBase64Image(value, maxBytes = DEFAULT_MAX_IMAGE_BYTES) {
  const raw = String(value || '').trim();
  let encoded = raw;
  if (/^data:/i.test(raw)) {
    const match = raw.match(/^data:image\/[a-z0-9.+-]+;base64,([\s\S]*)$/i);
    if (!match) throw new Error('图片数据 URL 必须使用 image/*;base64 格式');
    encoded = match[1];
  }

  const compact = encoded.replace(/\s+/g, '');
  const unpadded = compact.replace(/=+$/, '');
  if (
    !unpadded
    || !/^[a-z0-9+/]+$/i.test(unpadded)
    || /=/.test(unpadded)
    || compact.length - unpadded.length > 2
    || unpadded.length % 4 === 1
  ) {
    throw new Error('图片 API 返回的 Base64 数据无效');
  }

  const base64 = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=');
  if (compact.includes('=') && compact !== base64) {
    throw new Error('图片 API 返回的 Base64 数据无效');
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedLength = (base64.length / 4) * 3 - padding;
  if (decodedLength > maxBytes) {
    throw new Error(`图片过大，最大允许 ${maxBytes} 字节`);
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) {
    throw new Error('图片 API 返回的 Base64 数据无效');
  }
  if (bytes.length === 0) throw new Error('图片 API 返回的 Base64 数据为空');
  return bytes;
}

const UNSAFE_IMAGE_ADDRESSES = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) {
  UNSAFE_IMAGE_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64],
  ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) {
  UNSAFE_IMAGE_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}

function normalizeImageAddress(address) {
  const value = String(address).trim();
  const unwrapped = value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value;
  return unwrapped.split('%')[0];
}

function isUnsafeImageAddress(address, family) {
  const normalized = normalizeImageAddress(address);
  if (normalized.toLowerCase().startsWith('::ffff:')) return true;
  const type = family === 6 || net.isIP(normalized) === 6 ? 'ipv6' : 'ipv4';
  return net.isIP(normalized) === 0 || UNSAFE_IMAGE_ADDRESSES.check(normalized, type);
}

async function assertSafeImageUrl(imageUrl, lookup) {
  if (!['https:', 'http:'].includes(imageUrl.protocol)) {
    throw new Error(`图片 URL 使用了不支持的协议: ${imageUrl.protocol}`);
  }
  if (imageUrl.username || imageUrl.password) {
    throw new Error('Unsafe image URL: 不允许 URL 凭据');
  }
  if (imageUrl.hostname.toLowerCase() === 'localhost') {
    throw new Error('Unsafe private image URL: localhost');
  }

  const literalAddress = normalizeImageAddress(imageUrl.hostname);
  const literalFamily = net.isIP(literalAddress);
  if (literalFamily) {
    if (isUnsafeImageAddress(literalAddress, literalFamily)) {
      throw new Error(`Unsafe private image URL: ${literalAddress}`);
    }
    return { address: literalAddress, family: literalFamily };
  }

  const resolved = await lookup(imageUrl.hostname, { all: true, verbatim: true });
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  if (addresses.length === 0 || addresses.some(item => isUnsafeImageAddress(item.address, item.family))) {
    throw new Error(`Unsafe private image URL: ${imageUrl.hostname}`);
  }
  const selected = addresses[0];
  const address = String(selected.address).split('%')[0];
  return {
    address,
    family: selected.family === 6 || net.isIP(address) === 6 ? 6 : 4,
  };
}

function requestPinnedImage(imageUrl, target, signal) {
  const transport = imageUrl.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(imageUrl, {
      signal,
      family: target.family,
      autoSelectFamily: false,
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, [target]);
        else callback(null, target.address, target.family);
      },
    }, response => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
        else if (value !== undefined) headers.set(name, String(value));
      }
      const status = response.statusCode || 500;
      const body = [101, 204, 205, 304].includes(status)
        ? null
        : Readable.toWeb(response);
      resolve(new Response(body, { status, headers }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function readImageBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`图片过大，最大允许 ${maxBytes} 字节`);
  }
  if (!response.body) throw new Error('图片下载响应为空');

  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`图片过大，最大允许 ${maxBytes} 字节`);
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) throw new Error('图片下载响应为空');
  return Buffer.concat(chunks, total);
}

export async function downloadGeneratedImage(rawUrl, baseUrl, {
  lookup = dnsLookup,
  requestImpl = requestPinnedImage,
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
  timeoutMs = 15_000,
  maxRedirects = 3,
} = {}) {
  if (/^data:/i.test(String(rawUrl).trim())) {
    return decodeBase64Image(rawUrl, maxBytes);
  }

  let imageUrl = new URL(rawUrl, baseUrl);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const target = await assertSafeImageUrl(imageUrl, lookup);
    const response = await requestImpl(
      imageUrl,
      target,
      AbortSignal.timeout(timeoutMs),
    );

    if (response.status >= 300 && response.status < 400) {
      if (response.body) await response.body.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === maxRedirects) {
        throw new Error('图片下载重定向过多或缺少 Location');
      }
      imageUrl = new URL(location, imageUrl);
      continue;
    }
    if (!response.ok) throw new Error(`图片下载失败 (${response.status})`);

    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (!contentType?.startsWith('image/')) {
      throw new Error(`图片 Content-Type 无效: ${contentType || 'missing'}`);
    }
    return readImageBody(response, maxBytes);
  }
  throw new Error('图片下载重定向过多');
}
export async function textToSpeech(apiKey, text) {
  if (!apiKey) throw new Error('请先配置 API Key');
  if (!text || !text.trim()) throw new Error('请输入要合成的文本');

  const response = await fetch('https://api.siliconflow.cn/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      input: text.slice(0, 2000),
      voice: 'default',
      response_format: 'mp3',
      speed: 1.0,
    }),
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`TTS 请求失败 (${response.status}): ${errBody.slice(0, 200)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
export function getEngineCacheDiagnostics() {
  return engineCacheMonitor.summary();
}
