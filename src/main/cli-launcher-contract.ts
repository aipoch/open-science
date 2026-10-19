// Everything the launcher planner needs, injected so the pure path/shim logic is testable without
// Electron or the real filesystem. The IPC wrapper fills these from `app`/`process` at call time.
export type CliLauncherEnv = {
  platform: NodeJS.Platform
  // Used only to locate the AppImage mount; never executed as a backend or Node replacement.
  appExecPath: string
  nodeExecPath?: string
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
