import type { ProjectFileItem } from '../../../../shared/project-files'

export const FILE_MENTION_DRAG_TYPE = 'application/x-open-science-file-mention'

export type ProjectFileMentionTransfer = Readonly<{
  projectId: string
  file: ProjectFileItem
}>

type Source = { read: () => ProjectFileMentionTransfer | undefined }

// Drag data contains only a one-use token; the payload itself lives in this registry so external
// drops cannot inject references or callbacks. Unlike annotation moves, mentioning copies the file
// into the composer and never removes the source.
class ProjectFileMentionTransfers {
  private sources = new Map<string, Source>()
  private pending:
    { token: string; sourceId: string; snapshot: ProjectFileMentionTransfer } | undefined

  register(id: string, source: Source): () => void {
    this.sources.set(id, source)
    return () => {
      if (this.sources.get(id) === source) this.sources.delete(id)
    }
  }

  begin(sourceId: string): string | undefined {
    const snapshot = this.sources.get(sourceId)?.read()
    if (!snapshot) return undefined
    const token = crypto.randomUUID()
    this.pending = { token, sourceId, snapshot: structuredClone(snapshot) }
    return token
  }

  read(token?: string): ProjectFileMentionTransfer | undefined {
    const pending = this.pending
    if (!pending || (token !== undefined && pending.token !== token)) return undefined
    const current = this.sources.get(pending.sourceId)?.read()
    // The source must still expose the same live file; a stale card cannot be mentioned.
    return current && JSON.stringify(current) === JSON.stringify(pending.snapshot)
      ? pending.snapshot
      : undefined
  }

  cancel(): void {
    this.pending = undefined
  }
}

export const projectFileMentionTransfers = new ProjectFileMentionTransfers()
