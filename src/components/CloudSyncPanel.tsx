import {
  cloudSyncProviderLabels,
  cloudSyncProviders,
  type CloudSyncProvider,
  type CloudSyncProviderConnectionStatus
} from '../helpers/cloudSyncData';
import { useCloudSyncStatus } from '../hooks/useCloudSyncStatus';

function formatDateTime(value: string | null): string {
  if (!value) {
    return 'Not synced yet';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Not synced yet';
  }

  return date.toLocaleString();
}

function getProviderSetupMessage(
  provider: CloudSyncProvider,
  isConfigured: boolean
): string | null {
  if (isConfigured) {
    return null;
  }

  if (provider === 'google-drive') {
    return 'Set TRAVEL_GOOGLE_DRIVE_CLIENT_ID and TRAVEL_GOOGLE_DRIVE_CLIENT_SECRET to connect.';
  }

  return 'Set TRAVEL_DROPBOX_CLIENT_ID and TRAVEL_DROPBOX_CLIENT_SECRET to connect.';
}

function getProviderStatusLabel({
  isActive,
  isConfigured,
  isConnecting
}: {
  isActive: boolean;
  isConfigured: boolean;
  isConnecting: boolean;
}): string {
  if (isConnecting) {
    return 'Connecting';
  }

  if (isActive) {
    return 'Connected';
  }

  return isConfigured ? 'Ready' : 'Needs setup';
}

function ProviderCard({
  activeProvider,
  connect,
  disconnect,
  isPending,
  isResetPending,
  isSyncPending,
  pendingProvider,
  provider,
  resetLocalFromCloud,
  status,
  syncNow
}: {
  activeProvider: CloudSyncProvider | null;
  connect: (provider: CloudSyncProvider) => Promise<boolean>;
  disconnect: () => Promise<boolean>;
  isPending: boolean;
  isResetPending: boolean;
  isSyncPending: boolean;
  pendingProvider: CloudSyncProvider | null;
  provider: CloudSyncProvider;
  resetLocalFromCloud: () => Promise<boolean>;
  status: CloudSyncProviderConnectionStatus;
  syncNow: () => Promise<boolean>;
}): JSX.Element {
  const providerLabel = cloudSyncProviderLabels[provider];
  const isActive = activeProvider === provider && status.isConnected;
  const isConnecting = pendingProvider === provider;
  const setupMessage = getProviderSetupMessage(provider, status.isConfigured);

  return (
    <section className="sync-card">
      <div className="sync-card-header">
        <h2>{providerLabel}</h2>
        <span className={isActive ? 'sync-pill sync-pill-active' : 'sync-pill'}>
          {getProviderStatusLabel({
            isActive,
            isConfigured: status.isConfigured,
            isConnecting
          })}
        </span>
      </div>

      <div className="sync-card-body">
        <p className="text-sm text-app-muted">
          {provider === 'google-drive'
            ? "Uses Google Drive's private app data folder."
            : "Uses Dropbox's private app folder."}
        </p>

        <p className="text-sm font-semibold text-app-muted">
          Last synced:{' '}
          <span className="text-app-ink">{formatDateTime(status.lastSyncedAt)}</span>
        </p>
      </div>

      <div className="sync-card-message">
        {status.lastError ? <p className="empty-state">{status.lastError}</p> : null}
        {setupMessage ? <p className="empty-state">{setupMessage}</p> : null}
      </div>

      <div className="sync-card-actions">
        {!isActive ? (
          <button
            className="secondary-button"
            type="button"
            onClick={() => void connect(provider)}
            disabled={!status.isConfigured || isPending}
          >
            {isConnecting ? 'Connecting...' : `Connect ${providerLabel}`}
          </button>
        ) : null}

        {isActive ? (
          <>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void syncNow()}
              disabled={isPending}
            >
              {isSyncPending ? 'Syncing...' : 'Sync now'}
            </button>
            <button
              className="quiet-button"
              type="button"
              onClick={() => {
                if (window.confirm('Replace local travel data with the cloud copy?')) {
                  void resetLocalFromCloud();
                }
              }}
              disabled={isPending}
            >
              {isResetPending ? 'Replacing...' : 'Replace local with cloud'}
            </button>
            <button
              className="quiet-button"
              type="button"
              onClick={() => void disconnect()}
              disabled={isPending}
            >
              Disconnect
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}

export function CloudSyncPanel(): JSX.Element {
  const {
    connect,
    disconnect,
    error,
    isLoading,
    isPending,
    pendingAction,
    pendingProvider,
    resetLocalFromCloud,
    status,
    syncNow
  } = useCloudSyncStatus();

  return (
    <section className="panel">
      <div className="grid gap-5">
        <div>
          <h2 className="text-xl font-semibold text-app-ink">Cloud sync</h2>
          <p className="mt-1 text-sm text-app-muted">
            Keep a private copy of your travel data in Google Drive or Dropbox.
            Local data is stored in <span className="font-semibold">~/.travel</span>.
          </p>
        </div>

        {isLoading ? (
          <p className="empty-state">Loading cloud sync status...</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {cloudSyncProviders.map((provider) => (
              <ProviderCard
                activeProvider={status.activeProvider}
                connect={connect}
                disconnect={disconnect}
                isPending={isPending}
                isResetPending={pendingAction === 'reset-local'}
                isSyncPending={pendingAction === 'sync'}
                key={provider}
                pendingProvider={pendingProvider}
                provider={provider}
                resetLocalFromCloud={resetLocalFromCloud}
                status={status.providers[provider]}
                syncNow={syncNow}
              />
            ))}
          </div>
        )}

        {error ? <p className="empty-state">{error}</p> : null}
      </div>
    </section>
  );
}
