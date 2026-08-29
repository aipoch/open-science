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
const isOnPath = (binDir: string, pathVar: string, platform: NodeJS.Platform): boolean => {
  const separator = platform === 'win32' ? ';' : ':'
  return pathVar
    .split(separator)
    .filter(Boolean)
    .some((entry) => entry === binDir)
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

// Builds the PowerShell invocation that appends binDir to the persistent per-user PATH
// (HKCU\Environment), without an admin prompt. The path is embedded as a single-quoted PowerShell
// literal (single quotes doubled) rather than passed via `-args`: under `-Command`, trailing tokens
// like `-args <dir>` are unreliable and can leave $args empty, writing the wrong value into PATH.
export const buildWindowsPathCommand = (binDir: string): { command: string; args: string[] } => {
  const literal = `'${binDir.replace(/'/g, "''")}'`
  const script = [
    `$binDir = ${literal}`,
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$parts = @($current -split ';' | Where-Object { $_ -ne '' })",
    'if ($parts -notcontains $binDir) {',
    "  $next = (@($parts) + $binDir) -join ';'",
    "  [Environment]::SetEnvironmentVariable('Path', $next, 'User')",
    '}'
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

// Publish an existing launcher through a same-directory temporary file. Until rename succeeds the
// old command remains untouched; a write/flush failure therefore cannot truncate a working launcher.
const replaceCliLauncher = async (plan: CliLauncherPlan, expected: Stats): Promise<void> => {
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

    if (!(await isOpenCliLauncherCurrent(plan.target, expected))) {
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
    } finally {
      await opened.handle.close()
    }
    await replaceCliLauncher(plan, opened.stats)
    written = true
  }
  if (!written) throw new Error(`The CLI launcher path kept changing: ${plan.target}`)

  let onPath = plan.onPath
  let pathHint: string | undefined
  if (!onPath) {
    if (env.platform === 'win32') {
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

export const uninstallCliLauncher = async (env: CliLauncherEnv): Promise<CliLauncherStatus> => {
  const plan = planCliLauncher(env)
  const opened = await openStableCliLauncher(plan.target, constants.O_RDONLY)
  if (opened !== undefined) {
    try {
      const existing = await opened.handle.readFile('utf8')
      if (!isManagedCliLauncher(existing)) refuseUnmanagedCliLauncher(plan.target)
      if (!(await isOpenCliLauncherCurrent(plan.target, opened.stats))) {
        refuseUnmanagedCliLauncher(plan.target)
      }
    } finally {
      await opened.handle.close()
    }

    const final = await statCliLauncher(plan.target)
    if (final !== undefined) {
      if (!isDirectRegularFile(final) || !isSameFile(opened.stats, final)) {
        refuseUnmanagedCliLauncher(plan.target)
      }
      await rm(plan.target)
    }
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
