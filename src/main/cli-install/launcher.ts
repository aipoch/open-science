import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'

import type { CliLauncherStatus } from '../../shared/cli'
import { defaultFileDurability } from '../storage/file-durability'

const MANAGED_LAUNCHER_HEADER_V1 =
  'Open Science command-line launcher. Managed by the app. Format version: 1.'
const LEGACY_POSIX_HEADER =
  '# Open Science command-line launcher. Managed by the app (Settings -> General -> Command line'
const LEGACY_POSIX_BODIES = new Set([
  "# tool); edits will be overwritten on reinstall. Runs the app's Electron in Node mode.",
  '# tool); edits will be overwritten on reinstall. Mounts the AppImage for this CLI process.'
])
const LEGACY_WINDOWS_HEADER =
  'rem Open Science command-line launcher. Managed by the app; edits are overwritten on reinstall.'

// Everything the launcher planner needs, injected so the pure path/shim logic is testable without
// Electron or the real filesystem. The IPC wrapper fills these from `app`/`process` at call time.
export type CliLauncherEnv = {
  platform: NodeJS.Platform
  // The app's own executable. Run with ELECTRON_RUN_AS_NODE it behaves as Node; for a packaged build
  // it is also the app the CLI should spawn, so the shim pins OPEN_SCIENCE_APP_PATH to it.
  appExecPath: string
  // Absolute path to the bundled CLI entry (resources/cli/index.mjs when packaged).
  cliEntryPath: string
  // Stable path to the AppImage file. APPDIR/process paths point into an ephemeral FUSE mount.
  appImagePath?: string
  packaged: boolean
  homeDir: string
  // Per-user data dir (app.getPath('userData')); the Windows bin dir lives under it.
  userDataDir: string
  // The current PATH value, used to decide whether the bin dir is already reachable.
  pathVar: string
}

// A resolved install plan: where the shim goes, what it contains, and whether it will be callable.
export type CliLauncherPlan = {
  binDir: string
  target: string
  shim: string
  mode?: number
  onPath: boolean
}

// PATH entries are ';'-separated on Windows and ':'-separated elsewhere. Derive the separator from the
// target platform (not the host's path.delimiter) so the check is correct regardless of where it runs.
const normalizeWindowsPathEntry = (entry: string): string =>
  entry.replace(/[\\/]+$/, '').toLowerCase()

const isOnPath = (binDir: string, pathVar: string, platform: NodeJS.Platform): boolean => {
  const separator = platform === 'win32' ? ';' : ':'
  const normalize =
    platform === 'win32' ? normalizeWindowsPathEntry : (entry: string): string => entry
  const normalizedBinDir = normalize(binDir)
  return pathVar
    .split(separator)
    .filter(Boolean)
    .some((entry) => normalize(entry) === normalizedBinDir)
}

const isLinuxAppImage = (env: CliLauncherEnv): boolean =>
  env.platform === 'linux' && env.packaged && Boolean(env.appImagePath)

// electron-builder's AppRun may prepend --no-sandbox before user arguments when user namespaces are
// unavailable. Node mode rejects that Chromium flag before it can reach a script argument. Ask the
// AppImage runtime to mount and wait instead, then invoke the payload directly for the lifetime of the
// CLI process so AppRun never gets a chance to rewrite the Node argument list.
const appImagePayloadPaths = (env: CliLauncherEnv): { executable: string; cliEntry: string } => {
  const currentMount = posix.dirname(env.appExecPath)
  const executable = posix.relative(currentMount, env.appExecPath)
  const cliEntry = posix.relative(currentMount, env.cliEntryPath)
  const isInsideMount = (path: string): boolean =>
    path.length > 0 && !posix.isAbsolute(path) && path !== '..' && !path.startsWith('../')
  if (!isInsideMount(executable) || !isInsideMount(cliEntry)) {
    throw new Error('AppImage CLI paths must be inside the current AppImage mount.')
  }
  return { executable, cliEntry }
}

