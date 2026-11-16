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
    primaryAction: 'retry',
    secondaryActions: ['open-provider-settings'],
    feedback: 'link'
  },
  service: {
    level: 'warning',
    titleKey: "The model service couldn't respond",
    descriptionKey: 'Try again in a moment.',
    primaryAction: 'retry',
    secondaryActions: [],
    feedback: 'link'
  },
  environment: {
    level: 'warning',
    titleKey: 'The local environment needs attention',
    descriptionKey: 'Check the required runtime, files and permissions, then retry.',
    primaryAction: 'retry',
    secondaryActions: ['open-environment'],
    feedback: 'link'
  },
  input: {
    level: 'info',
    titleKey: 'The message needs adjustment',
    descriptionKey:
      'Reduce the conversation context or remove unsupported attachments before trying again.',
    primaryAction: 'retry',
    secondaryActions: ['compact', 'remove-attachments', 'new-session'],
    feedback: 'none'
  },
  session: {
    level: 'info',
    titleKey: "Couldn't complete your request",
    descriptionKey: 'Please try again.',
    primaryAction: 'resume',
    secondaryActions: [],
    feedback: 'none'
  },
  internal: {
    level: 'error',
    titleKey: "Couldn't complete your request",
    descriptionKey: 'Please try again.',
    primaryAction: 'retry',
    secondaryActions: [],
    feedback: 'link'
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
    titleKey: 'An operation needs checking',
    descriptionKey: 'Check the affected file or service before repeating the operation.',
    primaryAction: 'retry',
    secondaryActions: ['new-session'],
    feedback: 'none'
  },
  'configuration/auth-failed': {
    ...noticeCatalog.configuration,
    titleKey: 'Model authentication failed',
    descriptionKey: 'Check your sign-in or credentials in Settings, then retry.'
  },
  'service/connection-failed': {
    ...noticeCatalog.service,
    titleKey: "Couldn't connect to the model service",
    descriptionKey: 'Check your connection, then try again.'
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
const resolveNoticePresentation = (
  failure: ClassifiedFailure,
  owner?: Pick<ComposerNotice, 'recovery' | 'recoveryState'>
): NoticePresentation => {
  // Publication ownership is only attached after completed analysis by its existing owner.
  if (owner?.recovery === 'retry-artifact-publication')
    return {
      ...noticeCatalog.environment,
      titleKey: "Couldn't save the results",
      descriptionKey: 'Retry to save the results. The analysis does not need to run again.',
      secondaryActions: []
    }
  if (owner?.recoveryState)
    return {
      ...noticeCatalog.internal,
      level: 'info',
      titleKey: owner.recoveryState === 'ready' ? 'Ready to retry' : 'Retry failed',
      descriptionKey:
        owner.recoveryState === 'ready' ? 'Try again when you are ready.' : 'Please try again.'
    }
  // These exact production conditions are narrower than the general media/runtime reasons.
  if (
    failure.reason === 'input/media-invalid' &&
    failure.diagnostics.raw ===
      'This conversation needs image replay, but the selected model does not support image input.'
  )
    return {
      ...noticeCatalog.input,
      titleKey: "This model can't read images",
      descriptionKey: 'Choose a model that supports images, then retry.'
    }
  if (
    failure.reason === 'environment/runtime-unavailable' &&
    failure.diagnostics.raw === 'Notebook kernel failed to start'
  )
    return {
      ...noticeCatalog.environment,
      titleKey: "Notebook couldn't start",
      descriptionKey: 'Check the Notebook setup in Settings, then retry.'
    }
  return (failure.reason && reasonCatalog[failure.reason]) || noticeCatalog[failure.category]
}

export const noticePresentation = (
  failure: ClassifiedFailure,
  owner?: Pick<ComposerNotice, 'recovery' | 'recoveryState'>
): NoticePresentation => {
  const presentation = resolveNoticePresentation(failure, owner)
  return failure.responseMessage ? { ...presentation, feedback: 'none' } : presentation
}

export type ComposerNotice = Readonly<{
  id: string
  source: 'session' | 'turn' | 'environment' | 'operation' | 'input'
  failure: ClassifiedFailure
  occurredAt: number
  blocksSend?: boolean
  promptMessageId?: string
  recovery?: 'retry-artifact-publication'
  // Set only by the recovery owner after prerequisite verification or a failed retry.
  recoveryState?: 'ready' | 'retry-failed'
  recoveryCause?: string
  operation?: string
}>
export type NoticeActionHandler = Readonly<{
  run: (notice: ComposerNotice) => void | Promise<void>
  busy?: boolean | ((notice: ComposerNotice) => boolean)
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
    ...(description ? [description] : []),
    ...Object.entries(notice.failure.diagnostics)
      .filter(
        ([key, value]) =>
          value !== undefined && (key !== 'raw' || (value !== title && value !== description))
      )
      .map(([key, value]) => (key === 'raw' ? String(value) : `${key}: ${value}`))
  ].join('\n')

export type NoticeDetail = Readonly<{
  label: 'Model' | 'Provider' | 'Status' | 'Code' | 'Error'
  value: string
}>

// A small readable projection, separate from the complete report/export diagnostics.
// Request/turn/session identities, serialized payloads and stack frames stay in their existing owners.
export const readableNoticeDetails = (
  notice: ComposerNotice,
  title: string,
  description: string
): readonly NoticeDetail[] => {
  const { diagnostics, responseMessage } = notice.failure
  const details: NoticeDetail[] = []
  const presentation = noticePresentation(notice.failure, notice)
  const seen = new Set([
    title.trim(),
    description.trim(),
    presentation.titleKey,
    presentation.descriptionKey
  ])
  const add = (label: NoticeDetail['label'], value: string | number | undefined): void => {
    const text = value === undefined ? '' : String(value).trim()
    if (!text || seen.has(text)) return
    seen.add(text)
    details.push({ label, value: text })
  }
  add('Model', diagnostics.model)
  add('Provider', diagnostics.provider)
  add('Status', diagnostics.status)
  add('Code', diagnostics.code)
  const summary = (responseMessage || diagnostics.raw)?.trim()
  // Raw data is not parsed into a second diagnostic schema or displayed as a full payload.
  if (summary && !summary.startsWith('{') && !summary.startsWith('[')) {
    const readable =
      notice.failure.reason === 'session/tool-outcome-unknown' &&
      summary.includes('Built-in Agent tool outcome is unknown: ')
        ? summary.replace(/\s+\([^)]*\)(?=, |$)/g, '')
        : summary
    const firstLine = readable
      .split(/\r?\n/)[0]
      .split(/[{[]|\s+at\s+\S+\s*\(/)[0]
      .trim()
    if (!/^\s*at\s|^(?:Traceback|Stack trace)\b/.test(firstLine))
      add('Error', firstLine.slice(0, 1200))
  }
  return details
}
