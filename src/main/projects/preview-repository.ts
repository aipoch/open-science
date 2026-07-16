import type { PrismaClient } from '@prisma/client'

import {
  PREVIEW_STATE_VERSION,
  normalizePersistedPreviewState,
  type PersistedPreviewState
} from '../../shared/preview-state'
import { decodeDataPath, encodeDataPath } from '../storage/data-path'

// Only the preview-state delegate is needed; typing to this subset keeps the repository unit-testable
// with a lightweight mock instead of a real (engine-backed) PrismaClient.
type PreviewStateClient = Pick<PrismaClient, 'projectPreviewState'>

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

// Owns per-project preview panel state reads/writes. The client is resolved lazily per call.
class PreviewStateRepository {
  constructor(private readonly getClient: PreviewStateClientProvider) {}

  // Returns a project's persisted preview state, or null when none has been saved yet.
  async get(projectId: string): Promise<PersistedPreviewState | null> {
    const client = await this.getClient()
    const row = await client.projectPreviewState.findUnique({ where: { projectId } })

    if (!row) return null

    const state = normalizePersistedPreviewState({
      version: PREVIEW_STATE_VERSION,
      panelState: row.panelState,
      activeItemId: row.activeItemId ?? undefined,
      items: parseItems(row.items)
    })

    // Resolve item paths against the current data root so a relocated root needs no rewrite.
    return {
      ...state,
      items: state.items.map((item) => ({ ...item, path: decodeDataPath(item.path) ?? item.path }))
    }
  }

  // Upserts a project's preview state, sanitizing before writing so only durable fields are stored.
  async save(projectId: string, state: PersistedPreviewState): Promise<void> {
    const normalized = normalizePersistedPreviewState(state)
    const data = {
      panelState: normalized.panelState,
      activeItemId: normalized.activeItemId ?? null,
      // Item paths under the data root are stored as portable $DATA sentinels.
      items: JSON.stringify(
        normalized.items.map((item) => ({ ...item, path: encodeDataPath(item.path) ?? item.path }))
      )
    }
    const client = await this.getClient()

    await client.projectPreviewState.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data
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
