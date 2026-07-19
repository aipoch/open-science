import { spawnSync } from 'node:child_process'
import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

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

const isOnPath = (binDir: string, pathVar: string): boolean =>
  pathVar
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => entry === binDir)

// POSIX: a /bin/sh shim in ~/.local/bin. Double-quote every path (installs live under "Open Science"
// with a space) and escape embedded quotes defensively.
const posixShim = (env: CliLauncherEnv): string => {
  const quote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`
  const appPathLine = env.packaged ? `OPEN_SCIENCE_APP_PATH=${quote(env.appExecPath)} ` : ''
  return [
    '#!/bin/sh',
    '# Open Science command-line launcher. Managed by the app (Settings -> General -> Command line',
    "# tool); edits will be overwritten on reinstall. Runs the app's Electron in Node mode.",
    `${appPathLine}ELECTRON_RUN_AS_NODE=1 exec ${quote(env.appExecPath)} ${quote(env.cliEntryPath)} "$@"`,
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
      onPath: isOnPath(binDir, env.pathVar)
    }
  }
  const binDir = join(env.homeDir, '.local', 'bin')
  return {
    binDir,
    target: join(binDir, 'open-science'),
    shim: posixShim(env),
    mode: 0o755,
    onPath: isOnPath(binDir, env.pathVar)
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

// Adds binDir to the persistent per-user PATH on Windows (HKCU\Environment) via PowerShell, without an
// admin prompt. Returns true if the edit ran; the change only reaches new terminals. Never throws.
const addToWindowsUserPath = (binDir: string): boolean => {
  const script = [
    '$binDir = $args[0]',
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$parts = @($current -split ';' | Where-Object { $_ -ne '' })",
    'if ($parts -notcontains $binDir) {',
    "  $next = (@($parts) + $binDir) -join ';'",
    "  [Environment]::SetEnvironmentVariable('Path', $next, 'User')",
    '}'
  ].join('\n')
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script, '-args', binDir],
    { stdio: 'ignore', windowsHide: true }
  )
  return result.status === 0
}

// Writes the launcher shim and, on Windows, ensures its dir is on the user PATH. Returns the resulting
// status (installed + whether `open-science` is callable, with a hint when a manual step remains).
export const installCliLauncher = async (env: CliLauncherEnv): Promise<CliLauncherStatus> => {
  const plan = planCliLauncher(env)
  await mkdir(plan.binDir, { recursive: true })
  await writeFile(plan.target, plan.shim, plan.mode !== undefined ? { mode: plan.mode } : {})
  if (plan.mode !== undefined) await chmod(plan.target, plan.mode)

  let onPath = plan.onPath
  let pathHint: string | undefined
  if (!onPath) {
    if (env.platform === 'win32') {
      onPath = addToWindowsUserPath(plan.binDir)
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

export const getCliLauncherStatus = async (env: CliLauncherEnv): Promise<CliLauncherStatus> => {
  const plan = planCliLauncher(env)
  const installed = await exists(plan.target)
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
