import { compareVersions } from './update'

// Open-Science's supported baseline, not a universal provider minimum for every model.
export const MINIMUM_CODEX_CLI_VERSION = '0.157.1'
// Keep optional future download upgrades independent from the supported baseline.
export const MANAGED_CODEX_VERSION = '0.157.1'

export const isSupportedCodexCliVersion = (version: string | null | undefined): boolean =>
  Boolean(
    version &&
    /^\d+\.\d+\.\d+$/.test(version) &&
    compareVersions(version, MINIMUM_CODEX_CLI_VERSION) >= 0
  )

export const CODEX_CLI_INCOMPATIBLE_MESSAGE = `The installed Codex CLI is incompatible or its version could not be verified. Update Codex CLI to ${MINIMUM_CODEX_CLI_VERSION} or later, then re-detect it in Settings.`

export const hasCodexNativeUpdate = (version: string | undefined): boolean =>
  Boolean(
    version &&
    /^\d+\.\d+\.\d+$/.test(version) &&
    compareVersions(version, MANAGED_CODEX_VERSION) < 0
  )

// The app installs this adapter version and treats it as the oldest ACP contract it can safely run.
// Newer compatible adapters remain usable; older installs stay discoverable so Settings can offer an
// explicit update instead of misreporting them as missing.
export const MINIMUM_CODEX_ACP_VERSION = '1.6.2'

export const isSupportedCodexAcpVersion = (version: string): boolean =>
  compareVersions(version, MINIMUM_CODEX_ACP_VERSION) >= 0

const CODEX_ACP_UNSUPPORTED_VERSION_PREFIX = 'Codex ACP adapter '
const CODEX_ACP_UNSUPPORTED_VERSION_SUFFIX = ` is no longer supported. Update to ${MINIMUM_CODEX_ACP_VERSION} or later in settings.`

export const buildUnsupportedCodexAcpVersionMessage = (installedVersion: string): string =>
  `${CODEX_ACP_UNSUPPORTED_VERSION_PREFIX}${installedVersion}${CODEX_ACP_UNSUPPORTED_VERSION_SUFFIX}`
