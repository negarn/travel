import { useEffect, useRef, useState } from 'react';
import {
  cloudSyncProviderLabels,
  cloudSyncProviders,
  createDefaultCloudSyncStatus,
  type CloudSyncProvider,
  type CloudSyncStatus
} from '../helpers/cloudSyncData';
import {
  cloudSyncApiPaths,
  getCloudSyncAuthorizePath
} from '../helpers/cloudSyncRoutes';

const CLOUD_SYNC_STATUS_POLL_INTERVAL_MS = 30_000;
const CLOUD_SYNC_CONNECT_POLL_INTERVAL_MS = 1_000;
const CLOUD_SYNC_POPUP_FEATURES =
  'popup=yes,width=560,height=760,menubar=no,toolbar=no,location=yes,status=yes';
export const CLOUD_SYNC_APP_DATA_REFRESH_EVENT =
  'travel-cloud-sync-app-data-refresh';

type CloudSyncPendingAction = 'reset-local' | 'sync' | null;
type UseCloudSyncStatusResult = {
  connect: (provider: CloudSyncProvider) => Promise<boolean>;
  disconnect: () => Promise<boolean>;
  error: string | null;
  isLoading: boolean;
  isPending: boolean;
  pendingAction: CloudSyncPendingAction;
  pendingProvider: CloudSyncProvider | null;
  resetLocalFromCloud: () => Promise<boolean>;
  status: CloudSyncStatus;
  syncNow: () => Promise<boolean>;
};

function normalizeCloudSyncStatus(value: unknown): CloudSyncStatus {
  if (!value || typeof value !== 'object') {
    return createDefaultCloudSyncStatus();
  }

  const defaultStatus = createDefaultCloudSyncStatus();
  const parsedValue = value as Partial<CloudSyncStatus>;
  const providerStatus = (parsedValue.providers ?? {}) as Partial<
    CloudSyncStatus['providers']
  >;

  return {
    activeProvider:
      parsedValue.activeProvider &&
      cloudSyncProviders.includes(parsedValue.activeProvider)
        ? parsedValue.activeProvider
        : null,
    isSyncing: Boolean(parsedValue.isSyncing),
    providers: {
      'google-drive': {
        ...defaultStatus.providers['google-drive'],
        ...(providerStatus['google-drive'] ?? {})
      },
      dropbox: {
        ...defaultStatus.providers.dropbox,
        ...(providerStatus.dropbox ?? {})
      }
    }
  };
}

async function fetchCloudSyncStatus(): Promise<CloudSyncStatus> {
  const response = await fetch(cloudSyncApiPaths.status);

  if (!response.ok) {
    throw new Error('Could not load cloud sync status.');
  }

  const parsedResponse = (await response.json()) as { cloudSync?: unknown };
  return normalizeCloudSyncStatus(parsedResponse.cloudSync ?? parsedResponse);
}

