import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  cloudSyncProviderLabels,
  cloudSyncProviders,
  createDefaultCloudSyncStatus,
  emptyTravelAppState,
  isTravelAppStateEmpty,
  normalizeCloudSyncBundle,
  serializeCloudSyncBundle,
  type CloudSyncBundle,
  type CloudSyncProvider,
  type CloudSyncProviderConnectionStatus,
  type CloudSyncStatus
} from '../src/helpers/cloudSyncData';
import { getCloudSyncCallbackPath } from '../src/helpers/cloudSyncRoutes';
import type { TravelAppState } from '../src/types/travel';
import { getRequestOrigin } from './publicOrigin';
import {
  ensurePrivateJsonStorageFile,
  writePrivateJsonFile
} from './privateFilesystem';
import { getRequestPath } from './requestPath';

type CloudSyncTokenState = {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
};

type CloudSyncConnectionState = {
  lastKnownRemoteModifiedAt: string | null;
  lastSyncedAt: string | null;
  provider: CloudSyncProvider;
  remoteBundleId: string | null;
  remoteBundlePath: string | null;
  token: CloudSyncTokenState;
};

type CloudSyncPersistedState = {
  activeConnection: CloudSyncConnectionState | null;
};

type CloudSyncManagerOptions = {
  applySnapshot: (snapshot: TravelAppState) => Promise<void>;
  dataRootDir: string;
  getSnapshot: () => Promise<TravelAppState>;
  onError?: (error: unknown) => void;
};

const CLOUD_SYNC_STATE_FILE_NAME = 'cloud-sync.json';
const CLOUD_SYNC_BUNDLE_FILE_NAME = 'travel-app-state.json';
const CLOUD_SYNC_SYNC_DEBOUNCE_MS = 750;

class CloudSyncError extends Error {}

function getStateFilePath(dataRootDir: string) {
  return resolve(dataRootDir, CLOUD_SYNC_STATE_FILE_NAME);
}

function getCloudSyncBundleFilePath(dataRootDir: string) {
  return resolve(dataRootDir, CLOUD_SYNC_BUNDLE_FILE_NAME);
}

function getProviderConfig(provider: CloudSyncProvider) {
  switch (provider) {
    case 'google-drive':
      return {
        clientId: process.env.TRAVEL_GOOGLE_DRIVE_CLIENT_ID ?? null,
        clientSecret: process.env.TRAVEL_GOOGLE_DRIVE_CLIENT_SECRET ?? null
      };
    case 'dropbox':
      return {
        clientId: process.env.TRAVEL_DROPBOX_CLIENT_ID ?? null,
        clientSecret: process.env.TRAVEL_DROPBOX_CLIENT_SECRET ?? null
      };
  }
}

function isProviderConfigured(provider: CloudSyncProvider) {
  const { clientId, clientSecret } = getProviderConfig(provider);
  return Boolean(clientId && clientSecret);
}

function createEmptyPersistedState(): CloudSyncPersistedState {
  return {
    activeConnection: null
  };
}

