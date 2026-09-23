import { compareVersions } from './update'

// SDK 0.2.118 introduced managedSettings and declares claudeCodeVersion 2.1.118.
// Keep this policy lock for every session, including app-owned delegated work.
export const MINIMUM_CLAUDE_CLI_VERSION = '2.1.118'

export const isSupportedClaudeCliVersion = (version: string | null | undefined): boolean =>
  Boolean(
    version &&
    /^\d+\.\d+\.\d+$/.test(version) &&
    compareVersions(version, MINIMUM_CLAUDE_CLI_VERSION) >= 0
  )

export const CLAUDE_CLI_INCOMPATIBLE_MESSAGE =
  'The installed Claude Code CLI is incompatible or its version could not be verified. Update Claude Code to 2.1.118 or later, then re-detect it in Settings.'

export const isClaudeCliCompatibilityError = (message: string): boolean =>
  message === CLAUDE_CLI_INCOMPATIBLE_MESSAGE ||
  message.endsWith(`Error: ${CLAUDE_CLI_INCOMPATIBLE_MESSAGE}`) ||
  message === `Agent session resume failed: ${CLAUDE_CLI_INCOMPATIBLE_MESSAGE}`
