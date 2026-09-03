import type { StorageUsage } from '../../shared/storage'
import { readManagedWorkspaceOwnership } from './managed-workspace-ownership'
import { computeStorageUsage } from './usage'

// Settings-side storage usage enriched with managed-workspace ownership. Lives outside usage.ts so
// the artifact MCP server's plain-Node bundle can keep importing usage.ts without pulling the
// electron-dependent ownership chain into it.
export const computeStorageUsageWithOwnership = async (dataRoot: string): Promise<StorageUsage> =>
  computeStorageUsage(dataRoot, readManagedWorkspaceOwnership)
