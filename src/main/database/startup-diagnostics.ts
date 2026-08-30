import { homedir } from 'node:os'

import { redactSensitiveText } from '../diagnostic-redaction'

// Composes the pre-redacted stack block attached to a blocked database startup state. The block is
// user-shareable by design: credentials and absolute paths are removed before it crosses IPC, with
// known config/data/home roots replaced by useful stable markers. The budgets below are a generous
// IPC-safety ceiling; the precise fit to the GitHub issue-URL length limit happens at link-build time
// (startup-issue.ts). Environment facts travel separately in the typed `environment` field (see
// shared/database-startup.ts).

const MAX_CAUSE_DEPTH = 8
const MAX_STACK_FRAMES = 32
const MAX_DIAGNOSTICS_LENGTH = 16000

const TRUNCATION_MARKER = '… (truncated)'
const FURTHER_CAUSES_MARKER = '… (further causes omitted)'
const NON_ERROR_CAUSE_MARKER = '… (a non-error cause was omitted)'

type StartupDiagnosticsOptions = {
  configRoot?: string
  dataRoot?: string
  home?: string
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const replaceRoot = (text: string, root: string | undefined, marker: string): string => {
  if (!root || /^[\\/]+$/.test(root) || /^[A-Za-z]:[\\/]*$/.test(root)) return text
  const normalizedRoot = root.replace(/[\\/]+$/, '')
  const variants = new Set([normalizedRoot, normalizedRoot.replace(/\\/g, '/')])
  let redacted = text
  for (const variant of variants) {
    const flags =
      /^[A-Za-z]:[\\/]/.test(variant) || variant.startsWith('\\\\') || variant.startsWith('//')
        ? 'gi'
        : 'g'
    redacted = redacted.replace(new RegExp(`${escapeRegExp(variant)}(?=$|[\\\\/])`, flags), marker)
  }
  return redacted
}

const absolutePathMarker = (path: string): string => {
  const withoutFileScheme = path.replace(/^file:\/\//i, '')
  const tail = withoutFileScheme.split(/[\\/]/).at(-1)
  return tail ? `<absolute-path>/${tail}` : '<absolute-path>'
}

const redactRemainingAbsolutePaths = (text: string): string =>
  text
    // Delimiters let us retain a useful filename/line suffix even when the path contains spaces.
    .replace(
      /(["'`])((?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*?)\1/g,
      (_match, quote: string, path: string) => `${quote}${absolutePathMarker(path)}${quote}`
    )
    .replace(
      /\(((?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]+)\)/g,
      (_match, path: string) => `(${absolutePathMarker(path)})`
    )
    // Unquoted paths have no reliable end when a segment contains spaces. Redact the remaining line
    // conservatively rather than keeping a suffix that may still contain a mount/share/folder name.
    .replace(/\bfile:\/\/[^\r\n"'<>()[\]{}]+/gi, '<absolute-path>')
    .replace(/\\\\[^\r\n"'<>()[\]{}]+/g, '<absolute-path>')
    .replace(
      /(^|[\s("'=:[{])([A-Za-z]:[\\/][^\r\n"'<>()[\]{}]*)/gm,
      (_match, boundary: string) => `${boundary}<absolute-path>`
    )
    // The double-slash guard excludes URL schemes even when ':' is accepted as a path boundary.
    // Other leading boundaries avoid `I/O` and suffixes below already-redacted named roots.
    .replace(
      /(^|[\s("'=:[{])\/(?!\/)([^\r\n"'<>()[\]{}]*)/gm,
      (_match, boundary: string) => `${boundary}<absolute-path>`
    )
    // Multiple unquoted paths on one line can leave adjacent markers as each conservative matcher
    // stops at an earlier replacement. One marker communicates the same redaction more clearly.
    .replace(/(?:<absolute-path>){2,}/g, '<absolute-path>')

const redactPublicDiagnostics = (text: string, options: StartupDiagnosticsOptions): string => {
  const roots = [
    [options.configRoot, '<config-root>'],
    [options.dataRoot, '<data-root>'],
    [options.home ?? homedir(), '~']
  ] as const
  // Replace the most specific root first when roots are nested (the normal data-root/home case).
  const withNamedRoots = [...roots]
    .sort(([a], [b]) => (b?.length ?? 0) - (a?.length ?? 0))
    .reduce((value, [root, marker]) => replaceRoot(value, root, marker), text)
  return redactRemainingAbsolutePaths(redactSensitiveText(withNamedRoots))
}

const describeError = (error: unknown): { heading: string; frames: string[] } | undefined => {
  if (error instanceof Error) {
    const frames = (error.stack ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('at '))
    return { heading: `${error.name}: ${error.message}`, frames }
  }
  if (typeof error === 'string' && error.length > 0) return { heading: error, frames: [] }
  return undefined
}

const buildStartupDiagnostics = (
  error: unknown,
  options: StartupDiagnosticsOptions = {}
): string | undefined => {
  const sections: string[] = []
  let remainingFrames = MAX_STACK_FRAMES
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    const described = describeError(current)
    if (!described) break
    const frames = described.frames.slice(0, remainingFrames)
    remainingFrames -= frames.length
    // Frame and cause truncation is otherwise silent — mark it so "no marker" really means
    // "complete stack".
    const omittedFrames = described.frames.length - frames.length
    sections.push(
      [
        described.heading,
        ...frames.map((frame) => `    ${frame}`),
        ...(omittedFrames > 0
          ? [`    … ${omittedFrames} more frame${omittedFrames === 1 ? '' : 's'}`]
          : [])
      ].join('\n')
    )
    current = current instanceof Error ? current.cause : undefined
  }
  if (sections.length === 0) return undefined
  if (current !== undefined) {
    sections.push(describeError(current) ? FURTHER_CAUSES_MARKER : NON_ERROR_CAUSE_MARKER)
  }

  const body = redactPublicDiagnostics(sections.join('\nCaused by: '), options)
  if (body.length <= MAX_DIAGNOSTICS_LENGTH) return body
  // Slice by code points, not UTF-16 code units, so a multibyte character astride the cut never
  // leaves a lone surrogate in user-shared text.
  const budget = MAX_DIAGNOSTICS_LENGTH - TRUNCATION_MARKER.length
  return `${[...body].slice(0, budget).join('')}${TRUNCATION_MARKER}`
}

export { buildStartupDiagnostics }
export type { StartupDiagnosticsOptions }
