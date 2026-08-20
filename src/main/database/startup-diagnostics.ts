import { homedir } from 'node:os'

// Composes the pre-redacted stack block attached to a blocked database startup state. The block is
// user-shareable by design: it feeds the GitHub issue draft opened from the startup failure page,
// so every absolute path under the user's home directory is collapsed to `~`. The budgets below are
// a generous IPC-safety ceiling; the precise fit to the GitHub issue-URL length limit happens at
// link-build time (startup-issue.ts). Environment facts travel separately in the typed
// `environment` field (see shared/database-startup.ts).

const MAX_CAUSE_DEPTH = 8
const MAX_STACK_FRAMES = 32
const MAX_DIAGNOSTICS_LENGTH = 16000

const TRUNCATION_MARKER = '… (truncated)'
const FURTHER_CAUSES_MARKER = '… (further causes omitted)'
const NON_ERROR_CAUSE_MARKER = '… (a non-error cause was omitted)'

const redactPaths = (text: string, home: string): string => {
  if (!home || home === '/') return text
  // Windows paths may surface with either separator in stack traces.
  return text.split(home).join('~').split(home.replace(/\\/g, '/')).join('~')
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

const buildStartupDiagnostics = (error: unknown): string | undefined => {
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

  const body = redactPaths(sections.join('\nCaused by: '), homedir())
  if (body.length <= MAX_DIAGNOSTICS_LENGTH) return body
  // Slice by code points, not UTF-16 code units, so a multibyte character astride the cut never
  // leaves a lone surrogate in user-shared text.
  const budget = MAX_DIAGNOSTICS_LENGTH - TRUNCATION_MARKER.length
  return `${[...body].slice(0, budget).join('')}${TRUNCATION_MARKER}`
}

export { buildStartupDiagnostics }
