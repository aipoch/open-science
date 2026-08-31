import { stat } from 'node:fs/promises'

import { createLogger, diagnosticErrorFields } from '../logger'

// Errno codes that unambiguously mean "the path is not there": the leaf is gone (ENOENT) or a path
// segment is a file rather than a directory (ENOTDIR). On Windows a genuinely disconnected drive or
// deleted folder also surfaces as ENOENT ("The system cannot find the path specified"), so treating
// these as missing keeps the intended "data folder not found" dialog working.
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])

// Minimal logger shape so callers can inject one (and tests can assert) without importing electron.
type PresenceLogger = Pick<ReturnType<typeof createLogger>, 'warn'>

// Returns true when at least one path is proven to exist and false only when every path is proven
// absent. Any permission/I/O/encoding error remains inconclusive and rejects so safety-sensitive
// callers can fail closed instead of treating an unreadable directory as empty.
export const hasAnyExistingPath = async (
  paths: readonly string[],
  deps: { statFn?: (p: string) => Promise<unknown> } = {}
): Promise<boolean> => {
  const statFn = deps.statFn ?? stat
  for (const path of paths) {
    try {
      await statFn(path)
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code && MISSING_CODES.has(code)) continue
      throw err
    }
  }
  return false
}

// Decides whether a configured data root should be reported as MISSING (which drives the destructive
// "Data folder not found -> continue with an empty folder" prompt). This exists because a bare
// existsSync/statSync-in-try-catch collapses EVERY failure into "false", so a non-ENOENT stat error
// (a transient I/O hiccup, a permission error, or an encoding/`ERROR_NO_UNICODE_TRANSLATION`-class
// failure seen with non-ASCII paths on some Windows setups) was being misread as "the folder was
// deleted" and nagged the user on every launch.
//
// Contract: return true ONLY when stat proves the path is absent (ENOENT/ENOTDIR). Any other error is
// indeterminate — we cannot conclude the data is gone, and wrongly offering to start empty risks
// abandoning the user's real data — so we return false (don't nag) and log only a fixed category.
export const isDataRootMissing = async (
  path: string,
  deps: { statFn?: (p: string) => Promise<unknown>; logger?: PresenceLogger } = {}
): Promise<boolean> => {
  const statFn = deps.statFn ?? stat
  const logger = deps.logger ?? createLogger('storage')
  try {
    await statFn(path)
    return false
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code && MISSING_CODES.has(code)) return true

    try {
      logger.warn(
        'data root existence check inconclusive; not treating as missing',
        diagnosticErrorFields(err)
      )
    } catch {
      // Diagnostics must not turn an indeterminate path check into a rejected storage request.
    }
    return false
  }
}
