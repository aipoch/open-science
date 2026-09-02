import { Check, CircleAlert, Download, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import {
  useManagedFileDownload,
  type ManagedFileDownloadController,
  type ManagedFileDownloadInput
} from './use-managed-file-download'

type ManagedFileDownloadButtonProps = ManagedFileDownloadInput & {
  appearance?: 'icon' | 'primary'
  tone?: 'default' | 'strong'
  className?: string
  disabled?: boolean
  iconSize?: 'icon-xs' | 'icon-sm' | 'icon'
  revealOnParentHover?: boolean
  wrapperClassName?: string
  download?: ManagedFileDownloadController
}

const ManagedFileDownloadButtonState = ({
  source,
  projectId,
  fileId,
  versionId,
  versionNumber,
  latestVersionId,
  latestVersionNumber,
  suggestedName,
  appearance = 'icon',
  tone = 'default',
  className,
  disabled = false,
  iconSize = 'icon-xs',
  revealOnParentHover = false,
  wrapperClassName,
  download
}: ManagedFileDownloadButtonProps & {
  download: ManagedFileDownloadController
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { status, sizeLimitError } = download

  const hasExplicitManagedVersion = Boolean(projectId && fileId && versionId)
  const hasResolvedVersionContext =
    Boolean(latestVersionId) &&
    Number.isSafeInteger(versionNumber) &&
    Number.isSafeInteger(latestVersionNumber)
  const versionContextPending = hasExplicitManagedVersion && !hasResolvedVersionContext
  const missingManagedIdentity =
    (source === 'artifact' || source === 'upload') && (!projectId || !fileId)
  const effectiveDisabled = disabled || versionContextPending || missingManagedIdentity
  const isHistoricalVersion =
    hasExplicitManagedVersion &&
    hasResolvedVersionContext &&
    versionId !== latestVersionId &&
    versionId !== undefined
  const idleLabel = isHistoricalVersion
    ? t('Download options for {{name}}', { name: suggestedName })
    : t('Download {{name}}', { name: suggestedName })
  const label = sizeLimitError
    ? t(
        "{{name}} exceeds this browser's 512 MB download limit. Use a browser that supports streaming file saves.",
        { name: suggestedName }
      )
    : status === 'saving'
      ? t('Saving {{name}}', { name: suggestedName })
      : status === 'saved'
        ? t('Saved {{name}}', { name: suggestedName })
        : status === 'error'
          ? t('Download failed for {{name}}', { name: suggestedName })
          : idleLabel
  const tooltip = sizeLimitError
    ? label
    : status === 'saving'
      ? t('Saving')
      : status === 'saved'
        ? t('Saved')
        : status === 'error'
          ? t('Download failed. Try again')
          : effectiveDisabled
            ? t('File unavailable')
            : t('Download')
  // The labeled fallback action keeps a stable minimum size while allowing longer localized copy.
  const visibleLabel = sizeLimitError
    ? t('File too large')
    : status === 'saving'
      ? t('Saving...')
      : status === 'saved'
        ? t('Saved')
        : status === 'error'
          ? t('Try again')
          : t('Download')
  const isPrimary = appearance === 'primary'
  const canOpenVersionMenu = isHistoricalVersion && !effectiveDisabled && status !== 'saving'
  const actionButton = (
    <Button
      type="button"
      variant={isPrimary ? 'default' : 'ghost'}
      size={isPrimary ? 'sm' : iconSize}
      className={cn(
        isPrimary ? 'min-w-24' : 'bg-bg-000/90 shadow-sm',
        !isPrimary &&
          (status === 'saved'
            ? 'text-emerald-600 hover:bg-muted hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-400'
            : tone === 'strong'
              ? 'text-text-000 hover:bg-muted hover:text-text-000'
              : 'text-text-100 hover:bg-muted hover:text-text-000'),
        revealOnParentHover &&
          (status === 'idle'
            ? 'opacity-0 group-hover:opacity-100 group-focus-visible/download:opacity-100 focus-visible:opacity-100'
            : 'opacity-100'),
        className
      )}
      aria-label={label}
      disabled={effectiveDisabled || status === 'saving'}
      onClick={isHistoricalVersion ? undefined : () => void download.execute(null)}
    >
      {status === 'saving' ? (
        <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : status === 'saved' ? (
        <Check aria-hidden="true" />
      ) : status === 'error' ? (
        <CircleAlert aria-hidden="true" />
      ) : (
        <Download aria-hidden="true" />
      )}
      {isPrimary ? <span>{visibleLabel}</span> : null}
    </Button>
  )

  return (
    <TooltipProvider delayDuration={200}>
      {canOpenVersionMenu ? (
        <span
          data-testid="download-tooltip-trigger"
          className={cn('group/download inline-flex', wrapperClassName)}
        >
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                asChild
                onFocus={(event) => {
                  if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                }}
              >
                <DropdownMenuTrigger asChild>{actionButton}</DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{tooltip}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="z-[70] min-w-52">
              <DropdownMenuItem onSelect={() => void download.execute(versionId)}>
                {t('Download version v{{version}}', { version: versionNumber })}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void download.execute(null)}>
                {t('Download latest version v{{version}}', { version: latestVersionNumber })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-testid="download-tooltip-trigger"
              className={cn('group/download inline-flex', wrapperClassName)}
              tabIndex={effectiveDisabled || status === 'saving' ? 0 : undefined}
              aria-label={effectiveDisabled || status === 'saving' ? tooltip : undefined}
            >
              {actionButton}
            </span>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {status === 'idle' ? '' : label}
      </span>
    </TooltipProvider>
  )
}

const ManagedFileDownloadButtonWithState = (
  props: ManagedFileDownloadButtonProps
): React.JSX.Element => {
  const download = useManagedFileDownload(props)
  return <ManagedFileDownloadButtonState {...props} download={download} />
}

// Keeps standalone consumers self-contained while a preview surface can provide shared state.
const ManagedFileDownloadButton = (props: ManagedFileDownloadButtonProps): React.JSX.Element => {
  return props.download ? (
    <ManagedFileDownloadButtonState {...props} download={props.download} />
  ) : (
    <ManagedFileDownloadButtonWithState {...props} />
  )
}

export { ManagedFileDownloadButton }
