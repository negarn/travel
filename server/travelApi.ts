import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { normalizeTravelAppState } from '../src/helpers/travelData';
import { travelApiPaths } from '../src/helpers/travelApiRoutes';
import type { TravelAppState } from '../src/types/travel';
import { createCloudSyncManager, type CloudSyncManager } from './cloudSync';
import {
  getConfiguredPublicOrigin,
  getConfiguredPublicOriginHostName,
  getRequestOriginHeader
} from './publicOrigin';
import {
  ensurePrivateJsonStorageFile,
  writePrivateJsonFile
} from './privateFilesystem';
import { getRequestPath } from './requestPath';

type NextFunction = (error?: Error) => void;
type MiddlewareStack = {
  use: (
    handler: (
      request: IncomingMessage,
      response: ServerResponse,
      next: NextFunction
    ) => void
  ) => void;
};

const LOOPBACK_HOST_NAMES = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_JSON_REQUEST_BODY_BYTES = 512 * 1024;
const defaultTravelDataRootDir = resolve(homedir(), '.travel');
let cloudSyncManager: CloudSyncManager | null = null;
let mutationQueue = Promise.resolve();

class InvalidRequestBodyError extends Error {}
class RequestBodyTooLargeError extends Error {}

function getTravelDataRootDir() {
  return process.env.TRAVEL_DATA_DIR ?? defaultTravelDataRootDir;
}

function getTravelDataFilePath() {
  return resolve(getTravelDataRootDir(), 'travel-data.json');
}

function getRequestHostName(request: IncomingMessage) {
  const hostHeader = request.headers.host?.trim();

  if (!hostHeader) {
    return null;
  }

  if (hostHeader.startsWith('[')) {
    const closingBracketIndex = hostHeader.indexOf(']');

    if (closingBracketIndex <= 1) {
      return null;
    }

    return hostHeader.slice(1, closingBracketIndex).toLowerCase();
  }

  return hostHeader.split(':', 1)[0].toLowerCase();
}

function isLoopbackRemoteAddress(remoteAddress: string | null | undefined) {
  if (!remoteAddress) {
    return false;
  }

  const normalizedRemoteAddress = remoteAddress.toLowerCase();

  return (
    LOOPBACK_HOST_NAMES.has(normalizedRemoteAddress) ||
    normalizedRemoteAddress === '::ffff:127.0.0.1'
  );
}

function isTrustedLocalRequest(request: IncomingMessage) {
  const hostName = getRequestHostName(request);

  return (
    isLoopbackRemoteAddress(request.socket?.remoteAddress) &&
    Boolean(hostName && LOOPBACK_HOST_NAMES.has(hostName))
  );
}

function isTrustedPublicOriginRequest(
  request: IncomingMessage,
  requestPath: string
) {
  const configuredPublicOrigin = getConfiguredPublicOrigin();
  const configuredPublicOriginHostName = getConfiguredPublicOriginHostName();

  if (!configuredPublicOrigin || !configuredPublicOriginHostName) {
    return false;
  }

  const hostName = getRequestHostName(request);

  if (hostName !== configuredPublicOriginHostName) {
    return false;
  }

  const isCloudSyncCallbackRoute =
    /^\/api\/cloud-sync\/(google-drive|dropbox)\/callback$/.test(requestPath);

  if (isCloudSyncCallbackRoute) {
    return true;
  }

  if (request.method && request.method !== 'GET') {
    return getRequestOriginHeader(request) === configuredPublicOrigin;
  }

  return true;
}

function isTrustedRequest(request: IncomingMessage, requestPath: string) {
  return (
    isTrustedLocalRequest(request) ||
    isTrustedPublicOriginRequest(request, requestPath)
  );
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readRequestBody(request: IncomingMessage) {
  let requestBodyText = '';
  let requestBodyByteLength = 0;

  for await (const chunk of request) {
    requestBodyByteLength +=
      typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;

    if (requestBodyByteLength > MAX_JSON_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError(
        `Request body exceeds ${MAX_JSON_REQUEST_BODY_BYTES} bytes.`
      );
    }

    requestBodyText += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }

  if (!requestBodyText) {
    return null;
  }

  try {
    return JSON.parse(requestBodyText) as unknown;
  } catch {
    throw new InvalidRequestBodyError('Expected a valid JSON request body.');
  }
}

function queueMutation<T>(action: () => Promise<T>) {
  const nextAction = mutationQueue.then(action, action);
  mutationQueue = nextAction.then(
    () => undefined,
    () => undefined
  );
  return nextAction;
}

async function readTravelData() {
  const filePath = getTravelDataFilePath();

  await ensurePrivateJsonStorageFile(filePath);

  try {
    return normalizeTravelAppState(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return normalizeTravelAppState({});
    }

    if (error instanceof SyntaxError) {
      console.error(`Could not parse persisted travel data at ${filePath}.`, error);
      return normalizeTravelAppState({});
    }

    throw error;
  }
}

async function writeTravelData(value: TravelAppState) {
  const normalizedValue = normalizeTravelAppState(value);

  await writePrivateJsonFile(getTravelDataFilePath(), normalizedValue);
  void cloudSyncManager?.scheduleSync();
  return normalizedValue;
}

async function handleTravelDataRoute(
  request: IncomingMessage,
  response: ServerResponse
) {
  if (request.method === 'GET') {
    sendJson(response, 200, { travelData: await readTravelData() });
    return;
  }

  if (request.method === 'PUT') {
    const requestBody = await readRequestBody(request);
    const travelData = normalizeTravelAppState(
      requestBody && typeof requestBody === 'object' && 'travelData' in requestBody
        ? (requestBody as { travelData?: unknown }).travelData
        : requestBody
    );
    const nextTravelData = await queueMutation(() => writeTravelData(travelData));

    sendJson(response, 200, { travelData: nextTravelData });
    return;
  }

  response.statusCode = 405;
  response.end();
}

cloudSyncManager = createCloudSyncManager({
  applySnapshot: async (snapshot) => {
    await writeTravelData(snapshot);
  },
  dataRootDir: getTravelDataRootDir(),
  getSnapshot: readTravelData,
  onError: console.error
});

export function travelApi(): Plugin {
  return {
    name: 'travel-api',
    configureServer(server) {
      void cloudSyncManager?.initialize();

      (server.middlewares as MiddlewareStack).use((request, response, next) => {
        void (async () => {
          const requestPath = getRequestPath(request);

          if (!requestPath.startsWith('/api/')) {
            next();
            return;
          }

          if (!isTrustedRequest(request, requestPath)) {
            sendJson(response, 403, {
              error: getConfiguredPublicOrigin()
                ? 'This API is only available from localhost or the configured public origin.'
                : 'This API is only available from localhost.'
            });
            return;
          }

          if (await cloudSyncManager?.handleRequest(request, response)) {
            return;
          }

          if (requestPath === travelApiPaths.data) {
            await handleTravelDataRoute(request, response);
            return;
          }

          next();
        })().catch((error) => {
          if (error instanceof InvalidRequestBodyError) {
            sendJson(response, 400, { error: error.message });
            return;
          }

          if (error instanceof RequestBodyTooLargeError) {
            sendJson(response, 413, { error: error.message });
            return;
          }

          next(error as Error);
        });
      });
    }
  };
}
