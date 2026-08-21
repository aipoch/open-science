import { Check, CircleAlert, Download, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { SaveManagedFileRequest } from '../../../../shared/file-save'

type ManagedFileDownloadButtonProps = {
  source: SaveManagedFileRequest['source']
  path: string
  projectId?: string
  fileId?: string
  versionId?: string
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

  const downloadFile = (): void => {
    if (activeSaveRef.current) return

    const attempt = Symbol('managed-file-save')
    activeSaveRef.current = attempt
    if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current)
    setStatus('saving')
    void window.api
      .saveManagedFile({
        source,
        path,
        ...(projectId ? { projectId } : {}),
        ...(fileId ? { fileId } : {}),
        ...(versionId ? { versionId } : {}),
        suggestedName
      } as SaveManagedFileRequest)
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
          setStatus('error')
        }
      })
      .finally(() => {
        if (activeSaveRef.current === attempt) activeSaveRef.current = undefined
      })
  }

  const label =
    status === 'saving'
      ? t('Saving {{name}}', { name: suggestedName })
      : status === 'saved'
        ? t('Saved {{name}}', { name: suggestedName })
        : status === 'error'
          ? t('Download failed for {{name}}', { name: suggestedName })
          : t('Download {{name}}', { name: suggestedName })
  const tooltip =
    status === 'saving'
      ? t('Saving')
      : status === 'saved'
        ? t('Saved')
        : status === 'error'
          ? t('Download failed. Try again')
          : disabled
            ? t('File unavailable')
            : t('Download')
  // The labeled fallback action keeps a stable minimum size while allowing longer localized copy.
  const visibleLabel =
    status === 'saving'
      ? t('Saving...')
      : status === 'saved'
        ? t('Saved')
        : status === 'error'
          ? t('Try again')
          : t('Download')
  const isPrimary = appearance === 'primary'

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="download-tooltip-trigger"
            className={cn('group/download inline-flex', wrapperClassName)}
            tabIndex={disabled || status === 'saving' ? 0 : undefined}
            aria-label={disabled || status === 'saving' ? tooltip : undefined}
          >
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
              disabled={disabled || status === 'saving'}
              onClick={downloadFile}
            >
              {status === 'saving' ? (
                <LoaderCircle
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : status === 'saved' ? (
                <Check aria-hidden="true" />
              ) : status === 'error' ? (
                <CircleAlert aria-hidden="true" />
              ) : (
                <Download aria-hidden="true" />
              )}
              {isPrimary ? <span>{visibleLabel}</span> : null}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
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
    props.suggestedName
  ])
  return <ManagedFileDownloadButtonState key={requestKey} {...props} />
}

export { ManagedFileDownloadButton }
