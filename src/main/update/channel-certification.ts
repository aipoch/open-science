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
