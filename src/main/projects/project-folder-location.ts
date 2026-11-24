import { execFile } from 'node:child_process'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { projectFolderWarnings } from './project-folder-binding'

export type ProjectFolderLocationWarning = 'cloud-synced' | 'network' | 'removable'
export type ProjectFolderLocationProbe = {
  platform?: NodeJS.Platform
  home?: string
  environment?: NodeJS.ProcessEnv
  readText?: (path: string) => Promise<string>
  canonicalize?: (path: string) => Promise<string>
  run?: (command: string, args: string[], timeoutMs?: number) => Promise<string>
}
const execFileAsync = promisify(execFile)
const run = async (command: string, args: string[]): Promise<string> =>
  (await execFileAsync(command, args, { timeout: 2500, maxBuffer: 512 * 1024, windowsHide: true }))
    .stdout
const readText = async (path: string): Promise<string> => {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(512 * 1024)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}
const unescapeMountPath = (path: string): string =>
  path.replace(/\\([0-7]{3})/g, (_, digits: string) =>
    String.fromCharCode(Number.parseInt(digits, 8))
  )
const networkFilesystems = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smbfs',
  'smb3',
  'afpfs',
  'webdav',
  'fuse.sshfs'
])

function inside(paths: typeof posix, root: string, candidate: string): boolean {
  for (let current = candidate; ; current = paths.dirname(current)) {
    if (current === root) return true
    if (paths.dirname(current) === current) return false
  }
}

export async function detectProjectFolderPathWarnings(
  path: string,
  options: ProjectFolderLocationProbe = {}
): Promise<ProjectFolderLocationWarning[]> {
  const platform = options.platform ?? process.platform
  const paths = platform === 'win32' ? win32 : posix
  const environment = options.environment ?? process.env
  const home = options.home ?? homedir()
  const read = options.readText ?? readText
  const canonicalize = options.canonicalize ?? realpath
  const warnings = new Set<ProjectFolderLocationWarning>(projectFolderWarnings(path, environment))
  const withinRoot = async (root: string): Promise<boolean> => {
    try {
      return inside(paths, await canonicalize(root), path)
    } catch {
      return false
    }
  }

  const cloudRoots = [
    environment.OneDrive,
    environment.OneDriveCommercial,
    environment.OneDriveConsumer,
    ...(platform === 'darwin'
      ? [
          paths.join(home, 'Library', 'CloudStorage'),
          paths.join(home, 'Library', 'Mobile Documents')
        ]
      : [])
  ].filter((root): root is string => Boolean(root))
  const dropboxConfigs =
    platform === 'win32'
      ? [
          paths.join(
            environment.APPDATA ?? paths.join(home, 'AppData', 'Roaming'),
            'Dropbox',
            'info.json'
          ),
          paths.join(
            environment.LOCALAPPDATA ?? paths.join(home, 'AppData', 'Local'),
            'Dropbox',
            'info.json'
          )
        ]
      : [
          paths.join(home, '.dropbox', 'info.json'),
          ...(platform === 'darwin'
            ? [paths.join(home, 'Library', 'Application Support', 'Dropbox', 'info.json')]
            : [])
        ]
  for (const config of dropboxConfigs) {
    try {
      const value: unknown = JSON.parse(await read(config))
      if (!value || typeof value !== 'object') continue
      for (const account of Object.values(value).slice(0, 32)) {
        if (
          account &&
          typeof account === 'object' &&
          'path' in account &&
          typeof account.path === 'string' &&
          paths.isAbsolute(account.path)
        )
          cloudRoots.push(account.path)
      }
    } catch {
      /* Provider configuration is optional, never a binding requirement. */
    }
  }
  for (const root of cloudRoots) if (await withinRoot(root)) warnings.add('cloud-synced')
  return [...warnings]
}

