import { APP } from '../../../../shared/app-config'

// Assembles a failed-run diagnostic report locally. Nothing here transmits anything: the helpers only
// build human-readable text and a pre-filled GitHub "new issue" URL, so the user reviews every field
// before deciding to open a public issue. The runtime log stays on the device and is never inlined.

// Runtime versions the preload bridge exposes; kept loose so callers can pass a partial snapshot.
export type ReportRuntimeVersions = {
  electron?: string
  chrome?: string
  node?: string
}

// Everything the dialog knows about a failed run at report time. All optional but `error` so the
// bundle degrades gracefully when a field (provider, version) has not loaded yet.
export type ErrorReportContext = {
  error: string
  appVersion?: string
  platform?: string
  frameworkName?: string
  providerName?: string
  model?: string
  runtimeVersions?: ReportRuntimeVersions
}

// The exact option labels in .github/ISSUE_TEMPLATE/bug_report.yml's "Operating system" dropdown.
// GitHub matches a prefilled dropdown by label, so these must stay in sync with the template.
const OS_LABEL_WINDOWS = 'Windows'
const OS_LABEL_LINUX = 'Linux'

// Maps process.platform to the template's OS label. macOS is intentionally left unresolved: the
// dropdown splits Apple Silicon vs Intel, which the platform string alone cannot tell apart, so the
// user picks the right one rather than us guessing wrong.
export const osLabelForPlatform = (platform: string | undefined): string | undefined => {
  switch (platform) {
    case 'win32':
      return OS_LABEL_WINDOWS
    case 'linux':
      return OS_LABEL_LINUX
    default:
      return undefined
  }
}

// Formats the provider/model line, tolerating a provider with no concrete model selected.
export const formatProviderModel = (context: ErrorReportContext): string => {
  if (context.providerName && context.model) return `${context.providerName} · ${context.model}`
  if (context.providerName) return context.providerName
  if (context.model) return context.model
  return 'Unknown'
}

// Renders the "Environment" section shared by the on-screen preview and the GitHub issue body. Kept
// as a labelled list so a maintainer can read it at a glance and a user can scan it before sharing.
export const buildEnvironmentBlock = (context: ErrorReportContext): string => {
  const runtime = context.runtimeVersions
  const runtimeLine = runtime
    ? [
        runtime.electron ? `Electron ${runtime.electron}` : undefined,
        runtime.chrome ? `Chrome ${runtime.chrome}` : undefined,
        runtime.node ? `Node ${runtime.node}` : undefined
      ]
        .filter(Boolean)
        .join(', ')
    : ''

  return [
    `- App version: ${context.appVersion ?? 'Unknown'}`,
    `- Operating system: ${osLabelForPlatform(context.platform) ?? context.platform ?? 'Unknown'}`,
    `- Agent framework: ${context.frameworkName ?? 'Unknown'}`,
    `- Provider / model: ${formatProviderModel(context)}`,
    runtimeLine ? `- Runtime: ${runtimeLine}` : undefined
  ]
    .filter(Boolean)
    .join('\n')
}

// Builds the full copy-to-clipboard report: the error, the environment block, and an explicit note
// that the local log is not included so the user knows to attach it themselves if they want to.
export const buildErrorReportText = (context: ErrorReportContext): string =>
  [
    '## What happened',
    '',
    context.error.trim() || 'A run failed with no error message.',
    '',
    '## Environment',
    '',
    buildEnvironmentBlock(context),
    '',
    '## Logs',
    '',
    'The runtime log is not included automatically. It stays on this device; attach it from',
    'Settings → General → Diagnostics if you want to share it.'
  ].join('\n')

// Builds a pre-filled "new issue" URL against the Bug report form. GitHub's issue-form prefill reads
// query params keyed by each field's `id` in bug_report.yml; the dropdown (`os`) is matched by option
// label. Only fields we can fill accurately are set — Steps to reproduce is left for the user, and the
// preflight checkboxes cannot be prefilled, so the user still confirms them in the browser.
//
// `reportBody` overrides the `what-happened` field with user-edited content (the dialog's textarea
// value), so the submitted issue reflects any sensitive-data redactions made before consent.
export const buildGithubIssueUrl = (context: ErrorReportContext, reportBody?: string): string => {
  const params = new URLSearchParams({ template: 'bug_report.yml' })

  // Prefer the user-edited body; fall back to the raw error string.
  const whatHappened = (reportBody ?? context.error).trim()
  if (whatHappened) params.set('what-happened', whatHappened)

  if (context.appVersion) params.set('app-version', context.appVersion)

  const providerModel = formatProviderModel(context)
  if (providerModel !== 'Unknown') params.set('provider-model', providerModel)

  const osLabel = osLabelForPlatform(context.platform)
  if (osLabel) params.set('os', osLabel)

  // Include the full environment block (framework, runtime versions) so the issue captures what the
  // dialog preview shows — previously only the error text and structured fields were sent.
  params.set(
    'logs',
    `**Environment**\n${buildEnvironmentBlock(context)}\n\n` +
      '**Runtime log**\n' +
      'Not attached automatically (may contain local paths and prompts). ' +
      'Reveal it from Settings → General → Diagnostics and attach after reviewing.'
  )

  return `${APP.links.githubRepo}/issues/new?${params.toString()}`
}
