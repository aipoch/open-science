import type { InstallTarget } from './claude-install'

// OpenCode install coordinates for the generic runner in claude-install.ts. The npm wrapper package is
// `opencode-ai`; the shell installer is served from opencode.ai. There is no official Windows
// PowerShell installer, so `scriptWindows` is omitted and the script source is hidden on Windows
// (see getOpencodeInstallSources) — Windows users take the app-managed download or npm.
export const OPENCODE_INSTALL_TARGET: InstallTarget = {
  npmPackage: 'opencode-ai',
  scriptUnix: 'curl -fsSL https://opencode.ai/install | bash'
}
