import { ImageErrorNotice } from '@/components/image-error-notice'
import type { ImageErrorDetail } from '../../../../shared/image-model-error'
import { ImageToolPreviewContext } from './image-tool-preview-context'
import { ChevronDown, ImagePlus, LoaderCircle, X } from 'lucide-react'
import { useContext, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { ErrorNotice } from '@/components/error-notice'
import { cn } from '@/lib/utils'
import { useCachedPreviewImage } from './previews/useCachedPreviewImage'
import { useNearViewport } from './previews/useNearViewport'
import { ProjectFileMentionButton } from './ProjectFileMentionButton'
import { WorkspaceCollapsiblePanel } from './WorkspaceCollapsiblePanel'
import { imageOptionLabels, imageToolInput, type ImageToolResult } from './image-tool-presentation'

export const WorkspaceImageToolCard = ({
  operation,
  input,
  result,
  error,
  pending = false,
  inputFilename,
  variant = 'conversation'
}: {
  operation: 'generate' | 'edit'
  input: unknown
  error?: ImageErrorDetail
  result?: ImageToolResult
  pending?: boolean
  inputFilename?: string
  variant?: 'conversation' | 'provenance'
}): React.JSX.Element => {
  const { t } = useTranslation()
  const isProvenance = variant === 'provenance'
  const [expanded, setExpanded] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsId = useId()
  const labels = imageOptionLabels(t)
  const args = imageToolInput(input)
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''
  const filename = result?.filename ?? (typeof args.filename === 'string' ? args.filename : '')
  const options =
    args.options && typeof args.options === 'object' && !Array.isArray(args.options)
      ? Object.entries(args.options).filter(
          ([key, value]) =>
            Object.hasOwn(labels, key) && ['string', 'number', 'boolean'].includes(typeof value)
        )
      : []
  const settings = (
    <div
      id={settingsId}
      className={cn(
        'flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground',
        isProvenance && 'pt-2'
      )}
    >
      {options.map(([key, value]) => (
        <span key={key} className="max-w-full truncate" title={String(value)}>
          {labels[key]}:{' '}
          <span className={isProvenance ? 'font-medium text-foreground' : undefined}>
            {String(value)}
          </span>
        </span>
      ))}
    </div>
  )
  return (
    <section
      data-testid="image-tool-card"
      className={cn(
        'min-w-0 overflow-hidden rounded-lg border border-border bg-card text-sm',
        isProvenance && 'space-y-2 p-3'
      )}
    >
      <div
        className={cn(
          'flex min-w-0 items-center gap-2',
          !isProvenance && 'border-b border-border px-3 py-2.5'
        )}
      >
        {pending ? (
          <LoaderCircle
            className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <ImagePlus className="size-4 shrink-0 text-primary" aria-hidden="true" />
        )}
        <span className={cn('font-medium', !isProvenance && 'shrink-0')}>
          {operation === 'edit' ? t('Edit image') : t('Image generation')}
        </span>
        {!isProvenance ? (
          <span
            className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground"
            title={filename}
          >
            {filename}
          </span>
        ) : null}
      </div>
      <div className={isProvenance ? 'space-y-2' : 'space-y-3 p-3'}>
        {error ? <ImageErrorNotice error={error} /> : null}
        {prompt ? (
          <div>
            <p
              className={
                expanded ? 'max-h-64 overflow-auto whitespace-pre-wrap break-words' : 'truncate'
              }
            >
              {prompt}
            </p>
            {prompt.length > 120 || /\n/u.test(prompt) ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0 py-1 text-xs"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? t('Show less') : t('Show more')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {result?.model || (result?.width && result.height) || inputFilename ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {result?.model ? (
              <span className="max-w-full truncate" title={result.model}>
                {result.model}
              </span>
            ) : null}
            {result?.width && result.height ? (
              <span className="whitespace-nowrap tabular-nums">
                {result.width} × {result.height}
              </span>
            ) : null}
            {inputFilename ? (
              <span
                className={cn('max-w-full truncate', isProvenance && 'basis-full')}
                title={inputFilename}
              >
                {t('Source image')}: {inputFilename}
              </span>
            ) : null}
          </div>
        ) : null}
        {options.length > 0 ? (
          isProvenance ? (
            <div className="border-t border-border pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={settingsOpen}
                aria-controls={settingsOpen ? settingsId : undefined}
                className="-ml-1.5 gap-1.5 px-1.5 text-xs text-muted-foreground aria-expanded:bg-transparent"
                onClick={() => setSettingsOpen(!settingsOpen)}
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    'size-3.5 transition-transform motion-reduce:transition-none',
                    !settingsOpen && '-rotate-90'
                  )}
                />
                {t('Output settings')}
              </Button>
              <WorkspaceCollapsiblePanel isOpen={settingsOpen}>
                {settings}
              </WorkspaceCollapsiblePanel>
            </div>
          ) : (
            settings
          )
        ) : null}
      </div>
    </section>
  )
}

