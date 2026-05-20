import type { CloudSyncProvider } from './cloudSyncData';

export const cloudSyncApiPaths = {
  disconnect: '/api/cloud-sync/disconnect',
  resetLocal: '/api/cloud-sync/reset-local',
  status: '/api/cloud-sync',
  sync: '/api/cloud-sync/sync'
} as const;

export function getCloudSyncAuthorizePath(provider: CloudSyncProvider) {
  return `/api/cloud-sync/${provider}/authorize`;
}

export function getCloudSyncCallbackPath(provider: CloudSyncProvider) {
  return `/api/cloud-sync/${provider}/callback`;
}
