import type { IncomingMessage } from 'node:http';

export function getRequestPath(request: IncomingMessage) {
  return request.url?.split('?')[0] ?? '';
}
