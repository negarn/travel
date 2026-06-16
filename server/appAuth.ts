import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRequestOrigin } from './publicOrigin';
import { getRequestPath } from './requestPath';

type NextFunction = (error?: Error) => void;
type GoogleJwk = {
  alg?: string;
  e: string;
  kid: string;
  kty: 'RSA';
  n: string;
  use?: string;
};
type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  token_type?: string;
};
type GoogleIdTokenClaims = {
  aud?: string;
  email?: string;
  email_verified?: boolean | string;
  exp?: number;
  iss?: string;
  nonce?: string;
  sub?: string;
};
type AuthSession = {
  email: string;
  exp: number;
  sub: string;
};
type AuthState = {
  exp: number;
  nonce: string;
  returnTo: string;
  state: string;
};

const AUTH_SESSION_COOKIE_NAME = 'travel_auth_session';
const AUTH_STATE_COOKIE_NAME = 'travel_auth_state';
const AUTH_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
const AUTH_STATE_MAX_AGE_SECONDS = 60 * 10;
const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
let cachedGoogleJwks: {
  expiresAt: number;
  keys: GoogleJwk[];
} | null = null;

function getGoogleClientId() {
  return (
    process.env.TRAVEL_AUTH_GOOGLE_CLIENT_ID ||
    process.env.TRAVEL_GOOGLE_DRIVE_CLIENT_ID ||
    null
  );
}

function getGoogleClientSecret() {
  return (
    process.env.TRAVEL_AUTH_GOOGLE_CLIENT_SECRET ||
    process.env.TRAVEL_GOOGLE_DRIVE_CLIENT_SECRET ||
    null
  );
}

function getAllowedEmail() {
  return process.env.TRAVEL_AUTH_ALLOWED_EMAIL?.trim().toLowerCase() || null;
}

function getSessionSecret() {
  return (
    process.env.TRAVEL_AUTH_SESSION_SECRET ||
    process.env.TRAVEL_AUTH_GOOGLE_CLIENT_SECRET ||
    process.env.TRAVEL_GOOGLE_DRIVE_CLIENT_SECRET ||
    null
  );
}

function isAuthEnabled() {
  return Boolean(getAllowedEmail());
}

function isAuthConfigured() {
  return Boolean(getGoogleClientId() && getGoogleClientSecret() && getSessionSecret());
}

function base64UrlEncode(value: Buffer | string) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecodeJson(value: string) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
}

function signValue(value: string) {
  const sessionSecret = getSessionSecret();

  if (!sessionSecret) {
    return null;
  }

  return createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function createSignedToken(value: unknown) {
  const encodedValue = base64UrlEncode(JSON.stringify(value));
  const signature = signValue(encodedValue);

  return signature ? `${encodedValue}.${signature}` : null;
}

function parseSignedToken<T>(token: string | undefined) {
  if (!token) {
    return null;
  }

  const [encodedValue, signature] = token.split('.');
  const expectedSignature = encodedValue ? signValue(encodedValue) : null;

  if (!encodedValue || !signature || !expectedSignature) {
    return null;
  }

  const signatureBuffer = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedSignatureBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedSignatureBuffer)
  ) {
    return null;
  }

  try {
    return base64UrlDecodeJson(encodedValue) as T;
  } catch {
    return null;
  }
}

function parseCookies(request: IncomingMessage) {
  return Object.fromEntries(
    (request.headers.cookie ?? '')
      .split(';')
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const separatorIndex = cookie.indexOf('=');

        return separatorIndex === -1
          ? [cookie, '']
          : [
              decodeURIComponent(cookie.slice(0, separatorIndex)),
              decodeURIComponent(cookie.slice(separatorIndex + 1))
            ];
      })
  );
}

function isSecureRequest(request: IncomingMessage) {
  const origin = getRequestOrigin(request);

  return (
    origin.startsWith('https://') ||
    request.headers['x-forwarded-proto']?.toString().split(',')[0] === 'https'
  );
}

