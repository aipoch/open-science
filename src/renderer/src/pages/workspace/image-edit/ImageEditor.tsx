import { ImageErrorNotice } from '@/components/image-error-notice'
import { imageTaskIsActive, type ImageTask } from '../../../../../shared/image-task'
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Columns2,
  Hand,
  History,
  Lasso,
  LoaderCircle,
  MapPin,
  MoveUpRight,
  Redo2,
  Scan,
  Sparkles,
  Undo2,
  X
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReactZoomPanPinchRef } from 'react-zoom-pan-pinch'
import { unwrapProvenanceRead } from '../../../../../shared/provenance-read-result'
import { Button } from '@/components/ui/button'
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
  validateImageModelOptions
} from '../../../../../shared/image-model-presets'
import { useImageEditing } from './image-edit-context'
import {
  changeImageRegions,
  switchImageEditorSource,
  IMAGE_EDITOR_DRAFT_LIMIT,
  reusableImageDraftKey,
  imageEditorCandidates,
  imageEditorKey,
  imageEditorScope,
  imageEditorSource,
  imageLineageRequest,
  type ImageEditorDraft,
  type ImageEditorTool
} from './image-editor-state'
import { ImageEditCanvas } from './ImageEditCanvas'
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
  onVersionChange
}: {
  owner: Owner
  editorKey: string
  draft: ImageEditorDraft
  session: ChatSession
  rootItem: PreviewFileItem
  onVersionChange?: (item: PreviewFileItem | undefined) => void
}): React.JSX.Element {
  const { settings, update: updateDraft, reloadSettings, reloadTasks } = owner
  const { t } = useTranslation()
  const regionInput = useRef<HTMLTextAreaElement>(null)
  const compareButton = useRef<HTMLButtonElement>(null)
  const [canvasViewport, setCanvasViewport] = useState<HTMLDivElement | null>(null)
  const canvasZoom = useRef<ReactZoomPanPinchRef>(null)
  const regionToReveal = useRef<string | undefined>(undefined)
  const sending = useRef(false)
  const [decodeError, setDecodeError] = useState<string>()
  const [localError, setLocalError] = useState<string>()
  const [cancelErrorId, setCancelErrorId] = useState<string>()
  const [comparisonVersion, setComparisonVersion] = useState<string>()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyTask, setHistoryTask] = useState<ImageTask>()
  const historyTrigger = useRef<HTMLButtonElement>(null)
  const restoreHistoryFocus = useRef(false)
  useLayoutEffect(() => {
    if (!restoreHistoryFocus.current) return
    restoreHistoryFocus.current = false
    historyTrigger.current?.focus()
  }, [historyOpen])
  const scopedTasks = useMemo(
    () =>
      owner.tasks.filter(
        (task) => task.sessionId === session.id && task.branchId === draft.owner.branchId
      ),
    [owner.tasks, session.id, draft.owner.branchId]
  )
  const candidates = useMemo(
    () => imageEditorCandidates(scopedTasks, rootItem),
    [scopedTasks, rootItem]
  )
  useEffect(() => {
    void reloadTasks({ projectId: session.projectId!, sessionId: session.id }).catch(() =>
      setLocalError(t('Image results could not be verified.'))
    )
  }, [reloadTasks, session.projectId, session.id, t])
  const selectedCandidate = candidates.find(
    ({ item }) => item.selectedVersionId === draft.selectedCandidate
  )
  const selectedImage =
    draft.selectedCandidate === rootItem.selectedVersionId ? rootItem : selectedCandidate?.item
  const displayed = selectedImage ?? draft.source
  useLayoutEffect(() => {
    onVersionChange?.(displayed)
    return () => onVersionChange?.(undefined)
  }, [onVersionChange, displayed])
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
    knownInput ?? (verifiedInput?.item === displayed ? verifiedInput.source : undefined)
  const image = useCachedPreviewImage(displayed)
  const task = scopedTasks.find(({ id }) => id === draft.submission?.id)
  const running = task ? imageTaskIsActive(task) : Boolean(draft.submission?.preparing)
  const observationFailed =
    !!draft.submission && owner.observationFailures?.has(draft.submission.id)
  const locked =
    observationFailed ||
    running ||
    Boolean(draft.selectedCandidate && draft.selectedCandidate !== 'pending')
  const showPending = running && !observationFailed && draft.selectedCandidate === 'pending'
  const comparing = !running && !!inputSource && comparisonVersion === displayed.selectedVersionId
  const settled = useRef<string | undefined>(undefined)
  useEffect(() => {
    const pending = scopedTasks.find(
      (entry) =>
        imageTaskIsActive(entry) &&
        entry.edit.source.sourceVersionId === draft.source.selectedVersionId
    )
    if (!draft.submission && pending)
      updateDraft(editorKey, (current) =>
        current
          ? {
              ...current,
              submission: { id: pending.id, startedAt: pending.createdAt, preparing: false },
              selectedCandidate: 'pending'
            }
          : current
      )
    if (!task || imageTaskIsActive(task) || settled.current === task.id) return
    settled.current = task.id
    updateDraft(editorKey, (current) =>
      current
        ? {
            ...current,
            submission: current.submission
              ? { ...current.submission, preparing: false, stopping: false, error: undefined }
              : undefined,
            selectedCandidate: task.result?.versionId
          }
        : current
    )
  }, [task, scopedTasks, draft.submission, draft.source.selectedVersionId, updateDraft, editorKey])
  useEffect(() => {
    if (running || !selectedImage || (task && draft.selectedCandidate !== task.result?.versionId))
      return
    updateDraft(editorKey, (current) =>
      current
        ? switchImageEditorSource(
            task?.state === 'succeeded' && task.id === current.submission?.id
              ? { ...current, prompt: '', regions: [], regionDraft: undefined, undo: [], redo: [] }
              : current,
            selectedImage,
            selectedCandidate?.edit.source
          )
        : current
    )
  }, [
    running,
    selectedImage,
    selectedCandidate,
    task,
    draft.selectedCandidate,
    editorKey,
    updateDraft
  ])
  const service = settings?.services.find(({ id }) => id === draft.model?.serviceId)
  const model = service?.models.find(({ id }) => id === draft.model?.modelId)
  const editSpec = model && getImageModelPreset(model.presetId)?.operations.edit
  const canEdit = Boolean(service?.configured && editSpec)
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
    if (running) {
      update({ selectedCandidate: item.selectedVersionId, zoom: undefined })
      return
    }
    if (item.selectedVersionId === draft.source.selectedVersionId && !input) return
    updateDraft(editorKey, (current) =>
      current ? switchImageEditorSource(current, item, input) : current
    )
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
    update({ selectedRegion: id, regionDraft: draft.regions.find((region) => region.id === id) })
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
    const options = validateImageModelOptions(model.presetId, 'edit', draft.options)
    if (!options.ok) {
      setLocalError(t('Check the image output settings.'))
      return
    }
    const regionLength = draft.regions.reduce(
      (total, region) => total + region.instruction.length,
      0
    )
    if (
      regionLength > IMAGE_EDIT_TEXT_LIMIT ||
      !imagePromptFits(buildImageEditPrompt(draft.prompt, draft.regions, editSpec.spatial))
    ) {
      setLocalError(t('Shorten the image editing instructions.'))
      return
    }
    const parsed = imageEditSnapshotSchema.safeParse({
      version: 1,
      source: imageEditorSource(draft.source),
      model: draft.model,
      options: options.options,
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
    update({ submission, selectedRegion: undefined, selectedCandidate: 'pending' })
    const patchSubmission = (patch: Partial<NonNullable<ImageEditorDraft['submission']>>): void =>
      updateDraft(editorKey, (current) =>
        current?.submission?.id === submission.id
          ? { ...current, submission: { ...current.submission, ...patch } }
          : current
      )
    try {
      await owner.startTask({
        id: submission.id,
        projectId: session.projectId!,
        sessionId: session.id,
        frameId: draft.owner.frameId!,
        branchId: draft.owner.branchId!,
        prompt: draft.prompt,
        edit: parsed.data
      })
      patchSubmission({ preparing: false })
    } catch (error) {
      update({ selectedCandidate: undefined })
      patchSubmission({
        preparing: false,
        error: error instanceof Error ? error.message : t('Image editing failed.')
      })
    } finally {
      sending.current = false
    }
  }
  const cancel = async (): Promise<void> => {
    if (!task || !imageTaskIsActive(task) || !draft.submission || draft.submission.stopping) return
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
  const failure = observationFailed
    ? undefined
    : (localError ?? (task ? undefined : draft.submission?.error))
  const sendUnavailable = owner.settingsError
    ? t('Settings could not be loaded')
    : !canEdit
      ? t('Select an available image model in Settings.')
      : selectedRegion
        ? t('Add an instruction for each marked region.')
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
  const instructionChips = canvasRegions.filter((region) => region.instruction.trim())
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
          disabled={running || observationFailed}
          onClick={() => toggleHistory(true)}
          className="shrink-0"
        >
          <History className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('Image history')}</TooltipContent>
    </Tooltip>
  ) : null
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
      className="flex size-full min-h-0 flex-col bg-bg-000"
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
      <TooltipProvider>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-300/40 px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('Back to image preview')}
            onClick={() => updateDraft(editorKey, () => undefined)}
            disabled={running}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <div className="flex items-center gap-0.5">
            {tools.map(({ tool, label, icon: Icon }) => (
              <Tooltip key={tool}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant={draft.tool === tool ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    aria-label={label}
                    aria-pressed={draft.tool === tool}
                    disabled={locked || comparing}
                    onClick={() => update({ tool })}
                  >
                    <Icon className="size-4" />
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
          <div className="flex items-center">
            {inputSource && inputSource.sourceVersionId !== displayed.selectedVersionId ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant={comparing ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    ref={compareButton}
                    aria-label={t('Compare with input image')}
                    aria-pressed={comparing}
                    disabled={running || observationFailed}
                    onClick={() =>
                      setComparisonVersion(comparing ? undefined : displayed.selectedVersionId)
                    }
                  >
                    <Columns2 className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="z-[80]">{t('Compare with input image')}</TooltipContent>
              </Tooltip>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('Undo')}
              disabled={locked || comparing || !draft.undo.length}
              onClick={() => undo()}
            >
              <Undo2 className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('Redo')}
              disabled={locked || comparing || !draft.redo.length}
              onClick={() => undo(true)}
            >
              <Redo2 className="size-3.5" />
            </Button>
            {displayedTask ? (
              <ImageEditDetails
                key={displayed.selectedVersionId}
                item={displayed}
                edit={displayedTask.edit}
                prompt={displayedTask.prompt}
              />
            ) : null}
            {historyButton}
          </div>
        </div>
      </TooltipProvider>
      <div
        ref={setCanvasViewport}
        className="relative min-h-24 flex-1 overflow-hidden bg-muted/40 p-3"
      >
        {image.status === 'loading' ? (
          <PreviewLoadingContent />
        ) : image.status === 'ready' &&
          image.width &&
          image.height &&
          decodeError !== displayed.selectedVersionId ? (
          comparing && inputSource ? (
            <ImageEditComparison
              key={`${displayed.selectedVersionId}:${inputSource.sourceVersionId}`}
              source={inputSource}
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
                        className="min-h-10 min-w-0 flex-1 resize-none border-0 p-1 text-sm shadow-none focus-visible:ring-0"
                        rows={2}
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
                        size="icon-xs"
                        aria-label={t('Done')}
                        disabled={!selectedRegion.instruction.trim()}
                        onClick={confirmRegion}
                      >
                        <Check className="size-3.5" />
                      </Button>
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
        {showPending ? (
          <div
            aria-hidden
            className="image-generation-mask absolute inset-0 z-10 overflow-hidden"
          />
        ) : null}
        {running && draft.submission ? (
          <div
            className={`pointer-events-none absolute inset-x-0 z-20 flex justify-center px-3 ${showPending ? 'inset-y-0 items-center' : 'top-3'}`}
          >
            <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-lg border border-border-300/60 bg-bg-000 py-1 pl-3 pr-1 text-sm text-text-100 shadow-sm">
              <LoaderCircle
                aria-hidden
                className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
              />
              <span role="status" className="min-w-0 truncate">
                {draft.submission.stopping
                  ? t('Cancelling…')
                  : task?.state === 'running'
                    ? t('Processing')
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
                disabled={!task || draft.submission.stopping}
                onClick={() => void cancel()}
              >
                {t('Cancel')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-border-300/40">
        {running && draft.owner.branchId && candidates.length > 0 ? (
          <TooltipProvider>
            <div className="flex items-center gap-2 px-3 py-2">
              <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
                <ImageEditCandidate
                  item={rootItem}
                  label={rootItem.name}
                  selected={
                    !showPending && displayed.selectedVersionId === rootItem.selectedVersionId
                  }
                  onSelect={() => selectImage(rootItem)}
                />
                {draft.source.selectedVersionId !== rootItem.selectedVersionId &&
                !candidates.some(
                  ({ item }) => item.selectedVersionId === draft.source.selectedVersionId
                ) ? (
                  <ImageEditCandidate
                    item={draft.source}
                    label={draft.source.name}
                    selected={!showPending}
                    onSelect={() => selectImage(draft.source)}
                  />
                ) : null}
                {candidates.map((candidate, index) => (
                  <ImageEditCandidate
                    key={candidate.item.selectedVersionId}
                    {...candidate}
                    label={t('Candidate {{number}}', { number: index + 1 })}
                    selected={
                      !showPending &&
                      displayed.selectedVersionId === candidate.item.selectedVersionId
                    }
                    onSelect={() => selectImage(candidate.item, candidate.edit.source)}
                  />
                ))}
              </div>
            </div>
          </TooltipProvider>
        ) : null}
        <div className="space-y-2 p-3 empty:hidden">
          {draft.sourceSwitchBlocked ? (
            <ErrorNotice
              inline
              level="warning"
              title={t('Draft limit reached. Send or clear a draft before switching images.')}
            />
          ) : null}
          {scopedTasks.some((entry) => entry.error?.code === 'SOURCE_UNAVAILABLE') ? (
            <ErrorNotice inline level="warning" title={t('Some image results are unavailable.')} />
          ) : null}
          {draft.submission && owner.observationErrors?.has(draft.submission.id) ? (
            <ErrorNotice inline level="warning" title={t('Reconnecting to image task…')} />
          ) : null}
          {observationFailed ? (
            <ErrorNotice
              inline
              level="warning"
              title={t('Image results could not be verified.')}
              primaryButton={{
                label: t('Refresh'),
                onClick: () => {
                  if (draft.submission)
                    void owner
                      .checkTask?.({
                        projectId: session.projectId!,
                        sessionId: session.id,
                        id: draft.submission.id
                      })
                      .catch(() => {})
                }
              }}
            />
          ) : null}
          {running && task && cancelErrorId === task.id ? (
            <ErrorNotice inline level="warning" title={t('Could not cancel. Try again.')} />
          ) : null}
          {task?.error && !failure ? <ImageErrorNotice error={task.error} /> : null}
          {failure ? (
            <ErrorNotice inline title={t('Image editing failed.')} description={failure} />
          ) : null}
          {!running ? (
            <div className="rounded-xl border border-border-300/70 bg-bg-000 p-2 shadow-sm focus-within:border-border-200">
              {instructionChips.length ? (
                <div className="mb-1 flex max-h-20 flex-wrap gap-1 overflow-auto">
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
                aria-label={t('Image editing instruction')}
                placeholder={t('Describe your changes…')}
                value={draft.prompt}
                disabled={locked}
                maxLength={IMAGE_EDIT_TEXT_LIMIT}
                rows={2}
                className="min-h-12 max-h-32 resize-none border-0 p-1 text-sm shadow-none focus-visible:ring-0"
                onChange={(event) => update({ prompt: event.target.value })}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault()
                    void submit()
                  }
                }}
              />
              <div className="flex min-w-0 items-center justify-end gap-1 pt-1">
                <ImageEditParameters
                  settings={settings}
                  settingsError={owner.settingsError}
                  model={draft.model}
                  options={draft.options}
                  disabled={locked}
                  onModel={(model, options) => {
                    update({ model, options })
                    setLocalError(undefined)
                  }}
                  onOptions={(options) => {
                    update({ options })
                    setLocalError(undefined)
                  }}
                />
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        tabIndex={sendUnavailable ? 0 : undefined}
                        className="inline-flex shrink-0"
                      >
                        <Button
                          type="button"
                          size="icon-sm"
                          aria-label={t('Send image edit')}
                          disabled={
                            Boolean(sendUnavailable) ||
                            locked ||
                            (!draft.prompt.trim() && !draft.regions.length) ||
                            draft.regions.some(({ instruction }) => !instruction.trim())
                          }
                          onClick={() => void submit()}
                        >
                          <ArrowUp className="size-4" />
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
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function ImageEditorBoundary({
  item,
  children,
  readOnly,
  onPinSource,
  onVersionChange
}: {
  item: PreviewFileItem
  children: ReactNode
  readOnly?: boolean
  onPinSource?: () => void
  onVersionChange?: (item: PreviewFileItem | undefined) => void
}): React.JSX.Element {
  const owner = useImageEditing()
  const session = useSessionStore((state) =>
    state.sessions.find(({ id }) => id === state.selectedSessionId)
  )
  const scope = imageEditorScope(session)
  const key = scope ? imageEditorKey(scope, item) : undefined
  const allowed = !readOnly && owner && session && session.projectId === item.projectId && key
  const draft = allowed ? owner.drafts.get(key) : undefined
  const draftLimitReached =
    owner &&
    owner.drafts.size >= IMAGE_EDITOR_DRAFT_LIMIT &&
    reusableImageDraftKey(owner.drafts) === undefined
  const { t } = useTranslation()
  if (draft && allowed)
    return (
      <ActiveImageEditor
        key={key}
        owner={owner}
        editorKey={key}
        draft={draft}
        session={session}
        rootItem={item}
        onVersionChange={onVersionChange}
      />
    )
  return (
    <div className="relative size-full">
      {children}
      {allowed ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="absolute right-3 top-3 gap-1.5 bg-bg-000/90 shadow-sm backdrop-blur"
          title={
            draftLimitReached ? t('Close another image editor to start a new one.') : undefined
          }
          disabled={draftLimitReached}
          onClick={() => {
            onPinSource?.()
            void owner.reloadSettings().catch(() => {})
            const frame = session.conversationGraph?.frames.find(
              ({ id }) => id === session.conversationGraph?.activeFrameId
            )
            owner.update(key, () => ({
              owner: { sessionId: session.id, frameId: frame?.id, branchId: frame?.activeBranchId },
              source: { ...item },
              prompt: '',
              options: {},
              regions: [],
              undo: [],
              redo: [],
              tool: 'pan'
            }))
          }}
        >
          <Sparkles className="size-3.5" />
          {t('Edit image')}
        </Button>
      ) : null}
    </div>
  )
}
