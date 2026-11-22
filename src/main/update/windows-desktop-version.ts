import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { basename, dirname, join } from 'node:path'
import { installationFs } from './installation-filesystem'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { windowsProcessStartTicks } from '../windows-process-query'
import { isNewer, UpdateLifecycleError, type UpdateStatus } from '../../shared/update'
import { createLogger } from '@aipoch/diagnostics/node'
import { load } from 'js-yaml'

const { existsSync, promises: fs } = installationFs
const stable = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const exec = promisify(execFile)
const preparedName = 'open-science-prepared'
const log = createLogger('windows-prepared-update')
type Prepared = { version: string; sha512: string; executable: string; fileName: string }

// Keep published payloads outside the SDK's replaceable pending/ tree. A short cache key
// leaves room for nested Windows paths; the receipt still verifies the full SHA-512.
export function preparedWindowsUpdateId(executable: string, sha512: string): string {
  return createHash('sha256')
    .update(executable.toLowerCase())
    .update('\0')
    .update(sha512)
    .digest('hex')
    .slice(0, 32)
}

function preparedRoot(pending: string): string {
  return join(dirname(pending), preparedName)
}

function sameExecutable(recorded: unknown, executable: string): boolean {
  if (recorded === executable) return true
  if (typeof recorded !== 'string' || !recorded) return false
  // Shell links can use a short path or different casing for the same installed executable.
  try {
    return recorded === installationFs.realpathSync.native(executable)
  } catch {
    return false
  }
}

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

function verifiedScript(body: string): string {
  return verify + '\ntry {\n' + body + '\n} finally { $lock.Dispose() }'
}

