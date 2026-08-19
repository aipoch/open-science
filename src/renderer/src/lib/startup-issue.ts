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
    ...(error.migrationId ? [['Migration', `\`${error.migrationId}\``] as const] : [])
  ]
  const sections = [
    `## What happened\n\n${error.message}`,
    `| | |\n| --- | --- |\n${environmentRows.map(([key, value]) => `| ${key} | ${value} |`).join('\n')}`,
    '## Steps to reproduce\n\n1. Launch Open Science\n2. The startup screen reports the error above'
  ]
  if (diagnostics) {
    sections.push(
      '## Error stack\n\n' +
        '_Automatically attached and lightly redacted (personal paths are replaced with ~). ' +
        'Review before submitting — feel free to delete this section if you have any concerns._\n\n' +
        `\`\`\`text\n${diagnostics}\n\`\`\``
    )
  }
  return sections.join('\n\n')
}

const toIssueUrl = (error: DatabaseStartupError, diagnostics: string | undefined): string =>
  `${ISSUE_BASE_URL}?title=${encodeURIComponent(buildStartupIssueTitle(error))}&body=${encodeURIComponent(buildStartupIssueBody(error, diagnostics))}`

const fitDiagnosticsToUrl = (error: DatabaseStartupError): string | undefined => {
  const diagnostics = error.diagnostics
  if (!diagnostics) return undefined
  let candidate = diagnostics
  while (candidate && toIssueUrl(error, candidate).length > MAX_URL_LENGTH) {
    candidate = candidate.slice(0, Math.floor(candidate.length / 2))
  }
  return candidate ? `${candidate.trimEnd()}\n${STACK_TRUNCATION_NOTE}` : undefined
}

const buildStartupIssueUrl = (error: DatabaseStartupError): string =>
  toIssueUrl(error, fitDiagnosticsToUrl(error))

export { ISSUE_BASE_URL, buildStartupIssueBody, buildStartupIssueTitle, buildStartupIssueUrl }
