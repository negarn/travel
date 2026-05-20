import {
  emptyTravelAppState,
  isTravelAppStateEmpty,
  normalizeTravelAppState
} from './travelData';
import type { TravelAppState } from '../types/travel';

export const cloudSyncProviders = ['google-drive', 'dropbox'] as const;

export type CloudSyncProvider = (typeof cloudSyncProviders)[number];

export const cloudSyncProviderLabels: Record<CloudSyncProvider, string> = {
  'google-drive': 'Google Drive',
  dropbox: 'Dropbox'
};

export type CloudSyncBundle = {
  snapshot: TravelAppState;
  version: 1;
};

export type CloudSyncProviderConnectionStatus = {
  isConfigured: boolean;
  isConnected: boolean;
  lastError: string | null;
  lastKnownRemoteModifiedAt: string | null;
  lastSyncedAt: string | null;
};

export type CloudSyncStatus = {
  activeProvider: CloudSyncProvider | null;
  isSyncing: boolean;
  providers: Record<CloudSyncProvider, CloudSyncProviderConnectionStatus>;
};

export function serializeCloudSyncBundle(snapshot: TravelAppState): CloudSyncBundle {
  return {
    snapshot,
    version: 1
  };
}

export function normalizeCloudSyncBundle(value: unknown): TravelAppState {
  if (
    value &&
    typeof value === 'object' &&
    'version' in value &&
    value.version === 1 &&
    'snapshot' in value
  ) {
    return normalizeTravelAppState(value.snapshot);
  }

  return normalizeTravelAppState(value);
}

export function createDefaultCloudSyncStatus(): CloudSyncStatus {
  function providerStatus(): CloudSyncProviderConnectionStatus {
    return {
      isConfigured: false,
      isConnected: false,
      lastError: null,
      lastKnownRemoteModifiedAt: null,
      lastSyncedAt: null
    };
  }

  return {
    activeProvider: null,
    isSyncing: false,
    providers: {
      'google-drive': providerStatus(),
      dropbox: providerStatus()
    }
  };
}

export { emptyTravelAppState, isTravelAppStateEmpty };
