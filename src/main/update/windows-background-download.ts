import { execFile } from 'node:child_process'
import { profileDownloadPreference } from './download-preference'
import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import type { DownloadPreference } from './strategy'
import { stageWindowsDesktopVersion } from './windows-desktop-version'

const execFileAsync = promisify(execFile)

export function windowsDownloadPreference(profile: string): DownloadPreference {
  return Object.assign(profileDownloadPreference(profile), {
    stageForNextLaunch: stageWindowsDesktopVersion
  })
}

// Use the OS Internet profile and NSIS registration. Interface type (including Wi-Fi) alone
// does not establish the cost, and a portable copy must not inherit a registered install's policy.
const installationProbe = [
  "$key = 'Software\\a65c5229-0b29-5716-a0fe-d8755e62f3ca'",
  '$user = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key)',
  '$machine = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($key)',
  "if ($user -and !$machine -and $user.GetValue('InstallLocation') -eq $env:OPEN_SCIENCE_UPDATE_INSTALL_DIR) { 'eligible' }"
].join('\n')

const networkProbe = [
  '$profileInfo = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType=WindowsRuntime]::GetInternetConnectionProfile()',
  'if (!$profileInfo) { return }',
  '$cost = $profileInfo.GetConnectionCost()',
  "if ($cost.NetworkCostType -eq 'Unrestricted' -and !$cost.Roaming -and !$cost.OverDataLimit -and !$cost.ApproachingDataLimit -and !$cost.BackgroundDataUsageRestricted) { 'eligible' }"
].join('\n')

async function runProbe(script: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      resolveWindowsPowerShellExecutable(),
      ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'\n" + script],
      {
        env: { ...process.env, OPEN_SCIENCE_UPDATE_INSTALL_DIR: dirname(process.execPath) },
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 4096
      }
    )
    return stdout.trim() === 'eligible'
  } catch {
    return false
  }
}

export async function loadWindowsDownloadPreference(
  profile: string
): Promise<DownloadPreference | undefined> {
  // The NSIS staging protocol and its signed upgrade smoke currently ship for APP_64 only.
  if (process.arch !== 'x64') return undefined
  return (await runProbe(installationProbe)) ? windowsDownloadPreference(profile) : undefined
}

export async function canDownloadWindowsUpdate(
  bytes: number,
  cacheDirectory: string
): Promise<boolean> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return false
  try {
    const space = await statfs(cacheDirectory, { bigint: true })
    // The provider can hold both temporary and completed installers during publication.
    if (space.bavail * space.bsize < BigInt(bytes) * 2n) return false
    return runProbe(networkProbe)
  } catch {
    return false
  }
}
