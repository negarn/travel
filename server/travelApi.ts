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
const googlePlacesAutocompleteUrl =
  'https://places.googleapis.com/v1/places:autocomplete';
const googleRoutesUrl =
  'https://routes.googleapis.com/directions/v2:computeRoutes';
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

function getGoogleMapsApiKey() {
  return process.env.TRAVEL_GOOGLE_MAPS_API_KEY ?? null;
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

function normalizeAutocompleteSuggestions(value: unknown) {
  if (!value || typeof value !== 'object' || !('suggestions' in value)) {
    return [];
  }

  const suggestions = (value as { suggestions?: unknown }).suggestions;

  if (!Array.isArray(suggestions)) {
    return [];
  }

  return suggestions.flatMap((suggestion) => {
    if (
      !suggestion ||
      typeof suggestion !== 'object' ||
      !('placePrediction' in suggestion)
    ) {
      return [];
    }

    const placePrediction = (suggestion as { placePrediction?: unknown })
      .placePrediction;

    if (!placePrediction || typeof placePrediction !== 'object') {
      return [];
    }

    const placeId = (placePrediction as { placeId?: unknown }).placeId;
    const text = (placePrediction as { text?: { text?: unknown } }).text?.text;

    if (typeof placeId !== 'string' || typeof text !== 'string' || !text) {
      return [];
    }

    return [
      {
        id: placeId,
        label: text
      }
    ];
  });
}

function getGooglePlacesErrorMessage(value: unknown): string {
  if (!value || typeof value !== 'object' || !('error' in value)) {
    return 'Could not load address suggestions.';
  }

  const error = (value as { error?: unknown }).error;

  if (!error || typeof error !== 'object') {
    return 'Could not load address suggestions.';
  }

  const message = (error as { message?: unknown }).message;
  const status = (error as { status?: unknown }).status;
  const errorParts = [
    typeof message === 'string' ? message : '',
    typeof status === 'string' ? `(${status})` : ''
  ].filter(Boolean);

  return errorParts.length > 0
    ? errorParts.join(' ')
    : 'Could not load address suggestions.';
}

function getErrorMessage(error: unknown, fallbackMessage: string): string {
  return error instanceof Error && error.message ? error.message : fallbackMessage;
}

function getRequestStringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getRouteTravelMode(mode: string): string | null {
  const normalizedMode = mode.trim().toLocaleUpperCase();

  if (!normalizedMode) {
    return 'DRIVE';
  }

  return ['DRIVE', 'BICYCLE'].includes(normalizedMode)
    ? normalizedMode
    : null;
}

function getMapsUrlTravelMode(routeTravelMode: string): string | null {
  if (routeTravelMode === 'BICYCLE') {
    return 'bicycling';
  }

  if (routeTravelMode === 'DRIVE') {
    return 'driving';
  }

  return null;
}

function parseGoogleDurationSeconds(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^(\d+(?:\.\d+)?)s$/.exec(value);

  if (!match) {
    return null;
  }

  const seconds = Number(match[1]);

  return Number.isFinite(seconds) ? seconds : null;
}

function getFirstRoute(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || !('routes' in value)) {
    return null;
  }

  const routes = (value as { routes?: unknown }).routes;

  if (!Array.isArray(routes) || routes.length === 0) {
    return null;
  }

  const route = routes[0];

  return route && typeof route === 'object' ? route as Record<string, unknown> : null;
}

function createGoogleMapsDirectionsUrl({
  destination,
  origin,
  travelMode
}: {
  destination: string;
  origin: string;
  travelMode: string;
}) {
  const directionsUrl = new URL('https://www.google.com/maps/dir/');
  const mapsUrlTravelMode = getMapsUrlTravelMode(travelMode);

  directionsUrl.searchParams.set('api', '1');
  directionsUrl.searchParams.set('origin', origin);
  directionsUrl.searchParams.set('destination', destination);

  if (mapsUrlTravelMode) {
    directionsUrl.searchParams.set('travelmode', mapsUrlTravelMode);
  }

  return directionsUrl.toString();
}

function getGoogleRouteErrorMessage(value: unknown): string {
  if (!value || typeof value !== 'object' || !('error' in value)) {
    return 'Could not calculate this route.';
  }

  const error = (value as { error?: unknown }).error;

  if (!error || typeof error !== 'object') {
    return 'Could not calculate this route.';
  }

  const message = (error as { message?: unknown }).message;
  const status = (error as { status?: unknown }).status;
  const errorParts = [
    typeof message === 'string' ? message : '',
    typeof status === 'string' ? `(${status})` : ''
  ].filter(Boolean);

  return errorParts.length > 0
    ? errorParts.join(' ')
    : 'Could not calculate this route.';
}

