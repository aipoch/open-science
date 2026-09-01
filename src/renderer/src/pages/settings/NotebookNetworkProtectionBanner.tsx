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
  tone: 'info' | 'success' | 'warning' | 'failure' | 'neutral'
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
    void window.api.settings.getNotebookNetworkStatus().then(
      (next) => {
        if (!cancelled) setRuntimeStatus(next)
      },
      () => {
        if (!cancelled) setRuntimeStatus({ kind: 'error', reason: 'runtimeFailure' })
      }
    )
    return () => {
      cancelled = true
    }
  }, [previewState])

  const presentation: BannerPresentation = (() => {
    switch (status.kind) {
      case 'ready':
        return {
          Icon: ShieldCheck,
          title: t('Notebook network protection is active.'),
          description: t(
            'Notebook Python, R, REPL, Bash, and package downloads are limited to approved domains.'
          ),
          tone: 'success'
        }
      case 'setupRequired':
        return {
          Icon: ShieldAlert,
          title: t('Notebook network protection needs setup before notebooks can run.'),
          description:
            status.platform === 'win32'
              ? t(
                  'Securely route Notebook Python, R, REPL, Bash, and package downloads through your approved domains. Until set up, Notebook continues using standard execution.'
                )
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
    success:
      'border-status-success-accent/30 bg-status-success-surface/55 dark:border-status-success-dark-foreground/25 dark:bg-status-success-dark-surface/30',
    warning:
      'border-status-warning-foreground/30 bg-status-warning-surface/45 dark:border-status-warning-dark-foreground/30 dark:bg-status-warning-dark-surface/25',
    failure:
      'border-status-failure-border bg-status-failure-subtle/60 dark:border-status-failure-dark-border/50 dark:bg-status-failure-dark-surface/20',
    neutral: 'border-border bg-bg-10'
  }

  const iconClassName: Record<BannerPresentation['tone'], string> = {
    info: 'bg-status-info-surface text-status-info-foreground dark:bg-status-info-dark-surface dark:text-status-info-dark-foreground',
    success:
      'bg-status-success-surface text-status-success-foreground dark:bg-status-success-dark-surface dark:text-status-success-dark-foreground',
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
        'rounded-xl border p-3 sm:p-4',
        toneClassName[presentation.tone],
        previewState === 'disabled' && 'opacity-50'
      )}
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-lg',
              iconClassName[presentation.tone]
            )}
            aria-hidden="true"
          >
            <presentation.Icon
              className={cn(
                'size-5',
                status.kind === 'checking' && 'animate-spin motion-reduce:animate-none'
              )}
            />
          </span>
          <div className="min-w-0">
            <p className="break-words text-sm font-semibold text-foreground">
              {presentation.title}
            </p>
            <p className="mt-0.5 max-w-2xl break-words text-[13px] leading-5 text-foreground/80">
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
          {t('Manage network access')}
        </Button>
      </div>
    </section>
  )
}

export { NotebookNetworkProtectionBanner }
export type { NotebookNetworkProtectionBannerPreviewState }
