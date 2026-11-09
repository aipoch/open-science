import { desktopShellInteraction } from '../desktop-interaction'
import { resolveConfigRoot } from '../storage-root'
import { ComputeAccounts } from './compute-accounts'

export const computeAccounts = new ComputeAccounts({
  configRoot: resolveConfigRoot,
  openExternal: (url) => desktopShellInteraction().openExternal(url)
})
