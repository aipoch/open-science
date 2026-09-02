// Action cluster shown in the preview header for local ("This computer") files, replacing the
// artifact/upload "Download" button row. The primary action reloads the preview from disk; the
// "…" menu shows the file identity, Copy path, and an "On this machine" group with Download
// (same save pipeline as managed files) and Save as artifact (same staging pipeline as composer
// uploads). Kept in its own module so PreviewFileSurface stays source-neutral.
import { Check, ExternalLink, File, MoreHorizontal, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ActionToast } from '@/components/ActionToast'
import { ActionMenuItems } from '@/components/action-menu'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { errorDetail } from '@/lib/error-detail'
import { usePreviewActions } from './preview-actions/preview-action-hooks'

export type LocalFileActionFailure = Readonly<{
  title: string
  detail?: string
  retry: () => void
}>

export const LocalFileActionErrorToast = ({
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

export type SaveAsArtifactState = 'idle' | 'saving' | 'saved'

export const LocalFileHeaderActions = ({
  path,
  name,
  saveAsArtifactState,
  onReload,
  tooltipClassName
}: {
  path: string
  name: string
  saveAsArtifactState: SaveAsArtifactState
  onReload?: () => void
  tooltipClassName?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const previewActions = usePreviewActions()
  // The content menu has additional window actions; the header overflow keeps its established
  // Copy path -> On this machine grouping without duplicating the adjacent full-screen/close UI.
  const identityEntries = previewActions.entries.filter(
    (entry) => entry.kind === 'action' && entry.action === 'copy-path'
  )
  const machineEntries = (['download', 'save-as-artifact'] as const).flatMap((action) =>
    previewActions.entries.filter((entry) => entry.kind === 'action' && entry.action === action)
  )

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
                className="text-text-000 hover:text-text-000"
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
            className="text-text-000 hover:text-text-000"
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
          <ActionMenuItems
            entries={identityEntries}
            onSelect={previewActions.execute}
            compact={false}
          />
          <DropdownMenuLabel className="px-1 text-[10px] font-medium uppercase tracking-wider">
            {t('On this machine')}
          </DropdownMenuLabel>
          <ActionMenuItems
            entries={machineEntries}
            onSelect={previewActions.execute}
            compact={false}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
