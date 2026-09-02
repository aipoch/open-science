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
