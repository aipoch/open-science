export type PersistedSessionStatus =
  'idle' | 'running' | 'waiting-for-user' | 'waiting-permission' | 'waiting-plan-approval' | 'error'

export type PersistedActiveRun = {
  promptMessageId: string
  startedAt: number
}

export type PersistedSessionResumeRecovery = {
  kind: 'resume-required'
  cause: 'app-restart' | 'cancelled' | 'connection-lost'
  // References a user Message on the active Branch. Optional for interrupted control operations
  // such as compaction, where there is no prompt to annotate.
  promptMessageId?: string
}

// Main's exact, not-yet-admitted preparation. This is ownership evidence, not conversation history.
export type PersistedPromptPreparation = {
  id: string
  projectId: string
  sessionId: string
  promptMessageId: string
  mode: 'new' | 'resume' | 'rearm'
  preparedAt: number
  runStartedAt?: number
  expectedState: PersistedPromptPreparation['previousState']
  previousState: {
    status: PersistedSessionStatus
    error?: string
    errorReportable?: boolean
    resumeRecovery?: PersistedSessionResumeRecovery
  }
  // Immutable Main-owned display evidence written on every prepare-prompt (new send, Resume,
  // edit or rearm): the original Branch's notice state before the preparation changes it. Keeps
  // the prior notice and Resume visible until admission; never used for rollback or restart
  // execution, where previousState retains those meanings.
  noticeBaseline?: {
    messageBranchId: string
    // Absent only for a legacy recovery with no original user anchor.
    promptMessageId?: string
    state: PersistedPromptPreparation['previousState']
  }
}
