import { compareVersions } from './update'

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

// Recognizes only the app-authored version guidance, either directly or after Electron or the
// Session resume flow wraps it. The installed version varies, so validate the fixed prefix/suffix
// and require one version token.
export const isUnsupportedCodexAcpVersionError = (error: string | null | undefined): boolean => {
  const message = error?.trim()
  if (!message?.endsWith(CODEX_ACP_UNSUPPORTED_VERSION_SUFFIX)) return false

  const start = message.lastIndexOf(CODEX_ACP_UNSUPPORTED_VERSION_PREFIX)
  if (start < 0) return false

  const version = message.slice(
    start + CODEX_ACP_UNSUPPORTED_VERSION_PREFIX.length,
    -CODEX_ACP_UNSUPPORTED_VERSION_SUFFIX.length
  )
  if (!version || /\s/.test(version)) return false

  const wrapper = message.slice(0, start)
  return (
    wrapper === '' ||
    wrapper.endsWith('Error: ') ||
    wrapper.endsWith('Agent session resume failed: ')
  )
}