function parseJsonOrNull(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorMessage(value: unknown, fallbackMessage: string) {
  if (typeof value === 'string') {
    return value;
  }

  if (isRecordLike(value)) {
    if (typeof value.error_description === 'string') {
      return value.error_description;
    }

    if (typeof value.error === 'string') {
      return value.error;
    }

    if (typeof value.message === 'string') {
      return value.message;
    }
  }

  return fallbackMessage;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendHtml(response: ServerResponse, statusCode: number, html: string) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(html);
}

async function readJsonFile<T>(filePath: string, fallbackValue: T) {
  await ensurePrivateJsonStorageFile(filePath);

  try {
    const parsedValue = parseJsonOrNull(await fs.readFile(filePath, 'utf8'));
    return parsedValue === null ? fallbackValue : (parsedValue as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallbackValue;
    }

    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  await writePrivateJsonFile(filePath, value);
}

function normalizeConnectionState(value: unknown): CloudSyncConnectionState | null {
  if (!isRecordLike(value)) {
    return null;
  }

  const provider = value.provider;
  const token = value.token;

  if (!cloudSyncProviders.includes(provider as CloudSyncProvider) || !isRecordLike(token)) {
    return null;
  }

  if (
    typeof token.accessToken !== 'string' ||
    typeof token.accessTokenExpiresAt !== 'number' ||
    typeof token.refreshToken !== 'string'
  ) {
    return null;
  }

  return {
    lastKnownRemoteModifiedAt:
      typeof value.lastKnownRemoteModifiedAt === 'string'
        ? value.lastKnownRemoteModifiedAt
        : null,
    lastSyncedAt: typeof value.lastSyncedAt === 'string' ? value.lastSyncedAt : null,
    provider: provider as CloudSyncProvider,
    remoteBundleId: typeof value.remoteBundleId === 'string' ? value.remoteBundleId : null,
    remoteBundlePath:
      typeof value.remoteBundlePath === 'string' ? value.remoteBundlePath : null,
    token: {
      accessToken: token.accessToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt,
      refreshToken: token.refreshToken
    }
  };
}

function normalizePersistedState(value: unknown): CloudSyncPersistedState {
  if (!isRecordLike(value)) {
    return createEmptyPersistedState();
  }

  return {
    activeConnection: normalizeConnectionState(value.activeConnection)
  };
}

async function getFetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const responseText = await response.text();

  if (!response.ok) {
    throw new CloudSyncError(
      getErrorMessage(
        parseJsonOrNull(responseText),
        `Cloud provider request failed with status ${response.status}.`
      )
    );
  }

  return responseText ? parseJsonOrNull(responseText) : null;
}

async function postFormEncodedJson(
  url: string,
  body: Record<string, string | null | undefined>
) {
  const formBody = new URLSearchParams();

  Object.entries(body).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      formBody.set(key, value);
    }
  });

  return (await getFetchJson(url, {
    body: formBody,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    method: 'POST'
  })) as Record<string, unknown>;
}

function getRedirectUri(request: IncomingMessage, provider: CloudSyncProvider) {
  return new URL(getCloudSyncCallbackPath(provider), getRequestOrigin(request)).toString();
}

function createCloudSyncAuthorizeUrl({
  provider,
  redirectUri,
  state
}: {
  provider: CloudSyncProvider;
  redirectUri: string;
  state: string;
}) {
  const { clientId } = getProviderConfig(provider);

  if (!clientId) {
    throw new CloudSyncError(`${cloudSyncProviderLabels[provider]} sync is not configured.`);
  }

  if (provider === 'google-drive') {
    const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.appdata');
    authorizeUrl.searchParams.set('access_type', 'offline');
    authorizeUrl.searchParams.set('prompt', 'consent');
    authorizeUrl.searchParams.set('state', state);
    return authorizeUrl.toString();
  }

  const authorizeUrl = new URL('https://www.dropbox.com/oauth2/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set(
    'scope',
    ['files.content.read', 'files.content.write', 'files.metadata.read'].join(' ')
  );
  authorizeUrl.searchParams.set('token_access_type', 'offline');
  authorizeUrl.searchParams.set('state', state);
  return authorizeUrl.toString();
}

async function exchangeAuthorizationCode({
  code,
  provider,
  redirectUri
}: {
  code: string;
  provider: CloudSyncProvider;
  redirectUri: string;
}) {
  const { clientId, clientSecret } = getProviderConfig(provider);

  if (!clientId || !clientSecret) {
    throw new CloudSyncError(`${cloudSyncProviderLabels[provider]} sync is not configured.`);
  }

  const endpoint =
    provider === 'google-drive'
      ? 'https://oauth2.googleapis.com/token'
      : 'https://api.dropboxapi.com/oauth2/token';
  const parsedResponse = await postFormEncodedJson(endpoint, {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });
  const accessToken = parsedResponse.access_token;
  const refreshToken = parsedResponse.refresh_token;
  const expiresIn = parsedResponse.expires_in;

  if (
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof expiresIn !== 'number'
  ) {
    throw new CloudSyncError(
      `Could not finish connecting to ${cloudSyncProviderLabels[provider]}.`
    );
  }

  return {
    accessToken,
    accessTokenExpiresAt: Date.now() + expiresIn * 1000,
    refreshToken
  };
}