// POSIX: a /bin/sh shim in ~/.local/bin. Single-quote every path so it survives spaces and shell
// metacharacters: inside single quotes nothing is special (no $, backtick, or backslash expansion),
// so the only thing to escape is an embedded single quote, via the standard '\'' close-escape-reopen
// idiom. This fully quotes an arbitrary path, unlike double quotes, which would still expand
// $/backtick and need backslash handling.
const posixShim = (env: CliLauncherEnv): string => {
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
  if (isLinuxAppImage(env)) {
    const { executable, cliEntry } = appImagePayloadPaths(env)
    return [
      '#!/bin/sh',
      `# ${MANAGED_LAUNCHER_HEADER_V1}`,
      '# Edits are overwritten on reinstall. Mounts the AppImage for this CLI process.',
      `app_image=${quote(env.appImagePath!)}`,
      'mount_output=$(mktemp "${TMPDIR:-/tmp}/open-science-cli.XXXXXX") || {',
      "  echo 'Open Science could not create a temporary file for the AppImage mount.' >&2",
      '  exit 1',
      '}',
      'mount_pid=',
      'cleanup() {',
      '  if [ -n "$mount_pid" ]; then',
      '    kill "$mount_pid" 2>/dev/null || :',
      '    wait "$mount_pid" 2>/dev/null || :',
      '  fi',
      '  rm -f "$mount_output"',
      '}',
      'trap cleanup 0',
      "trap 'exit 129' 1",
      "trap 'exit 130' 2",
      "trap 'exit 143' 15",
      '"$app_image" --appimage-mount >"$mount_output" &',
      'mount_pid=$!',
      'while [ ! -s "$mount_output" ]; do',
      '  if ! kill -0 "$mount_pid" 2>/dev/null; then',
      '    wait "$mount_pid"',
      '    mount_status=$?',
      '    if [ "$mount_status" -eq 0 ]; then mount_status=1; fi',
      "    echo 'Open Science AppImage exited before reporting its mount point.' >&2",
      '    exit "$mount_status"',
      '  fi',
      '  sleep 0.05',
      'done',
      'mount_dir=$(sed -n \'1p\' "$mount_output")',
      `app_exec="$mount_dir"/${quote(executable)}`,
      `cli_entry="$mount_dir"/${quote(cliEntry)}`,
      'if [ ! -x "$app_exec" ] || [ ! -f "$cli_entry" ]; then',
      "  echo 'Open Science AppImage is missing its executable or CLI entry.' >&2",
      '  exit 1',
      'fi',
      'OPEN_SCIENCE_APP_PATH="$app_image" ELECTRON_RUN_AS_NODE=1 \\',
      '  "$app_exec" "$cli_entry" "$@"',
      'status=$?',
      'exit "$status"',
      ''
    ].join('\n')
  }
  const appPathLine = env.packaged ? `OPEN_SCIENCE_APP_PATH=${quote(env.appExecPath)} ` : ''
  return [
    '#!/bin/sh',
    `# ${MANAGED_LAUNCHER_HEADER_V1}`,
    "# Edits are overwritten on reinstall. Runs the app's Electron in Node mode.",
    `${appPathLine}ELECTRON_RUN_AS_NODE=1 exec ${quote(env.appExecPath)} ${quote(env.cliEntryPath)} "$@"`,
    ''
  ].join('\n')
}
// Windows: an open-science.cmd in a per-user bin dir. %* forwards all arguments.
const windowsShim = (env: CliLauncherEnv): string => {
  const appPathLine = env.packaged ? `set "OPEN_SCIENCE_APP_PATH=${env.appExecPath}"\r\n` : ''
  return [
    '@echo off',
    `rem ${MANAGED_LAUNCHER_HEADER_V1}`,
    'rem Edits are overwritten on reinstall.',
    'set ELECTRON_RUN_AS_NODE=1',
    `${appPathLine}"${env.appExecPath}" "${env.cliEntryPath}" %*`,
    ''
  ].join('\r\n')
}

// Resolves where the shim goes and what it contains for the current platform. Pure — no I/O.
export const planCliLauncher = (env: CliLauncherEnv): CliLauncherPlan => {
  if (env.platform === 'win32') {
    const binDir = join(env.userDataDir, 'bin')
    return {
      binDir,
      target: join(binDir, 'open-science.cmd'),
      shim: windowsShim(env),
      onPath: isOnPath(binDir, env.pathVar, env.platform)
    }
  }
  const binDir = join(env.homeDir, '.local', 'bin')
  return {
    binDir,
    target: join(binDir, 'open-science'),
    shim: posixShim(env),
    mode: 0o755,
    onPath: isOnPath(binDir, env.pathVar, env.platform)
  }
}

