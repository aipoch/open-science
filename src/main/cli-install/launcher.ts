import { spawnSync } from 'node:child_process'
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CliLauncherStatus } from '../../shared/cli'

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

// AppImage exposes APPIMAGE as the stable bundle path and APPDIR/process paths inside its ephemeral
// FUSE mount. Start the stable bundle in Node mode, then resolve the CLI entry from the new process's
// resourcesPath so the launcher remains usable while the desktop app is not running.
const appImageCliBootstrap = [
  "Promise.all([import('node:path'), import('node:url')])",
  '.then(([{ join }, { pathToFileURL }]) =>',
  "import(pathToFileURL(join(process.resourcesPath, 'cli', 'index.mjs')).href))",
  '.then(({ reportCliError, runCli }) => runCli(process.argv.slice(1)).catch(reportCliError))',
  '.catch((error) => { console.error(error instanceof Error ? error.message : error);',
  'process.exitCode = 1 })'
].join('')

const isLinuxAppImage = (env: CliLauncherEnv): boolean =>
  env.platform === 'linux' && env.packaged && Boolean(env.appImagePath)

// POSIX: a /bin/sh shim in ~/.local/bin. Single-quote every path so it survives spaces and shell
// metacharacters: inside single quotes nothing is special (no $, backtick, or backslash expansion),
// so the only thing to escape is an embedded single quote, via the standard '\'' close-escape-reopen
// idiom. This fully quotes an arbitrary path, unlike double quotes, which would still expand
// $/backtick and need backslash handling.
const posixShim = (env: CliLauncherEnv): string => {
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
  const command = isLinuxAppImage(env) ? env.appImagePath! : env.appExecPath
  const appPathLine = env.packaged ? `OPEN_SCIENCE_APP_PATH=${quote(command)} ` : ''
  const args = isLinuxAppImage(env)
    ? `-e ${quote(appImageCliBootstrap)} -- "$@"`
    : `${quote(env.cliEntryPath)} "$@"`
  return [
    '#!/bin/sh',
    '# Open Science command-line launcher. Managed by the app (Settings -> General -> Command line',
    "# tool); edits will be overwritten on reinstall. Runs the app's Electron in Node mode.",
    `${appPathLine}ELECTRON_RUN_AS_NODE=1 exec ${quote(command)} ${args}`,
    ''
  ].join('\n')
}
// Windows: an open-science.cmd in a per-user bin dir. %* forwards all arguments.
const windowsShim = (env: CliLauncherEnv): string => {
  const appPathLine = env.packaged ? `set "OPEN_SCIENCE_APP_PATH=${env.appExecPath}"\r\n` : ''
  return [
    '@echo off',
    'rem Open Science command-line launcher. Managed by the app; edits are overwritten on reinstall.',
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

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
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

// Writes the launcher shim and, on Windows, ensures its dir is on the user PATH. Returns the resulting
// status (installed + whether `open-science` is callable, with a hint when a manual step remains).
export const installCliLauncher = async (
  env: CliLauncherEnv,
  runCommand: CommandRunner = defaultRunCommand
): Promise<CliLauncherStatus> => {
  const plan = planCliLauncher(env)
  await mkdir(plan.binDir, { recursive: true })
  await writeFile(plan.target, plan.shim, plan.mode !== undefined ? { mode: plan.mode } : {})
  if (plan.mode !== undefined) await chmod(plan.target, plan.mode)

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
  await rm(plan.target, { force: true })
  return { installed: false, target: plan.target, onPath: false }
}

const readCliLauncher = async (target: string): Promise<string | undefined> => {
  try {
    return await readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const isManagedCliLauncher = (content: string): boolean =>
  content.includes('Open Science command-line launcher. Managed by the app')

// AppImage status is content-aware: a legacy shim can exist while still pointing at an unmounted
// FUSE path. Other packages retain the existing existence-only status contract.
export const getCliLauncherStatus = async (env: CliLauncherEnv): Promise<CliLauncherStatus> => {
  const plan = planCliLauncher(env)
  const installed = isLinuxAppImage(env)
    ? (await readCliLauncher(plan.target)) === plan.shim
    : await exists(plan.target)
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
// complete planned content covers the stable AppImage path, bootstrap, and CLI entry behavior.
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
