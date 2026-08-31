// Action cluster shown in the preview header for local ("This computer") files, replacing the
// artifact/upload "Download" button row. The primary action reloads the preview from disk; the
// "…" menu shows the file identity, Copy path, and an "On this machine" group with Download
// (same save pipeline as managed files) and Save as artifact (same staging pipeline as composer
// uploads). Kept in its own module so PreviewFileSurface stays source-neutral.
import {
  Check,
  ClipboardCopy,
  Download,
  ExternalLink,
  File,
  MoreHorizontal,
  PackagePlus,
  RotateCw
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ActionToast } from '@/components/ActionToast'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useNavigationStore } from '@/stores/navigation-store'

type LocalFileActionFailure = Readonly<{
  title: string
  detail?: string
  retry: () => void
}>

const errorDetail = (error: unknown): string | undefined => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return undefined
}

const LocalFileActionErrorToast = ({
  failure,
  onDismiss
}: {
  failure: LocalFileActionFailure
  onDismiss: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <ActionToast
      title={failure.title}
      detail={failure.detail}
      actionLabel={t('Retry')}
      dismissLabel={t('Close')}
      onAction={failure.retry}
      onDismiss={onDismiss}
      testId="local-file-action-error-toast"
    />
  )
}

// Primary labeled action for the "Preview unavailable" fallback of a local file: opening it in its
// default OS app is the local analogue of the artifact/upload "Download" affordance.
export const LocalFileFallbackAction = ({
  path,
  className
}: {
  path: string
  className?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [failure, setFailure] = useState<LocalFileActionFailure>()

  const open = async (): Promise<void> => {
    setFailure(undefined)
    try {
      const result = await window.api.localFs.openPath(path)
      if (result) throw new Error(result)
    } catch (error) {
      setFailure({
        title: t('Could not open this file.'),
        detail: errorDetail(error),
        retry: () => void open()
      })
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="default"
        size="sm"
        className={className}
        onClick={() => void open()}
      >
        <ExternalLink className="size-4" aria-hidden="true" />
        <span>{t('Open')}</span>
      </Button>
      {failure ? (
        <LocalFileActionErrorToast failure={failure} onDismiss={() => setFailure(undefined)} />
      ) : null}
    </>
  )
}

type SaveAsArtifactState = 'idle' | 'saving' | 'saved'

export const LocalFileHeaderActions = ({
  path,
  name,
  onReload,
  tooltipClassName
}: {
  path: string
  name: string
  onReload?: () => void
  tooltipClassName?: string
}): React.JSX.Element => {
  const { t } = useTranslation()

  const [copied, setCopied] = useState(false)
  const [failure, setFailure] = useState<LocalFileActionFailure>()
  // In-memory only by design: the staged upload joins the normal upload lifecycle, and the header
  // just reflects that this preview already handed the file over.
  const [saveAsArtifactState, setSaveAsArtifactState] = useState<SaveAsArtifactState>('idle')
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)

  // Clear any pending "Copied" reset when the header unmounts (tab closed within the 1.5s window).
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const copyPath = async (): Promise<void> => {
    setFailure(undefined)
    if (!navigator.clipboard?.writeText) {
      setFailure({
        title: t('Could not copy the file path.'),
        retry: () => void copyPath()
      })
      return
    }
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      setFailure({
        title: t('Could not copy the file path.'),
        detail: errorDetail(error),
        retry: () => void copyPath()
      })
    }
  }
  const download = async (): Promise<void> => {
    setFailure(undefined)
    try {
      await window.api.saveManagedFile({ source: 'local', path, suggestedName: name })
    } catch (error) {
      console.error(`Failed to download local file: ${name}`, error)
      setFailure({
        title: t('Could not download this file.'),
        detail: errorDetail(error),
        retry: () => void download()
      })
    }
  }
  const stageLocalPath = window.api.uploads.stageLocalPath

  const saveAsArtifact = async (): Promise<void> => {
    if (!stageLocalPath || saveAsArtifactState === 'saving') return

    setFailure(undefined)
    setSaveAsArtifactState('saving')
    try {
      await stageLocalPath({
        transferId: crypto.randomUUID(),
        name,
        sourcePath: path,
        projectId: activeProjectId
      })
      setSaveAsArtifactState('saved')
    } catch (error) {
      console.error(`Failed to save local file as artifact: ${name}`, error)
      setSaveAsArtifactState('idle')
      setFailure({
        title: t('Could not save this file as an artifact.'),
        detail: errorDetail(error),
        retry: () => void saveAsArtifact()
      })
    }
  }

  const canSaveAsArtifact = saveAsArtifactState !== 'saved' && typeof stageLocalPath === 'function'

  return (
    <>
      {saveAsArtifactState === 'saved' ? (
        <span
          data-testid="saved-as-artifact"
          role="status"
          className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-text-100"
        >
          <Check className="size-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          {t('Saved')}
        </span>
      ) : null}
      {onReload ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-text-100 hover:text-text-000"
                aria-label={t('Reload file')}
                onClick={onReload}
              >
                <RotateCw aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className={tooltipClassName}>{t('Reload from disk')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-text-100 hover:text-text-000"
            aria-label={t('More actions')}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        {/* z-[70] keeps the menu above the full-screen preview modal (z-[61]). */}
        <DropdownMenuContent align="end" className="z-[70] w-56">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <File className="size-4 shrink-0 text-text-100" aria-hidden="true" />
            <div className="min-w-0">
              <div className="truncate text-[12px] font-medium text-text-000">{name}</div>
              <div className="truncate text-[10px] text-text-100">{path}</div>
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void copyPath()} className="gap-2">
            {/* The label already flips to "Copied", so the checkmark needs no color of its own. */}
            {copied ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <ClipboardCopy className="size-4" aria-hidden="true" />
            )}
            {copied ? t('Copied') : t('Copy path')}
          </DropdownMenuItem>
          <DropdownMenuLabel className="px-1 text-[10px] font-medium uppercase tracking-wider">
            {t('On this machine')}
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => void download()} className="gap-2">
            <Download className="size-4" aria-hidden="true" />
            {t('Download')}
          </DropdownMenuItem>
          {canSaveAsArtifact ? (
            <DropdownMenuItem
              onSelect={() => void saveAsArtifact()}
              disabled={saveAsArtifactState === 'saving'}
              className="gap-2"
            >
              <PackagePlus className="size-4" aria-hidden="true" />
              {saveAsArtifactState === 'saving' ? t('Saving…') : t('Save as artifact')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {failure ? (
        <LocalFileActionErrorToast failure={failure} onDismiss={() => setFailure(undefined)} />
      ) : null}
    </>
  )
}
