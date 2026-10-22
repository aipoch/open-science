import type { GrantedLocalRootAccess } from '../../shared/local-fs'

export const AUTHORIZED_DIRECTORIES_PROMPT =
  'For local file operations, obtain authorized directories with list_authorized_directories when needed and follow its reuse rules. Prefer relevant authorized directories for discovery; respect explicit user targets and the session workspace. Use existing MCP tools for actual file operations.'

export const AUTHORIZED_DIRECTORIES_DESCRIPTION =
  'List authorized local directories, ro/rw access, and recorded grant times (legacy entries may show import time). Reuse the latest successful list across this conversation; do not query per file or turn. An application authorization-change notice invalidates it: refresh before the next local file operation. Also refresh if the list is missing from context or access is denied. This tool neither reads files nor grants access.'

export type AuthorizedDirectoriesSnapshot = {
  revision: string
  directories: Array<{
    path: string
    name: string
    access: GrantedLocalRootAccess
    grantedAt: string
  }>
}

export type ConversationDiscoveryRecord = {
  initialRevision: string
  queriedRevision?: string
  notifiedRevision?: string
}

type ConversationDiscovery = ConversationDiscoveryRecord & { issued: number; accepted: number }
type DiscoveryStore = {
  load: (sessionId: string) => Promise<ConversationDiscoveryRecord | undefined>
  save: (sessionId: string, state: ConversationDiscoveryRecord) => Promise<void>
}

// Shared by the MCP bridge and prompt admission; receipts outlive provider/context restoration.
export class AuthorizedDirectoryDiscovery {
  private readonly conversations = new Map<string, ConversationDiscovery>()
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(
    private readonly read: () => Promise<AuthorizedDirectoriesSnapshot>,
    private readonly store?: DiscoveryStore
  ) {}

  // Serialize query/ack writes per conversation so a slow older write cannot clear newer state.
  private withConversation<T>(
    sessionId: string,
    revision: string,
    work: (state: ConversationDiscovery) => Promise<T>
  ): Promise<T> {
    const result = (this.pending.get(sessionId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        let state = this.conversations.get(sessionId)
        if (!state) {
          const saved = await this.store?.load(sessionId)
          state = { ...(saved ?? { initialRevision: revision }), issued: 0, accepted: 0 }
          if (!saved) await this.store?.save(sessionId, state)
          this.conversations.set(sessionId, state)
        }
        return work(state)
      })
    this.pending.set(sessionId, result)
    const clear = (): void => {
      if (this.pending.get(sessionId) === result) this.pending.delete(sessionId)
    }
    void result.then(clear, clear)
    return result
  }

  async query(sessionId: string): Promise<AuthorizedDirectoriesSnapshot> {
    const result = await this.read()
    await this.withConversation(sessionId, result.revision, async (state) => {
      await this.store?.save(sessionId, { ...state, queriedRevision: result.revision })
      state.queriedRevision = result.revision
    })
    return result
  }

  async prepareNotice(
    sessionId: string
  ): Promise<{ text: string; commit: () => Promise<void> } | undefined> {
    const { revision } = await this.read()
    return this.withConversation(sessionId, revision, async (state) => {
      if (revision === (state.notifiedRevision ?? state.initialRevision)) return undefined
      const sequence = ++state.issued
      return {
        text: 'Local directory authorization has changed.',
        commit: () =>
          this.withConversation(sessionId, revision, async (current) => {
            // Acknowledge this snapshot only. Query freshness is a separate receipt.
            if (sequence <= current.accepted) return
            await this.store?.save(sessionId, { ...current, notifiedRevision: revision })
            current.accepted = sequence
            current.notifiedRevision = revision
          })
      }
    })
  }
}