// These observations never grant access or select an execution mode. Call only after the active
// mode's protection preflight succeeds; missing optional OS/provider metadata is not a rejection.
export async function detectProjectFolderWarnings(
  path: string,
  options: ProjectFolderLocationProbe = {}
): Promise<ProjectFolderLocationWarning[]> {
  const platform = options.platform ?? process.platform
  const read = options.readText ?? readText
  const canonicalize = options.canonicalize ?? realpath
  const command = options.run ?? run
  const warnings = new Set(await detectProjectFolderPathWarnings(path, options))

  try {
    if (platform === 'linux') {
      const mounts = (await read('/proc/self/mountinfo'))
        .split('\n')
        .flatMap((line) => {
          const [before, after] = line.split(' - ')
          const fields = before?.split(' ')
          const filesystem = after?.split(' ')[0]
          return fields?.[4] && filesystem
            ? [{ point: unescapeMountPath(fields[4]), device: fields[2], filesystem }]
            : []
        })
        .filter((mount) => inside(posix, mount.point, path))
        .sort((left, right) => right.point.length - left.point.length)
      const mount = mounts[0]
      if (mount && networkFilesystems.has(mount.filesystem)) warnings.add('network')
      if (mount?.device && /^\d+:\d+$/.test(mount.device)) {
        try {
          const device = await canonicalize(`/sys/dev/block/${mount.device}`)
          if (/\/usb\d+(?:\/|$)/.test(device)) warnings.add('removable')
          for (
            let current = device;
            current.startsWith('/sys/');
            current = posix.dirname(current)
          ) {
            try {
              if ((await read(posix.join(current, 'removable'))).trim() === '1') {
                warnings.add('removable')
                break
              }
            } catch {
              /* Partitions inherit the parent block device's removable flag. */
            }
            if (posix.dirname(current) === current) break
          }
        } catch {
          /* Pseudo filesystems and network mounts have no block device. */
        }
      }
    } else if (platform === 'darwin') {
      const mounts = (await command('/sbin/mount', []))
        .split('\n')
        .flatMap((line) => {
          const match = /^.+ on (.+) \(([^, )]+)(?:,.*)?\)$/.exec(line)
          return match ? [{ point: unescapeMountPath(match[1]), filesystem: match[2] }] : []
        })
        .filter((mount) => inside(posix, mount.point, path))
        .sort((left, right) => right.point.length - left.point.length)
      const mount = mounts[0]
      if (mount && networkFilesystems.has(mount.filesystem)) warnings.add('network')
      if (mount && !networkFilesystems.has(mount.filesystem)) {
        const metadata = await command('/usr/sbin/diskutil', ['info', '-plist', mount.point])
        if (
          /<key>(?:RemovableMedia|Ejectable)<\/key>\s*<true\s*\/>/.test(metadata) ||
          /<key>Internal<\/key>\s*<false\s*\/>/.test(metadata)
        )
          warnings.add('removable')
      }
    } else if (platform === 'win32') {
      const literal = path.replaceAll("'", "''")
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        `$root = [System.IO.Path]::GetPathRoot('${literal}')`,
        '$drive = [System.IO.DriveInfo]::new($root)',
        'if (!$drive.IsReady) { throw "Volume is unavailable" }',
        '$removable = $drive.DriveType -eq [System.IO.DriveType]::Removable',
        'if ($root -match "^([A-Za-z]):") { try { $disk = Get-Partition -DriveLetter $Matches[1] -ErrorAction Stop | Get-Disk -ErrorAction Stop; if ($disk.BusType.ToString() -in @("USB", "SD", "MMC", "1394")) { $removable = $true } } catch {} }',
        '[ordered]@{ driveType = [int]$drive.DriveType; removable = [bool]$removable } | ConvertTo-Json -Compress'
      ].join('; ')
      const info: unknown = JSON.parse(
        await command('powershell.exe', [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64')
        ])
      )
      if (info && typeof info === 'object') {
        if ('driveType' in info && info.driveType === 4) warnings.add('network')
        if ('removable' in info && info.removable === true) warnings.add('removable')
      }
    }
  } catch {
    /* Location hints must not override successful access and capability checks. */
  }
  return [...warnings]
}
