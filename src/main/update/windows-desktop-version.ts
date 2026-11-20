import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { installationFs } from './installation-filesystem'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { windowsDesktopInstallRoot } from '../../../packages/open-science/installation-startup.cjs'
import { isNewer, type UpdateStatus } from '../../shared/update'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import { load } from 'js-yaml'
import { verifyArtifactChecksum } from './installation-artifact'

const { existsSync, promises: fs } = installationFs
const stable = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const exec = promisify(execFile)
const versionDirectory = (root: string): string => join(root, 'resources', '.desktop-updates')
export function windowsDesktopShortcutTarget(executable = process.execPath): string {
  return join(windowsDesktopInstallRoot(dirname(executable)), basename(executable))
}

// NSIS normally seeds installer.exe during installation. The side-by-side path never runs
// that section. Publish the SDK's verified pending file as the basis for the next WEX/blockmap.
export async function promoteWindowsInstallerBasis(cache: string, expected: string): Promise<void> {
  const pending = join(cache, 'pending')
  const info = JSON.parse(await fs.readFile(join(pending, 'update-info.json'), 'utf8'))
  if (
    info.sha512 !== expected ||
    typeof info.fileName !== 'string' ||
    !/^[^\\/:]+\.exe$/i.test(info.fileName)
  )
    throw new Error('Cached installer does not match the active release')
  const source = join(pending, info.fileName)
  const temporary = join(cache, 'basis-' + randomUUID() + '.tmp')
  try {
    try {
      await fs.link(source, temporary)
    } catch (error) {
      if (
        !['ENOTSUP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(
          (error as NodeJS.ErrnoException).code ?? ''
        )
      )
        throw error
      await fs.copyFile(source, temporary, installationFs.constants.COPYFILE_EXCL)
    }
    await verifyArtifactChecksum(temporary, expected)
    // The provider already published its matching blockmap, or cleared it on the WEX path.
    await fs.rename(temporary, join(cache, 'installer.exe'))
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function promoteActiveBasis(root: string, version: string): Promise<void> {
  const config = load(await fs.readFile(join(root, 'resources', 'app-update.yml'), 'utf8')) as {
    updaterCacheDirName?: string
  }
  if (
    !process.env.LOCALAPPDATA ||
    !config?.updaterCacheDirName ||
    !/^[\w-]+$/.test(config.updaterCacheDirName)
  )
    return
  const expected = await fs.readFile(
    join(versionDirectory(root), version, 'prepared.sha512'),
    'utf8'
  )
  await promoteWindowsInstallerBasis(
    join(process.env.LOCALAPPDATA, config.updaterCacheDirName),
    expected
  )
}

// Keep a deny-write/delete handle from verification through extraction. SDK cache hits can
// outlive the process that verified them. Never pass a stage flag to a legacy installer.
const extract = String.raw`
$ErrorActionPreference = 'Stop'
$file = $env:OPEN_SCIENCE_UPDATE_FILE
$lock = [IO.File]::Open($file, 'Open', 'Read', 'Read')
try {
  $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($file)
  if ($info.PrivateBuild -notmatch '^Open-Science stage-v1 ([1-9][0-9]*)$' -or $info.ProductVersion -ne $env:OPEN_SCIENCE_UPDATE_VERSION) { throw 'Unsupported installer' }
  $unpacked = [int64]$Matches[1] * 1024
  $target = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:OPEN_SCIENCE_UPDATE_STAGING))
  $temp = [IO.DriveInfo]::new([IO.Path]::GetPathRoot([IO.Path]::GetTempPath()))
  if ($target.AvailableFreeSpace -lt ($unpacked + $(if ($target.Name -eq $temp.Name) { $lock.Length } else { 0 })) -or $temp.AvailableFreeSpace -lt $lock.Length) { throw 'Insufficient staging space' }
  $hash = [Security.Cryptography.SHA512]::Create()
  try { if ([Convert]::ToBase64String($hash.ComputeHash($lock)) -cne $env:OPEN_SCIENCE_UPDATE_SHA512) { throw 'Installer checksum changed' } } finally { $hash.Dispose() }
  $env:PSModulePath = Join-Path $PSHOME 'Modules'
  Import-Module Microsoft.PowerShell.Security
  $source = Get-AuthenticodeSignature -LiteralPath $env:OPEN_SCIENCE_UPDATE_SOURCE
  $candidate = Get-AuthenticodeSignature -LiteralPath $file
  if ($source.Status -ne 'Valid' -or $candidate.Status -ne 'Valid' -or $candidate.SignerCertificate.Subject -ne $source.SignerCertificate.Subject) { throw 'Installer publisher mismatch' }
  $process = Start-Process -FilePath $file -ArgumentList '--open-science-stage' -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Extraction failed ($($process.ExitCode))" }
} finally { $lock.Dispose() }
`

export async function stageWindowsDesktopVersion(status: UpdateStatus): Promise<void> {
  const { latest, localPath, artifactSha512 } = status
  if (
    !latest ||
    !stable.test(latest) ||
    !isNewer(latest, status.current) ||
    !localPath ||
    !artifactSha512
  )
    return
  const root = windowsDesktopInstallRoot(dirname(process.execPath))
  const versions = versionDirectory(root)
  await fs.mkdir(versions, { recursive: true })
  if (
    (await fs.realpath(versions)).toLowerCase() !==
    join(await fs.realpath(root), 'resources', '.desktop-updates').toLowerCase()
  )
    throw new Error('Unexpected staging directory')
  const target = join(versions, latest)
  if (existsSync(join(target, 'prepared.sha512'))) return
  const staging = join(versions, 'prepare-' + randomUUID())
  await fs.mkdir(staging)
  try {
    await exec(
      resolveWindowsPowerShellExecutable(),
      ['-NoProfile', '-NonInteractive', '-Command', extract],
      {
        windowsHide: true,
        env: {
          ...process.env,
          OPEN_SCIENCE_UPDATE_FILE: localPath,
          OPEN_SCIENCE_UPDATE_SHA512: artifactSha512,
          OPEN_SCIENCE_UPDATE_STAGING: staging,
          OPEN_SCIENCE_UPDATE_SOURCE: process.execPath,
          OPEN_SCIENCE_UPDATE_VERSION: latest
        }
      }
    )
    const payload = join(staging, 'payload')
    const executable = join(payload, basename(process.execPath))
    if (
      !(await fs.stat(executable)).isFile() ||
      !(await fs.stat(join(payload, 'resources', 'app.asar'))).isFile()
    )
      throw new Error('Incomplete staged desktop')
    await fs.writeFile(join(payload, 'prepared.sha512'), artifactSha512, {
      flag: 'wx',
      flush: true
    })
    // Same volume. An interrupted extraction is never visible as a published version.
    await fs.rename(payload, target)
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

export async function selectWindowsDesktopVersion(options: {
  executable: string
  current: string
  mayActivate(): Promise<boolean>
  checkOccupancy(): Promise<void>
}): Promise<string | undefined> {
  const { current, executable } = options
  const root = windowsDesktopInstallRoot(dirname(executable))
  const versions = versionDirectory(root)
  if (!existsSync(versions)) return
  if (
    (await fs.realpath(versions)).toLowerCase() !==
    versionDirectory(await fs.realpath(root)).toLowerCase()
  )
    return undefined
  const activeFile = join(versions, 'active.json')
  const readActive = async (): Promise<string | undefined> => {
    if (!existsSync(activeFile)) return undefined
    const value: unknown = JSON.parse(await fs.readFile(activeFile, 'utf8'))
    if (typeof value !== 'string' || !stable.test(value))
      throw new Error('Invalid active desktop version')
    return value
  }
  let active = await readActive()
  const candidates = (await fs.readdir(versions, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() && stable.test(entry.name) && isNewer(entry.name, active ?? current)
    )
    .map((entry) => entry.name)
    .sort((a, b) => (isNewer(a, b) ? -1 : 1))
  const next = candidates.find(
    (version) =>
      existsSync(join(versions, version, 'prepared.sha512')) &&
      existsSync(join(versions, version, basename(executable))) &&
      existsSync(join(versions, version, 'resources', 'app.asar'))
  )
  if (next && (await options.mayActivate())) {
    try {
      await options.checkOccupancy()
      active = await readActive()
      if (!active || isNewer(next, active)) {
        await writeDurableJsonFile(activeFile, JSON.stringify(next))
        active = next
        // A user may clear the download cache after staging. The complete local program still
        // launches, and the SDK can fall back to a full download on a subsequent update.
        await promoteActiveBasis(root, next).catch(() => undefined)
      }
    } catch {
      // Another profile, running service or file holder keeps its current program files.
      active = await readActive()
    }
  }
  if (active && active !== current) return join(versions, active, basename(executable))
  return undefined
}
