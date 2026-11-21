type ArchiveAvailabilityErrorCode = 'project-archived' | 'session-archived'

const messages: Record<ArchiveAvailabilityErrorCode, string> = {
  'project-archived': 'Restore this archived Project before continuing.',
  'session-archived': 'Restore this archived Session before continuing.'
}

const archiveAvailabilityMessage = (code: ArchiveAvailabilityErrorCode): string => messages[code]

class ArchiveAvailabilityError extends Error {
  constructor(readonly code: ArchiveAvailabilityErrorCode) {
    super(archiveAvailabilityMessage(code))
    this.name = 'ArchiveAvailabilityError'
  }
}

export { ArchiveAvailabilityError, archiveAvailabilityMessage }
export type { ArchiveAvailabilityErrorCode }

// These process-local reasons are selected by the owner that observed the activity.
export type SessionExportBlocker =
  | 'agent'
  | 'delegated'
  | 'notebook'
  | 'compute'
  | 'image'
  | 'pending'
  | 'permission'
  | 'question'
  | 'plan'

export const sessionExportBlockerMessage = (
  reason: SessionExportBlocker,
  translate: (key: string) => string = (key) => key
): string => {
  switch (reason) {
    case 'agent':
      return translate(
        'The agent is still working in this conversation. Wait for it to finish, then export again.'
      )
    case 'delegated':
      return translate('Wait for the subagent to finish its task, then export again.')
    case 'notebook':
      return translate(
        'Wait for the Notebook run to finish, or stop it in the Notebook, then export again.'
      )
    case 'compute':
      return translate(
        'A compute job is still active. Check its status and export again after it finishes.'
      )
    case 'image':
      return translate('An image task is still active. Wait for it to finish, then export again.')
    case 'pending':
      return translate('Session work is still settling. Try exporting again in a moment.')
    case 'permission':
      return translate(
        'Respond to the permission request in the conversation, then export again after the run finishes.'
      )
    case 'question':
      return translate(
        'Answer the pending question in the conversation, then export again after the run finishes.'
      )
    case 'plan':
      return translate(
        'Review the pending plan in the conversation, then export again after the run finishes.'
      )
  }
}

export class SessionExportBlockedError extends Error {
  constructor(readonly reason: SessionExportBlocker) {
    super(sessionExportBlockerMessage(reason))
  }
}
