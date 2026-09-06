import { createSessionRuntimeLookup } from './runtime-lookup'
import {
  selectPersistedUserTaskContext,
  type ClaudeCodeReplayInput
} from '../agents/claude-code-handoff'
import type { SessionRepository } from './repository'
import type { SessionCatalog } from './coordinator'

// Production handoff callback, kept separate from application bootstrap so filesystem stalls can
// be exercised through the same replay preparation used by Claude continuation.
export const createPersistedClaudeReplayPreparer =
  (options: {
    repository: Pick<
      SessionRepository,
      'loadAll' | 'loadSession' | 'assertSessionIdentityOwnership'
    >
    coordinator: Pick<SessionCatalog, 'sessionProjectId'>
    prepareReplay(input: ClaudeCodeReplayInput): void
  }): ((input: ClaudeCodeReplayInput) => Promise<void>) =>
  async (input) => {
    const persisted = (await createSessionRuntimeLookup(options)(input.sessionId))[0]
    options.prepareReplay({
      ...input,
      supportedTaskContext: selectPersistedUserTaskContext(persisted?.messages ?? [])
    })
  }
