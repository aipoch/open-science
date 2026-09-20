import { createHash } from 'node:crypto'

import type { ShellRuntimeBinding } from '../../shared/notebook'
import type { WslSelection } from '../../shared/wsl-setup'
import type { StoredSettings } from '../settings/types'
import { captureShellRuntimeBinding, defaultShellRuntimeBinding } from './shell-runtime'

type ConfiguredShellSettings = Pick<
  StoredSettings,
  'activatedWslSelection' | 'localShellRuntime' | 'wslSelection'
>

const wslProfileId = (distro: string, user: string): string =>
  `wsl2-${createHash('sha256').update(`${distro}\0${user}`, 'utf8').digest('hex').slice(0, 24)}`

// Resolves one immutable binding when a Session capability is provisioned. An explicit WSL choice
// without its profile is invalid rather than a reason to silently substitute the host Shell.
const resolveConfiguredShellRuntimeBinding = (
  settings: ConfiguredShellSettings,
  platform: NodeJS.Platform = process.platform
): ShellRuntimeBinding => {
  if (settings.localShellRuntime === 'powershell') {
    return captureShellRuntimeBinding({ kind: 'powershell', version: '5.1' })
  }
  if (settings.localShellRuntime === 'wsl2-bash') {
    const selection = settings.activatedWslSelection
    if (!selection) throw new Error('The activated WSL2 Shell profile is unavailable.')
    return captureShellRuntimeBinding({
      kind: 'wsl2-bash',
      profileId: wslProfileId(selection.distro, selection.user),
      distro: selection.distro,
      user: selection.user
    })
  }
  return defaultShellRuntimeBinding(platform)
}

export { resolveConfiguredShellRuntimeBinding }

export const resolveAvailableShellRuntimeBinding = async (
  settings: ConfiguredShellSettings,
  isWslReady: (selection: WslSelection) => Promise<boolean>,
  platform: NodeJS.Platform = process.platform
): Promise<ShellRuntimeBinding> => {
  if (settings.localShellRuntime === 'wsl2-bash') {
    if (platform !== 'win32') return defaultShellRuntimeBinding(platform)
    try {
      if (settings.activatedWslSelection && (await isWslReady(settings.activatedWslSelection))) {
        return resolveConfiguredShellRuntimeBinding(settings, platform)
      }
    } catch {
      // An unavailable distro must not prevent a new Session from obtaining a host Shell.
    }
    return defaultShellRuntimeBinding(platform)
  }
  return resolveConfiguredShellRuntimeBinding(settings, platform)
}