async function refreshAccessToken(connection: CloudSyncConnectionState) {
  const { clientId, clientSecret } = getProviderConfig(connection.provider);

  if (!clientId || !clientSecret) {
    throw new CloudSyncError(
      `${cloudSyncProviderLabels[connection.provider]} sync is not configured.`
    );
  }

  const endpoint =
    connection.provider === 'google-drive'
      ? 'https://oauth2.googleapis.com/token'
      : 'https://api.dropboxapi.com/oauth2/token';
  const parsedResponse = await postFormEncodedJson(endpoint, {
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: connection.token.refreshToken
  });
  const accessToken = parsedResponse.access_token;
  const expiresIn = parsedResponse.expires_in;

  if (typeof accessToken !== 'string' || typeof expiresIn !== 'number') {
    throw new CloudSyncError('Could not refresh cloud sync credentials.');
  }

  connection.token.accessToken = accessToken;
  connection.token.accessTokenExpiresAt = Date.now() + expiresIn * 1000;
}

async function getValidAccessToken(connection: CloudSyncConnectionState) {
  if (Date.now() >= connection.token.accessTokenExpiresAt - 60_000) {
    await refreshAccessToken(connection);
  }

  return connection.token.accessToken;
}

async function findGoogleRemoteFileId(accessToken: string) {
  const response = await fetch(
    "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name%3D%27travel-app-state.json%27%20and%20trashed%3Dfalse&fields=files(id%2CmodifiedTime%2Cname)",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (!response.ok) {
    throw new CloudSyncError('Could not find Google Drive sync file.');
  }

  const parsedResponse = (await response.json()) as Partial<{
    files: Array<Partial<Record<'id' | 'modifiedTime', unknown>>>;
  }>;

  return (parsedResponse.files ?? [])
    .flatMap((remoteFile) =>
      typeof remoteFile.id === 'string' && typeof remoteFile.modifiedTime === 'string'
        ? [{ fileId: remoteFile.id, modifiedAt: remoteFile.modifiedTime }]
        : []
    )
    .sort((firstFile, secondFile) =>
      secondFile.modifiedAt.localeCompare(firstFile.modifiedAt)
    )[0] ?? null;
}

async function uploadGoogleBundle(
  accessToken: string,
  remoteBundleId: string | null,
  bundle: CloudSyncBundle
) {
  let fileId = remoteBundleId ?? (await findGoogleRemoteFileId(accessToken))?.fileId ?? null;

  if (!fileId) {
    const createResponse = await fetch(
      'https://www.googleapis.com/drive/v3/files?fields=id,modifiedTime,name',
      {
        body: JSON.stringify({
          mimeType: 'application/json',
          name: CLOUD_SYNC_BUNDLE_FILE_NAME,
          parents: ['appDataFolder']
        }),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=utf-8'
        },
        method: 'POST'
      }
    );

    if (!createResponse.ok) {
      throw new CloudSyncError('Could not create Google Drive sync file.');
    }

    const createdFile = (await createResponse.json()) as Partial<Record<'id', unknown>>;

    if (typeof createdFile.id !== 'string') {
      throw new CloudSyncError('Could not create Google Drive sync file.');
    }

    fileId = createdFile.id;
  }

  let uploadResponse = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,modifiedTime,name`,
    {
      body: JSON.stringify(bundle),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      method: 'PATCH'
    }
  );

  if (uploadResponse.status === 404) {
    const currentRemoteFile = await findGoogleRemoteFileId(accessToken);

    if (currentRemoteFile && currentRemoteFile.fileId !== fileId) {
      fileId = currentRemoteFile.fileId;
      uploadResponse = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,modifiedTime,name`,
        {
          body: JSON.stringify(bundle),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=utf-8'
          },
          method: 'PATCH'
        }
      );
    }
  }

  if (!uploadResponse.ok) {
    throw new CloudSyncError('Could not upload Google Drive sync data.');
  }

  const uploadedFile = (await uploadResponse.json()) as Partial<
    Record<'id' | 'modifiedTime', unknown>
  >;

  return {
    fileId: typeof uploadedFile.id === 'string' ? uploadedFile.id : fileId,
    modifiedAt:
      typeof uploadedFile.modifiedTime === 'string'
        ? uploadedFile.modifiedTime
        : new Date().toISOString()
  };
}

async function downloadGoogleBundle(accessToken: string, fileId: string) {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new CloudSyncError('Could not download Google Drive sync data.');
  }

  return normalizeCloudSyncBundle(await response.json());
}

