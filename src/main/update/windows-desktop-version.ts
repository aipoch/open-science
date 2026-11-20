import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join } from 'node:path'
import { installationFs } from './installation-filesystem'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { isNewer, type UpdateStatus } from '../../shared/update'
import { load } from 'js-yaml'

const { existsSync, promises: fs } = installationFs
const stable = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const exec = promisify(execFile)
const preparedName = 'open-science-prepared'
type Prepared = { version: string; sha512: string; executable: string; fileName: string }

async function pendingDirectory(): Promise<string | undefined> {
  if (!process.env.LOCALAPPDATA) return
  const config = load(await fs.readFile(join(process.resourcesPath, 'app-update.yml'), 'utf8')) as {
    updaterCacheDirName?: string
  }
  if (config?.updaterCacheDirName && /^[\w-]+$/.test(config.updaterCacheDirName))
    return join(process.env.LOCALAPPDATA, config.updaterCacheDirName, 'pending')
  return undefined
}

// Keep a deny-write/delete handle from verification through the installer launch. In particular,
// an offline startup may consume a file cached by a different desktop process.
const verify = String.raw`
$ErrorActionPreference = 'Stop'
$file = $env:OPEN_SCIENCE_UPDATE_FILE
$lock = [IO.File]::Open($file, 'Open', 'Read', 'Read')
$info = [Diagnostics.FileVersionInfo]::GetVersionInfo($file)
if ($info.PrivateBuild -notmatch '^Open-Science stage-v1 ([1-9][0-9]*)$' -or $info.ProductVersion -ne $env:OPEN_SCIENCE_UPDATE_VERSION) { throw 'Unsupported installer' }
$unpacked = [int64]$Matches[1] * 1024
$hash = [Security.Cryptography.SHA512]::Create()
try { if ([Convert]::ToBase64String($hash.ComputeHash($lock)) -cne $env:OPEN_SCIENCE_UPDATE_SHA512) { throw 'Installer checksum changed' } } finally { $hash.Dispose() }
$env:PSModulePath = Join-Path $PSHOME 'Modules'
Import-Module Microsoft.PowerShell.Security
$source = Get-AuthenticodeSignature -LiteralPath $env:OPEN_SCIENCE_UPDATE_SOURCE
$candidate = Get-AuthenticodeSignature -LiteralPath $file
if ($source.Status -ne 'Valid' -or $candidate.Status -ne 'Valid' -or $candidate.SignerCertificate.Subject -ne $source.SignerCertificate.Subject) { throw 'Installer publisher mismatch' }
`

const extract = String.raw`
$target = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:OPEN_SCIENCE_UPDATE_STAGING))
$temp = [IO.DriveInfo]::new([IO.Path]::GetPathRoot([IO.Path]::GetTempPath()))
if ($target.AvailableFreeSpace -lt ($unpacked + $(if ($target.Name -eq $temp.Name) { $lock.Length } else { 0 })) -or $temp.AvailableFreeSpace -lt $lock.Length) { throw 'Insufficient staging space' }
$p = Start-Process -FilePath $file -ArgumentList '--open-science-stage' -WindowStyle Hidden -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "Extraction failed ($($p.ExitCode))" }
`

function verifiedCommand(body: string): string[] {
  const script = verify + '\ntry {\n' + body + '\n} finally { $lock.Dispose() }'
  return [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ]
}

function installerEnv(pending: string, receipt: Prepared): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPEN_SCIENCE_UPDATE_FILE: join(pending, receipt.fileName),
    OPEN_SCIENCE_UPDATE_SOURCE: process.execPath,
    OPEN_SCIENCE_UPDATE_VERSION: receipt.version,
    OPEN_SCIENCE_UPDATE_SHA512: receipt.sha512
  }
}

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
  const pending = await pendingDirectory()
  if (!pending || dirname(localPath).toLowerCase() !== pending.toLowerCase()) return
  const prepared = await readPreparedWindowsUpdate(pending, process.execPath, status.current)
  if (prepared?.version === latest && prepared.sha512 === artifactSha512) return
  const receipt = {
    version: latest,
    sha512: artifactSha512,
    fileName: basename(localPath),
    executable: process.execPath
  }
  const stage = await fs.mkdtemp(join(pending, 'prepare-'))
  try {
    await exec(resolveWindowsPowerShellExecutable(), verifiedCommand(extract), {
      windowsHide: true,
      env: { ...installerEnv(pending, receipt), OPEN_SCIENCE_UPDATE_STAGING: stage }
    })
    await fs.writeFile(join(stage, 'ready.json'), JSON.stringify(receipt), {
      flag: 'wx',
      flush: true
    })
    // Only a complete extraction becomes visible. The SDK owns the pending cache and clears
    // older downloads, including abandoned temporary trees, when it downloads a replacement.
    await fs.rename(stage, join(pending, preparedName))
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}

