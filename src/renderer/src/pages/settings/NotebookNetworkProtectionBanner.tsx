import { Notice, type NoticeLevel } from '@/components/notice'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNotebookNetworkStatus } from './use-notebook-network-status'

import type { NotebookNetworkStatus } from '../../../../shared/notebook-network'
import { cn } from '@/lib/utils'

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

  const presentation: BannerPresentation = (() => {
    switch (status.kind) {
      case 'ready':
        return {
          title: t('Network protection on'),
          description: t(
            'Notebook allows approved domains and restricted public HTTPS reads. GET and HEAD still send URLs; approved domains allow sending data.'
          ),
          level: 'info'
        }
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

  return (
    <Notice
      aria-label={t('Notebook network protection')}
      aria-live="polite"
      role={status.kind === 'error' ? 'alert' : 'status'}
      data-testid="notebook-network-protection-banner"
      level={presentation.level}
      icon={status.kind === 'checking' ? LoaderCircle : undefined}
      iconClassName={
        status.kind === 'checking' ? 'animate-spin motion-reduce:animate-none' : undefined
      }
      title={presentation.title}
      description={presentation.description}
      className={cn(previewState === 'disabled' && 'opacity-50')}
      primaryButton={{
        label: t('Network settings'),
        onClick: onOpen,
        disabled: previewState === 'disabled',
        className: cn('min-h-11 w-full sm:min-h-8 sm:w-auto', previewButtonClassName)
      }}
    />
  )
}

export { NotebookNetworkProtectionBanner }
export type { NotebookNetworkProtectionBannerPreviewState }
