import { compareVersions } from './update'

// The app installs this adapter version and treats it as the oldest ACP contract it can safely run.
// Newer compatible adapters remain usable; older installs stay discoverable so Settings can offer an
// explicit update instead of misreporting them as missing.
export const MINIMUM_CODEX_ACP_VERSION = '1.6.2'

export const isSupportedCodexAcpVersion = (version: string): boolean =>
  compareVersions(version, MINIMUM_CODEX_ACP_VERSION) >= 0
