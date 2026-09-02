// Durable per-project preview panel state, persisted in SQLite (see src/main/projects).
//
// Only restart-durable content is stored: file previews and the Session-scoped Subagents selection.
// Notebook and other tool tabs are runtime-only and re-appear from their existing owners.

import type { ProjectFileOriginSession } from './project-files'

export const PREVIEW_STATE_VERSION = 1
export const MAX_PERSISTED_PREVIEW_ITEMS = 100

const MAX_PREVIEW_ID_LENGTH = 512
const MAX_PREVIEW_LABEL_LENGTH = 1024
const MAX_PREVIEW_PATH_LENGTH = 8192
const MAX_PREVIEW_METADATA_LENGTH = 256

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
  artifactId?: string
  managedFileId?: string
  selectedVersionId?: string
  versionNumber?: number
  originSession?: ProjectFileOriginSession
}

export type PersistedSubagentsPreviewItem = {
  id: string
  sessionId: string
  title: string
  type: 'tool'
  toolKind: 'subagents'
  selectedAgentFrameId: string
}

export type PersistedPreviewState = {
  version: typeof PREVIEW_STATE_VERSION
  panelState: PersistedPreviewPanelState
  activeItemId?: string
  items: PersistedPreviewFileItem[]
  subagents?: PersistedSubagentsPreviewItem
}

export type PreviewStateSnapshot = {
  state: PersistedPreviewState
  revision: number
}

export type LoadPreviewStateRequest = {
  projectId: string
}

export type SavePreviewStateRequest = {
  projectId: string
  state: PersistedPreviewState
  expectedRevision: number
}

export type SavePreviewStateResult =
  | { status: 'saved'; revision: number }
  | { status: 'conflict'; snapshot: PreviewStateSnapshot | null }

export type DeletePreviewStateRequest = {
  projectId: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asBoundedString = (value: unknown, maxLength: number): string | undefined =>
  typeof value === 'string' && value.length <= maxLength ? value : undefined

const asNonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

const asPositiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined

const sanitizeOriginSession = (value: unknown): ProjectFileOriginSession | undefined => {
  if (!isRecord(value)) return undefined
  if (value.state !== 'active' && value.state !== 'deleting' && value.state !== 'deleted') {
    return undefined
  }

  const origin: ProjectFileOriginSession = { state: value.state }
  const title = asBoundedString(value.title, MAX_PREVIEW_LABEL_LENGTH)
  const deletedAt = asBoundedString(value.deletedAt, MAX_PREVIEW_METADATA_LENGTH)
  if (title) origin.title = title
  if (deletedAt) origin.deletedAt = deletedAt
  return origin
}

// Canonical empty state for projects that have never had a preview open.
export const createEmptyPersistedPreviewState = (): PersistedPreviewState => ({
  version: PREVIEW_STATE_VERSION,
  panelState: 'collapsed',
  items: []
})

// Rebuilds a single persisted file item from untrusted data, dropping anything without a usable path.
const sanitizePreviewFileItem = (value: unknown): PersistedPreviewFileItem | undefined => {
  if (!isRecord(value)) return undefined

  const id = asBoundedString(value.id, MAX_PREVIEW_ID_LENGTH)
  const sessionId = asBoundedString(value.sessionId, MAX_PREVIEW_ID_LENGTH)
  const path = asBoundedString(value.path, MAX_PREVIEW_PATH_LENGTH)
  const name = asBoundedString(value.name, MAX_PREVIEW_LABEL_LENGTH)

  if (!id || !sessionId || !path || !name) return undefined

  const item: PersistedPreviewFileItem = {
    id,
    sessionId,
    title: asBoundedString(value.title, MAX_PREVIEW_LABEL_LENGTH) ?? name,
    path,
    format: asBoundedString(value.format, MAX_PREVIEW_METADATA_LENGTH) ?? 'unknown',
    name
  }
  const source = asBoundedString(value.source, MAX_PREVIEW_METADATA_LENGTH)
  const mimeType = asBoundedString(value.mimeType, MAX_PREVIEW_METADATA_LENGTH)
  const size = asNonNegativeNumber(value.size)
  const mtimeMs = asNonNegativeNumber(value.mtimeMs)
  const artifactId = asBoundedString(value.artifactId, MAX_PREVIEW_ID_LENGTH)
  const managedFileId = asBoundedString(value.managedFileId, MAX_PREVIEW_ID_LENGTH)
  const selectedVersionId = asBoundedString(value.selectedVersionId, MAX_PREVIEW_ID_LENGTH)
  const versionNumber = asPositiveInteger(value.versionNumber)
  const originSession = sanitizeOriginSession(value.originSession)

  if (source) item.source = source
  if (mimeType) item.mimeType = mimeType
  if (size !== undefined) item.size = size
  if (mtimeMs !== undefined) item.mtimeMs = mtimeMs
  if (artifactId) item.artifactId = artifactId
  if (managedFileId) item.managedFileId = managedFileId
  if (selectedVersionId) item.selectedVersionId = selectedVersionId
  if (versionNumber !== undefined) item.versionNumber = versionNumber
  if (originSession) item.originSession = originSession

  return item
}

const sanitizeSubagentsPreviewItem = (
  value: unknown
): PersistedSubagentsPreviewItem | undefined => {
  if (!isRecord(value) || value.type !== 'tool' || value.toolKind !== 'subagents') {
    return undefined
  }
  const id = asBoundedString(value.id, MAX_PREVIEW_ID_LENGTH)
  const sessionId = asBoundedString(value.sessionId, MAX_PREVIEW_ID_LENGTH)
  const selectedAgentFrameId = asBoundedString(value.selectedAgentFrameId, MAX_PREVIEW_ID_LENGTH)
  if (!id || !sessionId || !selectedAgentFrameId) return undefined
  return {
    id,
    sessionId,
    title: asBoundedString(value.title, MAX_PREVIEW_LABEL_LENGTH) ?? 'Subagents',
    type: 'tool',
    toolKind: 'subagents',
    selectedAgentFrameId
  }
}

// Produces the only preview-state shape the renderer and main process should consume.
export const normalizePersistedPreviewState = (value: unknown): PersistedPreviewState => {
  if (!isRecord(value)) return createEmptyPersistedPreviewState()

  const serializedItems = Array.isArray(value.items)
    ? value.items.slice(-MAX_PERSISTED_PREVIEW_ITEMS)
    : []
  const items = serializedItems.length
    ? serializedItems
        .map(sanitizePreviewFileItem)
        .filter((item): item is PersistedPreviewFileItem => !!item)
    : []
  const subagents =
    sanitizeSubagentsPreviewItem(value.subagents) ??
    (serializedItems.length
      ? serializedItems.map(sanitizeSubagentsPreviewItem).find(Boolean)
      : undefined)
  const panelState: PersistedPreviewPanelState = value.panelState === 'open' ? 'open' : 'collapsed'
  const requestedActiveItemId = asBoundedString(value.activeItemId, MAX_PREVIEW_ID_LENGTH)
  // Keep the active id only when it still points at a persisted item.
  const activeItemId = [...items, ...(subagents ? [subagents] : [])].some(
    (item) => item.id === requestedActiveItemId
  )
    ? requestedActiveItemId
    : undefined

  const state: PersistedPreviewState = {
    version: PREVIEW_STATE_VERSION,
    panelState,
    items,
    ...(subagents ? { subagents } : {})
  }

  if (activeItemId) state.activeItemId = activeItemId

  return state
}
