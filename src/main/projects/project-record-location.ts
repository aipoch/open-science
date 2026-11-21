import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { ApplicationCommandError } from '../../shared/application-command-contract'
import {
  detectProjectFolderPathWarnings,
  detectProjectFolderWarnings,
  type ProjectFolderLocationProbe
} from './project-folder-location'

const exec = promisify(execFile)

// Unlike the legacy advisory probe this policy requires positive volume evidence. Optional cloud
// provider metadata remains best effort: arbitrary, unregistered sync roots are not discoverable.
export async function assertProjectRecordLocation(
  path: string,
  probe: ProjectFolderLocationProbe = {}
): Promise<void> {
  const platform = probe.platform ?? process.platform
  const paths = platform === 'win32' ? win32 : posix
  const read = probe.readText ?? ((file: string) => readFile(file, 'utf8'))
  const canonicalize = probe.canonicalize ?? realpath
  const run =
    probe.run ??
    (async (command: string, args: string[], timeout = 2500) =>
      (await exec(command, args, { timeout, maxBuffer: 512 * 1024, windowsHide: true })).stdout)
  let reason = 'unknown'
  try {
    const canonical = await canonicalize(path)
    // The Windows policy queries the containing volume itself. The advisory drive-letter probe
    // would run another PowerShell storage query and could inspect a different mounted volume.
    const warnings = await (platform === 'win32'
      ? detectProjectFolderPathWarnings(canonical, probe)
      : detectProjectFolderWarnings(canonical, probe))
    if (warnings.length) reason = warnings[0]
    else if (platform === 'darwin') {
      // diskutil accepts a volume mount point, not an arbitrary directory.
      const mounts = (await run('/sbin/mount', []))
        .split('\n')
        .flatMap((line) => {
          const match = /^.+ on (.+) \(([^, )]+)(?:,.*)?\)$/.exec(line)
          const point = match?.[1]?.replace(/\\([0-7]{3})/g, (_, digits: string) =>
            String.fromCharCode(Number.parseInt(digits, 8))
          )
          const rel = point ? posix.relative(point, canonical) : '..'
          return point && rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel)
            ? [point]
            : []
        })
        .sort((a, b) => b.length - a.length)
      if (!mounts[0]) throw new Error('No containing volume')
      const metadata = await run('/usr/sbin/diskutil', ['info', '-plist', mounts[0]])
      const flag = (key: string, value: boolean): boolean =>
        new RegExp(`<key>${key}</key>\\s*<${value}\\s*/>`).test(metadata)
      if (flag('Internal', false) || flag('Ejectable', true) || flag('RemovableMedia', true))
        reason = 'removable'
      else if (flag('Internal', true) && flag('Ejectable', false) && flag('RemovableMedia', false))
        return
    } else if (platform === 'win32') {
      const literal = canonical.replaceAll("'", "''")
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        `$root = [System.IO.Path]::GetPathRoot('${literal}')`,
        'if ([System.IO.DriveInfo]::new($root).DriveType -eq [System.IO.DriveType]::Network) { @{ driveType = "Network" } | ConvertTo-Json -Compress; return }',
        `$volume = Get-Volume -FilePath '${literal}' -ErrorAction Stop`,
        '$disk = $volume | Get-Partition -ErrorAction Stop | Get-Disk -ErrorAction Stop',
        '[ordered]@{ driveType = $volume.DriveType.ToString(); bus = $disk.BusType.ToString() } | ConvertTo-Json -Compress'
      ].join('; ')
      const metadata = JSON.parse(
        await run(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64')
          ],
          // This includes PowerShell startup and the first load of the Windows Storage module.
          10_000
        )
      )
      if (metadata.driveType === 'Network') reason = 'network'
      else if (
        metadata.driveType === 'Removable' ||
        ['USB', 'SD', 'MMC', '1394'].includes(metadata.bus)
      )
        reason = 'removable'
      else if (metadata.driveType === 'Fixed' && ['ATA', 'SATA', 'NVMe'].includes(metadata.bus))
        return
    } else if (platform === 'linux') {
      const mounts = (await read('/proc/self/mountinfo'))
        .split('\n')
        .flatMap((line) => {
          const [before, after] = line.split(' - ')
          const fields = before.split(' ')
          const point = fields[4]?.replace(/\\([0-7]{3})/g, (_, digits: string) =>
            String.fromCharCode(Number.parseInt(digits, 8))
          )
          const rel = point ? paths.relative(point, canonical) : '..'
          return point && rel !== '..' && !rel.startsWith('../') && !paths.isAbsolute(rel)
            ? [{ point, device: fields[2], filesystem: after?.split(' ')[0] }]
            : []
        })
        .sort((a, b) => b.point.length - a.point.length)
      const mount = mounts[0]
      // WSL/containers, FUSE, virtual devices and unmapped block devices are unknown. They do not
      // prove a physical internal disk, even when their filesystem claims local semantics.
      if (mount && ['ext4', 'ext3', 'xfs', 'btrfs', 'f2fs'].includes(mount.filesystem ?? '')) {
        const device = await canonicalize(`/sys/dev/block/${mount.device}`)
        if (/\/(?:usb\d*|thunderbolt\d*)(?:\/|$)/.test(device)) reason = 'removable'
        else if (/\/(?:ata\d+|nvme)(?:\/|$)/.test(device)) {
          for (
            let current = device;
            current.startsWith('/sys/');
            current = posix.dirname(current)
          ) {
            const removable = await read(posix.join(current, 'removable')).catch(() => '')
            if (removable.trim() === '1') {
              reason = 'removable'
              break
            }
            if (removable.trim() === '0') return
          }
        }
      }
    }
  } catch {
    // Missing or malformed OS metadata cannot establish eligibility.
  }
  throw new ApplicationCommandError(
    'project-folder-unavailable',
    `Project research records require an ordinary folder on an internal disk. Location classification: ${reason}. Folder: ${path}`
  )
}
