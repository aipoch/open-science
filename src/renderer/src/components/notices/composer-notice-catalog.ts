import { providerErrorExcerpt } from '@aipoch/providers/errors'
import { redactSensitiveText } from '@aipoch/diagnostics'
import type {
  ClassifiedFailure,
  FailureCategory,
  FailureReason
} from '../../../../shared/failure/contract'

export type NoticeActionId =
  | 'retry'
  | 'refresh'
  | 'resume'
  | 'open-provider-settings'
  | 'open-agent-settings'
  | 'export-diagnostics'
  | 'open-environment'
  | 'compact'
  | 'remove-attachments'
  | 'new-session'
  | 'copy-error'
  | 'report'
  | 'choose-specialist'
  | 'use-main-agent'
export type NoticePresentation = Readonly<{
  level: 'warning' | 'error' | 'info'
  titleKey: string
  descriptionKey: string
  primaryAction?: NoticeActionId
  secondaryActions: readonly NoticeActionId[]
  feedback: 'link' | 'primary' | 'none'
}>

export const noticeCatalog = {
  configuration: {
    level: 'warning',
    titleKey: 'Model configuration needs attention',
    descriptionKey: 'Check your credentials, model and account settings, then retry.',
    primaryAction: 'open-provider-settings',
    secondaryActions: ['retry'],
    feedback: 'link'
  },
  service: {
    level: 'warning',
    titleKey: 'The model service is temporarily unavailable',
    descriptionKey: 'The request could not finish. Wait a moment, then retry.',
    primaryAction: 'retry',
    secondaryActions: [],
    feedback: 'link'
  },
  environment: {
    level: 'warning',
    titleKey: 'The local environment needs attention',
    descriptionKey: 'Check the required runtime, files and permissions, then retry.',
    primaryAction: 'open-environment',
    secondaryActions: ['retry'],
    feedback: 'link'
  },
  input: {
    level: 'info',
    titleKey: 'The message needs adjustment',
    descriptionKey:
      'Reduce the conversation context or remove unsupported attachments before trying again.',
    primaryAction: 'compact',
    secondaryActions: ['remove-attachments', 'new-session'],
    feedback: 'none'
  },
  session: {
    level: 'info',
    titleKey: 'The conversation was interrupted',
    descriptionKey: 'Resume the conversation to reconnect and continue.',
    primaryAction: 'resume',
    secondaryActions: [],
    feedback: 'none'
  },
  internal: {
    level: 'error',
    titleKey: 'An unexpected application error occurred',
    descriptionKey: 'Report this error with its diagnostics to help us investigate.',
    primaryAction: 'report',
    secondaryActions: ['retry', 'export-diagnostics'],
    feedback: 'primary'
  }
} as const satisfies Record<FailureCategory, NoticePresentation>

