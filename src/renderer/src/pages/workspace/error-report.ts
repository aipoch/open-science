import { APP } from '../../../../shared/app-config'

// Assembles a failed-run diagnostic report locally. Nothing here transmits anything: the helpers only
// build human-readable text and a pre-filled GitHub "new issue" URL, so the user reviews every field
// before deciding to open a public issue. The runtime log stays on the device and is never inlined.

// Shown in the failure row AND seeded into the report when a failed run carries no error text. Defined
// once so the text the user sees always equals the text they report ("shown == reported").
export const RUN_FAILED_FALLBACK_ERROR = 'The run failed with no error message.'

// Upper bound for the error text placed in the `what-happened` query param. GitHub's issue-form prefill
// (and browsers) reject over-long request URIs with a 414, which would drop the user on an error page
// instead of the prefilled form — a regression in the very failure-reporting path this feature adds. A
// long stack trace is truncated with a visible marker; the full text is always available via Copy
// details (buildErrorReportText is never truncated). Chosen conservatively: query values are percent-
// encoded, so a char of stack trace can cost ~3 bytes in the URL.
export const MAX_WHAT_HAPPENED_LENGTH = 6000
const TRUNCATION_MARKER =
  '\n\n…(truncated — use “Copy details” for the full error and attach the log)'

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

// Holds the session-level identifiers that tell us which framework and backend were active when the
// run failed. Both are optional because older sessions were persisted before these fields were added.
export type SessionReportSubject = {
  agentFrameworkId?: string
  agentBackendId?: string
}

// The framework/provider/model the report should attribute the failure to, resolved from the session's
// own stored identifiers so a config change after the failure doesn't misattribute it.
export type ResolvedSubject = {
  frameworkName?: string
  providerName?: string
  model?: string
}

// Resolves the framework name and provider from the session's own stored identifiers. backendId is
// encoded as "${frameworkId}:${providerId}" (see service.ts) — we split on the first colon because
// provider ids can themselves contain colons (e.g. "ssh:alias"). The model is included only when the
// session's provider still matches the currently active one; otherwise omitting it avoids reporting a
// model that belonged to a later config switch.
export const resolveSessionSubject = (
  subject: SessionReportSubject,
  providers: Array<{ id: string; name: string }>,
  activeProviderId: string | undefined,
  activeModel: string | undefined,
  agentFrameworks: Array<{ id: string; displayName: string }>
): ResolvedSubject => {
  const frameworkName = subject.agentFrameworkId
    ? (agentFrameworks.find((f) => f.id === subject.agentFrameworkId)?.displayName ??
      subject.agentFrameworkId)
    : undefined

  if (!subject.agentBackendId) return { frameworkName }

  // backendId format: "{frameworkId}:{providerId}" — split on first colon only.
  const colonIdx = subject.agentBackendId.indexOf(':')
  const providerId = colonIdx !== -1 ? subject.agentBackendId.slice(colonIdx + 1) : undefined

  const provider = providerId ? providers.find((p) => p.id === providerId) : undefined
  const providerName = provider?.name

  // Only include the active model when the session's provider is still the active one; a config
  // switch after the failure would make the model misleading.
  const model =
    providerId && activeProviderId === providerId && activeModel ? activeModel : undefined

  return { frameworkName, providerName, model }
}
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
  if (whatHappened) {
    // Bound the error text so a long stack trace can't push the URL past GitHub's URI limit (414).
    const bounded =
      whatHappened.length > MAX_WHAT_HAPPENED_LENGTH
        ? whatHappened.slice(0, MAX_WHAT_HAPPENED_LENGTH) + TRUNCATION_MARKER
        : whatHappened
    params.set('what-happened', bounded)
  }

  if (context.appVersion) params.set('app-version', context.appVersion)

  const providerModel = formatProviderModel(context)
  if (providerModel !== 'Unknown') params.set('provider-model', providerModel)

  params.set('logs', buildLogsFieldText(context))

  return `${APP.links.githubRepo}/issues/new?${params.toString()}`
}
