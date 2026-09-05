/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · component: Notebook network protection banner · genre: modern-minimal
 * theme: existing Open Science Settings tokens
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: semantic status tokens · responsive: 320 / 375 / 414 / 768
 */
import {
  LoaderCircle,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { NotebookNetworkStatus } from '../../../../shared/notebook-network'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type NotebookNetworkProtectionBannerPreviewState =
  'default' | 'hover' | 'focus' | 'active' | 'disabled' | 'loading' | 'error' | 'success'

type NotebookNetworkProtectionBannerProps = {
  onOpen: () => void
  previewState?: NotebookNetworkProtectionBannerPreviewState
}

type BannerPresentation = Readonly<{
  Icon: LucideIcon
  title: string
  description: string
  tone: 'info' | 'warning' | 'failure' | 'neutral'
}>

const previewStatus = (
  previewState: NotebookNetworkProtectionBannerPreviewState
): NotebookNetworkStatus => {
  switch (previewState) {
    case 'loading':
      return { kind: 'checking' }
    case 'error':
      return { kind: 'error', reason: 'runtimeFailure' }
    case 'disabled':
      return { kind: 'unsupported', platform: 'linux' }
    default:
      return { kind: 'ready', warnings: [] }
  }
}

const NotebookNetworkProtectionBanner = ({
  onOpen,
  previewState
}: NotebookNetworkProtectionBannerProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [runtimeStatus, setRuntimeStatus] = useState<NotebookNetworkStatus>({ kind: 'checking' })
  const status = previewState ? previewStatus(previewState) : runtimeStatus

  useEffect(() => {
    if (previewState) return
    let cancelled = false
    let retry: number | undefined
    const refresh = (): void => {
      const getStatus = window.api.settings?.getNotebookNetworkStatus
      if (typeof getStatus !== 'function') {
        setRuntimeStatus({ kind: 'error', reason: 'runtimeFailure' })
        return
      }
      void getStatus().then(
        (next) => {
          if (cancelled) return
          setRuntimeStatus(next)
          if (next.kind === 'checking') retry = window.setTimeout(refresh, 1_000)
        },
        () => {
          if (!cancelled) setRuntimeStatus({ kind: 'error', reason: 'runtimeFailure' })
        }
      )
    }
    refresh()
    return () => {
      cancelled = true
      if (retry !== undefined) window.clearTimeout(retry)
    }
  }, [previewState])

  const presentation: BannerPresentation = (() => {
    switch (status.kind) {
      case 'ready':
        return {
          Icon: ShieldCheck,
          title: t('Network protection on'),
          description: t(
            'Notebook sessions and package downloads can access only approved domains.'
          ),
          tone: 'neutral'
        }
      case 'setupRequired':
        return {
          Icon: ShieldAlert,
          title:
            status.platform === 'win32'
              ? t('Notebook network protection is not set up.')
              : t('Notebook network protection needs setup before notebooks can run.'),
          description:
            status.platform === 'win32'
              ? t('Notebook continues using standard execution. No protected mode is active.')
              : t('Open Network settings to review the required setup.'),
          tone: 'warning'
        }
      case 'unsupported':
        return {
          Icon: ShieldQuestion,
          title: t('Notebook network protection is not supported on this platform.'),
          description: t('Open Network settings to review availability and allowed domains.'),
          tone: 'neutral'
        }
      case 'error':
        return {
          Icon: ShieldAlert,
          title: t('Could not check Notebook network protection.'),
          description: t('Open Network settings to check again and review the setup.'),
          tone: 'failure'
        }
      case 'checking':
        return {
          Icon: LoaderCircle,
          title: t('Notebook network protection'),
          description: t('Checking…'),
          tone: 'info'
        }
    }
  })()

  const toneClassName: Record<BannerPresentation['tone'], string> = {
    info: 'border-status-info-foreground/25 bg-status-info-surface/45 dark:border-status-info-dark-foreground/25 dark:bg-status-info-dark-surface/25',
    warning:
      'border-status-warning-foreground/30 bg-status-warning-surface/45 dark:border-status-warning-dark-foreground/30 dark:bg-status-warning-dark-surface/25',
    failure:
      'border-status-failure-border bg-status-failure-subtle/60 dark:border-status-failure-dark-border/50 dark:bg-status-failure-dark-surface/20',
    neutral: 'border-border bg-bg-10'
  }

  const iconClassName: Record<BannerPresentation['tone'], string> = {
    info: 'bg-status-info-surface text-status-info-foreground dark:bg-status-info-dark-surface dark:text-status-info-dark-foreground',
    warning:
      'bg-status-warning-surface text-status-warning-foreground dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground',
    failure:
      'bg-status-failure-surface text-status-failure-foreground dark:bg-status-failure-dark-surface dark:text-status-failure-dark-foreground',
    neutral: 'bg-muted text-muted-foreground'
  }

  const previewButtonClassName =
    previewState === 'hover'
      ? 'bg-muted'
      : previewState === 'focus'
        ? 'border-ring ring-3 ring-ring/50'
        : previewState === 'active'
          ? 'translate-y-px'
          : ''

  return (
    <section
      aria-label={t('Notebook network protection')}
      aria-live="polite"
      role={status.kind === 'error' ? 'alert' : 'status'}
      data-testid="notebook-network-protection-banner"
      className={cn(
        'rounded-lg border p-3',
        toneClassName[presentation.tone],
        previewState === 'disabled' && 'opacity-50'
      )}
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-md',
              iconClassName[presentation.tone]
            )}
            aria-hidden="true"
          >
            <presentation.Icon
              className={cn(
                'size-4.5',
                status.kind === 'checking' && 'animate-spin motion-reduce:animate-none'
              )}
            />
          </span>
          <div className="min-w-0">
            <p className="break-words text-sm font-medium text-foreground">{presentation.title}</p>
            <p className="mt-0.5 max-w-2xl break-words text-[13px] leading-5 text-muted-foreground">
              {presentation.description}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={previewState === 'disabled'}
          className={cn(
            'min-h-11 w-full shrink-0 whitespace-nowrap sm:min-h-8 sm:w-auto',
            previewButtonClassName
          )}
          onClick={onOpen}
        >
          {t('Network settings')}
        </Button>
      </div>
    </section>
  )
}

export { NotebookNetworkProtectionBanner }
export type { NotebookNetworkProtectionBannerPreviewState }