// Runs a command synchronously and reports success (exit 0). Injectable so the Windows PATH edit can
// be asserted in tests without invoking a real shell.
export type CommandRunner = (command: string, args: string[]) => boolean

const defaultRunCommand: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true })
  return result.status === 0
}

const WINDOWS_PATH_PENDING_NAME = '.open-science-path-pending'
const WINDOWS_PATH_RECEIPT_NAME = '.open-science-path-receipt'
const WINDOWS_PATH_RECEIPT_OWNER = 'Open Science Windows PATH entry. Managed by the app.'
// The file name is the journal state: pending is flushed before the registry mutation, then renamed
// to the owned receipt as the commit step. The snapshots let a later run reconcile a crash safely.
const windowsPathPendingPath = (binDir: string): string => join(binDir, WINDOWS_PATH_PENDING_NAME)
const windowsPathReceiptPath = (binDir: string): string => join(binDir, WINDOWS_PATH_RECEIPT_NAME)
const powershellLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`

type WindowsPathJournal = {
  version: 1
  owner: typeof WINDOWS_PATH_RECEIPT_OWNER
  binDir: string
  beforePath: string | null
  afterPath: string
}

const parseWindowsPathJournal = (
  content: string | undefined,
  binDir: string
): WindowsPathJournal | undefined => {
  if (content === undefined) return undefined
  try {
    const value = JSON.parse(content) as Partial<WindowsPathJournal>
    const beforePath = value.beforePath
    if (
      value.version !== 1 ||
      value.owner !== WINDOWS_PATH_RECEIPT_OWNER ||
      typeof value.binDir !== 'string' ||
      normalizeWindowsPathEntry(value.binDir) !== normalizeWindowsPathEntry(binDir) ||
      (beforePath !== null && typeof beforePath !== 'string') ||
      typeof value.afterPath !== 'string' ||
      isOnPath(binDir, beforePath ?? '', 'win32')
    ) {
      return undefined
    }
    const expectedAfterPath = [...(beforePath ?? '').split(';').filter(Boolean), binDir].join(';')
    return value.afterPath === expectedAfterPath ? (value as WindowsPathJournal) : undefined
  } catch {
    return undefined
  }
}

// Builds the PowerShell invocation that appends binDir to the persistent per-user PATH
// (HKCU\Environment), without an admin prompt. The path is embedded as a single-quoted PowerShell
// literal (single quotes doubled) rather than passed via `-args`: under `-Command`, trailing tokens
// like `-args <dir>` are unreliable and can leave $args empty, writing the wrong value into PATH.
export const buildWindowsPathCommand = (binDir: string): { command: string; args: string[] } => {
  const pendingPath = windowsPathPendingPath(binDir)
  const receiptPath = windowsPathReceiptPath(binDir)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$binDir = ${powershellLiteral(binDir)}`,
    `$pendingPath = ${powershellLiteral(pendingPath)}`,
    `$receiptPath = ${powershellLiteral(receiptPath)}`,
    `$receiptOwner = ${powershellLiteral(WINDOWS_PATH_RECEIPT_OWNER)}`,
    'function Get-PathParts($value) {',
    "  return @($value -split ';' | Where-Object { $_ -ne '' })",
    '}',
    'function Get-MatchCount($value) {',
    "  $normalizedBinDir = $binDir.TrimEnd([char[]]'\\/')",
    '  return @(Get-PathParts $value | Where-Object {',
    "    $_.TrimEnd([char[]]'\\/') -ieq $normalizedBinDir",
    '  }).Count',
    '}',
    'function Read-PathJournal($path) {',
    '  try { $journal = [IO.File]::ReadAllText($path) | ConvertFrom-Json }',
    "  catch { throw 'The PATH ownership journal is not managed by Open Science.' }",
    '  $beforeIsValid = $null -eq $journal.beforePath -or $journal.beforePath -is [string]',
    "  $expectedAfter = (@(Get-PathParts $journal.beforePath) + $binDir) -join ';'",
    '  if ($journal.version -ne 1 -or $journal.owner -cne $receiptOwner -or',
    "      $journal.binDir.TrimEnd([char[]]'\\/') -ine $binDir.TrimEnd([char[]]'\\/') -or",
    '      -not $beforeIsValid -or (Get-MatchCount $journal.beforePath) -ne 0 -or',
    '      $journal.afterPath -isnot [string] -or',
    '      $journal.afterPath -cne $expectedAfter) {',
    "    throw 'The PATH ownership journal is not managed by Open Science.'",
    '  }',
    '  return $journal',
    '}',
    'function Write-PendingJournal($beforePath, $afterPath) {',
    '  $content = [ordered]@{',
    '    version = 1',
    '    owner = $receiptOwner',
    '    binDir = $binDir',
    '    beforePath = $beforePath',
    '    afterPath = $afterPath',
    '  } | ConvertTo-Json -Compress',
    '  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($content)',
    '  $stream = [IO.File]::Open($pendingPath, [IO.FileMode]::CreateNew,',
    '    [IO.FileAccess]::Write, [IO.FileShare]::None)',
    '  try {',
    '    $stream.Write($bytes, 0, $bytes.Length)',
    '    $stream.Flush($true)',
    '  } finally {',
    '    $stream.Dispose()',
    '  }',
    '}',
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    'if ([IO.File]::Exists($pendingPath) -and [IO.File]::Exists($receiptPath)) {',
    "  throw 'The PATH ownership journal is ambiguous.'",
    '}',
    'if ([IO.File]::Exists($pendingPath)) {',
    '  $journal = Read-PathJournal $pendingPath',
    '  if ($current -ceq $journal.afterPath) {',
    '    [IO.File]::Move($pendingPath, $receiptPath)',
    '    return',
    '  }',
    '  if ($current -cne $journal.beforePath) {',
    "    throw 'The pending PATH ownership journal cannot be reconciled.'",
    '  }',
    "  [Environment]::SetEnvironmentVariable('Path', $journal.afterPath, 'User')",
    '  [IO.File]::Move($pendingPath, $receiptPath)',
    '  return',
    '}',
    'if ([IO.File]::Exists($receiptPath)) {',
    '  $null = Read-PathJournal $receiptPath',
    '  if ((Get-MatchCount $current) -gt 0) { return }',
    '  [IO.File]::Delete($receiptPath)',
    '}',
    'if ((Get-MatchCount $current) -gt 0) { return }',
    "$next = (@(Get-PathParts $current) + $binDir) -join ';'",
    'Write-PendingJournal $current $next',
    "[Environment]::SetEnvironmentVariable('Path', $next, 'User')",
    '[IO.File]::Move($pendingPath, $receiptPath)'
  ].join('\n')
  return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
}

