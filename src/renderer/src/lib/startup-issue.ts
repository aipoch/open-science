import type { DatabaseStartupError } from '../../../shared/database-startup'

// Builds the public GitHub "new issue" URL for a blocked database startup. The URL carries the
// whole draft (title + body) so no app-side permissions or tokens are involved; GitHub renders the
// pre-filled form and only asks for an account when the user actually submits.

const ISSUE_BASE_URL = 'https://github.com/aipoch/open-science/issues/new'

// GitHub's issues/new query stays reliable well under ~8KB; leave headroom for percent-encoding.
const MAX_URL_LENGTH = 7800

const STACK_TRUNCATION_NOTE = '… (stack truncated to fit the issue URL)'

const buildStartupIssueTitle = (error: DatabaseStartupError): string =>
  `Startup blocked: ${error.code}${error.migrationId ? ` (${error.migrationId})` : ''}`

const buildStartupIssueBody = (
  error: DatabaseStartupError,
  diagnostics: string | undefined
): string => {
  const environmentRows = [
    ['Error code', `\`${error.code}\``],
    ...(error.migrationId ? [['Migration', `\`${error.migrationId}\``] as const] : []),
    ...(error.environment
      ? ([
          [
            'App version',
            `${error.environment.appVersion} (${error.environment.platform}-${error.environment.arch})`
          ],
          ['Electron', `${error.environment.electron} · Node ${error.environment.node}`]
        ] as const)
      : [])
  ]
  const sections = [
    `## What happened\n\n${error.message}`,
    `## Environment\n\n| | |\n| --- | --- |\n${environmentRows.map(([key, value]) => `| ${key} | ${value} |`).join('\n')}`,
    '## Steps to reproduce\n\n1. Launch Open Science\n2. The startup screen reports the error above'
  ]
  if (diagnostics) {
    sections.push(
      '## Error stack\n\n' +
        '_Automatically attached and redacted for credentials and local paths. ' +
        'Review before submitting — feel free to edit or delete this section._\n\n' +
        `\`\`\`text\n${diagnostics}\n\`\`\``
    )
  }
  return sections.join('\n\n')
}

const toIssueUrl = (error: DatabaseStartupError, diagnostics: string | undefined): string =>
  `${ISSUE_BASE_URL}?title=${encodeURIComponent(buildStartupIssueTitle(error))}&body=${encodeURIComponent(buildStartupIssueBody(error, diagnostics))}`

const withTruncationNote = (diagnostics: string, end: number): string =>
  `${diagnostics.slice(0, end).trimEnd()}\n${STACK_TRUNCATION_NOTE}`

const fitDiagnosticsToUrl = (
  error: DatabaseStartupError,
  diagnostics: string | undefined
): string | undefined => {
  if (!diagnostics) return undefined
  if (toIssueUrl(error, diagnostics).length <= MAX_URL_LENGTH) return diagnostics
  // Binary search the longest prefix whose encoded URL still fits. Encoded length is not linear in
  // the raw length (multibyte characters expand), so measure the real URL at each step.
  let low = 0
  let high = diagnostics.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (toIssueUrl(error, withTruncationNote(diagnostics, mid)).length <= MAX_URL_LENGTH) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return low > 0 ? withTruncationNote(diagnostics, low) : undefined
}

const buildStartupIssueUrl = (
  error: DatabaseStartupError,
  diagnostics: string | undefined = error.diagnostics
): string => toIssueUrl(error, fitDiagnosticsToUrl(error, diagnostics))

export { ISSUE_BASE_URL, buildStartupIssueBody, buildStartupIssueTitle, buildStartupIssueUrl }
