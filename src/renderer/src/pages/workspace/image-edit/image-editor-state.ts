import type {
  ArtifactVersionDescriptor,
  GetArtifactLineageRequest,
  ImageVersionDependency
} from '../../../../../shared/artifact-provenance'
import { createUploadVersionReference } from '../../../../../shared/uploads'
import { createPreviewFileItemForArtifactVersion } from '../preview-file-item'
import type { ImageTask } from '../../../../../shared/image-task'
import type { ImageErrorDetail } from '../../../../../shared/image-model-error'
import { createArtifactVersionLocator } from '../../../../../shared/artifact-version-locator'
import type { PreviewFileItem } from '@/stores/preview-workbench-contract'
import type { ChatSession } from '@/stores/session-store'
import type { ImageEditRegion, ImageEditSnapshot } from '../../../../../shared/image-edit-contract'
import type { ImageModelBinding } from '../../../../../shared/image-model-settings'
import type { ImageOptionValue } from '../../../../../shared/image-model-presets'

export function imageLineageRequest(
  source: ImageEditSnapshot['source']
): GetArtifactLineageRequest {
  return {
    projectId: source.projectId,
    appSessionId: source.sourceSessionId,
    artifactId: source.sourceFileId,
    versionId: source.sourceVersionId,
    imageSourceKind: source.sourceKind
  }
}

export type ImageEditorTool = ImageEditRegion['geometry']['kind'] | 'pan'
export type ImageEditorDraft = {
  inputSource?: ImageEditSnapshot['source']
  sourceSwitchBlocked?: boolean
  versionDrafts?: ReadonlyMap<string, ImageVersionDraft>
  owner: { sessionId: string; frameId?: string; branchId?: string }
  source: PreviewFileItem
  prompt: string
  model?: ImageModelBinding
  options: Record<string, ImageOptionValue>
  optionsInherited?: boolean
  regions: ImageEditRegion[]
  undo: ImageEditRegion[][]
  redo: ImageEditRegion[][]
  tool: ImageEditorTool
  selectedRegion?: string
  regionDraft?: ImageEditRegion
  selectedCandidate?: string
  zoom?: { scale: number; positionX: number; positionY: number }
  submission?: {
    id: string
    startedAt: number
    preparing: boolean
    stopping?: boolean
    error?: ImageErrorDetail
    recoveryTask?: ImageTask
  }
}

type ImageVersionDraft = Pick<
  ImageEditorDraft,
  | 'inputSource'
  | 'prompt'
  | 'model'
  | 'options'
  | 'optionsInherited'
  | 'regions'
  | 'undo'
  | 'redo'
  | 'tool'
  | 'selectedRegion'
  | 'regionDraft'
  | 'zoom'
>

export const IMAGE_EDITOR_DRAFT_LIMIT = 8

const hasDraftContent = (draft: ImageVersionDraft): boolean =>
  Boolean(
    draft.prompt.trim() ||
    draft.regions.length ||
    draft.regionDraft ||
    draft.undo.length ||
    draft.redo.length ||
    (!draft.optionsInherited && Object.keys(draft.options).length)
  )

export function reusableImageDraftKey(
  drafts: ReadonlyMap<string, ImageEditorDraft>
): string | undefined {
  for (const [key, draft] of drafts) {
    if (draft.submission || hasDraftContent(draft)) continue
    if (draft.versionDrafts && [...draft.versionDrafts.values()].some(hasDraftContent)) continue
    return key
  }
  return undefined
}

export function switchImageEditorSource(
  draft: ImageEditorDraft,
  source: PreviewFileItem,
  inputSource?: ImageEditSnapshot['source']
): ImageEditorDraft {
  if (source.selectedVersionId === draft.source.selectedVersionId)
    return inputSource ? { ...draft, inputSource } : draft
  const saved = new Map(draft.versionDrafts)
  const { prompt, model, options, regions, undo, redo, tool, selectedRegion, regionDraft, zoom } =
    draft
  const previous = draft.source.selectedVersionId!
  saved.delete(previous)
  saved.set(previous, {
    inputSource: draft.inputSource,
    optionsInherited: draft.optionsInherited,
    prompt,
    model,
    options,
    regions,
    undo,
    redo,
    tool,
    selectedRegion,
    regionDraft,
    zoom
  })
  const restored = saved.get(source.selectedVersionId!)
  saved.delete(source.selectedVersionId!)
  if (saved.size > IMAGE_EDITOR_DRAFT_LIMIT) {
    const empty = [...saved].find(([, value]) => !hasDraftContent(value))
    if (!empty) return { ...draft, sourceSwitchBlocked: true, selectedCandidate: undefined }
    saved.delete(empty[0])
  }
  return {
    ...draft,
    source,
    inputSource: undefined,
    sourceSwitchBlocked: false,
    prompt: '',
    regions: [],
    undo: [],
    redo: [],
    tool: 'pan',
    selectedRegion: undefined,
    regionDraft: undefined,
    zoom: undefined,
    optionsInherited: true,
    ...restored,
    ...(inputSource ? { inputSource } : {}),
    selectedCandidate: undefined,
    submission: undefined,
    versionDrafts: saved
  }
}