// Unknown reasons retain category copy.
export const reasonCatalog: Partial<Record<FailureReason, NoticePresentation>> = {
  'configuration/model-unavailable': {
    level: 'warning',
    titleKey: 'Model configuration needs attention',
    descriptionKey: 'The selected model is unavailable. Select another model in Settings.',
    primaryAction: 'open-provider-settings',
    secondaryActions: ['retry'],
    feedback: 'link'
  },
  'service/unavailable': noticeCatalog.service,
  'configuration/endpoint-invalid': {
    ...noticeCatalog.configuration,
    titleKey: 'The model service address is invalid',
    descriptionKey: 'Check the model provider base URL and endpoint path, then retry.',
    primaryAction: 'open-provider-settings',
    secondaryActions: ['retry']
  },
  'configuration/auth-failed': {
    ...noticeCatalog.configuration,
    titleKey: 'Model provider credentials need attention',
    descriptionKey: 'Check the model provider API key or credentials, then retry.',
    primaryAction: 'open-provider-settings',
    secondaryActions: ['retry']
  },
  'configuration/billing': {
    ...noticeCatalog.configuration,
    titleKey: 'Model provider quota needs attention',
    descriptionKey: 'Check the model provider plan, quota or account balance, then retry.',
    primaryAction: 'open-provider-settings',
    secondaryActions: ['retry']
  },
  'configuration/request-invalid': {
    ...noticeCatalog.configuration,
    titleKey: 'Request parameters need attention',
    descriptionKey:
      'The model provider rejected this request. Check the model and provider settings.',
    primaryAction: 'open-provider-settings',
    secondaryActions: ['retry']
  },
  'service/rate-limited': {
    ...noticeCatalog.service,
    titleKey: 'Request limited',
    descriptionKey: 'The model provider is limiting requests. Wait a moment, then retry.',
    primaryAction: 'retry',
    secondaryActions: []
  },
  'service/connection-failed': {
    ...noticeCatalog.service,
    titleKey: 'Unable to connect to the model service',
    descriptionKey: 'Check the network connection and model service address, then retry.',
    primaryAction: 'retry',
    secondaryActions: ['open-provider-settings']
  },
  'service/response-interrupted': {
    ...noticeCatalog.service,
    titleKey: 'The model response was interrupted',
    descriptionKey: 'The connection closed before the model finished replying. Retry the request.',
    primaryAction: 'retry',
    secondaryActions: []
  },
  'service/response-invalid': {
    ...noticeCatalog.service,
    titleKey: 'The model response could not be parsed',
    descriptionKey:
      'The model provider returned an invalid response. Check the protocol settings or retry.',
    primaryAction: 'retry',
    secondaryActions: ['open-provider-settings']
  },
  'service/provider-error': {
    ...noticeCatalog.service,
    titleKey: 'Model request failed',
    descriptionKey:
      'The model provider could not complete the request. Retry or check the model provider settings.',
    primaryAction: 'retry',
    secondaryActions: ['open-provider-settings']
  },
  'input/context-overflow': {
    ...noticeCatalog.input,
    titleKey: 'The input is too long',
    descriptionKey: 'Shorten the conversation or remove some attachments, then retry.',
    primaryAction: 'compact',
    secondaryActions: ['remove-attachments']
  },
  'configuration/vision-model': {
    level: 'warning',
    titleKey: 'Image support is not configured',
    descriptionKey:
      "The selected model doesn't support images. Configure a Vision model in Settings > Model to enable image support.",
    primaryAction: 'open-provider-settings',
    secondaryActions: [],
    feedback: 'none'
  },
  'service/image-observation': {
    ...noticeCatalog.service,
    primaryAction: 'refresh'
  },
  'service/prompt-optimization': {
    level: 'warning',
    titleKey: 'Optimize question',
    descriptionKey: 'Could not optimize your question. Your draft was kept. Please try again.',
    secondaryActions: [],
    feedback: 'none'
  },
  'input/prompt-optimization-too-long': {
    level: 'info',
    titleKey: 'Optimize question',
    descriptionKey: 'Shorten your question to optimize it (maximum 16,000 characters).',
    secondaryActions: [],
    feedback: 'none'
  },
  'input/prompt-optimization-changed': {
    level: 'info',
    titleKey: 'Optimize question',
    descriptionKey: 'Your input changed while optimizing. Please try again.',
    secondaryActions: [],
    feedback: 'none'
  },
  'session/tool-outcome-unknown': {
    level: 'warning',
    titleKey: 'Check the interrupted tool result',
    descriptionKey:
      'The tool may have changed files or an external service. Check its actual result before continuing. Export diagnostics to identify the call, then start a new conversation with the verified state. This conversation will not repeat the uncertain operation.',
    primaryAction: 'export-diagnostics',
    secondaryActions: ['new-session'],
    feedback: 'none'
  },
  'configuration/claude-cli': {
    ...noticeCatalog.configuration,
    primaryAction: 'open-agent-settings'
  },
  'configuration/codex-cli': {
    ...noticeCatalog.configuration,
    primaryAction: 'open-agent-settings'
  },
  'configuration/codex-adapter': {
    ...noticeCatalog.configuration,
    primaryAction: 'open-agent-settings'
  },
  'internal/model-request-stack-overflow': {
    ...noticeCatalog.internal,
    titleKey: 'Call stack limit reached during a model request',
    descriptionKey:
      'This turn stopped. Export diagnostics to help identify where the call stack limit was reached.'
  },
  'internal/reconfigure': {
    ...noticeCatalog.internal,
    secondaryActions: ['retry', 'choose-specialist', 'use-main-agent']
  }
}
// This is the SDK's display prefix, outside the returned body. Its presence alone
// does not identify which service failed. Keep the body opaque, including JSON.
const rpcInternalPrefix = /^\s*(?:RequestError:\s*)?internal error(?:\s*:\s*|\.?\s*$)/i

