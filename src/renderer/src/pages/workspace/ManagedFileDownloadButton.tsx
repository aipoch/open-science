import { Check, CircleAlert, Download, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
  WEB_MANAGED_FILE_SIZE_LIMIT_ERROR_NAME,
  type SaveManagedFileRequest
} from '../../../../shared/file-save'

type ManagedFileDownloadButtonProps = {
  source: SaveManagedFileRequest['source']
  path: string
  projectId?: string
  fileId?: string
  versionId?: string
  versionNumber?: number
  latestVersionId?: string
  latestVersionNumber?: number
  suggestedName: string
  appearance?: 'icon' | 'primary'
  tone?: 'default' | 'strong'
  className?: string
  disabled?: boolean
  iconSize?: 'icon-xs' | 'icon-sm' | 'icon'
  revealOnParentHover?: boolean
  wrapperClassName?: string
}

type DownloadStatus = 'idle' | 'saving' | 'saved' | 'error'

// Owns one file identity's transient save state; the wrapper remounts it when that identity changes.
const ManagedFileDownloadButtonState = ({
  source,
  path,
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
  wrapperClassName
}: ManagedFileDownloadButtonProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [status, setStatus] = useState<DownloadStatus>('idle')
  const [sizeLimitError, setSizeLimitError] = useState(false)
  const activeSaveRef = useRef<symbol | undefined>(undefined)
  const resetTimerRef = useRef<number | undefined>(undefined)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current)
    }
  }, [])

  const downloadFile = (requestedVersionId?: string): void => {
    if (activeSaveRef.current) return

    let request: SaveManagedFileRequest
    if (source === 'artifact' || source === 'upload') {
      if (!projectId || !fileId) {
        console.error(
          `Failed to download managed file: ${suggestedName}`,
          new Error('Managed file download requires a logical identity.')
        )
        setStatus('error')
        return
      }
      request = {
        source,
        projectId,
        fileId,
        ...(requestedVersionId ? { versionId: requestedVersionId } : {}),
        suggestedName
      }
    } else {
      request = { source, path, suggestedName }
    }

    const attempt = Symbol('managed-file-save')
    activeSaveRef.current = attempt
    if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current)
    setSizeLimitError(false)
    setStatus('saving')
    void window.api
      .saveManagedFile(request)
      .then((result) => {
        if (!mountedRef.current || activeSaveRef.current !== attempt) return

        if (!result.saved) {
          setStatus('idle')
          return
        }

        setStatus('saved')
        resetTimerRef.current = window.setTimeout(() => {
          resetTimerRef.current = undefined
          if (mountedRef.current) setStatus('idle')
        }, 1600)
      })
      .catch((error) => {
        if (mountedRef.current && activeSaveRef.current === attempt) {
          console.error(`Failed to download managed file: ${suggestedName}`, error)
          setSizeLimitError(
            error instanceof Error && error.name === WEB_MANAGED_FILE_SIZE_LIMIT_ERROR_NAME
          )
          setStatus('error')
        }
      })
      .finally(() => {
        if (activeSaveRef.current === attempt) activeSaveRef.current = undefined
      })
  }

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
      onClick={isHistoricalVersion ? undefined : () => downloadFile()}
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
              <DropdownMenuItem onSelect={() => downloadFile(versionId)}>
                {t('Download version v{{version}}', { version: versionNumber })}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => downloadFile()}>
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

// Keeps managed-file export behind one source-neutral renderer control.
const ManagedFileDownloadButton = (props: ManagedFileDownloadButtonProps): React.JSX.Element => {
  const requestKey = JSON.stringify([
    props.source,
    props.path,
    'projectId' in props ? props.projectId : undefined,
    'fileId' in props ? props.fileId : undefined,
    'versionId' in props ? props.versionId : undefined,
    props.versionNumber,
    props.latestVersionId,
    props.latestVersionNumber,
    props.suggestedName
  ])
  return <ManagedFileDownloadButtonState key={requestKey} {...props} />
}

export { ManagedFileDownloadButton }