export function imageEditorScope(session: ChatSession | undefined): string | undefined {
  if (!session || session.archivedAt || session.contentLoaded === false) return undefined
  const graph = session.conversationGraph
  const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
  return `${session.projectId}:${session.id}:${frame?.id ?? ''}:${frame?.activeBranchId ?? ''}`
}

export function imageEditorSource(item: PreviewFileItem): ImageEditSnapshot['source'] | undefined {
  if (item.fromNotebookDataLink || !item.projectId || !item.sessionId || !item.selectedVersionId)
    return undefined
  const sourceFileId = item.managedFileId ?? item.artifactId
  if (
    !sourceFileId ||
    (item.source !== 'upload' && item.source !== 'artifact' && item.source !== undefined)
  )
    return undefined
  const mimeType =
    item.mimeType ??
    ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as const)[
      item.name.split('.').pop()?.toLowerCase() ?? ''
    ]
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp')
    return undefined
  return {
    projectId: item.projectId,
    sourceSessionId: item.sessionId,
    sourceKind: item.source === 'upload' ? 'upload-version' : 'artifact-version',
    sourceFileId,
    sourceVersionId: item.selectedVersionId,
    name: item.name,
    mimeType
  }
}

export function imageEditorKey(scope: string, item: PreviewFileItem): string | undefined {
  const source = imageEditorSource(item)
  return source ? `${scope}:${source.sourceFileId}:${source.sourceVersionId}` : undefined
}

export function changeImageRegions(
  draft: ImageEditorDraft,
  regions: ImageEditRegion[]
): ImageEditorDraft {
  return { ...draft, regions, undo: [...draft.undo.slice(-31), draft.regions], redo: [] }
}

export function imageEditorResultItem(task: ImageTask): PreviewFileItem | undefined {
  const artifact = task.result
  if (task.state !== 'succeeded' || !artifact) return undefined
  return {
    type: 'file',
    format: 'image',
    source: 'artifact',
    id: artifact.versionId,
    artifactId: artifact.artifactId,
    managedFileId: artifact.artifactId,
    selectedVersionId: artifact.versionId,
    versionNumber: artifact.versionNumber,
    projectId: task.projectId,
    sessionId: task.sessionId,
    path: createArtifactVersionLocator({
      projectId: task.projectId,
      appSessionId: task.sessionId,
      artifactId: artifact.artifactId,
      versionId: artifact.versionId
    }),
    title: artifact.name,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size
  }
}

export function imageEditorCandidates(
  tasks: readonly ImageTask[],
  source: PreviewFileItem
): Array<{ item: PreviewFileItem; edit: ImageEditSnapshot; prompt: string }> {
  const knownVersions = new Set<string>()
  const pending = [source.selectedVersionId!]
  const neighbors = new Map<string, string[]>()
  const completed = [...tasks]
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .flatMap((task) => {
      const item = imageEditorResultItem(task)
      return item ? [{ item, edit: task.edit, prompt: task.prompt }] : []
    })
  for (const { item, edit } of completed) {
    const output = item.selectedVersionId!
    const input = edit.source.sourceVersionId
    neighbors.set(input, [...(neighbors.get(input) ?? []), output])
    neighbors.set(output, [...(neighbors.get(output) ?? []), input])
    if (item.artifactId === (source.artifactId ?? source.managedFileId)) pending.push(output)
  }
  // Follow both directions so reopening a result also finds its earlier edits and siblings.
  for (const id of pending) {
    if (knownVersions.has(id)) continue
    knownVersions.add(id)
    pending.push(...(neighbors.get(id) ?? []))
  }
  const included = new Set([source.selectedVersionId])
  const result: Array<{ item: PreviewFileItem; edit: ImageEditSnapshot; prompt: string }> = []
  for (const candidate of completed) {
    const id = candidate.item.selectedVersionId!
    if (!knownVersions.has(id) || included.has(id)) continue
    included.add(id)
    result.push(candidate)
  }
  return result.slice(-32)
}

export type ImageHistoryNode = {
  item: PreviewFileItem
  parentId?: string
  task?: ImageTask
  children: ImageHistoryNode[]
}

