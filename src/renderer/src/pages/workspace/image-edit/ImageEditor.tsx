import type { PreviewFileRendererProps } from '../previews/preview-types'
import type { ArtifactVersionDescriptor } from '../../../../../shared/artifact-provenance'
import { createPreviewFileItemForArtifactVersion } from '../preview-file-item'
import { ensureSessionContentLoaded } from '@/lib/session-persistence/session-history'
import { ImageEditFloatingTools } from './ImageEditFloatingTools'
import { createPortal } from 'react-dom'
import { useImageComposerTarget } from './image-composer-bridge'
import type { ComposerNotice } from '@/components/notices/composer-notice-catalog'
import { ImageComposerNotices, ImageErrorNotice } from '@/components/image-error-notice'
import type { ImageErrorDetail } from '../../../../../shared/image-model-error'
import {
  imageTaskIsActive,
  matchesImageTaskSource,
  type ImageTask
} from '../../../../../shared/image-task'
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Columns2,
  Maximize2,
  Minimize2,
  Hand,
  History,
  Lasso,
  LoaderCircle,
  MapPin,
  MoveUpRight,
  Redo2,
  Scan,
  Sparkles,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReactZoomPanPinchRef } from 'react-zoom-pan-pinch'
import { unwrapProvenanceRead } from '../../../../../shared/provenance-read-result'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorNotice } from '@/components/error-notice'
import { useSessionStore } from '@/stores/session-store'
import type { ChatSession } from '@/stores/session-store'
import type { PreviewFileItem } from '@/stores/preview-workbench-contract'
import {
  buildImageEditPrompt,
  IMAGE_EDIT_TEXT_LIMIT,
  imageEditSnapshotSchema,
  imagePromptFits,
  type ImageEditRegion,
  type ImageEditSnapshot
} from '../../../../../shared/image-edit-contract'
import {
  getImageModelPreset,
  imageInputExceedsLimits,
  imageEditSpatialReference,
  validateImageModelOptions
} from '../../../../../shared/image-model-presets'
import { useImageEditing } from './image-edit-context'
import {
  changeImageRegions,
  switchImageEditorSource,
  IMAGE_EDITOR_DRAFT_LIMIT,
  reusableImageDraftKey,
  imageEditorCandidates,
  imageEditorResultItem,
  imageEditorKey,
  imageEditorScope,
  imageEditorSource,
  imageLineageRequest,
  type ImageEditorDraft,
  type ImageEditorTool
} from './image-editor-state'
import { ImageEditCanvas } from './ImageEditCanvas'
import { ImageEditPending } from './ImageEditPending'
import { imageOptionLabels } from '../image-tool-presentation'
import { ImageEditParameters } from './ImageEditParameters'
import { ImageEditHistory } from './ImageEditHistory'
import { ImageEditComparison } from './ImageEditComparison'
import { ImageEditCandidate, ImageEditDetails } from './ImageEditCandidate'
import { useCachedPreviewImage } from '../previews/useCachedPreviewImage'
import { ZoomablePreview } from '../previews/renderers/ZoomablePreview'
import { PreviewLoadingContent } from '../previews/PreviewFallback'

