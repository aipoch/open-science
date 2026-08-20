import { homedir } from 'node:os'

// Composes the pre-redacted diagnostic block attached to a blocked database startup state. The
// block is user-shareable by design: it feeds the GitHub issue draft opened from the startup
// failure page, so every absolute path under the user's home directory is collapsed to `~`. The
// budgets below are a generous IPC-safety ceiling; the precise fit to the GitHub issue-URL length
// limit happens at link-build time (startup-issue.ts).

type StartupDiagnosticsEnvironment = {
  appVersion: string
  platform: string
  arch: string
  electron: string
  node: string
}

const MAX_CAUSE_DEPTH = 8
const MAX_STACK_FRAMES = 32
const MAX_DIAGNOSTICS_LENGTH = 16000

const TRUNCATION_MARKER = '… (truncated)'

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

const buildStartupDiagnostics = (
  error: unknown,
  env: StartupDiagnosticsEnvironment
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
  if (describeError(current)) sections.push('… (further causes omitted)')

  const home = homedir()
  const header = [
    `App version: ${env.appVersion} (${env.platform}-${env.arch})`,
    `Electron: ${env.electron} · Node: ${env.node}`
  ].join('\n')
  const body = redactPaths(sections.join('\nCaused by: '), home)
  const diagnostics = `${header}\n\n${body}`
  if (diagnostics.length <= MAX_DIAGNOSTICS_LENGTH) return diagnostics
  return `${diagnostics.slice(0, MAX_DIAGNOSTICS_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
}

export { buildStartupDiagnostics }
export type { StartupDiagnosticsEnvironment }
