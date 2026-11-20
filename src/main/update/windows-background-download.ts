import { execFile } from 'node:child_process'
import { lstatSync, unlinkSync, writeFileSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import type { DownloadPreference } from './strategy'
import { stageWindowsDesktopVersion } from './windows-desktop-version'
import { windowsDesktopInstallRoot } from '../../../packages/open-science/installation-startup.cjs'

const execFileAsync = promisify(execFile)

// A missing opt-out marker is the same default for existing and freshly created profiles.
// Failure to read the profile never authorizes a background transfer.
export function windowsDownloadPreference(profile: string): DownloadPreference {
  const marker = join(profile, 'disable-background-update-downloads')
  let enabled = false
  try {
    lstatSync(marker)
  } catch (error) {
    enabled = (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  return {
    stageForNextLaunch: stageWindowsDesktopVersion,
    get enabled() {
      return enabled
    },
    setEnabled(next: boolean) {
      if (enabled === next) return
      if (next) {
        try {
          unlinkSync(marker)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      } else {
        writeFileSync(marker, '', { flag: 'wx' })
      }
      enabled = next
    }
  }
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
        env: {
          ...process.env,
          OPEN_SCIENCE_UPDATE_INSTALL_DIR: windowsDesktopInstallRoot(dirname(process.execPath))
        },
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
