import { APP } from '../../../../shared/app-config'
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  isCodexSubscriptionProviderId
} from '../../../../shared/settings'

// Assembles a failed-run diagnostic report locally. Nothing here transmits anything: the helpers only
// build human-readable text and a pre-filled GitHub "new issue" URL, so the user reviews every field
// before deciding to open a public issue. The runtime log stays on the device and is never inlined.

// Shown in the failure row AND seeded into the report when a failed run carries no error text. Defined
// once so the text the user sees always equals the text they report ("shown == reported").
export const RUN_FAILED_FALLBACK_ERROR = 'The run failed with no error message.'
export const normalizeRunFailureError = (error: string | null | undefined): string =>
  error?.trim() || RUN_FAILED_FALLBACK_ERROR

// Bound the serialized request URI, not decoded field lengths: URLSearchParams can expand one Unicode
// code point into several percent-encoded bytes. Copy details remains full-fidelity when prefill fields
// must be shortened to stay within this conservative request-line budget.
export const MAX_GITHUB_ISSUE_URL_LENGTH = 7000
const ERROR_TRUNCATION_MARKER =
  '\n\n…(truncated — use “Copy details” for the full error and attach the log)'
const FIELD_TRUNCATION_MARKER = '…(truncated; full value is in Copy details)'
const ENCODED_FIELD_BUDGETS = {
  'app-version': 128,
  'provider-model': 512,
  logs: 1500
} as const

type GithubIssueFieldId = 'what-happened' | 'app-version' | 'provider-model' | 'logs'

export type GithubIssuePrefill = {
  url: string
  fields: Partial<Record<GithubIssueFieldId, string>>
  truncatedFields: GithubIssueFieldId[]
}

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
  model?: string
}

// The framework/provider/model the report should attribute the failure to, resolved from the session's
// stored subject and run-time model snapshot so later settings changes cannot misattribute it.
export type ResolvedSubject = {
  frameworkName?: string
  providerName?: string
  model?: string
}

const normalizeSessionProviderId = (providerId: string | undefined): string | undefined => {
  if (!providerId) return undefined

  return isCodexSubscriptionProviderId(providerId) ||
    providerId === 'codex-shared' ||
    providerId === 'codex-isolated'
    ? CODEX_SUBSCRIPTION_PROVIDER_ID
    : providerId
}

// Resolves the framework name and provider from the session's own stored identifiers. backendId is
// encoded as "${frameworkId}:${providerId}" (see service.ts) — we split on the first colon because
// provider ids can themselves contain colons (e.g. "ssh:alias"). Codex subscription sessions retain
// mode-specific backend ids, which normalize to the single provider card exposed in renderer settings.
export const resolveSessionSubject = (
  subject: SessionReportSubject,
  providers: Array<{ id: string; name: string }>,
  agentFrameworks: Array<{ id: string; displayName: string }>
): ResolvedSubject => {
  const frameworkName = subject.agentFrameworkId
    ? (agentFrameworks.find((f) => f.id === subject.agentFrameworkId)?.displayName ??
      subject.agentFrameworkId)
    : undefined

  if (!subject.agentBackendId) return { frameworkName, model: subject.model }

  // backendId format: "{frameworkId}:{providerId}" — split on first colon only.
  const colonIdx = subject.agentBackendId.indexOf(':')
  const providerId = normalizeSessionProviderId(
    colonIdx !== -1 ? subject.agentBackendId.slice(colonIdx + 1) : undefined
  )

  const provider = providerId ? providers.find((p) => p.id === providerId) : undefined
  const providerName = provider?.name

  return { frameworkName, providerName, model: subject.model }
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

const issueUrlFromParams = (params: URLSearchParams): string =>
  `${APP.links.githubRepo}/issues/new?${params.toString()}`

const encodedParamValueLength = (key: string, value: string): number => {
  const serialized = new URLSearchParams([[key, value]]).toString()
  return serialized.length - key.length - 1
}

const truncateToEncodedBudget = (
  key: string,
  value: string,
  budget: number,
  marker: string
): { value: string; truncated: boolean } => {
  if (encodedParamValueLength(key, value) <= budget) return { value, truncated: false }

  const characters = Array.from(value)
  let low = 0
  let high = characters.length

  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const candidate = `${characters.slice(0, mid).join('')}${marker}`

    if (encodedParamValueLength(key, candidate) <= budget) low = mid
    else high = mid - 1
  }

  return { value: `${characters.slice(0, low).join('')}${marker}`, truncated: true }
}

const fitErrorToUrlBudget = (
  params: URLSearchParams,
  value: string
): { value: string; truncated: boolean } => {
  params.set('what-happened', value)
  if (issueUrlFromParams(params).length <= MAX_GITHUB_ISSUE_URL_LENGTH) {
    return { value, truncated: false }
  }

  const characters = Array.from(value)
  let low = 0
  let high = characters.length

  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const candidate = `${characters.slice(0, mid).join('')}${ERROR_TRUNCATION_MARKER}`
    params.set('what-happened', candidate)

    if (issueUrlFromParams(params).length <= MAX_GITHUB_ISSUE_URL_LENGTH) low = mid
    else high = mid - 1
  }

  const bounded = `${characters.slice(0, low).join('')}${ERROR_TRUNCATION_MARKER}`
  params.set('what-happened', bounded)
  return { value: bounded, truncated: true }
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
export const buildGithubIssuePrefill = (context: ErrorReportContext): GithubIssuePrefill => {
  const params = new URLSearchParams({ template: 'bug_report.yml' })
  const truncatedFields: GithubIssueFieldId[] = []

  const whatHappened = context.error.trim()
  if (whatHappened) params.set('what-happened', whatHappened)

  if (context.appVersion) params.set('app-version', context.appVersion)

  const providerModel = formatProviderModel(context)
  if (providerModel !== 'Unknown') params.set('provider-model', providerModel)

  params.set('logs', buildLogsFieldText(context))

  if (issueUrlFromParams(params).length > MAX_GITHUB_ISSUE_URL_LENGTH) {
    for (const [field, budget] of Object.entries(ENCODED_FIELD_BUDGETS) as Array<
      [keyof typeof ENCODED_FIELD_BUDGETS, number]
    >) {
      const value = params.get(field)
      if (!value) continue

      const bounded = truncateToEncodedBudget(field, value, budget, FIELD_TRUNCATION_MARKER)
      params.set(field, bounded.value)
      if (bounded.truncated) truncatedFields.push(field)
    }

    if (whatHappened) {
      const bounded = fitErrorToUrlBudget(params, whatHappened)
      if (bounded.truncated) truncatedFields.push('what-happened')
    }
  }

  const fields: GithubIssuePrefill['fields'] = {}
  for (const field of ['what-happened', 'app-version', 'provider-model', 'logs'] as const) {
    const value = params.get(field)
    if (value !== null) fields[field] = value
  }

  return { url: issueUrlFromParams(params), fields, truncatedFields }
}

export const buildGithubIssueUrl = (context: ErrorReportContext): string =>
  buildGithubIssuePrefill(context).url
