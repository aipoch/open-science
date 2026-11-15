import { Notice, type NoticeLevel } from '@/components/notice'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNotebookNetworkStatus } from './use-notebook-network-status'

import type { NotebookNetworkStatus } from '../../../../shared/notebook-network'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { SettingsSection } from './SettingsLayout'
import { NotebookNetworkAccessSummary } from './NotebookNetworkAccessSummary'

type NotebookNetworkProtectionBannerPreviewState =
  'default' | 'hover' | 'focus' | 'active' | 'disabled' | 'loading' | 'error' | 'success'

type NotebookNetworkProtectionBannerProps = {
  onOpen: () => void
  previewState?: NotebookNetworkProtectionBannerPreviewState
  status?: NotebookNetworkStatus
}

type BannerPresentation = Readonly<{
  title: string
  description: string
  level: NoticeLevel
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
  previewState,
  status: suppliedStatus
}: NotebookNetworkProtectionBannerProps): React.JSX.Element => {
  const { t } = useTranslation()
  const runtimeStatus = useNotebookNetworkStatus(!previewState && suppliedStatus === undefined)
  const status = previewState ? previewStatus(previewState) : (suppliedStatus ?? runtimeStatus)

  const presentation: BannerPresentation | null = (() => {
    switch (status.kind) {
      case 'ready':
        return null
      case 'setupRequired':
        return {
          title:
            status.platform === 'win32'
              ? t('Notebook network protection is not set up.')
              : t('Notebook network protection needs setup before notebooks can run.'),
          description:
            status.platform === 'win32'
              ? t('Notebook continues using standard execution. No protected mode is active.')
              : t('Open Network settings to review the required setup.'),
          level: 'warning'
        }
      case 'unsupported':
        return {
          title: t('Notebook network protection is not supported on this platform.'),
          description: t('Open Network settings to review availability and allowed domains.'),
          level: 'info'
        }
      case 'error':
        return {
          title: t('Could not check Notebook network protection.'),
          description: t('Open Network settings to check again and review the setup.'),
          level: 'error'
        }
      case 'checking':
        return {
          title: t('Notebook network protection'),
          description: t('Checking…'),
          level: 'info'
        }
    }
  })()

  const previewButtonClassName =
    previewState === 'hover'
      ? 'bg-muted'
      : previewState === 'focus'
        ? 'border-ring ring-3 ring-ring/50'
        : previewState === 'active'
          ? 'translate-y-px'
          : ''

  if (!presentation) {
    return (
      <NotebookNetworkAccessSummary
        onOpen={onOpen}
        testId="notebook-network-protection-banner"
        buttonClassName={previewButtonClassName}
      />
    )
  }

  return (
    <SettingsSection
      title={t('Notebook network protection')}
      aria-label={t('Notebook network protection')}
      data-testid="notebook-network-protection-banner"
      className={cn(previewState === 'disabled' && 'opacity-50')}
    >
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4">
        <Notice
          inline
          aria-live="polite"
          role={status.kind === 'error' ? 'alert' : 'status'}
          level={presentation.level}
          icon={status.kind === 'checking' ? LoaderCircle : undefined}
          iconClassName={
            status.kind === 'checking' ? 'animate-spin motion-reduce:animate-none' : undefined
          }
          title={status.kind === 'checking' ? undefined : presentation.title}
          description={presentation.description}
          className="min-w-0 flex-1 basis-64"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpen}
          disabled={previewState === 'disabled'}
          className={cn('ml-auto min-h-11 shrink-0 sm:min-h-8', previewButtonClassName)}
        >
          {t('Network settings')}
        </Button>
      </div>
    </SettingsSection>
  )
}

export { NotebookNetworkProtectionBanner }
export type { NotebookNetworkProtectionBannerPreviewState }