async function uploadDropboxBundle(
  accessToken: string,
  remoteBundlePath: string,
  bundle: CloudSyncBundle
) {
  const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
    body: JSON.stringify(bundle),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        autorename: false,
        mode: 'overwrite',
        mute: true,
        path: remoteBundlePath
      })
    },
    method: 'POST'
  });

  if (!response.ok) {
    throw new CloudSyncError('Could not upload Dropbox sync data.');
  }

  const uploadedFile = (await response.json()) as Partial<Record<'server_modified', unknown>>;

  return typeof uploadedFile.server_modified === 'string'
    ? uploadedFile.server_modified
    : new Date().toISOString();
}

async function downloadDropboxBundle(accessToken: string, remoteBundlePath: string) {
  const response = await fetch('https://content.dropboxapi.com/2/files/download', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({ path: remoteBundlePath })
    },
    method: 'POST'
  });

  if (response.status === 409 || response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new CloudSyncError('Could not download Dropbox sync data.');
  }

  return normalizeCloudSyncBundle(await response.json());
}

function getDropboxRemoteBundlePath() {
  return `/${CLOUD_SYNC_BUNDLE_FILE_NAME}`;
}

export type CloudSyncManager = ReturnType<typeof createCloudSyncManager>;

export function createCloudSyncManager(options: CloudSyncManagerOptions) {
  const stateFilePath = getStateFilePath(options.dataRootDir);
  const localBundleFilePath = getCloudSyncBundleFilePath(options.dataRootDir);
  let persistedState: CloudSyncPersistedState = createEmptyPersistedState();
  let status = createDefaultCloudSyncStatus();
  let isSyncing = false;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  const lastErrorByProvider: Record<CloudSyncProvider, string | null> = {
    'google-drive': null,
    dropbox: null
  };
  const pendingAuthorizeStates = new Map<
    string,
    { provider: CloudSyncProvider; redirectUri: string }
  >();

  function refreshStatus() {
    const activeConnection = persistedState.activeConnection;

    const providerStatus = (provider: CloudSyncProvider): CloudSyncProviderConnectionStatus => ({
      isConfigured: isProviderConfigured(provider),
      isConnected: activeConnection?.provider === provider,
      lastError: lastErrorByProvider[provider],
      lastKnownRemoteModifiedAt:
        activeConnection?.provider === provider
          ? activeConnection.lastKnownRemoteModifiedAt
          : null,
      lastSyncedAt:
        activeConnection?.provider === provider ? activeConnection.lastSyncedAt : null
    });

    status = {
      activeProvider: activeConnection?.provider ?? null,
      isSyncing: isSyncing || Boolean(syncTimer),
      providers: {
        'google-drive': providerStatus('google-drive'),
        dropbox: providerStatus('dropbox')
      }
    };
  }

  async function saveState() {
    await writeJsonFile(stateFilePath, persistedState);
    refreshStatus();
  }

  async function initialize() {
    persistedState = normalizePersistedState(
      await readJsonFile(stateFilePath, createEmptyPersistedState())
    );
    refreshStatus();
  }

  async function writeLocalBundle(snapshot: TravelAppState) {
    await writeJsonFile(localBundleFilePath, serializeCloudSyncBundle(snapshot));
  }

  async function getSnapshotBundle() {
    const snapshot = await options.getSnapshot();
    await writeLocalBundle(snapshot);
    return serializeCloudSyncBundle(snapshot);
  }

  async function uploadBundle(connection: CloudSyncConnectionState, bundle: CloudSyncBundle) {
    const accessToken = await getValidAccessToken(connection);

    if (connection.provider === 'google-drive') {
      const uploadedFile = await uploadGoogleBundle(
        accessToken,
        connection.remoteBundleId,
        bundle
      );
      connection.remoteBundleId = uploadedFile.fileId;
      connection.lastKnownRemoteModifiedAt = uploadedFile.modifiedAt;
      return;
    }

    const remoteBundlePath = connection.remoteBundlePath ?? getDropboxRemoteBundlePath();
    const modifiedAt = await uploadDropboxBundle(accessToken, remoteBundlePath, bundle);
    connection.remoteBundlePath = remoteBundlePath;
    connection.lastKnownRemoteModifiedAt = modifiedAt;
  }

  async function downloadBundle(connection: CloudSyncConnectionState) {
    const accessToken = await getValidAccessToken(connection);

    if (connection.provider === 'google-drive') {
      const remoteFile =
        connection.remoteBundleId !== null
          ? { fileId: connection.remoteBundleId, modifiedAt: null }
          : await findGoogleRemoteFileId(accessToken);

      if (!remoteFile) {
        return null;
      }

      connection.remoteBundleId = remoteFile.fileId;
      return downloadGoogleBundle(accessToken, remoteFile.fileId);
    }

    const remoteBundlePath = connection.remoteBundlePath ?? getDropboxRemoteBundlePath();
    connection.remoteBundlePath = remoteBundlePath;
    return downloadDropboxBundle(accessToken, remoteBundlePath);
  }

  async function syncLocalBundleToRemote() {
    const connection = persistedState.activeConnection;

    if (!connection) {
      throw new CloudSyncError('Cloud sync is not connected.');
    }

    isSyncing = true;
    refreshStatus();

    try {
      await uploadBundle(connection, await getSnapshotBundle());
      connection.lastSyncedAt = new Date().toISOString();
      lastErrorByProvider[connection.provider] = null;
      persistedState.activeConnection = connection;
      await saveState();
    } finally {
      isSyncing = false;
      refreshStatus();
    }
  }

  async function resetLocalBundleFromRemote() {
    const connection = persistedState.activeConnection;

    if (!connection) {
      throw new CloudSyncError('Cloud sync is not connected.');
    }

    isSyncing = true;
    refreshStatus();

    try {
      const remoteBundle = await downloadBundle(connection);

      if (!remoteBundle) {
        throw new CloudSyncError('No cloud sync data was found to restore.');
      }

      await options.applySnapshot(remoteBundle);
      await writeLocalBundle(remoteBundle);
      connection.lastSyncedAt = new Date().toISOString();
      lastErrorByProvider[connection.provider] = null;
      persistedState.activeConnection = connection;
      await saveState();
    } finally {
      isSyncing = false;
      refreshStatus();
    }
  }

  async function connectProvider({
    code,
    provider,
    redirectUri
  }: {
    code: string;
    provider: CloudSyncProvider;
    redirectUri: string;
  }) {
    const token = await exchangeAuthorizationCode({ code, provider, redirectUri });
    const connection: CloudSyncConnectionState = {
      lastKnownRemoteModifiedAt: null,
      lastSyncedAt: null,
      provider,
      remoteBundleId: null,
      remoteBundlePath: provider === 'dropbox' ? getDropboxRemoteBundlePath() : null,
      token
    };
    const localSnapshot = await options.getSnapshot();

    persistedState.activeConnection = connection;
    await saveState();

    const remoteBundle = await downloadBundle(connection);

    if (remoteBundle && isTravelAppStateEmpty(localSnapshot)) {
      await options.applySnapshot(remoteBundle);
      await writeLocalBundle(remoteBundle);
    } else {
      await uploadBundle(connection, serializeCloudSyncBundle(localSnapshot));
    }

    connection.lastSyncedAt = new Date().toISOString();
    lastErrorByProvider[provider] = null;
    persistedState.activeConnection = connection;
    await saveState();
  }

  async function getStatus() {
    refreshStatus();
    return status;
  }

  async function scheduleSync() {
    if (!persistedState.activeConnection) {
      return;
    }

    if (syncTimer) {
      clearTimeout(syncTimer);
    }

    syncTimer = setTimeout(() => {
      syncTimer = null;
      void syncLocalBundleToRemote().catch((error) => {
        const connection = persistedState.activeConnection;

        if (connection) {
          lastErrorByProvider[connection.provider] = getErrorMessage(
            error,
            'Could not sync cloud data.'
          );
          refreshStatus();
        }

        options.onError?.(error);
      });
    }, CLOUD_SYNC_SYNC_DEBOUNCE_MS);
    refreshStatus();
  }

  async function handleAuthorizeRoute(
    provider: CloudSyncProvider,
    request: IncomingMessage,
    response: ServerResponse
  ) {
    const state = randomUUID();
    const redirectUri = getRedirectUri(request, provider);
    const authorizeUrl = createCloudSyncAuthorizeUrl({ provider, redirectUri, state });

    pendingAuthorizeStates.set(state, { provider, redirectUri });
    response.statusCode = 302;
    response.setHeader('Location', authorizeUrl);
    response.end();
  }

  function getCallbackCloseHtml(message: string, provider?: CloudSyncProvider) {
    const safeMessage = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return `<!doctype html><html><head><meta charset="utf-8" /><title>Cloud sync</title></head><body style="font-family: system-ui, sans-serif; padding: 24px; line-height: 1.5;">
      <p>${safeMessage}</p>
      <script>
        try {
          window.opener && window.opener.postMessage(${JSON.stringify({
            provider,
            type: 'travel-cloud-sync-complete'
          })}, window.location.origin);
        } catch (error) {}
        setTimeout(() => window.close(), 150);
      </script>
    </body></html>`;
  }

  async function handleCallbackRoute(
    provider: CloudSyncProvider,
    request: IncomingMessage,
    response: ServerResponse
  ) {
    const requestUrl = new URL(request.url ?? '', getRequestOrigin(request));
    const code = requestUrl.searchParams.get('code');
    const state = requestUrl.searchParams.get('state');

    if (!code || !state) {
      sendHtml(response, 400, getCallbackCloseHtml('Missing cloud sync authorization data.'));
      return;
    }

    const pendingState = pendingAuthorizeStates.get(state);

    if (!pendingState || pendingState.provider !== provider) {
      sendHtml(response, 400, getCallbackCloseHtml('Cloud sync authorization expired.'));
      return;
    }

    pendingAuthorizeStates.delete(state);

    try {
      await connectProvider({ code, provider, redirectUri: pendingState.redirectUri });
      sendHtml(
        response,
        200,
        getCallbackCloseHtml(`Connected ${cloudSyncProviderLabels[provider]} sync.`, provider)
      );
    } catch (error) {
      const message = getErrorMessage(
        error,
        `Could not connect ${cloudSyncProviderLabels[provider]} sync.`
      );
      lastErrorByProvider[provider] = message;
      refreshStatus();
      options.onError?.(error);
      sendHtml(response, 500, getCallbackCloseHtml(message));
    }
  }

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ) {
    const requestPath = getRequestPath(request);

    if (request.method === 'GET' && requestPath === '/api/cloud-sync') {
      sendJson(response, 200, { cloudSync: await getStatus() });
      return true;
    }

    if (request.method === 'POST' && requestPath === '/api/cloud-sync/disconnect') {
      persistedState = createEmptyPersistedState();
      cloudSyncProviders.forEach((provider) => {
        lastErrorByProvider[provider] = null;
      });
      await saveState();
      sendJson(response, 200, { cloudSync: await getStatus() });
      return true;
    }

    if (request.method === 'POST' && requestPath === '/api/cloud-sync/sync') {
      try {
        await syncLocalBundleToRemote();
        sendJson(response, 200, { cloudSync: await getStatus() });
      } catch (error) {
        sendJson(response, 500, { error: getErrorMessage(error, 'Could not sync cloud data.') });
      }
      return true;
    }

    if (request.method === 'POST' && requestPath === '/api/cloud-sync/reset-local') {
      try {
        await resetLocalBundleFromRemote();
        sendJson(response, 200, { cloudSync: await getStatus() });
      } catch (error) {
        sendJson(response, 500, {
          error: getErrorMessage(error, 'Could not reset local data from cloud.')
        });
      }
      return true;
    }

    const authorizeMatch = requestPath.match(
      /^\/api\/cloud-sync\/(google-drive|dropbox)\/authorize$/
    );
    if (request.method === 'GET' && authorizeMatch) {
      await handleAuthorizeRoute(authorizeMatch[1] as CloudSyncProvider, request, response);
      return true;
    }

    const callbackMatch = requestPath.match(
      /^\/api\/cloud-sync\/(google-drive|dropbox)\/callback$/
    );
    if (request.method === 'GET' && callbackMatch) {
      await handleCallbackRoute(callbackMatch[1] as CloudSyncProvider, request, response);
      return true;
    }

    return false;
  }

  return {
    getStatus,
    handleRequest,
    initialize,
    scheduleSync
  };
}