type Owner = NonNullable<ReturnType<typeof useImageEditing>>
function Elapsed({ start }: { start: number }): React.JSX.Element {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const update = (): void => setSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)))
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [start])
  return (
    <span className="tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

function ActiveImageEditor({
  owner,
  editorKey,
  draft,
  session,
  rootItem,
  localComposer,
  onClose,
  onVersionChange
}: {
  owner: Owner
  editorKey: string
  draft: ImageEditorDraft
  session: ChatSession
  localComposer: boolean
  onClose(): void
  rootItem: PreviewFileItem
  onVersionChange?: (item: PreviewFileItem | undefined) => void
}): React.JSX.Element {
  const { settings, update: updateDraft, reloadSettings, reloadTasks } = owner
  const { t } = useTranslation()
  const regionInput = useRef<HTMLTextAreaElement>(null)
  const promptInput = useRef<HTMLTextAreaElement>(null)
  const continueButton = useRef<HTMLButtonElement>(null)
  const compareButton = useRef<HTMLButtonElement>(null)
  const [canvasViewport, setCanvasViewport] = useState<HTMLDivElement | null>(null)
  const composerTarget = useImageComposerTarget(
    imageEditorScope(session)!,
    canvasViewport,
    localComposer
  )
  const canvasZoom = useRef<ReactZoomPanPinchRef>(null)
  const regionToReveal = useRef<string | undefined>(undefined)
  const sending = useRef(false)
  const composing = useRef(false)
  const [decodeError, setDecodeError] = useState<string>()
  const [localError, setLocalError] = useState<string>()
  const [unavailableHistoryVersion, setUnavailableHistoryVersion] = useState<string>()
  const [cancelErrorId, setCancelErrorId] = useState<string>()
  const [comparisonVersion, setComparisonVersion] = useState<string>()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [historyTask, setHistoryTask] = useState<ImageTask>()
  const historyTrigger = useRef<HTMLButtonElement>(null)
  const restoreHistoryFocus = useRef(false)
  useLayoutEffect(() => {
    if (!restoreHistoryFocus.current) return
    restoreHistoryFocus.current = false
    historyTrigger.current?.focus()
  }, [historyOpen])
  const { frameId, branchId } = draft.owner
  const sourceVersionId = draft.source.selectedVersionId
  const sessionId = session.id
  const projectId = session.projectId!
  const scopedTasks = useMemo(
    () =>
      owner.tasks.filter(
        (task) =>
          task.projectId === projectId &&
          task.sessionId === sessionId &&
          task.frameId === frameId &&
          task.branchId === branchId
      ),
    [owner.tasks, projectId, sessionId, frameId, branchId]
  )
  const recoveryTask = draft.submission?.recoveryTask
  const currentCandidates = useMemo(
    () => imageEditorCandidates(scopedTasks, rootItem),
    [scopedTasks, rootItem]
  )
  const [candidateHistory, setCandidateHistory] = useState(() => ({
    current: currentCandidates,
    versions: currentCandidates
  }))
  let candidates = candidateHistory.versions
  if (candidateHistory.current !== currentCandidates) {
    const versions = new Map(
      candidateHistory.versions.map((candidate) => [candidate.item.selectedVersionId, candidate])
    )
    for (const candidate of currentCandidates) {
      const id = candidate.item.selectedVersionId
      if (id) versions.set(id, candidate)
    }
    candidates = [...versions.values()].sort(
      (a, b) => (a.item.versionNumber ?? 0) - (b.item.versionNumber ?? 0)
    )
    setCandidateHistory({ current: currentCandidates, versions: candidates })
  }
  const recentCandidates = candidates.slice(-6)
  const [savedVersions, setSavedVersions] = useState<ArtifactVersionDescriptor[]>([])
  const candidateVersionKey = candidates.map(({ item }) => item.selectedVersionId).join(':')
  useEffect(() => {
    const source = imageEditorSource(rootItem)
    if (!source) return
    let current = true
    void window.api.artifacts
      .getLineage(imageLineageRequest(source))
      .then(unwrapProvenanceRead)
      .then((lineage) => {
        if (!current) return
        const versions = [
          ...(lineage?.versions ?? []),
          ...[lineage?.selectedVersion, lineage?.headVersion, lineage?.basedOnVersion].filter(
            (version): version is ArtifactVersionDescriptor => Boolean(version)
          )
        ]
        setSavedVersions(
          versions.filter(
            (version) =>
              version.state === 'finalized' &&
              version.isPublished !== false &&
              version.artifactId === source.sourceFileId
          )
        )
      })
      .catch(() => {
        if (current) setSavedVersions([])
      })
    return () => {
      current = false
    }
  }, [rootItem, candidateVersionKey])
  const stripItems: Array<{
    item: PreviewFileItem
    label: string
    edit?: ImageEditSnapshot
    prompt?: string
  }> = [
    { item: rootItem, label: rootItem.name },
    ...savedVersions.map((version) => ({
      item: createPreviewFileItemForArtifactVersion({
        item: { ...rootItem, sessionId: version.sessionId },
        version,
        projectId: version.projectId
      }),
      label: t('Version {{number}}', { number: version.versionNumber })
    })),
    ...recentCandidates.map((candidate, index) => ({
      ...candidate,
      label: t('Result {{number}}', { number: index + 1 })
    }))
  ]
  if (!stripItems.some(({ item }) => item.selectedVersionId === draft.source.selectedVersionId))
    stripItems.push({ item: draft.source, label: draft.source.name })
  const versionStrip = [
    ...new Map(stripItems.map((entry) => [entry.item.selectedVersionId, entry])).values()
  ].sort((a, b) => (a.item.versionNumber ?? 0) - (b.item.versionNumber ?? 0))

  const activeSourceTask = scopedTasks.find(
    (entry) => entry.edit.source.sourceVersionId === sourceVersionId && imageTaskIsActive(entry)
  )
  useEffect(() => {
    let current = true
    const recovery =
      frameId && branchId && sourceVersionId ? { frameId, branchId, sourceVersionId } : undefined
    void reloadTasks({ projectId, sessionId, ...(recovery ? { recovery } : {}) })
      .then((tasks) => {
        if (!current) return
        setUnavailableHistoryVersion(undefined)
        if (!recovery) return
        const sourceTasks = tasks.filter(
          (task) =>
            task.projectId === projectId &&
            task.sessionId === sessionId &&
            matchesImageTaskSource(task, recovery)
        )
        if (sourceTasks.some(imageTaskIsActive)) return
        const latest = sourceTasks[0]
        if (
          !latest ||
          (latest.state !== 'outcome-unknown' && (latest.state !== 'failed' || !latest.error))
        )
          return
        updateDraft(editorKey, (draft) =>
          draft && !draft.submission && draft.source.selectedVersionId === sourceVersionId
            ? {
                ...draft,
                submission: {
                  id: latest.id,
                  startedAt: latest.createdAt,
                  preparing: false,
                  recoveryTask: latest
                }
              }
            : draft
        )
      })
      .catch(() => {
        if (current) setUnavailableHistoryVersion(sourceVersionId)
      })
    return () => {
      current = false
    }
  }, [
    reloadTasks,
    projectId,
    sessionId,
    frameId,
    branchId,
    sourceVersionId,
    editorKey,
    updateDraft
  ])
  const selectedCandidate = candidates.find(
    ({ item }) => item.selectedVersionId === draft.selectedCandidate
  )
  const selectedImage =
    draft.selectedCandidate === rootItem.selectedVersionId ? rootItem : selectedCandidate?.item
  const displayed = draft.browsing?.item ?? selectedImage ?? draft.source
  useLayoutEffect(() => {
    onVersionChange?.(displayed)
  }, [onVersionChange, displayed])
  useLayoutEffect(() => () => onVersionChange?.(undefined), [onVersionChange])
  const knownInput =
    scopedTasks.find((entry) => entry.result?.versionId === displayed.selectedVersionId)?.edit
      .source ??
    (displayed.selectedVersionId === draft.source.selectedVersionId ? draft.inputSource : undefined)
  const [verifiedInput, setVerifiedInput] = useState<{
    item: PreviewFileItem
    source: ImageEditSnapshot['source']
  }>()
  useEffect(() => {
    if (knownInput || displayed.source !== 'artifact') return
    const source = imageEditorSource(displayed)
    if (!source) return
    let current = true
    void window.api.artifacts
      .getLineage({ ...imageLineageRequest(source), imageInputOnly: true })
      .then(unwrapProvenanceRead)
      .then((lineage) => {
        const input = lineage?.imageDependencies?.find(
          ({ output }) => output.versionId === source.sourceVersionId
        )?.input
        if (current) setVerifiedInput(input ? { item: displayed, source: input } : undefined)
      })
      .catch(() => {
        if (current) setVerifiedInput(undefined)
      })
    return () => {
      current = false
    }
  }, [displayed, knownInput])
  const inputSource =
    draft.browsing?.inputSource ??
    knownInput ??
    (verifiedInput?.item === displayed ? verifiedInput.source : undefined)
  const currentVersionNumber =
    displayed.versionNumber ??
    versionStrip.find(({ item }) => item.selectedVersionId === displayed.selectedVersionId)?.item
      .versionNumber
  const otherVersions = versionStrip.filter(
    ({ item }) => item.selectedVersionId !== displayed.selectedVersionId
  )
  const fallbackComparisonItem =
    otherVersions
      .filter(
        ({ item }) =>
          currentVersionNumber !== undefined &&
          item.versionNumber !== undefined &&
          item.versionNumber < currentVersionNumber
      )
      .at(-1)?.item ?? otherVersions[0]?.item
  const comparisonSource =
    inputSource?.sourceVersionId !== displayed.selectedVersionId
      ? (inputSource ??
        (fallbackComparisonItem ? imageEditorSource(fallbackComparisonItem) : undefined))
      : undefined
  const comparisonLabel = inputSource ? t('Compare with input image') : t('Compare')
  const [decodedResult, setDecodedResult] = useState<{
    url: string
    versionId?: string
    failed: boolean
    width?: number
    height?: number
  }>()
  const cachedImage = useCachedPreviewImage(displayed)
  const [measured, setMeasured] = useState<{ url: string; width: number; height: number }>()
  const image =
    cachedImage.status === 'loading' &&
    decodedResult &&
    !decodedResult.failed &&
    decodedResult.versionId === displayed.selectedVersionId
      ? { ...decodedResult, status: 'ready' as const }
      : cachedImage.status === 'ready' &&
          (!cachedImage.width || !cachedImage.height) &&
          measured?.url === cachedImage.url
        ? { ...cachedImage, width: measured.width, height: measured.height }
        : cachedImage
  const sourceThumbnail = useCachedPreviewImage(draft.source, true, false, true)
  const task = scopedTasks.find(({ id }) => id === draft.submission?.id) ?? recoveryTask
  const running = task ? imageTaskIsActive(task) : Boolean(draft.submission?.preparing)
  const observationFailed =
    !!draft.submission && owner.observationFailures?.has(draft.submission.id)
  const resultItem = useMemo(() => task && imageEditorResultItem(task), [task])
  const resultImage = useCachedPreviewImage(resultItem ?? draft.source, Boolean(resultItem), false)
  const resultUrl = resultItem && resultImage.status === 'ready' ? resultImage.url : undefined
  const resultWidth = resultImage.status === 'ready' ? resultImage.width : undefined
  const resultHeight = resultImage.status === 'ready' ? resultImage.height : undefined
  useEffect(() => {
    if (!resultUrl) return
    let current = true
    const image = new Image()
    image.src = resultUrl
    void image.decode().then(
      () =>
        current &&
        setDecodedResult({
          url: resultUrl,
          versionId: resultItem?.selectedVersionId,
          width: resultWidth ?? image.naturalWidth,
          height: resultHeight ?? image.naturalHeight,
          failed: false
        }),
      () => current && setDecodedResult({ url: resultUrl, failed: true })
    )
    return () => {
      current = false
    }
  }, [resultUrl, resultItem?.selectedVersionId, resultWidth, resultHeight])
  const resultDecoded = Boolean(resultUrl && decodedResult?.url === resultUrl)
  const resultFailed = resultImage.status === 'error' || (resultDecoded && decodedResult?.failed)
  const loadingResult = Boolean(resultItem && !resultDecoded && !resultFailed)
  const busy = running || Boolean(resultItem)
  const showPending = busy && draft.selectedCandidate === 'pending' && !observationFailed
  const composerOpen = !draft.composerCollapsed || busy || observationFailed || Boolean(task?.error)
  const locked = observationFailed || busy || task?.state === 'outcome-unknown'
  const comparing = !!comparisonSource && comparisonVersion === displayed.selectedVersionId
  useLayoutEffect(() => {
    if (!composerOpen) continueButton.current?.focus({ preventScroll: true })
  }, [composerOpen])
  const settled = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!draft.submission && activeSourceTask) {
      updateDraft(editorKey, (current) =>
        current && !current.submission
          ? {
              ...current,
              submission: {
                id: activeSourceTask.id,
                startedAt: activeSourceTask.createdAt,
                preparing: false
              },
              selectedCandidate: 'pending'
            }
          : current
      )
    }
    if (!task || imageTaskIsActive(task) || loadingResult) return
    const settlement = JSON.stringify([task.id, task.state])
    if (settled.current === settlement) return
    settled.current = settlement
    const result = imageEditorResultItem(task)
    updateDraft(editorKey, (current) => {
      if (!current || current.submission?.id !== task.id) return current
      if (result) {
        const completed = {
          ...current,
          lastEdit: { source: current.source, prompt: task.prompt, regions: task.edit.regions },
          composerExpanded: false,
          composerCollapsed: !resultFailed,
          optionsInherited: true,
          prompt: '',
          regions: [],
          selectedRegion: undefined,
          regionDraft: undefined,
          undo: [],
          redo: [],
          selectedCandidate: undefined,
          submission: undefined,
          browsing: undefined
        }
        // Browsing is an explicit choice: a late result must not steal the viewport.
        if (current.browsing || resultFailed) {
          const next = current.browsing
            ? switchImageEditorSource(
                completed,
                current.browsing.item,
                current.browsing.inputSource
              )
            : completed
          return {
            ...next,
            completedResult: {
              item: result,
              inputSource: task.edit.source,
              failed: Boolean(resultFailed)
            }
          }
        }
        return switchImageEditorSource(completed, result, task.edit.source)
      }
      const finished = {
        ...current,
        submission: { ...current.submission, preparing: false, stopping: false, error: undefined },
        selectedCandidate: undefined,
        browsing: undefined,
        composerCollapsed: false
      }
      if (current.browsing && (task.state === 'cancelled' || task.state === 'failed'))
        return switchImageEditorSource(
          finished,
          current.browsing.item,
          current.browsing.inputSource
        )
      return finished
    })
  }, [
    task,
    activeSourceTask,
    draft.submission,
    updateDraft,
    editorKey,
    loadingResult,
    resultFailed
  ])
  const service = settings?.services.find(({ id }) => id === draft.model?.serviceId)
  const model = service?.models.find(({ id }) => id === draft.model?.modelId)
  const editSpec = model && getImageModelPreset(model.presetId)?.operations.edit
  const outputOptions = model && validateImageModelOptions(model.presetId, 'edit', draft.options)
  const invalidOutput = outputOptions && !outputOptions.ok ? outputOptions : undefined
  const canEdit = Boolean(service?.configured && editSpec)
  const sourceLimitExceeded = Boolean(
    editSpec &&
    imageInputExceedsLimits(editSpec, {
      sizeBytes: displayed.size,
      width: image.status === 'ready' ? image.width : undefined,
      height: image.status === 'ready' ? image.height : undefined
    })
  )
  useEffect(() => {
    if (draft.model || !settings) return
    const available = settings.services.flatMap((entry) =>
      entry.configured
        ? entry.models
            .filter((candidate) => getImageModelPreset(candidate.presetId)?.operations.edit)
            .map((candidate) => ({
              binding: { serviceId: entry.id, modelId: candidate.id },
              model: candidate
            }))
        : []
    )
    const initial =
      available.find(
        ({ binding }) =>
          binding.serviceId === settings.imageModel?.serviceId &&
          binding.modelId === settings.imageModel?.modelId
      ) ?? available[0]
    if (!initial) return
    updateDraft(editorKey, (current) =>
      current && !current.model
        ? {
            ...current,
            model: initial.binding,
            optionsInherited: true,
            options: initial.model.presetId === 'minimax-h3/sglang' ? { size: '1024x1024' } : {}
          }
        : current
    )
  }, [draft.model, settings, updateDraft, editorKey])
  useEffect(() => {
    const refresh = (): void => {
      void reloadSettings().catch(() => {})
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [reloadSettings])
  const selectedRegion = draft.regionDraft
  useLayoutEffect(() => {
    const id = regionToReveal.current
    const zoom = canvasZoom.current
    if (!id || id !== selectedRegion?.id || !canvasViewport || !zoom) return
    const marker = Array.from(canvasViewport.querySelectorAll('[data-edit-region]')).find(
      (element) => element.getAttribute('data-edit-region') === id
    )
    if (!marker) return
    regionToReveal.current = undefined
    const viewport = canvasViewport.getBoundingClientRect()
    const bounds = marker.getBoundingClientRect()
    const { scale, positionX, positionY } = zoom.state
    if (
      scale <= 1 ||
      (bounds.left >= viewport.left &&
        bounds.right <= viewport.right &&
        bounds.top >= viewport.top &&
        bounds.bottom <= viewport.bottom)
    )
      return
    zoom.setTransform(
      Math.max(
        viewport.width * (1 - scale),
        Math.min(0, positionX + (viewport.left + viewport.right - bounds.left - bounds.right) / 2)
      ),
      Math.max(
        viewport.height * (1 - scale),
        Math.min(0, positionY + (viewport.top + viewport.bottom - bounds.top - bounds.bottom) / 2)
      ),
      scale,
      0
    )
  }, [canvasViewport, comparing, selectedRegion?.id])
  const update = (change: Partial<ImageEditorDraft>): void =>
    updateDraft(editorKey, (current) => (current ? { ...current, ...change } : current))
  const selectImage = (item: PreviewFileItem, input?: ImageEditSnapshot['source']): void => {
    setComparisonVersion(undefined)
    if (busy || observationFailed) {
      update({
        selectedCandidate: item.selectedVersionId,
        browsing: { item, inputSource: input },
        zoom: undefined
      })
      return
    }
    if (item.selectedVersionId === draft.source.selectedVersionId && !input) return
    updateDraft(editorKey, (current) => {
      if (!current) return current
      const next = switchImageEditorSource(current, item, input)
      return !next.sourceSwitchBlocked &&
        next.completedResult?.item.selectedVersionId === item.selectedVersionId
        ? { ...next, completedResult: undefined }
        : next
    })
    setLocalError(undefined)
  }
  const regions = (next: ImageEditRegion[]): void =>
    updateDraft(editorKey, (current) => (current ? changeImageRegions(current, next) : current))
  const focusRegion = (id: string, reveal = false): void => {
    setComparisonVersion(undefined)
    if (selectedRegion) {
      regionInput.current?.focus()
      return
    }
    if (reveal) regionToReveal.current = id
    update({
      composerCollapsed: false,
      selectedRegion: id,
      regionDraft: draft.regions.find((region) => region.id === id)
    })
  }
  const onAdd = (geometry: ImageEditRegion['geometry']): void => {
    if (locked || draft.regions.length >= 16) return
    if (selectedRegion) {
      regionInput.current?.focus()
      return
    }
    const number = Array.from({ length: 16 }, (_, i) => i + 1).find(
      (n) => !draft.regions.some((r) => r.number === n)
    )!
    const id = crypto.randomUUID()
    updateDraft(editorKey, (current) =>
      current
        ? {
            ...current,
            composerCollapsed: false,
            regionDraft: { id, number, instruction: '', geometry },
            selectedRegion: id
          }
        : current
    )
  }
  const closeRegion = (): void => update({ selectedRegion: undefined, regionDraft: undefined })
  const confirmRegion = (): void => {
    if (!selectedRegion?.instruction.trim()) return
    const region = { ...selectedRegion, instruction: selectedRegion.instruction.trim() }
    updateDraft(editorKey, (current) => {
      if (!current) return current
      const exists = current.regions.some(({ id }) => id === region.id)
      return {
        ...changeImageRegions(
          current,
          exists
            ? current.regions.map((entry) => (entry.id === region.id ? region : entry))
            : [...current.regions, region]
        ),
        selectedRegion: undefined,
        regionDraft: undefined
      }
    })
  }
  const deleteRegion = (id: string): void => {
    if (draft.regions.some((region) => region.id === id))
      regions(draft.regions.filter((region) => region.id !== id))
    if (selectedRegion?.id === id) closeRegion()
  }
  const undo = (redo = false): void =>
    updateDraft(editorKey, (current) => {
      if (!current) return current
      const stack = redo ? current.redo : current.undo,
        next = stack.at(-1)
      if (!next) return current
      return {
        ...current,
        regions: next,
        selectedRegion: undefined,
        regionDraft: undefined,
        undo: redo ? [...current.undo.slice(-31), current.regions] : stack.slice(0, -1),
        redo: redo ? stack.slice(0, -1) : [...current.redo.slice(-31), current.regions]
      }
    })
  const submit = async (): Promise<void> => {
    if (
      sending.current ||
      selectedRegion ||
      locked ||
      owner.settingsError ||
      !canEdit ||
      sourceLimitExceeded ||
      !editSpec ||
      !model ||
      !draft.model ||
      displayed.selectedVersionId !== draft.source.selectedVersionId ||
      image.status !== 'ready' ||
      !image.width ||
      !image.height
    )
      return
    const currentSession = useSessionStore.getState().sessions.find(({ id }) => id === session.id)
    if (imageEditorScope(currentSession) !== imageEditorScope(session)) return
    if (!outputOptions?.ok) return
    const spatial = imageEditSpatialReference(
      model.presetId,
      model.wireModelId,
      image.width * image.height
    )
    const regionLength = draft.regions.reduce(
      (total, region) => total + region.instruction.length,
      0
    )
    if (
      regionLength > IMAGE_EDIT_TEXT_LIMIT ||
      !imagePromptFits(buildImageEditPrompt(draft.prompt, draft.regions, spatial, model.presetId))
    ) {
      setLocalError(t('Shorten the image editing instructions.'))
      return
    }
    const parsed = imageEditSnapshotSchema.safeParse({
      version: 1,
      source: imageEditorSource(draft.source),
      model: draft.model,
      options: outputOptions.options,
      naturalSize: { width: image.width, height: image.height },
      regions: draft.regions
    })
    if (!parsed.success || (!draft.prompt.trim() && !draft.regions.length)) {
      setLocalError(t('Add an instruction for each marked region.'))
      return
    }
    sending.current = true
    setComparisonVersion(undefined)
    setLocalError(undefined)
    const submission = { id: crypto.randomUUID(), startedAt: Date.now(), preparing: true }
    update({
      submission,
      completedResult: undefined,
      browsing: undefined,
      selectedRegion: undefined,
      selectedCandidate: 'pending'
    })
    const patchSubmission = (patch: Partial<NonNullable<ImageEditorDraft['submission']>>): void =>
      updateDraft(editorKey, (current) =>
        current?.submission?.id === submission.id
          ? { ...current, submission: { ...current.submission, ...patch } }
          : current
      )
    try {
      const result = await owner.startTask({
        id: submission.id,
        projectId: session.projectId!,
        sessionId: session.id,
        frameId: draft.owner.frameId!,
        branchId: draft.owner.branchId!,
        prompt: draft.prompt,
        edit: parsed.data
      })
      if ('state' in result) patchSubmission({ preparing: false })
      else {
        update({ selectedCandidate: undefined })
        patchSubmission({ preparing: false, stopping: false, error: result.error })
      }
    } catch {
      update({ selectedCandidate: undefined })
      patchSubmission({ preparing: false, stopping: false })
      setLocalError(t('Image editing failed.'))
    } finally {
      sending.current = false
    }
  }
  const cancel = async (): Promise<void> => {
    if (!running || !draft.submission || draft.submission.stopping) return
    const id = draft.submission.id
    setCancelErrorId(undefined)
    update({ submission: { ...draft.submission, stopping: true } })
    try {
      await owner.cancelTask({
        projectId: session.projectId!,
        sessionId: session.id,
        id
      })
    } catch {
      setCancelErrorId(id)
      updateDraft(editorKey, (current) =>
        current?.submission?.id === id
          ? { ...current, submission: { ...current.submission, stopping: false } }
          : current
      )
    }
  }
  const tools: Array<{ tool: ImageEditorTool; label: string; icon: typeof Hand }> = [
    { tool: 'pan', label: t('Pan image'), icon: Hand },
    { tool: 'point', label: t('Mark a point'), icon: MapPin },
    { tool: 'rectangle', label: t('Select a rectangle'), icon: Scan },
    { tool: 'polygon', label: t('Lasso selection'), icon: Lasso },
    { tool: 'arrow', label: t('Draw an arrow'), icon: MoveUpRight }
  ]
  const failure = observationFailed ? undefined : localError
  const imageError: ImageErrorDetail | undefined =
    !running && sourceLimitExceeded
      ? { code: 'SOURCE_LIMIT_EXCEEDED' }
      : failure
        ? undefined
        : (task?.error ?? draft.submission?.error)
  const notices: ComposerNotice[] = []
  if (!running && invalidOutput)
    notices.push({
      id: 'image-output-settings',
      source: 'input',
      occurredAt: 0,
      failure: { category: 'input', diagnostics: {} },
      summary: {
        title: t('Check the image output settings.'),
        description: invalidOutput.option && imageOptionLabels(t)[invalidOutput.option]
      }
    })
  if (observationFailed)
    notices.push({
      id: 'image-observation',
      source: 'operation',
      occurredAt: 0,
      failure: { category: 'service', reason: 'service/image-observation', diagnostics: {} },
      summary: { title: t('Image results could not be verified.') }
    })
  if (running && cancelErrorId && cancelErrorId === draft.submission?.id)
    notices.push({
      id: 'image-cancel',
      source: 'operation',
      occurredAt: 0,
      failure: { category: 'service', diagnostics: {} },
      summary: { title: t('Could not cancel. Try again.') }
    })
  if (failure)
    notices.push({
      id: 'image-edit',
      source: 'operation',
      occurredAt: 0,
      failure: { category: 'internal', diagnostics: {} },
      summary: { title: failure }
    })
  if (draft.sourceSwitchBlocked)
    notices.push({
      id: 'image-draft-limit',
      source: 'input',
      occurredAt: 0,
      failure: { category: 'input', diagnostics: {} },
      summary: { title: t('Draft limit reached. Send or clear a draft before switching images.') }
    })
  const failedTask = task?.error && task.error === imageError ? task : undefined
  const sendUnavailable = owner.settingsError
    ? t('Settings could not be loaded')
    : !canEdit
      ? t('Select an available image model in Settings.')
      : selectedRegion
        ? t('Add an instruction for each marked region.')
        : invalidOutput
          ? t('Check the image output settings.')
          : undefined
  const showMarks = displayed.selectedVersionId === draft.source.selectedVersionId && !showPending
  const canvasRegions = showMarks
    ? draft.regions.map((region) => (region.id === selectedRegion?.id ? selectedRegion : region))
    : []
  if (
    showMarks &&
    selectedRegion &&
    !canvasRegions.some((region) => region.id === selectedRegion.id)
  )
    canvasRegions.push(selectedRegion)
  const instructionChips = busy || showMarks ? draft.regions : []
  const drawingMode = draft.tool !== 'pan' && !locked
  const displayedTask =
    scopedTasks.find(
      (entry) =>
        entry.result?.versionId === displayed.selectedVersionId && entry.state === 'succeeded'
    ) ?? (historyTask?.result?.versionId === displayed.selectedVersionId ? historyTask : undefined)
  const toggleHistory = (open: boolean): void => {
    restoreHistoryFocus.current = true
    setHistoryOpen(open)
  }
  const historyButton = draft.owner.branchId ? (
    <Tooltip>
      <TooltipTrigger
        asChild
        onFocus={(event) => {
          if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
        }}
      >
        <Button
          ref={historyTrigger}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('Image history')}
          aria-expanded={historyOpen}
          onClick={() => toggleHistory(true)}
          className="shrink-0"
        >
          <History className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('Image history')}</TooltipContent>
    </Tooltip>
  ) : null
  const composerContent = (
    <div
      className={
        composerTarget
          ? 'max-h-[min(65vh,36rem)] overflow-y-auto rounded-2xl border border-border-200 bg-bg-000 shadow-sm'
          : undefined
      }
    >
      {composerTarget ? (
        <div className="flex items-center gap-2 border-b border-border-300/40 px-3 py-2">
          <Sparkles className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{t('Edit image')}</span>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            {t('Back to conversation')}
          </Button>
        </div>
      ) : null}
      <div className="space-y-2 p-3 empty:hidden">
        {(unavailableHistoryVersion !== undefined &&
          unavailableHistoryVersion === sourceVersionId) ||
        scopedTasks.some((entry) => entry.error?.code === 'SOURCE_UNAVAILABLE') ? (
          <ErrorNotice inline level="warning" title={t('Some image results are unavailable.')} />
        ) : null}
        {draft.submission && owner.observationErrors?.has(draft.submission.id) ? (
          <ErrorNotice inline level="warning" title={t('Reconnecting to image task…')} />
        ) : null}
        {imageError?.code === 'CANCELLED' ? <ImageErrorNotice error={imageError} /> : null}
        <ImageComposerNotices
          error={imageError?.code === 'CANCELLED' || observationFailed ? undefined : imageError}
          task={
            failedTask
              ? {
                  id: failedTask.id,
                  updatedAt: failedTask.updatedAt,
                  ...failedTask.executionModel
                }
              : undefined
          }
          notices={notices}
          handlers={{
            refresh: {
              run: async () => {
                const id = draft.submission?.id
                if (!id) return
                const next = await owner.checkTask?.({
                  projectId,
                  sessionId,
                  id
                })
                if (!recoveryTask) return
                updateDraft(editorKey, (current) =>
                  current?.submission?.id === id
                    ? { ...current, submission: { ...current.submission, recoveryTask: next } }
                    : current
                )
              }
            }
          }}
        />
        {draft.completedResult ? (
          <ErrorNotice
            inline
            level={draft.completedResult.failed ? 'warning' : 'success'}
            title={
              draft.completedResult.failed ? t('Image could not be loaded.') : t('New image ready')
            }
            primaryButton={{
              label: t('View image'),
              onClick: () => {
                selectImage(draft.completedResult!.item, draft.completedResult!.inputSource)
              }
            }}
          />
        ) : null}
        {composerOpen ? (
          <div className="flex flex-col gap-2" data-testid="image-edit-input-panel">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                aria-label={draft.source.name}
                onClick={() => selectImage(draft.source, draft.inputSource)}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-border-300/60 p-1 pr-2 text-left text-xs focus-visible:ring-2 focus-visible:ring-ring"
              >
                {sourceThumbnail.status === 'ready' ? (
                  <img
                    src={sourceThumbnail.url}
                    alt=""
                    className="h-9 w-12 shrink-0 rounded object-contain bg-muted/40"
                  />
                ) : (
                  <span className="h-9 w-12 rounded bg-muted/40" />
                )}
                <span className="min-w-0">
                  <span className="block text-text-200">{t('Source image')}</span>
                  <span className="block max-w-44 truncate">
                    {draft.source.versionNumber
                      ? t('Version {{number}}', { number: draft.source.versionNumber })
                      : draft.source.name}
                  </span>
                </span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="ml-auto shrink-0"
                aria-label={
                  draft.composerExpanded ? t('Collapse instructions') : t('Expand instructions')
                }
                aria-expanded={Boolean(draft.composerExpanded)}
                onClick={() => update({ composerExpanded: !draft.composerExpanded })}
              >
                {draft.composerExpanded ? (
                  <Minimize2 className="size-4" />
                ) : (
                  <Maximize2 className="size-4" />
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy || Boolean(selectedRegion)}
                aria-label={t('Hide instructions')}
                onClick={() => update({ composerCollapsed: true })}
              >
                <ChevronDown className="size-4" />
              </Button>
            </div>
            {instructionChips.length ? (
              <div className="mb-1 flex max-h-14 shrink-0 flex-wrap gap-1 overflow-y-auto">
                {instructionChips.map((region) => (
                  <div
                    key={region.id}
                    className={`flex min-w-0 max-w-full items-center rounded-md border text-xs ${draft.selectedRegion === region.id ? 'border-primary text-primary' : 'border-border-300/50 text-text-200'}`}
                  >
                    <button
                      type="button"
                      disabled={locked}
                      title={region.instruction}
                      className="flex min-w-0 items-center gap-1.5 px-2 py-1"
                      onClick={() => focusRegion(region.id, true)}
                    >
                      <span className="shrink-0 tabular-nums">{region.number}</span>
                      <span className="truncate">{region.instruction}</span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={locked}
                      aria-label={`${t('Delete region')} ${region.number}`}
                      onClick={() => deleteRegion(region.id)}
                    >
                      <X className="size-3" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            <Textarea
              ref={promptInput}
              aria-label={t('Image editing instruction')}
              placeholder={t('Describe your changes…')}
              value={draft.prompt}
              disabled={locked}
              autoFocus={!draft.submission && !draft.regionDraft}
              maxLength={IMAGE_EDIT_TEXT_LIMIT}
              rows={2}
              className={`disabled:bg-transparent disabled:text-text-200 disabled:opacity-100 field-sizing-fixed min-h-16 shrink-0 resize-none overflow-y-auto border-0 p-1 text-sm leading-6 shadow-none focus-visible:ring-0 ${draft.composerExpanded ? 'h-40' : 'h-16'}`}
              onChange={(event) => update({ prompt: event.target.value })}
              onCompositionStart={() => {
                composing.current = true
              }}
              onCompositionEnd={() => {
                composing.current = false
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !composing.current &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
            <div className="flex h-9 min-w-0 shrink-0 items-center justify-end gap-1 pt-1">
              {busy && draft.submission ? (
                <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                  <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-lg border border-border-300/60 bg-bg-000 h-8 pl-3 pr-1 text-sm text-text-100 shadow-sm">
                    <LoaderCircle
                      aria-hidden
                      className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                    />
                    <span
                      role="status"
                      data-testid="image-task-status"
                      className="min-w-0 truncate"
                    >
                      {loadingResult
                        ? t('Loading image…')
                        : draft.submission.stopping
                          ? t('Cancelling…')
                          : task?.state === 'running'
                            ? t('Processing')
                            : draft.submission.preparing
                              ? t('Preparing…')
                              : t('Queued')}
                    </span>
                    <span className="shrink-0 text-text-200">
                      <Elapsed start={draft.submission.startedAt} />
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={t('Stop image editing')}
                      disabled={draft.submission.stopping || loadingResult}
                      onClick={() => void cancel()}
                    >
                      {t('Cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mr-auto min-w-0">
                    <ImageEditParameters
                      settings={settings}
                      settingsError={owner.settingsError}
                      model={draft.model}
                      options={draft.options}
                      invalidOption={invalidOutput?.option}
                      disabled={locked}
                      onModel={(model, options) => {
                        update({ model, options, optionsInherited: true })
                        setLocalError(undefined)
                      }}
                      onOptions={(options) => {
                        update({ options, optionsInherited: false })
                        setLocalError(undefined)
                      }}
                    />
                  </div>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          tabIndex={sendUnavailable ? 0 : undefined}
                          className="inline-flex shrink-0"
                        >
                          <Button
                            type="button"
                            size="sm"
                            aria-label={t('Send image edit')}
                            disabled={
                              Boolean(sendUnavailable) ||
                              image.status !== 'ready' ||
                              !image.width ||
                              !image.height ||
                              sourceLimitExceeded ||
                              locked ||
                              (!draft.prompt.trim() && !draft.regions.length) ||
                              draft.regions.some(({ instruction }) => !instruction.trim())
                            }
                            onClick={() => void submit()}
                          >
                            <ArrowUp className="size-4" />
                            {t('Generate new version')}
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="z-[80]">
                        {sendUnavailable ||
                          (draft.regions.length
                            ? t('Marked regions guide the model. Other parts may also change.')
                            : t('Send image edit'))}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-3 py-1">
            <span className="text-sm text-text-200">
              {displayed.versionNumber
                ? t('Version {{number}}', { number: displayed.versionNumber })
                : displayed.name}
            </span>
            <Button
              ref={continueButton}
              type="button"
              size="sm"
              onClick={() => update({ composerCollapsed: false })}
            >
              <Sparkles className="size-3.5" />
              {t('Continue editing')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
  const composerPortal = composerTarget ? createPortal(composerContent, composerTarget) : null
  if (historyOpen && draft.owner.branchId) {
    return (
      <div
        className="flex size-full min-h-0 flex-col bg-bg-000"
        data-testid="image-editor"
        data-preview-escape-boundary
        data-preview-context-menu-passthrough
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          toggleHistory(false)
        }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border-300/40 px-3 py-1.5">
          <span className="text-sm font-medium">{t('Image history')}</span>
          <Button
            ref={historyTrigger}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('Close')}
            onClick={() => toggleHistory(false)}
          >
            <X className="size-4" />
          </Button>
        </div>
        {composerPortal}
        <ImageEditHistory
          source={rootItem}
          selected={displayed}
          scope={{ projectId: session.projectId!, sessionId: session.id }}
          branchId={draft.owner.branchId}
          onSelect={(item, input, task) => {
            selectImage(item, input)
            setHistoryTask(task)
            toggleHistory(false)
          }}
        />
      </div>
    )
  }
  return (
    <div
      className="image-edit-studio relative flex size-full min-h-0 flex-col overflow-hidden bg-muted/40"
      data-testid="image-editor"
      data-preview-context-menu-passthrough
      data-preview-escape-boundary={comparing || undefined}
      onKeyDown={(event) => {
        if (
          !comparing ||
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing
        )
          return
        event.preventDefault()
        event.stopPropagation()
        setComparisonVersion(undefined)
        compareButton.current?.focus()
      }}
    >
      <ConfirmActionDialog
        open={discardOpen}
        title={t('Discard unsaved changes?')}
        description={t('Your unsaved edits to this file will be lost.')}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Discard changes')}
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          if (!locked) updateDraft(editorKey, () => undefined)
        }}
      />
      <TooltipProvider delayDuration={0} disableHoverableContent>
        <div className="flex shrink-0 items-center justify-between gap-1 px-2 py-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Back to image preview')}
                  onClick={onClose}
                >
                  <ArrowLeft className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('Back to image preview')}</TooltipContent>
          </Tooltip>
          <div className="min-w-0 flex-1 truncate text-sm font-medium">{displayed.name}</div>
          <div className="flex items-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant={comparing ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    ref={compareButton}
                    disabled={!comparisonSource}
                    aria-label={comparisonLabel}
                    aria-pressed={comparing}
                    onClick={() =>
                      setComparisonVersion(comparing ? undefined : displayed.selectedVersionId)
                    }
                  >
                    <Columns2 className="size-4" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent className="z-[80]">
                {comparisonSource ? comparisonLabel : t('Generate another version to compare.')}
              </TooltipContent>
            </Tooltip>
            <ImageEditDetails
              key={displayed.selectedVersionId}
              item={displayed}
              edit={displayedTask?.edit}
              prompt={displayedTask?.prompt}
            />
            {historyButton}
            <Tooltip>
              <TooltipTrigger
                asChild
                onFocus={(event) => {
                  if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                }}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('Discard changes')}
                  disabled={locked}
                  onClick={() => setDiscardOpen(true)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('Discard changes')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </TooltipProvider>
      <div ref={setCanvasViewport} className="relative min-h-24 flex-1 overflow-hidden p-3">
        <ImageEditFloatingTools
          key={displayed.selectedVersionId}
          viewport={canvasViewport}
          naturalSize={
            image.status === 'ready' && image.width && image.height
              ? { width: image.width, height: image.height }
              : undefined
          }
          hidden={showPending || comparing || image.status !== 'ready'}
        >
          <TooltipProvider delayDuration={300} disableHoverableContent>
            <div
              className="flex w-max max-w-full flex-wrap items-center justify-center gap-1 rounded-xl border border-border-300/60 bg-bg-000/95 p-1.5 shadow-lg backdrop-blur-md"
              data-testid="image-edit-tools"
            >
              <div className="flex items-center gap-0.5">
                {tools.map(({ tool, label, icon: Icon }) => (
                  <Tooltip key={tool}>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant={draft.tool === tool ? 'secondary' : 'ghost'}
                        size="sm"
                        className="image-edit-tool"
                        aria-label={label}
                        aria-pressed={draft.tool === tool}
                        disabled={locked || comparing}
                        onClick={() => update({ tool, composerCollapsed: false })}
                      >
                        <Icon className="size-4" />
                        <span className="image-edit-tool-label">{label}</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="z-[80]">
                      {label}
                      {tool !== 'pan' && editSpec ? (
                        <span className="mt-0.5 block opacity-75">
                          {t('Marks guide the model. Other areas may change.')}
                        </span>
                      ) : null}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
              <div className="flex items-center border-l border-border-300/50 pl-1">
                {' '}
                {[
                  { label: t('Undo'), icon: Undo2, unavailable: !draft.undo.length, redo: false },
                  { label: t('Redo'), icon: Redo2, unavailable: !draft.redo.length, redo: true }
                ].map(({ label, icon: Icon, unavailable, redo }) => (
                  <Tooltip key={label}>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={label}
                          disabled={locked || comparing || unavailable}
                          onClick={() => undo(redo)}
                        >
                          <Icon className="size-3.5" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          </TooltipProvider>
        </ImageEditFloatingTools>

        <div
          className={showPending ? 'invisible size-full' : 'size-full'}
          aria-hidden={showPending || undefined}
          inert={showPending || undefined}
        >
          {image.status === 'loading' ? (
            <PreviewLoadingContent />
          ) : image.status === 'ready' &&
            (!image.width || !image.height) &&
            decodeError !== displayed.selectedVersionId ? (
            <img
              key={image.url}
              src={image.url}
              alt={displayed.name}
              className="size-full object-contain"
              onLoad={({ currentTarget }) =>
                setMeasured({
                  url: image.url,
                  width: currentTarget.naturalWidth,
                  height: currentTarget.naturalHeight
                })
              }
              onError={() => setDecodeError(displayed.selectedVersionId)}
            />
          ) : image.status === 'ready' &&
            image.width &&
            image.height &&
            decodeError !== displayed.selectedVersionId ? (
            comparing && comparisonSource ? (
              <ImageEditComparison
                key={`${displayed.selectedVersionId}:${comparisonSource.sourceVersionId}`}
                source={comparisonSource}
                sourceLabel={
                  !inputSource && fallbackComparisonItem?.versionNumber !== undefined
                    ? t('Version {{number}}', { number: fallbackComparisonItem.versionNumber })
                    : undefined
                }
                resultLabel={
                  !inputSource && currentVersionNumber !== undefined
                    ? t('Version {{number}}', { number: currentVersionNumber })
                    : undefined
                }
                resultUrl={image.url}
              />
            ) : (
              <ZoomablePreview
                key={displayed.selectedVersionId}
                viewRef={canvasZoom}
                panningDisabled={drawingMode}
                cursorMode={drawingMode ? 'crosshair' : 'grab'}
                initialTransform={draft.zoom}
                onTransformEnd={(zoom) =>
                  updateDraft(editorKey, (current) => {
                    if (
                      !current ||
                      (current.selectedCandidate ?? current.source.selectedVersionId) !==
                        displayed.selectedVersionId
                    )
                      return current
                    return { ...current, zoom }
                  })
                }
                tooltipClassName="z-[80]"
              >
                <ImageEditCanvas
                  url={image.url}
                  name={displayed.name}
                  naturalSize={{ width: image.width, height: image.height }}
                  regions={canvasRegions}
                  popupBoundary={canvasViewport ?? undefined}
                  instructionEditor={
                    selectedRegion && !locked ? (
                      <>
                        <Textarea
                          ref={regionInput}
                          aria-label={t('Region instruction')}
                          placeholder={t('Change this region…')}
                          value={selectedRegion.instruction}
                          maxLength={4000}
                          className="max-h-28 min-h-0 resize-none overflow-y-auto rounded-none border-0 bg-transparent py-1 text-sm leading-5 shadow-none focus-visible:ring-0 dark:bg-transparent"
                          rows={1}
                          onChange={(event) =>
                            update({
                              regionDraft: { ...selectedRegion, instruction: event.target.value }
                            })
                          }
                          onKeyDown={(event) => {
                            if (
                              event.key === 'Enter' &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing
                            ) {
                              event.preventDefault()
                              confirmRegion()
                            }
                          }}
                        />
                        <div className="flex justify-end gap-1 px-2.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={t('Cancel')}
                            onClick={closeRegion}
                          >
                            <X className="size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={t('Done')}
                            disabled={!selectedRegion.instruction.trim()}
                            onClick={confirmRegion}
                          >
                            <Check className="size-3.5" />
                            {t('Add instruction')}
                          </Button>
                        </div>
                      </>
                    ) : undefined
                  }
                  onCloseInstruction={closeRegion}
                  tool={draft.tool}
                  selected={draft.selectedRegion}
                  locked={locked}
                  onAdd={onAdd}
                  onSelect={focusRegion}
                  onError={() => setDecodeError(displayed.selectedVersionId)}
                />
              </ZoomablePreview>
            )
          ) : (
            <ErrorNotice inline title={t('Image could not be loaded.')} />
          )}
        </div>
        {showPending ? (
          <ImageEditPending
            width={image.status === 'ready' ? image.width : undefined}
            height={image.status === 'ready' ? image.height : undefined}
            loading={loadingResult}
            onViewSource={() => selectImage(draft.source, draft.inputSource)}
          />
        ) : null}
      </div>
      <div
        className="image-edit-dock z-20 mx-auto mb-3 max-h-[55%] w-[calc(100%-1.5rem)] max-w-2xl shrink-0 overflow-y-auto rounded-2xl border border-border-300/60 bg-bg-000 shadow-lg"
        data-testid="image-edit-composer"
        data-collapsed={Boolean(composerTarget) || !composerOpen}
      >
        <TooltipProvider>
          <div data-testid="image-recent-results" className="flex items-center gap-2 px-3 py-2">
            <span className="sr-only" aria-live="polite">
              {displayed.versionNumber
                ? t('Version {{number}}', { number: displayed.versionNumber })
                : displayed.name}
            </span>
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {versionStrip.map(({ item, label, edit, prompt }) => (
                <ImageEditCandidate
                  key={item.selectedVersionId}
                  item={item}
                  label={label}
                  edit={edit}
                  prompt={prompt}
                  selected={displayed.selectedVersionId === item.selectedVersionId}
                  onSelect={() => selectImage(item, edit?.source)}
                />
              ))}
              {busy ? (
                <div
                  aria-label={t('Generating image…')}
                  className="flex h-11 w-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-border-300 bg-muted/40"
                >
                  <LoaderCircle
                    aria-hidden
                    className="size-4 animate-spin motion-reduce:animate-none"
                  />
                </div>
              ) : null}
              {draft.lastEdit ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  onClick={() => {
                    updateDraft(editorKey, (current) => {
                      if (!current?.lastEdit) return current
                      const previous = current.lastEdit
                      const next = switchImageEditorSource(current, previous.source)
                      if (next.sourceSwitchBlocked) return next
                      return {
                        ...next,
                        prompt: previous.prompt,
                        regions: previous.regions,
                        completedResult: undefined,
                        composerCollapsed: false
                      }
                    })
                  }}
                >
                  {t('Revise last edit')}
                </Button>
              ) : null}
            </div>
          </div>
        </TooltipProvider>
        {!composerTarget ? composerContent : null}
      </div>
      {composerPortal}
    </div>
  )
}

export function ImageEditorBoundary({
  item,
  children,
  readOnly,
  presentation = 'panel',
  onPinSource,
  onVersionChange
}: {
  item: PreviewFileItem
  children:
    | ReactNode
    | ((preview: {
        item: PreviewFileItem
        initialTransform?: ImageEditorDraft['zoom']
        onEdit?: () => void
        editDisabledReason?: string
        onTransformEnd: (zoom: NonNullable<ImageEditorDraft['zoom']>) => void
      }) => ReactNode)
  presentation?: PreviewFileRendererProps['imageEditPresentation']
  readOnly?: boolean
  onPinSource?: () => void
  onVersionChange?: (item: PreviewFileItem | undefined) => void
}): React.JSX.Element {
  const [loadingRequest, setLoadingRequest] = useState<object>()
  const [failedRequest, setFailedRequest] = useState<object>()
  const [requestedEditKey, setRequestedEditKey] = useState<string>()
  const owner = useImageEditing()
  const [previewZoom, setPreviewZoom] = useState<{ key: string; zoom: ImageEditorDraft['zoom'] }>()
  const session = useSessionStore((state) =>
    state.sessions.find(({ id }) => id === state.selectedSessionId)
  )
  const entryIdentity = JSON.stringify([
    session?.id,
    item.projectId,
    item.id,
    item.selectedVersionId,
    readOnly
  ])
  const entryRequest = useMemo(
    () => ({ identity: entryIdentity, requests: new Set<AbortController>() }),
    [entryIdentity]
  )
  const entryLoading = loadingRequest === entryRequest
  const entryError = failedRequest === entryRequest
  const scope = imageEditorScope(session)
  const key = scope ? imageEditorKey(scope, item) : undefined
  const allowed = !readOnly && owner && session && session.projectId === item.projectId && key
  const canEnter =
    !readOnly &&
    owner &&
    session &&
    !session.archivedAt &&
    session.projectId === item.projectId &&
    imageEditorSource(item) &&
    (key || (session.contentLoaded === false && session.historyPage))
  useEffect(() => {
    return () => {
      entryRequest.requests.forEach((request) => request.abort())
      entryRequest.requests.clear()
    }
  }, [entryRequest])
  const draft = allowed ? owner.drafts.get(key) : undefined
  const draftLimitReached =
    owner &&
    owner.drafts.size >= IMAGE_EDITOR_DRAFT_LIMIT &&
    reusableImageDraftKey(owner.drafts) === undefined
  const { t } = useTranslation()
  const previewItem = draft?.browsing?.item ?? draft?.source ?? item
  const previewZoomKey = `${key}:${previewItem.selectedVersionId}`
  const inDialog = presentation === 'dialog'
  const editing = inDialog ? requestedEditKey === key : draft?.panelOpen
  useLayoutEffect(() => {
    if (draft && !editing) onVersionChange?.(previewItem)
  }, [draft, editing, previewItem, onVersionChange])
  useLayoutEffect(() => () => onVersionChange?.(undefined), [onVersionChange])
  if (draft && allowed && editing)
    return (
      <ActiveImageEditor
        key={key}
        owner={owner}
        editorKey={key}
        draft={draft}
        session={session}
        rootItem={item}
        localComposer={presentation !== 'panel'}
        onClose={() => {
          if (inDialog) setRequestedEditKey(undefined)
          else owner.update(key, (current) => current && { ...current, panelOpen: false })
        }}
        onVersionChange={onVersionChange}
      />
    )
  const onEdit = canEnter
    ? (): void => {
        if (entryLoading || (!draft && draftLimitReached)) return
        const request = new AbortController()
        entryRequest.requests.add(request)
        setFailedRequest(undefined)
        const begin = (loaded: ChatSession | undefined): void => {
          if (request.signal.aborted || useSessionStore.getState().selectedSessionId !== session.id)
            return
          const loadedScope = imageEditorScope(loaded)
          const loadedKey = loadedScope ? imageEditorKey(loadedScope, item) : undefined
          if (!loaded || !loadedKey || loaded.projectId !== item.projectId) return
          setRequestedEditKey(loadedKey)
          onPinSource?.()
          void owner.reloadSettings().catch(() => {})
          const frame = loaded.conversationGraph?.frames.find(
            ({ id }) => id === loaded.conversationGraph?.activeFrameId
          )
          owner.update(loadedKey, (current) =>
            current
              ? {
                  ...current,
                  panelOpen: current.panelOpen || !inDialog,
                  composerCollapsed: false,
                  zoom: previewZoom?.key === previewZoomKey ? previewZoom.zoom : current.zoom
                }
              : {
                  owner: {
                    sessionId: session.id,
                    frameId: frame?.id,
                    branchId: frame?.activeBranchId
                  },
                  panelOpen: !inDialog,
                  source: { ...item },
                  prompt: '',
                  options: {},
                  regions: [],
                  undo: [],
                  redo: [],
                  tool: 'pan',
                  zoom: previewZoom?.key === previewZoomKey ? previewZoom.zoom : undefined
                }
          )
        }
        if (session.contentLoaded !== false) {
          begin(session)
          entryRequest.requests.delete(request)
          return
        }
        setLoadingRequest(entryRequest)
        void ensureSessionContentLoaded({ projectId: session.projectId!, sessionId: session.id })
          .then(begin)
          .catch(() => {
            if (!request.signal.aborted) setFailedRequest(entryRequest)
          })
          .finally(() => {
            entryRequest.requests.delete(request)
            if (!request.signal.aborted) setLoadingRequest(undefined)
          })
      }
    : undefined
  return (
    <div className="relative size-full">
      {entryError ? (
        <div className="absolute inset-x-3 top-12 z-30">
          <ErrorNotice inline title={t('Saved conversations could not be loaded')} />
        </div>
      ) : null}
      {typeof children === 'function'
        ? children({
            item: previewItem,
            onEdit,
            editDisabledReason: entryLoading
              ? t('Loading...')
              : !draft && draftLimitReached
                ? t('Close another image editor to start a new one.')
                : undefined,
            initialTransform: draft?.zoom,
            onTransformEnd: (zoom) => {
              setPreviewZoom({ key: previewZoomKey, zoom })
            }
          })
        : children}
      {presentation !== 'panel' && onEdit ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="absolute right-3 top-3 gap-1.5 bg-bg-000 shadow-sm"
          disabled={entryLoading || (!draft && Boolean(draftLimitReached))}
          title={
            !draft && draftLimitReached
              ? t('Close another image editor to start a new one.')
              : undefined
          }
          onClick={onEdit}
        >
          <Sparkles className="size-3.5" />
          {t('Edit image')}
        </Button>
      ) : null}
    </div>
  )
}
