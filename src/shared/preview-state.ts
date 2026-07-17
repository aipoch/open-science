// Durable per-project preview panel state, persisted in SQLite (see src/main/projects).
//
// Only restart-durable content is stored: the panel open/collapsed state and opened *file* previews.
// Notebook tabs are runtime-only (endpoint/token change per app session) and re-appear via
// notebook.onAvailable, so they are intentionally not persisted.

export const PREVIEW_STATE_VERSION = 1

export type PersistedPreviewPanelState = 'open' | 'collapsed'

// A restorable file preview tab. Mirrors the renderer PreviewFileItem's durable fields (format/source
// are kept as strings here so the shared layer stays free of renderer types; the renderer casts back).
export type PersistedPreviewFileItem = {
  id: string
  sessionId: string
  title: string
  source?: string
  path: string
  format: string
  name: string
  mimeType?: string
  size?: number
  mtimeMs?: number
}

export type PersistedPreviewState = {
  version: typeof PREVIEW_STATE_VERSION
  panelState: PersistedPreviewPanelState
  activeItemId?: string
  items: PersistedPreviewFileItem[]
}

export type LoadPreviewStateRequest = {
  projectId: string
}

export type SavePreviewStateRequest = {
  projectId: string
  state: PersistedPreviewState
}

export type DeletePreviewStateRequest = {
  projectId: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asNonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

// Canonical empty state for projects that have never had a preview open.
export const createEmptyPersistedPreviewState = (): PersistedPreviewState => ({
  version: PREVIEW_STATE_VERSION,
  panelState: 'collapsed',
  items: []
})

// Rebuilds a single persisted file item from untrusted data, dropping anything without a usable path.
const sanitizePreviewFileItem = (value: unknown): PersistedPreviewFileItem | undefined => {
  if (!isRecord(value)) return undefined

  const id = asString(value.id)
  const sessionId = asString(value.sessionId)
  const path = asString(value.path)
  const name = asString(value.name)

  if (!id || !sessionId || !path || !name) return undefined

  const item: PersistedPreviewFileItem = {
    id,
    sessionId,
    title: asString(value.title) ?? name,
    path,
    format: asString(value.format) ?? 'unknown',
    name
  }
  const source = asString(value.source)
  const mimeType = asString(value.mimeType)
  const size = asNonNegativeNumber(value.size)
  const mtimeMs = asNonNegativeNumber(value.mtimeMs)

  if (source) item.source = source
  if (mimeType) item.mimeType = mimeType
  if (size !== undefined) item.size = size
  if (mtimeMs !== undefined) item.mtimeMs = mtimeMs

  return item
}

// Produces the only preview-state shape the renderer and main process should consume.
export const normalizePersistedPreviewState = (value: unknown): PersistedPreviewState => {
  if (!isRecord(value)) return createEmptyPersistedPreviewState()

  const items = Array.isArray(value.items)
    ? value.items
        .map(sanitizePreviewFileItem)
        .filter((item): item is PersistedPreviewFileItem => !!item)
    : []
  const panelState: PersistedPreviewPanelState = value.panelState === 'open' ? 'open' : 'collapsed'
  const requestedActiveItemId = asString(value.activeItemId)
  // Keep the active id only when it still points at a persisted item.
  const activeItemId = items.some((item) => item.id === requestedActiveItemId)
    ? requestedActiveItemId
    : undefined

  const state: PersistedPreviewState = {
    version: PREVIEW_STATE_VERSION,
    panelState,
    items
  }

  if (activeItemId) state.activeItemId = activeItemId

  return state
}
