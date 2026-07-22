import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { travelApiPaths } from '../src/helpers/travelApiRoutes';
import { handleTravelApiRequest } from './travelApi';

afterEach(() => {
  delete process.env.TRAVEL_AUTH_ALLOWED_EMAIL;
  delete process.env.TRAVEL_AUTH_GOOGLE_CLIENT_ID;
  delete process.env.TRAVEL_AUTH_GOOGLE_CLIENT_SECRET;
  delete process.env.TRAVEL_AUTH_SESSION_SECRET;
  delete process.env.TRAVEL_GOOGLE_MAPS_API_KEY;
  delete process.env.VITE_TRAVEL_GOOGLE_MAPS_EMBED_API_KEY;
  vi.restoreAllMocks();
});

async function executeRequest({
  host = '127.0.0.1:5175',
  body,
  method,
  remoteAddress = '127.0.0.1',
  url
}: {
  host?: string;
  body?: unknown;
  method: string;
  remoteAddress?: string;
  url: string;
}) {
  const request = Readable.from(
    body === undefined ? [] : [JSON.stringify(body)]
  ) as IncomingMessage;
  const responseState = {
    body: '',
    headers: new Map<string, string>(),
    statusCode: 200
  };

  Object.assign(request, {
    headers: {
      host
    },
    method,
    socket: {
      remoteAddress
    },
    url
  });

  const response = {
    end(chunk?: string | Buffer) {
      responseState.body = chunk ? String(chunk) : '';
      done();
    },
    getHeader(name: string) {
      return responseState.headers.get(name.toLowerCase());
    },
    setHeader(name: string, value: string) {
      responseState.headers.set(name.toLowerCase(), String(value));
    },
    statusCode: responseState.statusCode
  } as unknown as ServerResponse;

  let done!: () => void;
  const completion = new Promise<void>((resolve) => {
    done = resolve;
  });

  const handled = await handleTravelApiRequest(request, response);
  await completion;
  responseState.statusCode = response.statusCode;

  if (!handled) {
    throw new Error(`Expected request to be handled: ${method} ${url}`);
  }

  return {
    body: responseState.body ? (JSON.parse(responseState.body) as Record<string, unknown>) : {},
    headers: responseState.headers,
    statusCode: responseState.statusCode
  };
}

describe('travelApi', () => {
  it('requires Google sign-in for API requests when app auth is configured', async () => {
    process.env.TRAVEL_AUTH_ALLOWED_EMAIL = 'traveler@example.com';
    process.env.TRAVEL_AUTH_GOOGLE_CLIENT_ID = 'client-id';
    process.env.TRAVEL_AUTH_GOOGLE_CLIENT_SECRET = 'client-secret';
    process.env.TRAVEL_AUTH_SESSION_SECRET = 'session-secret';

    const response = await executeRequest({
      method: 'GET',
      url: travelApiPaths.data
    });

    expect(response.statusCode).toBe(401);
    expect(response.body.error).toBe('Sign in with Google to use this app.');
  });

  it('returns the runtime Maps Embed key with a calculated route', async () => {
    process.env.TRAVEL_GOOGLE_MAPS_API_KEY = 'server-maps-key';
    process.env.VITE_TRAVEL_GOOGLE_MAPS_EMBED_API_KEY = 'runtime-embed-key';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          routes: [{ distanceMeters: 1000, duration: '600s' }]
        }),
        { status: 200 }
      )
    );

    const response = await executeRequest({
      body: {
        destination: 'Toronto',
        mode: 'DRIVE',
        origin: 'Ottawa'
      },
      method: 'POST',
      url: travelApiPaths.mapsRoute
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.route).toMatchObject({
      durationMinutes: 10,
      embedApiKey: 'runtime-embed-key'
    });
  });
});
