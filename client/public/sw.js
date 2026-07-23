'use strict';

const API_CACHE = 'study-assistant-api-v2';
const OFFLINE_QUEUE_CACHE = 'study-assistant-offline-queue-v2';
const OFFLINE_QUEUE_KEY = '/__study_assistant_offline_queue__';

function isCacheableApiRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return /^\/api\/learn\/plans(?:\/[^/]+(?:\/topics\/[^/]+)?)?$/.test(url.pathname)
    || url.pathname === '/api/learn/reviews/today'
    || url.pathname === '/api/user-profile/summary';
}

async function readQueue(cache) {
  const response = await cache.match(OFFLINE_QUEUE_KEY);
  if (!response) return [];
  try {
    const queue = await response.json();
    return Array.isArray(queue) ? queue : [];
  } catch {
    return [];
  }
}

async function writeQueue(cache, queue) {
  await cache.put(OFFLINE_QUEUE_KEY, new Response(JSON.stringify(queue), {
    headers: { 'Content-Type': 'application/json' },
  }));
}

async function queueOfflineMutation(payload) {
  if (!payload || payload.method !== 'PATCH' || !/\/resources\/\d+\/rating$/.test(new URL(payload.url).pathname)) {
    return;
  }
  const cache = await caches.open(OFFLINE_QUEUE_CACHE);
  const queue = await readQueue(cache);
  const key = `${payload.method}:${payload.url}`;
  const nextItem = {
    key,
    url: payload.url,
    method: payload.method,
    headers: payload.headers || { 'Content-Type': 'application/json' },
    body: payload.body || null,
    queuedAt: Date.now(),
  };
  const existingIndex = queue.findIndex(item => item.key === key);
  if (existingIndex >= 0) queue[existingIndex] = nextItem;
  else queue.push(nextItem);
  await writeQueue(cache, queue);
  if (self.registration.sync) {
    try { await self.registration.sync.register('study-assistant-replay'); } catch {}
  }
}

async function replayOfflineQueue() {
  const cache = await caches.open(OFFLINE_QUEUE_CACHE);
  const queue = await readQueue(cache);
  if (queue.length === 0) return;

  const pending = [];
  for (const item of queue) {
    try {
      const response = await fetch(item.url, {
        method: item.method,
        headers: item.headers,
        body: item.body,
      });
      if (!response.ok) pending.push(item);
    } catch {
      pending.push(item);
    }
  }
  await writeQueue(cache, pending);
}

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith('study-assistant-') && key !== API_CACHE && key !== OFFLINE_QUEUE_CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
    await replayOfflineQueue();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (!isCacheableApiRequest(request)) return;

  event.respondWith((async () => {
    const cache = await caches.open(API_CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(request);
      if (cached) return cached;
      return new Response(JSON.stringify({ error: '当前离线，且没有可用的本地缓存。' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'OFFLINE_QUEUE') event.waitUntil(queueOfflineMutation(event.data.payload));
  if (event.data?.type === 'REPLAY_OFFLINE_QUEUE') event.waitUntil(replayOfflineQueue());
});

self.addEventListener('sync', event => {
  if (event.tag === 'study-assistant-replay') event.waitUntil(replayOfflineQueue());
});
