import { Prisma, type PrismaClient, type ProjectPreviewState } from '@prisma/client'

import {
  PREVIEW_STATE_VERSION,
  normalizePersistedPreviewState,
  type PersistedPreviewState,
  type PreviewStateSnapshot,
  type SavePreviewStateResult
} from '../../shared/preview-state'
import { decodeDataPath, encodeDataPath } from '../storage/data-path'

// Only the preview-state delegate is needed; typing to this subset keeps the repository unit-testable
// with a lightweight mock instead of a real (engine-backed) PrismaClient.
type PreviewStateClient = Pick<PrismaClient, '$transaction' | 'project' | 'projectPreviewState'>

// Parses the JSON items column defensively; a corrupt value degrades to an empty preview state.
const parseItems = (items: string): unknown => {
  try {
    return JSON.parse(items)
  } catch {
    return []
  }
}

// Resolves the Prisma client on demand so a failed initialization is not held forever (see repository.ts).
type PreviewStateClientProvider = () => Promise<PreviewStateClient>

const isMissingPreviewOwnerError = (error: unknown): boolean =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') ||
  (error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message))

const isExistingPreviewStateError = (error: unknown): boolean =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') ||
  (error instanceof Error && /UNIQUE constraint failed/i.test(error.message))

const toSnapshot = (row: ProjectPreviewState): PreviewStateSnapshot => {
  const state = normalizePersistedPreviewState({
    version: PREVIEW_STATE_VERSION,
    panelState: row.panelState,
    activeItemId: row.activeItemId ?? undefined,
    items: parseItems(row.items)
  })

  return {
    revision: row.updatedAt.getTime(),
    state: {
      ...state,
      items: state.items.map((item) => ({ ...item, path: decodeDataPath(item.path) ?? item.path }))
    }
  }
}

// Owns per-project preview panel state reads/writes. The client is resolved lazily per call.
class PreviewStateRepository {
  constructor(private readonly getClient: PreviewStateClientProvider) {}

  // Returns a project's persisted preview state and compare-and-set revision, or null when absent.
  async get(projectId: string): Promise<PreviewStateSnapshot | null> {
    const client = await this.getClient()
    const row = await client.projectPreviewState.findFirst({
      where: { projectId, project: { deletedAt: null } }
    })

    return row ? toSnapshot(row) : null
  }

  // Saves only when the row still has the revision observed by the caller.
  async save(
    projectId: string,
    state: PersistedPreviewState,
    expectedRevision: number
  ): Promise<SavePreviewStateResult> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Preview state revision must be a non-negative integer.')
    }

    const normalized = normalizePersistedPreviewState(state)
    const data = {
      panelState: normalized.panelState,
      activeItemId: normalized.activeItemId ?? null,
      // Item paths under the data root are stored as portable $DATA sentinels.
      items: JSON.stringify([
        ...normalized.items.map((item) => ({
          ...item,
          path: encodeDataPath(item.path) ?? item.path
        })),
        ...(normalized.subagents ? [normalized.subagents] : [])
      ])
    }
    const client = await this.getClient()
    const revision = Math.max(Date.now(), expectedRevision + 1)

    return client.$transaction(async (transaction) => {
      const owner = await transaction.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { id: true }
      })
      if (!owner) return { status: 'saved', revision: 0 }

      if (expectedRevision === 0) {
        // Revision zero means the caller observed no row. A concurrent create becomes a conflict,
        // never an unconditional upsert that replaces the winning snapshot.
        try {
          await transaction.projectPreviewState.create({
            data: { projectId, ...data, updatedAt: new Date(revision) }
          })
          return { status: 'saved', revision }
        } catch (error) {
          if (isMissingPreviewOwnerError(error)) return { status: 'saved', revision: 0 }
          if (!isExistingPreviewStateError(error)) throw error
        }
      } else {
        const result = await transaction.projectPreviewState.updateMany({
          where: { projectId, updatedAt: new Date(expectedRevision) },
          data: { ...data, updatedAt: new Date(revision) }
        })
        if (result.count === 1) return { status: 'saved', revision }
      }

      const current = await transaction.projectPreviewState.findUnique({ where: { projectId } })
      return { status: 'conflict', snapshot: current ? toSnapshot(current) : null }
    })
  }

  // Removes a project's preview state (used when the project is deleted). Missing rows are ignored.
  async delete(projectId: string): Promise<void> {
    const client = await this.getClient()

    await client.projectPreviewState.deleteMany({ where: { projectId } })
  }
}

export { PreviewStateRepository }
export type { PreviewStateClient, PreviewStateClientProvider }
