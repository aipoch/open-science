import { parseApplicationCommandError } from '../../../../../shared/application-command-contract'
import type { TFunction } from 'i18next'

// Only known application messages cross the presentation boundary; IPC errors may contain paths.
export function scheduleErrorText(error: unknown, t: TFunction): string {
  switch (parseApplicationCommandError(error)?.code) {
    case 'schedule-running':
      return t(
        'This task is running. Wait for it to finish or stop the current run before deleting it.'
      )
    case 'schedule-conflict':
      return t('This task changed while you were editing.')
    case 'schedule-pending':
      return t('This task is waiting to run. Its instructions and schedule cannot be changed yet.')
    case 'schedule-limit-reached':
      return t('The run limit has been reached. Increase it before resuming.')
    case 'schedule-no-future-run':
      return t('Choose a future execution time before saving or resuming.')
    case 'schedule-outside-window':
      return t('The next run must be before the task ends.')
    case 'schedule-invalid-change':
      return t('This change is not available. Review the task settings.')
    case 'schedule-target-unavailable':
      return t('The target conversation is unavailable. Choose an available conversation.')
    case 'schedule-request-conflict':
      return t('This request was already used for another task. Start a new request.')
  }
  const message = error instanceof Error ? error.message : String(error)
  const known = [
    t('Conversation not found'),
    t('Notebook not found'),
    t('The scheduled conversation branch is unavailable.'),
    t('The source message is no longer available.'),
    t('This task is waiting to run. Its instructions and schedule cannot be changed yet.')
  ]
  if (known.includes(message)) return message
  return t('Could not complete the schedule request. Try again.')
}

// Unknown values never expose persisted exception text as user-facing copy.
export function scheduleReasonText(reason: string | null, t: TFunction): string {
  switch (reason) {
    case 'expired':
      return t('This run was missed while the app was unavailable.')
    case 'changed':
      return t('This run was skipped because the task changed.')
    case 'archived':
      return t('The project or conversation was archived.')
    case 'conversation_unavailable':
      return t('The conversation for this run is unavailable.')
    case 'unconfirmed':
      return t('The previous run could not be confirmed. Check its results before retrying.')
    case 'interrupted':
      return t('This run was interrupted before it finished.')
    case 'cancelled':
      return t('This run was cancelled.')
    case 'admission_rejected':
      return t('This run could not start. Check the conversation and runtime settings.')
    case 'dispatch_failed':
      return t('This run could not start. Check the conversation and runtime settings.')
    default:
      return t('This run failed. Open its results for details.')
  }
}