const buildWindowsPathRemovalCommand = (
  binDir: string,
  journalPath: string,
  state: 'pending' | 'owned'
): { command: string; args: string[] } => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$binDir = ${powershellLiteral(binDir)}`,
    `$journalPath = ${powershellLiteral(journalPath)}`,
    `$receiptOwner = ${powershellLiteral(WINDOWS_PATH_RECEIPT_OWNER)}`,
    `$state = ${powershellLiteral(state)}`,
    'try { $journal = [IO.File]::ReadAllText($journalPath) | ConvertFrom-Json }',
    "catch { throw 'The PATH ownership journal is not managed by Open Science.' }",
    '  $beforeIsValid = $null -eq $journal.beforePath -or $journal.beforePath -is [string]',
    "$beforeParts = @($journal.beforePath -split ';' | Where-Object { $_ -ne '' })",
    "$normalizedBinDir = $binDir.TrimEnd([char[]]'\\/')",
    '  $beforeMatchCount = @($beforeParts | Where-Object {',
    "    $_.TrimEnd([char[]]'\\/') -ieq $normalizedBinDir",
    '  }).Count',
    "  $expectedAfter = (@($beforeParts) + $binDir) -join ';'",
    'if ($journal.version -ne 1 -or $journal.owner -cne $receiptOwner -or',
    "    $journal.binDir.TrimEnd([char[]]'\\/') -ine $binDir.TrimEnd([char[]]'\\/') -or",
    '    -not $beforeIsValid -or $beforeMatchCount -ne 0 -or',
    '    $journal.afterPath -isnot [string] -or',
    '    $journal.afterPath -cne $expectedAfter) {',
    "  throw 'The PATH ownership journal is not managed by Open Science.'",
    '}',
    '$beforePath = $journal.beforePath',
    '$afterPath = $journal.afterPath',
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$parts = @($current -split ';' | Where-Object { $_ -ne '' })",
    '$matches = @($parts | Where-Object {',
    "  $_.TrimEnd([char[]]'\\/') -ieq $normalizedBinDir",
    '})',
    "if ($state -ceq 'pending') {",
    '  if ($current -ceq $beforePath) { return }',
    '  if ($current -cne $afterPath) {',
    "    throw 'The pending PATH ownership journal cannot be reconciled.'",
    '  }',
    '}',
    'if ($matches.Count -eq 0) { return }',
    'if ($current -cne $afterPath) {',
    "  throw 'The owned PATH entry no longer matches its recorded snapshot.'",
    '}',
    "[Environment]::SetEnvironmentVariable('Path', $beforePath, 'User')"
  ].join('\n')
  return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
}

class UnmanagedCliLauncherError extends Error {}

const refuseUnmanagedCliLauncher = (target: string): never => {
  throw new UnmanagedCliLauncherError(
    `Refusing to modify ${target} because it is not managed by Open Science. ` +
      'Move or rename the existing file, then try again.'
  )
}

const statCliLauncher = async (target: string): Promise<Stats | undefined> => {
  try {
    return await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const isDirectRegularFile = (stats: Stats): boolean =>
  stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1

const isSameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino

type OpenCliLauncher = { handle: FileHandle; stats: Stats }

// Open only a direct, single-link regular file and verify that the path still resolves to the same
// inode after opening it. O_NOFOLLOW closes the lstat/open gap on POSIX; the identity checks provide
// the equivalent guard on platforms where Node does not expose that flag.
const openStableCliLauncher = async (
  target: string,
  flags: number
): Promise<OpenCliLauncher | undefined> => {
  const before = await statCliLauncher(target)
  if (before === undefined) return undefined
  if (!isDirectRegularFile(before)) refuseUnmanagedCliLauncher(target)

  let handle: FileHandle
  try {
    handle = await open(target, flags | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    if (code === 'ELOOP') refuseUnmanagedCliLauncher(target)
    throw error
  }

  try {
    const [opened, current] = await Promise.all([handle.stat(), statCliLauncher(target)])
    if (
      current === undefined ||
      !isDirectRegularFile(opened) ||
      !isDirectRegularFile(current) ||
      !isSameFile(before, opened) ||
      !isSameFile(opened, current)
    ) {
      refuseUnmanagedCliLauncher(target)
    }
    return { handle, stats: opened }
  } catch (error) {
    await handle.close()
    throw error
  }
}

const isOpenCliLauncherCurrent = async (target: string, opened: Stats): Promise<boolean> => {
  const current = await statCliLauncher(target)
  return current !== undefined && isDirectRegularFile(current) && isSameFile(opened, current)
}

const readCliLauncher = async (target: string): Promise<string | undefined> => {
  let opened: OpenCliLauncher | undefined
  try {
    opened = await openStableCliLauncher(target, constants.O_RDONLY)
  } catch (error) {
    if (error instanceof UnmanagedCliLauncherError) return undefined
    throw error
  }
  if (opened === undefined) return undefined

  try {
    const content = await opened.handle.readFile('utf8')
    return (await isOpenCliLauncherCurrent(target, opened.stats)) ? content : undefined
  } finally {
    await opened.handle.close()
  }
}

const openManagedWindowsPathJournal = async (
  target: string,
  binDir: string
): Promise<OpenCliLauncher | undefined> => {
  const opened = await openStableCliLauncher(target, constants.O_RDONLY)
  if (opened === undefined) return undefined

  try {
    const content = await opened.handle.readFile('utf8')
    const journal = parseWindowsPathJournal(content, binDir)
    if (journal !== undefined && (await isOpenCliLauncherCurrent(target, opened.stats))) {
      return opened
    }
  } catch (error) {
    await opened.handle.close()
    throw error
  }
  await opened.handle.close()
  return undefined
}

const isManagedCliLauncher = (content: string): boolean => {
  const lines = content.split(/\r?\n/)
  if (lines[0] === '#!/bin/sh') {
    return (
      lines[1] === `# ${MANAGED_LAUNCHER_HEADER_V1}` ||
      (lines[1] === LEGACY_POSIX_HEADER && LEGACY_POSIX_BODIES.has(lines[2] ?? ''))
    )
  }
  return (
    lines[0]?.toLowerCase() === '@echo off' &&
    (lines[1] === `rem ${MANAGED_LAUNCHER_HEADER_V1}` || lines[1] === LEGACY_WINDOWS_HEADER)
  )
}