export const WorkspaceImageToolOutput = ({
  result
}: {
  result: ImageToolResult
}): React.JSX.Element | null => {
  const context = useContext(ImageToolPreviewContext)
  if (!context?.projectId || !context.sessionId) return null
  return (
    <ImageToolOutputContent
      result={result}
      projectId={context.projectId}
      sessionId={context.sessionId}
    />
  )
}

const ImageToolOutputContent = ({
  result,
  projectId,
  sessionId
}: {
  result: ImageToolResult
  projectId: string
  sessionId: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [setElement, near] = useNearViewport<HTMLDivElement>()
  const [approached, setApproached] = useState(false)
  if (near && !approached) setApproached(true)
  const image = useCachedPreviewImage(
    {
      source: 'artifact',
      path: result.versionId,
      projectId,
      sessionId,
      managedFileId: result.artifactId,
      selectedVersionId: result.versionId,
      imageGenerationSessionId: sessionId
    },
    approached
  )
  return (
    <div
      ref={setElement}
      className="mx-1 mb-2 mt-2 flex w-fit max-w-full items-start gap-1 overflow-hidden rounded-lg border border-border bg-card p-2 md:ml-[30px]"
      data-testid="image-tool-output"
    >
      {image.status === 'ready' ? (
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Trigger asChild>
            <button
              type="button"
              className="block min-w-0 max-w-full cursor-zoom-in overflow-hidden rounded-md focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={t('Preview {{name}}', { name: result.filename })}
            >
              <img
                src={image.url}
                alt={result.filename}
                className="block max-h-[300px] max-w-full object-contain"
                decoding="async"
              />
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className={dialogOverlayClassName} />
            <Dialog.Content
              aria-describedby={undefined}
              className={dialogPanelClassName('max-h-[94vh] w-[min(94vw,96rem)] max-w-none p-2')}
            >
              <Dialog.Title className="sr-only">
                {t('Preview {{name}}', { name: result.filename })}
              </Dialog.Title>
              <img
                src={image.url}
                alt={result.filename}
                className="mx-auto block max-h-[88vh] max-w-full object-contain"
              />
              <Dialog.Close asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  className="absolute right-3 top-3"
                  aria-label={t('Close preview')}
                >
                  <X className="size-4" />
                </Button>
              </Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : image.status === 'error' ? (
        <ErrorNotice inline title={t('Preview unavailable')} />
      ) : (
        <div
          className="flex h-36 w-72 max-w-full items-center justify-center bg-muted"
          role="status"
          aria-label={t('Loading preview…')}
        >
          <LoaderCircle
            className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none"
            aria-hidden="true"
          />
        </div>
      )}
      {image.status === 'ready' ? (
        <ProjectFileMentionButton
          target={{
            id: result.artifactId,
            source: 'artifact',
            sourceFileId: result.artifactId,
            projectId,
            name: result.filename,
            path: result.versionId,
            versionId: result.versionId
          }}
        />
      ) : null}
    </div>
  )
}