const isUnattributedRequest = ({ category, reason, diagnostics }: ClassifiedFailure): boolean =>
  category === 'internal' &&
  !reason &&
  (diagnostics.status !== undefined ||
    diagnostics.code === '-32603' ||
    rpcInternalPrefix.test(diagnostics.raw ?? ''))

export const noticePresentation = (
  failure: ClassifiedFailure,
  operation?: string
): NoticePresentation => {
  // Attachment recovery belongs to the transfer row or the editable draft.
  if (operation === 'attachment' || operation === 'stop')
    return {
      ...noticeCatalog.internal,
      level: 'warning',
      primaryAction: undefined,
      secondaryActions: [],
      feedback: 'none'
    }
  if (isUnattributedRequest(failure))
    return {
      ...noticeCatalog.internal,
      titleKey: 'Request failed',
      descriptionKey: 'The action could not be completed. See details and try again.'
    }
  const presentation =
    (failure.reason && reasonCatalog[failure.reason]) || noticeCatalog[failure.category]
  if (!failure.responseMessage) return presentation
  return {
    ...presentation,
    titleKey:
      failure.diagnostics.protocol ||
      (failure.reason === 'configuration/billing' && failure.diagnostics.status === 402) ||
      providerErrorExcerpt(failure.responseMessage)
        ? presentation.titleKey
        : 'Model provider error',
    feedback: 'none'
  }
}

export type ComposerNotice = Readonly<{
  id: string
  source: 'session' | 'turn' | 'environment' | 'operation' | 'input'
  failure: ClassifiedFailure
  occurredAt: number
  blocksSend?: boolean
  promptMessageId?: string
  recovery?: 'retry-artifact-publication'
  recoveryCause?: string
  operation?: string
  summary?: { title: string; description?: string }
}>
export type NoticeActionHandler = Readonly<{
  run: (notice: ComposerNotice) => void | Promise<void>
  busy?: boolean
  available?: (notice: ComposerNotice) => boolean
  disabled?: (notice: ComposerNotice) => boolean
}>
export type NoticeActionHandlers = Partial<Record<NoticeActionId, NoticeActionHandler>>

export const noticePriority = (notice: ComposerNotice): number =>
  notice.blocksSend || notice.failure.category === 'session'
    ? 0
    : notice.source === 'turn'
      ? 1
      : notice.failure.category === 'environment'
        ? 2
        : notice.failure.category === 'input'
          ? 4
          : 3

export const formatNoticeDiagnostics = (
  notice: ComposerNotice,
  title: string,
  description: string
): { details: string; fullText: string } => {
  const { raw, providerExcerpt, ...fields } = notice.failure.diagnostics
  const reportedResponse = fields.protocol ? providerExcerpt : notice.failure.responseMessage
  const response = reportedResponse && redactSensitiveText(reportedResponse)
  const showResponseInfo = Boolean(
    response ||
    fields.protocol ||
    fields.status !== undefined ||
    notice.failure.category === 'service' ||
    (notice.failure.category !== 'internal' && rpcInternalPrefix.test(raw ?? '')) ||
    isUnattributedRequest(notice.failure)
  )
  const diagnostic =
    raw && redactSensitiveText(showResponseInfo ? raw.replace(rpcInternalPrefix, '') : raw)
  const detail = [
    diagnostic !== title && diagnostic !== description ? diagnostic : undefined,
    response !== title && response !== description && response && !diagnostic?.includes(response)
      ? response
      : undefined
  ]
    .filter(Boolean)
    .join('\n')
  const responseDetail = detail && showResponseInfo ? `Info: ${detail}` : undefined
  const metadata = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value}`)
  const diagnosticText = [...metadata, responseDetail ?? detail].filter(Boolean).join('\n')
  const fullText = [title, description, diagnosticText].filter(Boolean).join('\n')
  // Local operations may use their recovery instructions as the entire diagnostic.
  const localInstructions =
    notice.source === 'operation' && !notice.summary && diagnostic === description
  return { details: localInstructions ? fullText : diagnosticText, fullText }
}