function createCookie({
  httpOnly = true,
  maxAgeSeconds,
  name,
  request,
  value
}: {
  httpOnly?: boolean;
  maxAgeSeconds: number;
  name: string;
  request: IncomingMessage;
  value: string;
}) {
  const cookieParts = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'SameSite=Lax'
  ];

  if (httpOnly) {
    cookieParts.push('HttpOnly');
  }

  if (isSecureRequest(request)) {
    cookieParts.push('Secure');
  }

  return cookieParts.join('; ');
}

function clearCookie(name: string, request: IncomingMessage) {
  return createCookie({
    maxAgeSeconds: 0,
    name,
    request,
    value: ''
  });
}

function appendSetCookie(response: ServerResponse, cookie: string) {
  const currentValue = response.getHeader('Set-Cookie');

  if (Array.isArray(currentValue)) {
    response.setHeader('Set-Cookie', [...currentValue, cookie]);
    return;
  }

  if (typeof currentValue === 'string') {
    response.setHeader('Set-Cookie', [currentValue, cookie]);
    return;
  }

  response.setHeader('Set-Cookie', cookie);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function sendHtml(response: ServerResponse, statusCode: number, html: string) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(html);
}

function redirect(response: ServerResponse, location: string) {
  response.statusCode = 302;
  response.setHeader('Location', location);
  response.end();
}

function getRequestUrl(request: IncomingMessage) {
  return new URL(request.url ?? '/', getRequestOrigin(request));
}

function normalizeReturnTo(value: string | null) {
  if (!value || !value.startsWith('/')) {
    return '/';
  }

  if (value.startsWith('//') || value.startsWith('/auth/')) {
    return '/';
  }

  return value;
}

function getCurrentSession(request: IncomingMessage) {
  const session = parseSignedToken<AuthSession>(
    parseCookies(request)[AUTH_SESSION_COOKIE_NAME]
  );
  const allowedEmail = getAllowedEmail();

  if (
    !session ||
    !allowedEmail ||
    session.exp < Math.floor(Date.now() / 1000) ||
    session.email.toLowerCase() !== allowedEmail
  ) {
    return null;
  }

  return session;
}

