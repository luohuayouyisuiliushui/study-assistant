import crypto from 'crypto';

export const DEFAULT_LISTEN_HOST = '127.0.0.1';

export function getListenHost(env = process.env) {
  return env.STUDY_ASSISTANT_HOST?.trim() || DEFAULT_LISTEN_HOST;
}

export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.replace(/^::ffff:/i, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

function tokensMatch(expected, actual) {
  if (!expected || !actual) return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  return expectedBuffer.length === actualBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

export function createApiAuthorization({ token = process.env.STUDY_ASSISTANT_API_TOKEN } = {}) {
  return (req, res, next) => {
    if (isLoopbackAddress(req.socket?.remoteAddress)) return next();

    const supplied = req.get?.('x-study-assistant-token') || req.headers?.['x-study-assistant-token'];
    if (tokensMatch(token, supplied)) return next();

    return res.status(403).json({ error: '远程 API 访问需要有效的 x-study-assistant-token' });
  };
}