const writeCliLauncher = async (handle: FileHandle, plan: CliLauncherPlan): Promise<void> => {
  const content = Buffer.from(plan.shim)
  let offset = 0
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset)
    if (bytesWritten === 0) throw new Error(`Could not write the CLI launcher at ${plan.target}.`)
    offset += bytesWritten
  }
  if (plan.mode !== undefined) await handle.chmod(plan.mode)
}

// Publish an existing launcher through a same-directory temporary file while retaining the handle
// whose managed contents were validated. Until rename succeeds the old command remains untouched; a
// write/flush failure therefore cannot truncate a working launcher.
const replaceCliLauncher = async (
  plan: CliLauncherPlan,
  expected: OpenCliLauncher
): Promise<void> => {
  const temporaryPath = join(
    plan.binDir,
    `.${basename(plan.target)}.${process.pid}-${randomUUID()}.tmp`
  )
  let handle: FileHandle | undefined
  let published = false
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      plan.mode ?? 0o666
    )
    await writeCliLauncher(handle, plan)
    await handle.sync()
    await handle.close()
    handle = undefined

    const opened = await expected.handle.stat()
    if (
      !isDirectRegularFile(opened) ||
      !isSameFile(expected.stats, opened) ||
      !(await isOpenCliLauncherCurrent(plan.target, opened))
    ) {
      refuseUnmanagedCliLauncher(plan.target)
    }
    await rename(temporaryPath, plan.target)
    published = true
    await defaultFileDurability.syncDirectory(plan.binDir)
  } finally {
    await handle?.close().catch(() => undefined)
    if (!published) await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

const tryCreateCliLauncher = async (plan: CliLauncherPlan): Promise<boolean> => {
  let handle: FileHandle
  try {
    handle = await open(
      plan.target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      plan.mode ?? 0o666
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }

  try {
    await writeCliLauncher(handle, plan)
    const created = await handle.stat()
    if (!(await isOpenCliLauncherCurrent(plan.target, created))) {
      refuseUnmanagedCliLauncher(plan.target)
    }
    return true
  } finally {
    await handle.close()
  }
}

// Writes the launcher shim and, on Windows, ensures its dir is on the user PATH. Returns the resulting
// status (installed + whether `open-science` is callable, with a hint when a manual step remains).
export const installCliLauncher = async (
  env: CliLauncherEnv,
  runCommand: CommandRunner = defaultRunCommand
): Promise<CliLauncherStatus> => {
  const plan = planCliLauncher(env)
  await mkdir(plan.binDir, { recursive: true })

  let written = false
  for (let attempt = 0; attempt < 3 && !written; attempt += 1) {
    if (await tryCreateCliLauncher(plan)) {
      written = true
      break
    }

    const opened = await openStableCliLauncher(plan.target, constants.O_RDONLY)
    if (opened === undefined) continue
    try {
      const existing = await opened.handle.readFile('utf8')
      if (!isManagedCliLauncher(existing)) refuseUnmanagedCliLauncher(plan.target)
      await replaceCliLauncher(plan, opened)
      written = true
    } finally {
      await opened.handle.close()
    }
  }
  if (!written) throw new Error(`The CLI launcher path kept changing: ${plan.target}`)

  let onPath = plan.onPath
  let pathHint: string | undefined
  if (!onPath) {
    if (env.platform === 'win32') {
      for (const journalPath of [
        windowsPathPendingPath(plan.binDir),
        windowsPathReceiptPath(plan.binDir)
      ]) {
        if (
          (await statCliLauncher(journalPath)) !== undefined &&
          parseWindowsPathJournal(await readCliLauncher(journalPath), plan.binDir) === undefined
        ) {
          refuseUnmanagedCliLauncher(journalPath)
        }
      }
      const { command, args } = buildWindowsPathCommand(plan.binDir)
      onPath = runCommand(command, args)
      pathHint = onPath
        ? 'Added to your PATH — open a new terminal to use "open-science".'
        : `Add ${plan.binDir} to your PATH to use "open-science".`
    } else {
      pathHint = `Add ${plan.binDir} to your PATH (e.g. in your shell profile) to use "open-science".`
    }
  }
  return { installed: true, target: plan.target, onPath, pathHint }
}

export const uninstallCliLauncher = async (
  env: CliLauncherEnv,
  runCommand: CommandRunner = defaultRunCommand
): Promise<CliLauncherStatus> => {
  const plan = planCliLauncher(env)
  const opened = await openStableCliLauncher(plan.target, constants.O_RDONLY)
  let pathJournal: OpenCliLauncher | undefined
  try {
    if (opened !== undefined) {
      const existing = await opened.handle.readFile('utf8')
      if (!isManagedCliLauncher(existing)) refuseUnmanagedCliLauncher(plan.target)
      if (!(await isOpenCliLauncherCurrent(plan.target, opened.stats))) {
        refuseUnmanagedCliLauncher(plan.target)
      }
    }

    if (env.platform === 'win32') {
      const journalPaths = [
        windowsPathPendingPath(plan.binDir),
        windowsPathReceiptPath(plan.binDir)
      ]
      const existingJournalPaths: string[] = []
      for (const journalPath of journalPaths) {
        if ((await statCliLauncher(journalPath)) !== undefined) {
          existingJournalPaths.push(journalPath)
        }
      }
      if (existingJournalPaths.length > 1) {
        throw new Error('The Windows PATH ownership journal is ambiguous.')
      }
      const journalPath = existingJournalPaths[0]
      if (journalPath !== undefined) {
        const openedJournal =
          (await openManagedWindowsPathJournal(journalPath, plan.binDir)) ??
          refuseUnmanagedCliLauncher(journalPath)
        pathJournal = openedJournal

        const journalStats = openedJournal.stats
        const state = journalPath === journalPaths[0] ? 'pending' : 'owned'
        const { command, args } = buildWindowsPathRemovalCommand(plan.binDir, journalPath, state)
        if (!runCommand(command, args)) {
          throw new Error(`Could not remove ${plan.binDir} from the user PATH.`)
        }
        if (!(await isOpenCliLauncherCurrent(journalPath, openedJournal.stats))) {
          refuseUnmanagedCliLauncher(journalPath)
        }
        await openedJournal.handle.close()
        pathJournal = undefined

        const finalJournal = await statCliLauncher(journalPath)
        if (finalJournal !== undefined) {
          if (!isDirectRegularFile(finalJournal) || !isSameFile(finalJournal, journalStats)) {
            refuseUnmanagedCliLauncher(journalPath)
          }
          await rm(journalPath)
        }
      }
    }

    if (opened === undefined) {
      return { installed: false, target: plan.target, onPath: false }
    }
    const final = await statCliLauncher(plan.target)
    if (final !== undefined) {
      if (!isDirectRegularFile(final) || !isSameFile(opened.stats, final)) {
        refuseUnmanagedCliLauncher(plan.target)
      }
      await rm(plan.target)
    }
  } finally {
    await pathJournal?.handle.close()
    await opened?.handle.close()
  }
  return { installed: false, target: plan.target, onPath: false }
}

// AppImage status is content-aware: a legacy shim can exist while still pointing at an unmounted
// FUSE path. Other packages report installed only when the existing launcher is app-managed.
export const getCliLauncherStatus = async (env: CliLauncherEnv): Promise<CliLauncherStatus> => {
  const plan = planCliLauncher(env)
  const content = await readCliLauncher(plan.target)
  const installed = isLinuxAppImage(env)
    ? content === plan.shim
    : content !== undefined && isManagedCliLauncher(content)
  return {
    installed,
    target: plan.target,
    onPath: plan.onPath,
    pathHint:
      installed && !plan.onPath
        ? `Add ${plan.binDir} to your PATH to use "open-science".`
        : undefined
  }
}

// Only an existing app-managed AppImage launcher is eligible for automatic migration. Comparing the
// complete planned content covers the stable AppImage path, mount procedure, and CLI entry behavior.
export const isCliShimStale = async (env: CliLauncherEnv): Promise<boolean> => {
  if (!isLinuxAppImage(env)) return false
  const plan = planCliLauncher(env)
  const content = await readCliLauncher(plan.target)
  return content !== undefined && isManagedCliLauncher(content) && content !== plan.shim
}

// Migrate legacy mount-pinned shims and refresh the stable path after the AppImage file itself moves.
export const ensureCliLauncherCurrent = async (
  env: CliLauncherEnv,
  runCommand: CommandRunner = defaultRunCommand
): Promise<CliLauncherStatus | undefined> => {
  if (!(await isCliShimStale(env))) return undefined
  return installCliLauncher(env, runCommand)
}
