import { UpdateLifecycleError } from '../../shared/update'
export type InstallationChannel = 'mac-zip' | 'windows-nsis' | 'linux-appimage' | 'linux-deb'
export type ChannelAcceptance = Readonly<{
  evidence: string
  platform: NodeJS.Platform
  architecture: string
}>
// Only reviewed native installed-package acceptance can add an entry. Artifact verification,
// source tests and simulated process supervision are deliberately not acceptance evidence.
const productionAcceptance: Readonly<Partial<Record<InstallationChannel, ChannelAcceptance>>> = {}
export function assertInstallationChannelCertified(
  channel: InstallationChannel,
  acceptance: Readonly<
    Partial<Record<InstallationChannel, ChannelAcceptance>>
  > = productionAcceptance
): void {
  const evidence = acceptance[channel]
  if (
    evidence?.evidence &&
    evidence.platform === process.platform &&
    evidence.architecture === process.arch
  )
    return
  throw new UpdateLifecycleError(
    'installation-busy',
    'Automatic installation for this channel has not passed installed-package acceptance. Keep the current service running; the downloaded package remains available. This action cannot safely replace the installation yet.',
    {
      phase: 'preparing',
      runtime: 'running',
      installation: 'unchanged',
      detail: 'unsupported-channel',
      canCancel: true,
      canRecover: false,
      canRetryInstall: false
    }
  )
}

export function installationChannelFor(
  platform: NodeJS.Platform,
  localPath: string
): InstallationChannel | undefined {
  if (platform === 'darwin') return 'mac-zip'
  if (platform === 'win32') return 'windows-nsis'
  if (platform === 'linux') return localPath.endsWith('.AppImage') ? 'linux-appimage' : 'linux-deb'
  return undefined
}

// Non-throwing routing decision: only a certified channel may use the supervised replacement.
// Windows stays on the legacy NSIS handoff until its supervised completion receipt lands.
export function usesSupervisedInstall(
  platform: NodeJS.Platform,
  localPath: string,
  acceptance: Readonly<
    Partial<Record<InstallationChannel, ChannelAcceptance>>
  > = productionAcceptance
): boolean {
  const channel = installationChannelFor(platform, localPath)
  if (!channel || platform === 'win32') return false
  try {
    assertInstallationChannelCertified(channel, acceptance)
    return true
  } catch {
    return false
  }
}