function createLoginPage({
  errorMessage,
  returnTo
}: {
  errorMessage?: string;
  returnTo: string;
}) {
  const startPath = `/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#24353f" />
    <title>Sign in - Travel Plans</title>
    <style>
      body {
        min-height: 100dvh;
        margin: 0;
        display: grid;
        place-items: center;
        background: #f7f2e8;
        color: #1b2730;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
      }

      main {
        width: min(100% - 2rem, 25rem);
        display: grid;
        gap: 1rem;
      }

      h1 {
        margin: 0;
        font-size: clamp(2rem, 10vw, 3rem);
        line-height: 1;
      }

      p {
        margin: 0;
        color: #52616a;
      }

      a {
        min-height: 3rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 0.5rem;
        background: #24353f;
        color: #fffaf1;
        cursor: pointer;
        font-weight: 700;
        text-decoration: none;
      }

      .error {
        color: #9b4e3a;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Travel Plans</h1>
      <p>Sign in with the Google account allowed for this private app.</p>
      ${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ''}
      <a href="${startPath}">Sign in with Google</a>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createRandomToken() {
  return randomBytes(32).toString('base64url');
}

function createAuthRedirectUrl({
  nonce,
  request,
  state
}: {
  nonce: string;
  request: IncomingMessage;
  state: string;
}) {
  const clientId = getGoogleClientId();
  const authorizeUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);

  authorizeUrl.searchParams.set('client_id', clientId ?? '');
  authorizeUrl.searchParams.set('redirect_uri', `${getRequestOrigin(request)}/auth/google/callback`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'openid email');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('nonce', nonce);
  authorizeUrl.searchParams.set('prompt', 'select_account');

  const allowedEmail = getAllowedEmail();

  if (allowedEmail) {
    authorizeUrl.searchParams.set('login_hint', allowedEmail);
  }

  return authorizeUrl.toString();
}

async function fetchGoogleJwks() {
  if (cachedGoogleJwks && cachedGoogleJwks.expiresAt > Date.now()) {
    return cachedGoogleJwks.keys;
  }

  const response = await fetch(GOOGLE_JWKS_ENDPOINT);

  if (!response.ok) {
    throw new Error('Could not load Google sign-in keys.');
  }

  const parsedResponse = (await response.json()) as { keys?: GoogleJwk[] };
  const maxAgeMatch = response.headers.get('cache-control')?.match(/max-age=(\d+)/);
  const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 60 * 60;
  cachedGoogleJwks = {
    expiresAt: Date.now() + maxAgeSeconds * 1000,
    keys: Array.isArray(parsedResponse.keys) ? parsedResponse.keys : []
  };

  return cachedGoogleJwks.keys;
}

function decodeJwt(idToken: string) {
  const [encodedHeader, encodedPayload, encodedSignature] = idToken.split('.');

  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error('Google did not return a valid identity token.');
  }

  return {
    encodedHeader,
    encodedPayload,
    encodedSignature,
    header: base64UrlDecodeJson(encodedHeader) as { alg?: string; kid?: string },
    payload: base64UrlDecodeJson(encodedPayload) as GoogleIdTokenClaims
  };
}

async function verifyGoogleIdToken(idToken: string, expectedNonce: string) {
  const { encodedHeader, encodedPayload, encodedSignature, header, payload } =
    decodeJwt(idToken);

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Google returned an unsupported identity token.');
  }

  const jwk = (await fetchGoogleJwks()).find((key) => key.kid === header.kid);

  if (!jwk) {
    cachedGoogleJwks = null;
    throw new Error('Could not find the Google sign-in key.');
  }

  const publicKey = createPublicKey({
    format: 'jwk',
    key: jwk
  } as Parameters<typeof createPublicKey>[0]);
  const isValidSignature = verify(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    Buffer.from(encodedSignature, 'base64url')
  );

  if (!isValidSignature) {
    throw new Error('Google identity token signature was invalid.');
  }

  const clientId = getGoogleClientId();
  const allowedEmail = getAllowedEmail();
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
  const emailVerified =
    payload.email_verified === true || payload.email_verified === 'true';
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (
    !clientId ||
    payload.aud !== clientId ||
    (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') ||
    typeof payload.exp !== 'number' ||
    payload.exp < nowSeconds ||
    payload.nonce !== expectedNonce ||
    typeof payload.sub !== 'string' ||
    !email ||
    !emailVerified ||
    !allowedEmail ||
    email !== allowedEmail
  ) {
    throw new Error('That Google account is not allowed to open this app.');
  }

  return {
    email,
    sub: payload.sub
  };
}

async function exchangeCodeForIdToken({
  code,
  request
}: {
  code: string;
  request: IncomingMessage;
}) {
  const clientId = getGoogleClientId();
  const clientSecret = getGoogleClientSecret();

  if (!clientId || !clientSecret) {
    throw new Error('Google sign-in is not configured.');
  }

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${getRequestOrigin(request)}/auth/google/callback`
    })
  });

  if (!response.ok) {
    throw new Error('Google sign-in failed while exchanging the authorization code.');
  }

  const tokenResponse = (await response.json()) as GoogleTokenResponse;

  if (!tokenResponse.id_token) {
    throw new Error('Google did not return an identity token.');
  }

  return tokenResponse.id_token;
}

function setAuthSessionCookie({
  email,
  request,
  response,
  sub
}: {
  email: string;
  request: IncomingMessage;
  response: ServerResponse;
  sub: string;
}) {
  const sessionToken = createSignedToken({
    email,
    exp: Math.floor(Date.now() / 1000) + AUTH_SESSION_MAX_AGE_SECONDS,
    sub
  } satisfies AuthSession);

  if (!sessionToken) {
    throw new Error('Could not create an app session.');
  }

  appendSetCookie(
    response,
    createCookie({
      maxAgeSeconds: AUTH_SESSION_MAX_AGE_SECONDS,
      name: AUTH_SESSION_COOKIE_NAME,
      request,
      value: sessionToken
    })
  );
}

function clearAuthCookies(request: IncomingMessage, response: ServerResponse) {
  appendSetCookie(response, clearCookie(AUTH_SESSION_COOKIE_NAME, request));
  appendSetCookie(response, clearCookie(AUTH_STATE_COOKIE_NAME, request));
}

