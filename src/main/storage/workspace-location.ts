import { isAbsolute, relative, resolve, sep } from 'node:path'

import { MANAGED_WORKSPACE_OWNERSHIP_DIR } from './managed-workspace-ownership-dir'

declare const managedWorkspace: unique symbol
declare const projectFolder: unique symbol

// Only the managed-storage owner may mint this capability. ProjectFolderPath deliberately has a
// different brand: user-owned directories cannot be handed to a destructive managed-storage API.
export type ManagedWorkspacePath = string & { readonly [managedWorkspace]: true }
export type ProjectFolderPath = string & { readonly [projectFolder]: true }

export function locateManagedWorkspacePath(
  path: string,
  dataRoot: string
): ManagedWorkspacePath | undefined {
  if (!isAbsolute(path)) return undefined
  const directory = resolve(path)
  const workspaceId = relative(resolve(dataRoot, 'workspaces'), directory)
  if (
    !workspaceId ||
    workspaceId.toLowerCase() === MANAGED_WORKSPACE_OWNERSHIP_DIR.toLowerCase() ||
    workspaceId === '..' ||
    workspaceId.startsWith(`..${sep}`) ||
    isAbsolute(workspaceId) ||
    workspaceId.includes(sep)
  )
    return undefined
  return directory as ManagedWorkspacePath
}