export async function readPreparedWindowsUpdate(
  pending: string,
  executable: string,
  current: string
): Promise<Prepared | undefined> {
  const marker = join(pending, preparedName, 'ready.json')
  if (!existsSync(marker)) return
  const receipt: Prepared = JSON.parse(await fs.readFile(marker, 'utf8'))
  const info = JSON.parse(await fs.readFile(join(pending, 'update-info.json'), 'utf8'))
  if (
    receipt.executable !== executable ||
    typeof receipt.version !== 'string' ||
    !stable.test(receipt.version) ||
    !isNewer(receipt.version, current) ||
    typeof receipt.fileName !== 'string' ||
    !/^[^\\/:]+\.exe$/i.test(receipt.fileName) ||
    receipt.fileName !== info.fileName ||
    !/^[A-Za-z0-9+/]{86}==$/.test(receipt.sha512) ||
    receipt.sha512 !== info.sha512
  )
    return
  return receipt
}

// The installer keeps ownership of shortcut/registry publication, recovery and the next delta
// basis. Start the original executable after NSIS exits, forwarding this cold launch's exact argv.
// Claim the receipt once, so even a failed installer cannot put the user in a relaunch loop.
const install = String.raw`
$target = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:OPEN_SCIENCE_UPDATE_SOURCE))
$temp = [IO.DriveInfo]::new([IO.Path]::GetPathRoot([IO.Path]::GetTempPath()))
if ($temp.AvailableFreeSpace -lt ($unpacked + $lock.Length) -or $target.AvailableFreeSpace -lt $unpacked) { throw 'Insufficient installation space' }
$parent = [Diagnostics.Process]::GetProcessById([int]$env:OPEN_SCIENCE_UPDATE_PARENT)
$null = $parent.Handle
$stage = Join-Path ([IO.Path]::GetDirectoryName($file)) 'open-science-prepared'
[IO.File]::Move((Join-Path $stage 'ready.json'), (Join-Path $stage 'installing.json'))
[Console]::Out.WriteLine('accepted')
[Console]::Out.Flush()
if (!$parent.WaitForExit(30000)) { throw 'Desktop did not exit' }
try {
  $env:OPEN_SCIENCE_USE_STAGED_UPDATE = '1'
  $setup = Start-Process -FilePath $file -ArgumentList '/S --updated /currentuser' -Wait -PassThru
} finally {
  Remove-Item Env:\OPEN_SCIENCE_USE_STAGED_UPDATE -ErrorAction SilentlyContinue
  $next = [Diagnostics.ProcessStartInfo]::new($env:OPEN_SCIENCE_UPDATE_SOURCE, $env:OPEN_SCIENCE_UPDATE_ARGUMENTS)
  $next.UseShellExecute = $false
  $null = [Diagnostics.Process]::Start($next)
}
`

function launchInstaller(pending: string, receipt: Prepared): Promise<boolean> {
  return new Promise((resolve) => {
    // CommandLineToArgvW quoting. No user arguments are evaluated as PowerShell source.
    const args = process.argv
      .slice(1)
      .map((arg) => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"')
      .join(' ')
    const worker = spawn(resolveWindowsPowerShellExecutable(), verifiedCommand(install), {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...installerEnv(pending, receipt),
        OPEN_SCIENCE_UPDATE_PARENT: String(process.pid),
        OPEN_SCIENCE_UPDATE_ARGUMENTS: args
      }
    })
    let output = ''
    worker.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
      if (output.trim() === 'accepted') {
        worker.stdout.destroy()
        worker.unref()
        resolve(true)
      }
    })
    worker.once('error', () => resolve(false))
    worker.once('exit', () => resolve(false))
  })
}

export async function applyPreparedWindowsUpdate(options: {
  current: string
  enabled(): Promise<boolean>
  checkOccupancy(): Promise<void>
}): Promise<boolean> {
  try {
    const pending = await pendingDirectory()
    if (!pending) return false
    const stage = join(pending, preparedName)
    if (existsSync(join(stage, 'installing.json'))) {
      const previous: Prepared = JSON.parse(
        await fs.readFile(join(stage, 'installing.json'), 'utf8')
      )
      if (previous.executable === process.execPath && previous.version === options.current)
        await fs.rm(stage, { recursive: true, force: true })
      return false
    }
    const receipt = await readPreparedWindowsUpdate(pending, process.execPath, options.current)
    if (!receipt || !(await options.enabled())) return false
    await options.checkOccupancy()
    return await launchInstaller(pending, receipt)
  } catch {
    return false
  }
}