function powershellArguments(script: string): string[] {
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
  const receipt = {
    version: latest,
    sha512: artifactSha512,
    fileName: basename(localPath),
    executable: installationFs.realpathSync.native(process.execPath)
  }
  const root = preparedRoot(pending)
  const destination = join(root, preparedWindowsUpdateId(receipt.executable, artifactSha512))
  if (existsSync(destination)) return
  await fs.mkdir(root, { recursive: true })
  const stage = await fs.mkdtemp(join(pending, 'prepare-'))
  try {
    await exec(resolveWindowsPowerShellExecutable(), powershellArguments(verifiedScript(extract)), {
      windowsHide: true,
      env: { ...installerEnv(pending, receipt), OPEN_SCIENCE_UPDATE_STAGING: stage }
    })
    await fs.writeFile(join(stage, 'ready.json'), JSON.stringify(receipt), {
      flag: 'wx',
      flush: true
    })
    // Concurrent preparation of identical signed bytes can share the first published result.
    try {
      await fs.rename(stage, destination)
    } catch (error) {
      if (!existsSync(destination)) throw error
    }
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}

export async function readPreparedWindowsUpdate(
  pending: string,
  executable: string,
  current: string
): Promise<Prepared | undefined> {
  const infoFile = join(pending, 'update-info.json')
  if (!existsSync(infoFile)) return
  const info = JSON.parse(await fs.readFile(infoFile, 'utf8'))
  if (typeof info.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(info.sha512)) return
  const canonical = installationFs.realpathSync.native(executable)
  const marker = join(
    preparedRoot(pending),
    preparedWindowsUpdateId(canonical, info.sha512),
    'ready.json'
  )
  if (!existsSync(marker)) return
  const receipt: Prepared = JSON.parse(await fs.readFile(marker, 'utf8'))
  if (
    !sameExecutable(receipt.executable, executable) ||
    typeof receipt.version !== 'string' ||
    !stable.test(receipt.version) ||
    !isNewer(receipt.version, current) ||
    typeof receipt.fileName !== 'string' ||
    !/^[^\\/:]+\.exe$/i.test(receipt.fileName) ||
    receipt.fileName !== info.fileName ||
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
$stage = [IO.Path]::GetDirectoryName($env:OPEN_SCIENCE_UPDATE_ACK)
[IO.File]::Move((Join-Path $stage 'ready.json'), (Join-Path $stage 'installing.json'))
[IO.File]::WriteAllText($env:OPEN_SCIENCE_UPDATE_ACK, '')
if (!$parent.WaitForExit(30000)) { throw 'Desktop did not exit' }
try {
  $setup = Start-Process -FilePath $file -ArgumentList '/S --updated /currentuser' -Wait -PassThru
} finally {
  Remove-Item Env:\OPEN_SCIENCE_PREPARED_ID -ErrorAction SilentlyContinue
  $next = [Diagnostics.ProcessStartInfo]::new($env:OPEN_SCIENCE_UPDATE_SOURCE, $env:OPEN_SCIENCE_UPDATE_ARGUMENTS)
  $next.UseShellExecute = $false
  $next.WorkingDirectory = $env:OPEN_SCIENCE_UPDATE_LAUNCH_CWD
  $null = [Diagnostics.Process]::Start($next)
}
`

export function startWindowsUpdateSupervisor(
  script: string,
  stage: string,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  const root = env.SystemRoot || env.WINDIR
  if (!root) throw new Error('Windows system directory unavailable')
  // PowerShell 5.1 can exit 0 without evaluating a command when started directly with
  // DETACHED_PROCESS. Detach the command processor and let it host the hidden PowerShell.
  // Only the fixed switches and base64-encoded script enter cmd. All launch data stays in env.
  const command =
    '""%OPEN_SCIENCE_UPDATE_POWERSHELL%" ' + powershellArguments(script).join(' ') + '"'
  const ack = join(stage, 'accepted-' + randomUUID())
  const worker = spawn(
    join(root, 'System32', 'cmd.exe'),
    ['/d', '/q', '/v:off', '/s', '/c', command],
    {
      // Avoid pinning the payload directory while the successor reclaims it.
      cwd: dirname(stage),
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: 'ignore',
      env: {
        ...env,
        OPEN_SCIENCE_UPDATE_ACK: ack,
        OPEN_SCIENCE_UPDATE_POWERSHELL: resolveWindowsPowerShellExecutable(env)
      }
    }
  )
  return new Promise((resolve, reject) => {
    // A detached console does not reliably forward stdout. Only the claimant for this
    // launch writes this marker, after it has opened the parent and claimed the receipt.
    const timer = setInterval(() => {
      if (existsSync(ack)) {
        clearInterval(timer)
        worker.unref()
        resolve(true)
      }
    }, 50)
    worker.once('error', (error) => {
      clearInterval(timer)
      reject(error)
    })
    worker.once('exit', (code) => {
      clearInterval(timer)
      const accepted = existsSync(ack)
      if (!accepted) log.warn('Installer supervisor declined the handoff', { code })
      resolve(accepted)
    })
  })
}

function launchInstaller(pending: string, receipt: Prepared, stage: string): Promise<boolean> {
  // CommandLineToArgvW quoting. No user arguments are evaluated as shell source.
  const args = process.argv
    .slice(1)
    .map((arg) => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"')
    .join(' ')
  return startWindowsUpdateSupervisor(verifiedScript(install), stage, {
    ...installerEnv(pending, receipt),
    OPEN_SCIENCE_PREPARED_ID: basename(stage),
    OPEN_SCIENCE_UPDATE_PARENT: String(process.pid),
    OPEN_SCIENCE_UPDATE_LAUNCH_CWD: process.cwd(),
    OPEN_SCIENCE_UPDATE_ARGUMENTS: args
  })
}

export async function reclaimInstalledWindowsUpdates(
  pending: string,
  executable: string,
  current: string
): Promise<void> {
  const root = preparedRoot(pending)
  if (!existsSync(root) || !(await fs.lstat(root)).isDirectory()) return
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue
    const stage = join(root, entry.name)
    try {
      const marker = ['installing.json', 'scan-timed-out.json', 'ready.json']
        .map((name) => join(stage, name))
        .find(existsSync)
      if (!marker) continue
      const receipt: Prepared = JSON.parse(await fs.readFile(marker, 'utf8'))
      if (
        sameExecutable(receipt.executable, executable) &&
        preparedWindowsUpdateId(receipt.executable, receipt.sha512) === entry.name &&
        stable.test(receipt.version) &&
        !isNewer(receipt.version, current)
      )
        await fs.rm(stage, { recursive: true, force: true })
    } catch (error) {
      log.warn('Could not reclaim prepared update', { error: String(error) })
    }
  }
}

const coldLaunchScanBudgetMs = 10_000
const blockerCacheMs = 60_000

/** A cached blocker can only defer installation. Its exit or PID reuse always requires a fresh scan. */
export async function checkColdLaunchOccupancy(
  stage: string,
  check: (signal: AbortSignal) => Promise<void>
): Promise<boolean> {
  for (const name of await fs.readdir(stage)) {
    const match = /^occupant-(\d+)-(\d+)$/.exec(name)
    if (!match) continue
    const marker = join(stage, name)
    // A long-lived process can close its file while keeping the same PID and creation time.
    const info = await fs.lstat(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!info) continue
    const ageMs = Date.now() - Math.floor(info.mtimeMs)
    if (
      ageMs >= 0 &&
      ageMs < blockerCacheMs &&
      windowsProcessStartTicks(Number(match[1])) === match[2]
    )
      return false
    await fs.rm(marker, { force: true })
  }

  const controller = new AbortController()
  const timeout = Promise.withResolvers<never>()
  const deadline = performance.now() + coldLaunchScanBudgetMs
  // GetProcessTimes is exposed by windowsProcessStartTicks in .NET ticks since year 1.
  const ticksAtScanStart = (BigInt(Date.now()) + 62_135_596_800_000n) * 10_000n
  const timer = setTimeout(() => {
    controller.abort()
    timeout.reject(controller.signal.reason)
  }, coldLaunchScanBudgetMs)
  try {
    // Only race the read-only inspection. A worker settling after cancellation cannot hand off
    // to NSIS or hold the normal launch open while its process tree is reaped.
    await Promise.race([check(controller.signal), timeout.promise])
    if (!controller.signal.aborted && performance.now() < deadline) return true
  } catch (error) {
    if (!controller.signal.aborted && performance.now() < deadline) {
      if (error instanceof UpdateLifecycleError && error.reason === 'installation-busy') {
        for (const { pid } of error.recovery?.blockingProcesses ?? []) {
          const ticks = windowsProcessStartTicks(pid)
          // A PID reassigned since the snapshot must not pin an unrelated process to this package.
          if (ticks && BigInt(ticks) <= ticksAtScanStart)
            await fs.writeFile(join(stage, `occupant-${pid}-${ticks}`), '')
        }
      }
      throw error
    }
  } finally {
    clearTimeout(timer)
  }
  await fs.rename(join(stage, 'ready.json'), join(stage, 'scan-timed-out.json'))
  log.info('Cold-launch occupancy scan timed out; manual update remains available')
  return false
}

export async function applyPreparedWindowsUpdate(options: {
  current: string
  enabled(): Promise<boolean>
  checkOccupancy(signal: AbortSignal): Promise<void>
}): Promise<boolean> {
  try {
    const pending = await pendingDirectory()
    if (!pending) return false
    await reclaimInstalledWindowsUpdates(pending, process.execPath, options.current)
    const receipt = await readPreparedWindowsUpdate(pending, process.execPath, options.current)
    if (!receipt) return false
    if (!(await options.enabled())) {
      log.info('Automatic installation is disabled or unavailable', { version: receipt.version })
      return false
    }
    const stage = join(
      preparedRoot(pending),
      preparedWindowsUpdateId(receipt.executable, receipt.sha512)
    )
    if (!(await checkColdLaunchOccupancy(stage, options.checkOccupancy))) return false
    return await launchInstaller(pending, receipt, stage)
  } catch (error) {
    log.warn(
      'Prepared update deferred at startup',
      error instanceof UpdateLifecycleError
        ? {
            reason: error.reason,
            detail: error.recovery?.detail,
            blockers: error.recovery?.blockingProcesses
          }
        : { error: error instanceof Error ? error.message : 'Unknown error' }
    )
    return false
  }
}