async function handlePlacesAutocompleteRoute(
  request: IncomingMessage,
  response: ServerResponse
) {
  if (request.method !== 'POST') {
    response.statusCode = 405;
    response.end();
    return;
  }

  const apiKey = getGoogleMapsApiKey();
  const requestBody = await readRequestBody(request);
  const input =
    requestBody && typeof requestBody === 'object' && 'input' in requestBody
      ? String((requestBody as { input?: unknown }).input ?? '').trim()
      : '';
  const sessionToken =
    requestBody && typeof requestBody === 'object' && 'sessionToken' in requestBody
      ? String((requestBody as { sessionToken?: unknown }).sessionToken ?? '')
      : '';

  if (!input || input.length < 3) {
    sendJson(response, 200, { isConfigured: Boolean(apiKey), suggestions: [] });
    return;
  }

  if (!apiKey) {
    sendJson(response, 200, { isConfigured: false, suggestions: [] });
    return;
  }

  try {
    const placesResponse = await fetch(googlePlacesAutocompleteUrl, {
      body: JSON.stringify({
        input,
        ...(sessionToken ? { sessionToken } : {})
      }),
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text'
      },
      method: 'POST'
    });

    const responseBody = (await placesResponse.json()) as unknown;

    if (!placesResponse.ok) {
      sendJson(response, placesResponse.status, {
        error: getGooglePlacesErrorMessage(responseBody)
      });
      return;
    }

    sendJson(response, 200, {
      isConfigured: true,
      suggestions: normalizeAutocompleteSuggestions(responseBody)
    });
  } catch (error) {
    sendJson(response, 502, {
      error: getErrorMessage(error, 'Could not reach Google Places.')
    });
  }
}

async function handleMapsRouteRoute(
  request: IncomingMessage,
  response: ServerResponse
) {
  if (request.method !== 'POST') {
    response.statusCode = 405;
    response.end();
    return;
  }

  const apiKey = getGoogleMapsApiKey();
  const requestBody = await readRequestBody(request);
  const origin =
    requestBody && typeof requestBody === 'object' && 'origin' in requestBody
      ? getRequestStringValue((requestBody as { origin?: unknown }).origin)
      : '';
  const destination =
    requestBody && typeof requestBody === 'object' && 'destination' in requestBody
      ? getRequestStringValue(
          (requestBody as { destination?: unknown }).destination
        )
      : '';
  const mode =
    requestBody && typeof requestBody === 'object' && 'mode' in requestBody
      ? getRequestStringValue((requestBody as { mode?: unknown }).mode)
      : '';
  const travelMode = getRouteTravelMode(mode);

  if (!origin || !destination) {
    sendJson(response, 200, {
      isConfigured: Boolean(apiKey),
      route: null
    });
    return;
  }

  if (!apiKey) {
    sendJson(response, 200, {
      isConfigured: false,
      route: null
    });
    return;
  }

  if (!travelMode) {
    sendJson(response, 200, {
      isConfigured: true,
      route: null,
      error: 'Route maps support drive and bicycle modes.'
    });
    return;
  }

  try {
    const routesResponse = await fetch(googleRoutesUrl, {
      body: JSON.stringify({
        destination: { address: destination },
        origin: { address: origin },
        travelMode
      }),
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters'
      },
      method: 'POST'
    });
    const responseBody = (await routesResponse.json()) as unknown;

    if (!routesResponse.ok) {
      sendJson(response, routesResponse.status, {
        error: getGoogleRouteErrorMessage(responseBody)
      });
      return;
    }

    const route = getFirstRoute(responseBody);

    if (!route) {
      sendJson(response, 404, { error: 'No route was found.' });
      return;
    }

    const durationSeconds = parseGoogleDurationSeconds(route.duration);
    const distanceMeters =
      typeof route.distanceMeters === 'number' ? route.distanceMeters : null;

    sendJson(response, 200, {
      isConfigured: true,
      route: {
        distanceMeters,
        durationMinutes:
          durationSeconds === null
            ? null
            : Math.max(1, Math.round(durationSeconds / 60)),
        mapsUrl: createGoogleMapsDirectionsUrl({
          destination,
          origin,
          travelMode
        }),
        travelMode
      }
    });
  } catch (error) {
    sendJson(response, 502, {
      error: getErrorMessage(error, 'Could not reach Google Routes.')
    });
  }
}

cloudSyncManager = createCloudSyncManager({
  applySnapshot: async (snapshot) => {
    await writeTravelData(snapshot);
  },
  dataRootDir: getTravelDataRootDir(),
  getSnapshot: readTravelData,
  onError: console.error
});

export async function initializeTravelApi() {
  await cloudSyncManager?.initialize();
}

export async function handleTravelApiRequest(
  request: IncomingMessage,
  response: ServerResponse
) {
  const requestPath = getRequestPath(request);

  if (!requestPath.startsWith('/api/')) {
    return false;
  }

  if (!isTrustedRequest(request, requestPath)) {
    sendJson(response, 403, {
      error: getConfiguredPublicOrigin()
        ? 'This API is only available from localhost or the configured public origin.'
        : 'This API is only available from localhost.'
    });
    return true;
  }

  if (await cloudSyncManager?.handleRequest(request, response)) {
    return true;
  }

  if (requestPath === travelApiPaths.mapsRoute) {
    await handleMapsRouteRoute(request, response);
    return true;
  }

  if (requestPath === travelApiPaths.placesAutocomplete) {
    await handlePlacesAutocompleteRoute(request, response);
    return true;
  }

  if (requestPath === travelApiPaths.data) {
    await handleTravelDataRoute(request, response);
    return true;
  }

  sendJson(response, 404, { error: 'API route not found.' });
  return true;
}

export function travelApi(): Plugin {
  return {
    name: 'travel-api',
    configureServer(server) {
      void initializeTravelApi();

      (server.middlewares as MiddlewareStack).use((request, response, next) => {
        void (async () => {
          if (!(await handleTravelApiRequest(request, response))) {
            next();
          }
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
