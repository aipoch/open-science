import type {
  ClassifiedFailure,
  FailureCategory,
  FailureReason
} from '../../../../shared/failure/contract'

export type NoticeActionId =
  | 'retry'
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
  'internal/reconfigure': {
    ...noticeCatalog.internal,
    secondaryActions: ['retry', 'choose-specialist', 'use-main-agent']
  }
}
export const noticePresentation = (failure: ClassifiedFailure): NoticePresentation =>
  (failure.reason && reasonCatalog[failure.reason]) || noticeCatalog[failure.category]

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
): string =>
  [
    title,
    description,
    ...Object.entries(notice.failure.diagnostics)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => (key === 'raw' ? String(value) : `${key}: ${value}`))
  ].join('\n')
