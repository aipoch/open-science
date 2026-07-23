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

// Maps process.platform to a human-readable OS name for the preview and the `logs` field. macOS is
// not split into Apple Silicon vs Intel here — the platform string alone can't tell them apart, and
// the user selects the exact variant in the required dropdown themselves.
//
// Note: the bug_report.yml "Operating system" field is a `dropdown`, and GitHub's issue-form prefill
// does NOT support dropdowns (only `input`/`textarea` accept query values). So we don't try to prefill
// it — the detected OS is carried in the `logs` field instead, and the user picks the dropdown value.
export const osLabelForPlatform = (platform: string | undefined): string | undefined => {
  switch (platform) {
    case 'win32':
      return 'Windows'
    case 'linux':
      return 'Linux'
    case 'darwin':
      return 'macOS'
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

// Joins the runtime versions into one line, e.g. "Electron 30.0.0, Chrome 124, Node 20.11".
const formatRuntimeVersions = (context: ErrorReportContext): string => {
  const runtime = context.runtimeVersions
  if (!runtime) return ''
  return [
    runtime.electron ? `Electron ${runtime.electron}` : undefined,
    runtime.chrome ? `Chrome ${runtime.chrome}` : undefined,
    runtime.node ? `Node ${runtime.node}` : undefined
  ]
    .filter(Boolean)
    .join(', ')
}

// Renders the full "Environment" section for the copy-to-clipboard bundle. Kept as a labelled list so
// a maintainer can read it at a glance and a user can scan it before sharing.
export const buildEnvironmentBlock = (context: ErrorReportContext): string => {
  const runtimeLine = formatRuntimeVersions(context)
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

// Builds the `logs` field text: the environment facts that either have no dedicated bug_report.yml
// field (agent framework, runtime versions) or cannot be prefilled (OS — a dropdown GitHub won't
// prefill, so we surface it here so maintainers still see the detected value even if the user's
// dropdown pick differs). App version / provider-model are omitted — they prefill into their own
// inputs. The field is `render: shell`, so this stays plain text (no Markdown).
const buildLogsFieldText = (context: ErrorReportContext): string => {
  const osLabel = osLabelForPlatform(context.platform)
  const runtimeLine = formatRuntimeVersions(context)
  const envLines = [
    osLabel ? `Detected OS: ${osLabel}` : undefined,
    `Agent framework: ${context.frameworkName ?? 'Unknown'}`,
    runtimeLine ? `Runtime: ${runtimeLine}` : undefined
  ].filter(Boolean)

  return [
    ...envLines,
    '',
    'Runtime log not attached automatically (it can contain local paths and prompts).',
    'Reveal it from Settings → General → Diagnostics and attach after reviewing.'
  ].join('\n')
}

// Builds a pre-filled "new issue" URL against the Bug report form. GitHub's issue-form prefill reads
// query params keyed by each field's `id` in bug_report.yml, but ONLY for `input`/`textarea` fields —
// `dropdown` and `checkboxes` fields ignore query values. So we prefill what-happened / app-version /
// provider-model / logs (the OS dropdown and preflight checkboxes are left for the user; the detected
// OS is included in `logs` so it isn't lost). Steps to reproduce is intentionally left blank.
//
// `what-happened` carries only the error/description (from `context.error`); the caller redacts it by
// passing an edited context. Structured fields and `logs` carry the environment, so nothing is
// duplicated across fields.
export const buildGithubIssueUrl = (context: ErrorReportContext): string => {
  const params = new URLSearchParams({ template: 'bug_report.yml' })

  const whatHappened = context.error.trim()
  if (whatHappened) params.set('what-happened', whatHappened)

  if (context.appVersion) params.set('app-version', context.appVersion)

  const providerModel = formatProviderModel(context)
  if (providerModel !== 'Unknown') params.set('provider-model', providerModel)

  params.set('logs', buildLogsFieldText(context))

  return `${APP.links.githubRepo}/issues/new?${params.toString()}`
}
