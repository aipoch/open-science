import { execFile } from 'node:child_process'

export type WindowsVolumeProbeResult =
  | Readonly<{ kind: 'local-ntfs' }>
  | Readonly<{ kind: 'not-local' }>
  | Readonly<{ kind: 'not-ntfs'; fileSystem: string }>
  | Readonly<{ kind: 'unavailable' }>

type WindowsVolumeCommandResult = Readonly<{
  stdout: string
  stderr: string
  exitCode: number
}>

export interface WindowsVolumeCommand {
  run(encodedCommand: string): Promise<WindowsVolumeCommandResult>
}

const powershell: WindowsVolumeCommand = {
  run: (encodedCommand) =>
    new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        { windowsHide: true, timeout: 10_000 },
        (error, stdout, stderr) => {
          resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: error ? 1 : 0 })
        }
      )
    })
}

const encodedDriveInfoCommand = (path: string): string => {
  const literal = path.replaceAll("'", "''")
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `$root = [System.IO.Path]::GetPathRoot('${literal}')`,
    '$drive = [System.IO.DriveInfo]::new($root)',
    '[ordered]@{ driveType = [int]$drive.DriveType; fileSystem = $drive.DriveFormat; isReady = $drive.IsReady } | ConvertTo-Json -Compress'
  ].join('; ')
  return Buffer.from(script, 'utf16le').toString('base64')
}

export const probeWindowsVolume = async (
  path: string,
  command: WindowsVolumeCommand = powershell
): Promise<WindowsVolumeProbeResult> => {
  const result = await command.run(encodedDriveInfoCommand(path))
  if (result.exitCode !== 0) return { kind: 'unavailable' }
  try {
    const value = JSON.parse(result.stdout) as Record<string, unknown>
    if (value.isReady !== true || typeof value.driveType !== 'number') {
      return { kind: 'unavailable' }
    }
    // DriveType.Fixed is 3. Network (4), removable media, and all other volume kinds fail closed.
    if (value.driveType !== 3) return { kind: 'not-local' }
    if (typeof value.fileSystem !== 'string') return { kind: 'unavailable' }
    if (value.fileSystem.toUpperCase() !== 'NTFS') {
      return { kind: 'not-ntfs', fileSystem: value.fileSystem }
    }
    return { kind: 'local-ntfs' }
  } catch {
    return { kind: 'unavailable' }
  }
}