async function handleAuthRoute(request: IncomingMessage, response: ServerResponse) {
  const requestUrl = getRequestUrl(request);
  const requestPath = getRequestPath(request);

  if (request.method === 'GET' && requestPath === '/api/auth/session') {
    const session = getCurrentSession(request);

    sendJson(response, 200, {
      auth: {
        email: session?.email ?? null,
        isAuthenticated: Boolean(session),
        isEnabled: true
      }
    });
    return true;
  }

  if (request.method === 'GET' && requestPath === '/auth/login') {
    if (getCurrentSession(request)) {
      redirect(response, normalizeReturnTo(requestUrl.searchParams.get('returnTo')));
      return true;
    }

    sendHtml(
      response,
      200,
      createLoginPage({
        errorMessage: requestUrl.searchParams.get('error') ?? undefined,
        returnTo: normalizeReturnTo(requestUrl.searchParams.get('returnTo'))
      })
    );
    return true;
  }

  if (request.method === 'GET' && requestPath === '/auth/google/start') {
    const state = createRandomToken();
    const nonce = createRandomToken();
    const returnTo = normalizeReturnTo(requestUrl.searchParams.get('returnTo'));
    const stateToken = createSignedToken({
      exp: Math.floor(Date.now() / 1000) + AUTH_STATE_MAX_AGE_SECONDS,
      nonce,
      returnTo,
      state
    } satisfies AuthState);

    if (!stateToken) {
      sendHtml(
        response,
        500,
        createLoginPage({
          errorMessage: 'Google sign-in is not configured.',
          returnTo
        })
      );
      return true;
    }

    appendSetCookie(
      response,
      createCookie({
        maxAgeSeconds: AUTH_STATE_MAX_AGE_SECONDS,
        name: AUTH_STATE_COOKIE_NAME,
        request,
        value: stateToken
      })
    );
    redirect(response, createAuthRedirectUrl({ nonce, request, state }));
    return true;
  }

  if (request.method === 'GET' && requestPath === '/auth/google/callback') {
    const authState = parseSignedToken<AuthState>(
      parseCookies(request)[AUTH_STATE_COOKIE_NAME]
    );
    const code = requestUrl.searchParams.get('code');
    const state = requestUrl.searchParams.get('state');

    try {
      if (
        !authState ||
        authState.exp < Math.floor(Date.now() / 1000) ||
        !code ||
        state !== authState.state
      ) {
        throw new Error('Google sign-in expired. Please try again.');
      }

      const idToken = await exchangeCodeForIdToken({ code, request });
      const account = await verifyGoogleIdToken(idToken, authState.nonce);

      setAuthSessionCookie({
        email: account.email,
        request,
        response,
        sub: account.sub
      });
      appendSetCookie(response, clearCookie(AUTH_STATE_COOKIE_NAME, request));
      redirect(response, authState.returnTo);
    } catch (error) {
      clearAuthCookies(request, response);
      redirect(
        response,
        `/auth/login?error=${encodeURIComponent(
          error instanceof Error ? error.message : 'Google sign-in failed.'
        )}`
      );
    }

    return true;
  }

  if (request.method === 'GET' && requestPath === '/auth/logout') {
    clearAuthCookies(request, response);
    redirect(response, '/auth/login');
    return true;
  }

  return false;
}

export async function handleAppAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  next: NextFunction
) {
  if (!isAuthEnabled()) {
    return false;
  }

  if (!isAuthConfigured()) {
    sendHtml(
      response,
      503,
      createLoginPage({
        errorMessage:
          'Google sign-in needs TRAVEL_AUTH_ALLOWED_EMAIL, TRAVEL_AUTH_GOOGLE_CLIENT_ID, TRAVEL_AUTH_GOOGLE_CLIENT_SECRET, and TRAVEL_AUTH_SESSION_SECRET.',
        returnTo: '/'
      })
    );
    return true;
  }

  if (await handleAuthRoute(request, response)) {
    return true;
  }

  if (getCurrentSession(request)) {
    return false;
  }

  const requestPath = getRequestPath(request);

  if (requestPath.startsWith('/api/')) {
    sendJson(response, 401, { error: 'Sign in with Google to use this app.' });
    return true;
  }

  if (request.method === 'GET') {
    redirect(
      response,
      `/auth/login?returnTo=${encodeURIComponent(request.url ?? '/')}`
    );
    return true;
  }

  next();
  return true;
}