const historyFileId = (item: PreviewFileItem): string =>
  (item.source ?? 'artifact') + ':' + (item.managedFileId ?? item.artifactId ?? item.id)

function historyInputItem(source: ImageEditSnapshot['source']): PreviewFileItem {
  const upload = source.sourceKind === 'upload-version'
  return {
    id: source.sourceVersionId,
    type: 'file',
    format: 'image',
    source: upload ? 'upload' : 'artifact',
    artifactId: upload ? undefined : source.sourceFileId,
    managedFileId: source.sourceFileId,
    selectedVersionId: source.sourceVersionId,
    projectId: source.projectId,
    sessionId: source.sourceSessionId,
    path: upload
      ? createUploadVersionReference(source.sourceVersionId, {
          projectId: source.projectId,
          sessionId: source.sourceSessionId,
          fileId: source.sourceFileId
        })
      : createArtifactVersionLocator({
          projectId: source.projectId,
          appSessionId: source.sourceSessionId,
          artifactId: source.sourceFileId,
          versionId: source.sourceVersionId
        }),
    name: source.name,
    title: source.name,
    mimeType: source.mimeType
  }
}

export function imageHistoryNodes(
  source: PreviewFileItem,
  selected: PreviewFileItem,
  versions: readonly ArtifactVersionDescriptor[],
  tasks: readonly ImageTask[],
  dependencies: readonly ImageVersionDependency[] = []
): ImageHistoryNode[] {
  const nodes = new Map<string, ImageHistoryNode>()
  const add = (item: PreviewFileItem, parentId?: string, task?: ImageTask): void => {
    const id = item.selectedVersionId
    if (!id || !imageEditorSource(item)) return
    const existing = nodes.get(id)
    nodes.set(id, {
      item: { ...item, versionNumber: item.versionNumber ?? existing?.item.versionNumber },
      parentId: parentId && parentId !== id ? parentId : existing?.parentId,
      task: task ?? existing?.task,
      children: []
    })
  }
  add(source)
  add(selected)
  for (const version of versions) {
    if (version.state !== 'finalized' || version.isPublished === false) continue
    const base =
      version.artifactId === (source.artifactId ?? source.managedFileId) ? source : selected
    add(
      createPreviewFileItemForArtifactVersion({
        item: {
          ...base,
          source: 'artifact',
          artifactId: version.artifactId,
          sessionId: version.sessionId,
          mimeType: version.mimeType
        },
        version,
        projectId: version.projectId
      }),
      version.basedOnVersionId
    )
  }
  for (const { input, output } of dependencies) {
    if (input.projectId !== source.projectId || output.projectId !== source.projectId) continue
    if (!nodes.has(input.sourceVersionId))
      add({ ...historyInputItem(input), versionNumber: input.versionNumber })
    add(
      createPreviewFileItemForArtifactVersion({
        item: {
          ...selected,
          source: 'artifact',
          artifactId: output.artifactId,
          sessionId: output.sessionId,
          mimeType: output.mimeType
        },
        version: output,
        projectId: output.projectId
      }),
      input.sourceVersionId
    )
  }
  for (const task of tasks) {
    if (task.projectId !== source.projectId || task.state !== 'succeeded' || !task.result) continue
    const input = historyInputItem(task.edit.source)
    const [result] = imageEditorCandidates([task], input)
    if (!result) continue
    if (!nodes.has(task.edit.source.sourceVersionId)) add(input)
    add(result.item, task.edit.source.sourceVersionId, task)
  }

  const roots: ImageHistoryNode[] = []
  const byParent = new Map<string, ImageHistoryNode[]>()
  for (const node of nodes.values()) {
    if (!node.parentId || !nodes.has(node.parentId)) continue
    const children = byParent.get(node.parentId) ?? []
    children.push(node)
    byParent.set(node.parentId, children)
  }
  // Keep the current asset and its connected sources/results, even across file renames.
  const present = new Set<string>()
  const pending = [...nodes.values()].filter(
    ({ item }) =>
      historyFileId(item) === historyFileId(source) ||
      item.selectedVersionId === selected.selectedVersionId
  )
  for (const node of pending) {
    const id = node.item.selectedVersionId!
    if (present.has(id)) continue
    present.add(id)
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent && !present.has(parent.item.selectedVersionId!)) pending.push(parent)
    pending.push(...(byParent.get(id) ?? []))
  }
  const sorted = [...nodes.values()].sort(
    (a, b) => (a.item.versionNumber ?? 0) - (b.item.versionNumber ?? 0)
  )
  for (const node of sorted) {
    if (!present.has(node.item.selectedVersionId!)) continue
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}
