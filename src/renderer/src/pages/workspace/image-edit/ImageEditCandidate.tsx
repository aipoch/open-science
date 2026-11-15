import { unwrapProvenanceRead } from '../../../../../shared/provenance-read-result'
import { getImageModelPreset } from '../../../../../shared/image-model-presets'
import type { ImageModelPresetId } from '../../../../../shared/image-model-settings'
import { imageOptionLabels } from '../image-tool-presentation'
import { ErrorNotice } from '@/components/error-notice'
import { ChevronDown, Info } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { PreviewFileItem } from '@/stores/preview-workbench-contract'
import type { ImageEditSnapshot } from '../../../../../shared/image-edit-contract'
import { useCachedPreviewImage } from '../previews/useCachedPreviewImage'
import { WorkspaceCollapsiblePanel } from '../WorkspaceCollapsiblePanel'
import { Button } from '@/components/ui/button'

export function ImageEditCandidate({
  item,
  label,
  selected,
  onSelect,
  edit,
  prompt
}: {
  item: PreviewFileItem
  label: string
  selected: boolean
  onSelect(): void
  edit?: ImageEditSnapshot
  prompt?: string
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!container.current) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: '80px'
    })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const image = useCachedPreviewImage(item, visible, false, true)
  return (
    <div
      ref={container}
      className={`flex shrink-0 items-center gap-1 rounded-lg border p-1 ${selected ? 'border-primary bg-primary/5' : 'border-border-300/60'}`}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onSelect}
            aria-label={label}
            aria-pressed={selected}
            className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {image.status === 'ready' ? (
              <img
                src={image.url}
                alt=""
                draggable={false}
                className="h-9 w-12 rounded object-cover"
              />
            ) : (
              <span className="block h-9 w-12 rounded bg-bg-200" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
      {edit ? <ImageEditDetails item={item} edit={edit} prompt={prompt} /> : null}
    </div>
  )
}

export function ImageEditDetails({
  item,
  edit,
  prompt
}: {
  item: PreviewFileItem
  edit: ImageEditSnapshot
  prompt?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [details, setDetails] = useState<{ model: string; parameters: Record<string, unknown> }>()
  const [detailsError, setDetailsError] = useState(false)
  const labels = imageOptionLabels(t)
  useEffect(() => {
    if (!open || !edit || details) return
    let active = true
    void window.api.artifacts
      .getVersionProvenance({
        projectId: item.projectId!,
        appSessionId: item.sessionId!,
        artifactId: item.artifactId!,
        versionId: item.selectedVersionId!
      })
      .then(unwrapProvenanceRead)
      .then((value) => {
        if (!active) return
        const args = value?.evidence.connector_execution?.normalized_arguments
        if (!args || typeof args.model !== 'string') throw new Error('Image details unavailable.')
        const spec =
          typeof args.presetId === 'string'
            ? getImageModelPreset(args.presetId as ImageModelPresetId)?.operations.edit
            : undefined
        const parameters =
          args.parameters && typeof args.parameters === 'object'
            ? Object.fromEntries(
                Object.entries(args.parameters).filter(
                  ([key, value]) =>
                    spec?.options[key] && ['string', 'number', 'boolean'].includes(typeof value)
                )
              )
            : {}
        setDetailsError(false)
        setDetails({ model: args.model, parameters })
      })
      .catch(() => {
        if (active) setDetailsError(true)
      })
    return () => {
      active = false
    }
  }, [open, edit, details, item.projectId, item.sessionId, item.artifactId, item.selectedVersionId])
  const [expanded, setExpanded] = useState(false)
  const [clipped, setClipped] = useState(false)
  const [parametersOpen, setParametersOpen] = useState(false)
  const parametersId = useId()
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  const enter = (): void => {
    clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const leave = (): void => {
    closeTimer.current = setTimeout(() => setOpen(false), 180)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('Image generation details')}
          onMouseEnter={enter}
          onMouseLeave={leave}

          className="grid size-7 place-items-center rounded-md text-text-300 hover:bg-muted hover:text-text-000 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="z-[80] w-80 max-w-[calc(100vw-2rem)] space-y-3 p-3"
        onMouseEnter={enter}
        onMouseLeave={leave}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex min-w-0 items-center gap-3 text-xs">
          <span className="shrink-0 text-text-300">{t('Input')}</span>
          <span className="min-w-0 truncate text-text-100" title={edit.source.name}>
            {edit.source.name}
          </span>
        </div>
        <div
          ref={(node) => {
            if (node && !expanded) setClipped(node.scrollHeight > node.clientHeight)
          }}
          className={`${expanded ? 'max-h-48 overflow-auto whitespace-pre-wrap' : 'line-clamp-2'} break-words text-xs leading-relaxed text-text-000`}
        >
          {[prompt, ...edit.regions.map((r) => `${r.number}. ${r.instruction}`)]
            .filter(Boolean)
            .join('\n')}
        </div>
        {clipped || expanded ? (
          <button
            type="button"
            className="text-xs text-primary"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? t('Collapse') : t('Expand')}
          </button>
        ) : null}
        <div className="border-t border-border-300/50 pt-2">
          <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
            <span className="shrink-0 text-text-300">{t('Model')}</span>
            <span className="min-w-0 truncate font-medium" title={details?.model ?? '…'}>
              {details?.model ?? '…'}
            </span>
          </div>
          {detailsError ? (
            <ErrorNotice inline title={t('Image results could not be verified.')} />
          ) : null}
          {details && Object.keys(details.parameters).length ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={parametersOpen}
                aria-controls={parametersId}
                className="mt-2 w-full justify-between px-0 text-xs text-text-200"
                onClick={() => setParametersOpen(!parametersOpen)}
              >
                {t('Output settings')}
                <ChevronDown
                  className={`size-3.5 transition-transform motion-reduce:transition-none ${parametersOpen ? 'rotate-180' : ''}`}
                />
              </Button>
              <WorkspaceCollapsiblePanel isOpen={parametersOpen}>
                <dl
                  id={parametersId}
                  className="flex flex-wrap gap-x-3 gap-y-1 pt-2 text-xs text-text-200"
                >
                  {Object.entries(details.parameters).map(([key, value]) => (
                    <div className="flex min-w-0 gap-1" key={key}>
                      <dt className="truncate">{labels[key] ?? key}:</dt>
                      <dd className="max-w-36 truncate">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              </WorkspaceCollapsiblePanel>
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
