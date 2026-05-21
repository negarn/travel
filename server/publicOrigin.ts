import type { IncomingMessage } from 'node:http';

function normalizeConfiguredOrigin(rawOrigin: string | undefined) {
  if (!rawOrigin) {
    return null;
  }

  try {
    const parsedOrigin = new URL(rawOrigin.trim());

    if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
      return null;
    }

    return parsedOrigin.origin;
  } catch {
    return null;
  }
}

export function getConfiguredPublicOrigin() {
  return normalizeConfiguredOrigin(process.env.TRAVEL_PUBLIC_ORIGIN);
}

export function getConfiguredPublicOriginHostName() {
  const configuredOrigin = getConfiguredPublicOrigin();

  if (!configuredOrigin) {
    return null;
  }

  return new URL(configuredOrigin).hostname.toLowerCase();
}

export function getRequestOrigin(request: IncomingMessage) {
  const configuredOrigin = getConfiguredPublicOrigin();

  if (configuredOrigin) {
    return configuredOrigin;
  }

  const host = request.headers.host;
  const protocol = request.headers['x-forwarded-proto']?.toString().split(',')[0] ?? 'http';

  if (typeof host === 'string' && host.length > 0) {
    return `${protocol}://${host}`;
  }

  return 'http://127.0.0.1:5175';
}

export function getRequestOriginHeader(request: IncomingMessage) {
  const originHeader = request.headers.origin;

  if (typeof originHeader !== 'string' || !originHeader.trim()) {
    return null;
  }

  try {
    return new URL(originHeader).origin;
  } catch {
    return null;
  }
}
