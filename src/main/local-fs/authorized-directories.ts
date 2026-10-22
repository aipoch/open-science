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

type NoticeState = { revision: string; issued: number; accepted: number }

// A live provider attachment owns its notice baseline; no query or durable state is kept.
export class AuthorizedDirectoryNotices {
  private readonly sessions = new WeakMap<object, NoticeState>()

  constructor(private readonly read: () => Promise<AuthorizedDirectoriesSnapshot>) {}

  async initialize(session: object): Promise<void> {
    if (this.sessions.has(session)) return
    const { revision } = await this.read()
    this.sessions.set(session, { revision, issued: 0, accepted: 0 })
  }

  async prepareNotice(session: object): Promise<{ text: string; commit: () => void } | undefined> {
    const state = this.sessions.get(session)
    const { revision } = await this.read()
    if (!state) {
      this.sessions.set(session, { revision, issued: 0, accepted: 0 })
      return undefined
    }
    if (revision === state.revision) return undefined
    const sequence = ++state.issued
    return {
      text: 'Local directory authorization has changed.',
      commit: () => {
        if (this.sessions.get(session) !== state || sequence <= state.accepted) return
        state.accepted = sequence
        state.revision = revision
      }
    }
  }
}