export function useCloudSyncStatus(): UseCloudSyncStatusResult {
  const [status, setStatus] = useState<CloudSyncStatus>(
    createDefaultCloudSyncStatus()
  );
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isActionPending, setIsActionPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<CloudSyncPendingAction>(null);
  const [pendingProvider, setPendingProvider] = useState<CloudSyncProvider | null>(
    null
  );
  const pendingPopupRef = useRef<Window | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  function clearConnectionPollingTimer(): void {
    if (refreshTimerRef.current === null) {
      return;
    }

    window.clearInterval(refreshTimerRef.current);
    refreshTimerRef.current = null;
  }

  useEffect(() => {
    let isCurrent = true;

    async function loadStatus() {
      try {
        const nextStatus = await fetchCloudSyncStatus();

        if (isCurrent) {
          setStatus(nextStatus);
          setError(null);
        }
      } catch (error) {
        console.error(error);

        if (isCurrent) {
          setError('Could not load cloud sync status.');
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false);
        }
      }
    }

    void loadStatus();

    return () => {
      isCurrent = false;
    };
  }, []);

  useEffect(() => {
    if (!status.activeProvider) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      void refreshStatus();
    }, CLOUD_SYNC_STATUS_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [status.activeProvider]);

  useEffect(() => {
    return () => {
      clearConnectionPollingTimer();
      pendingPopupRef.current?.close();
    };
  }, []);

  async function refreshStatus(): Promise<CloudSyncStatus> {
    try {
      const nextStatus = await fetchCloudSyncStatus();
      setStatus(nextStatus);
      setError(null);
      return nextStatus;
    } catch (error) {
      console.error(error);
      setError('Could not load cloud sync status.');
      return status;
    }
  }

  async function waitForConnection(
    provider: CloudSyncProvider
  ): Promise<boolean> {
    const popupWindow = pendingPopupRef.current;

    if (!popupWindow) {
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      refreshTimerRef.current = window.setInterval(async () => {
        if (popupWindow.closed) {
          clearConnectionPollingTimer();
          setPendingProvider(null);
          const nextStatus = await refreshStatus();
          resolve(
            nextStatus.activeProvider === provider &&
              nextStatus.providers[provider].isConnected
          );
          return;
        }

        const nextStatus = await refreshStatus();

        if (
          nextStatus.activeProvider === provider &&
          nextStatus.providers[provider].isConnected
        ) {
          clearConnectionPollingTimer();
          popupWindow.close();
          setPendingProvider(null);
          resolve(true);
        }
      }, CLOUD_SYNC_CONNECT_POLL_INTERVAL_MS);
    });
  }

  async function connect(provider: CloudSyncProvider): Promise<boolean> {
    setError(null);

    if (!status.providers[provider].isConfigured) {
      setError(`${cloudSyncProviderLabels[provider]} sync is not configured yet.`);
      return false;
    }

    const popupWindow = window.open(
      getCloudSyncAuthorizePath(provider),
      'travel-cloud-sync',
      CLOUD_SYNC_POPUP_FEATURES
    );

    if (!popupWindow) {
      setError(`Could not open the ${cloudSyncProviderLabels[provider]} authorization window.`);
      return false;
    }

    pendingPopupRef.current = popupWindow;
    setPendingProvider(provider);

    const isConnected = await waitForConnection(provider);

    if (!isConnected) {
      setError(`Could not finish connecting to ${cloudSyncProviderLabels[provider]}.`);
    }

    await refreshStatus();
    return isConnected;
  }

  async function postCloudAction(
    path: string,
    action: Exclude<CloudSyncPendingAction, null>,
    errorMessage: string
  ): Promise<boolean> {
    setError(null);
    setIsActionPending(true);
    setPendingAction(action);

    try {
      const response = await fetch(path, { method: 'POST' });

      if (!response.ok) {
        setError(errorMessage);
        return false;
      }

      await refreshStatus();
      window.dispatchEvent(new Event(CLOUD_SYNC_APP_DATA_REFRESH_EVENT));
      return true;
    } finally {
      setPendingAction(null);
      setIsActionPending(false);
    }
  }

  async function disconnect(): Promise<boolean> {
    setError(null);
    setIsActionPending(true);

    try {
      const response = await fetch(cloudSyncApiPaths.disconnect, {
        method: 'POST'
      });

      if (!response.ok) {
        setError('Could not disconnect cloud sync.');
        return false;
      }

      await refreshStatus();
      return true;
    } finally {
      setIsActionPending(false);
    }
  }

  return {
    connect,
    disconnect,
    error,
    isLoading,
    isPending: Boolean(pendingProvider) || isActionPending || status.isSyncing,
    pendingAction,
    pendingProvider,
    resetLocalFromCloud: () =>
      postCloudAction(
        cloudSyncApiPaths.resetLocal,
        'reset-local',
        'Could not replace local data from cloud.'
      ),
    status,
    syncNow: () =>
      postCloudAction(cloudSyncApiPaths.sync, 'sync', 'Could not sync cloud data.')
  };
}
