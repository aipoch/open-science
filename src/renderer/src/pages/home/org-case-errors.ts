import type { TFunction } from 'i18next'
import type { LabView } from '../../../../shared/lab'
import type { OrgCaseDownloadSnapshot, OrgCaseErrorCode } from '../../../../shared/org-cases'
import type { NoticeLevel } from '@/components/ui/notice-chrome'

export type OrgCaseErrorPresentation = {
  level: NoticeLevel
  title: string
  description: string
  canOpenLabSettings: boolean
  canRetry: boolean
}

export function resolveOrgCaseLabError(lab: LabView | undefined): OrgCaseErrorCode | null {
  if (!lab || lab.state === 'unconfigured') return 'unconfigured'
  if (lab.state === 'expired') return 'expired'
  if (lab.state === 'unreachable') return 'network'
  if (lab.state === 'blocked') {
    const code = lab.error?.code
    if (
      code === 'license-inactive' ||
      code === 'seat-required' ||
      code === 'org-inactive' ||
      code === 'account-disabled'
    ) {
      return code
    }
    return 'signed-out'
  }
  if (lab.state !== 'authenticated') return 'signed-out'
  return null
}

export function describeOrgCaseError(
  errorCode: OrgCaseErrorCode,
  t: TFunction
): OrgCaseErrorPresentation {
  switch (errorCode) {
    case 'unconfigured':
      return {
        level: 'info',
        title: t('Connect to your Lab organization'),
        description: t(
          'Configure and sign in to a Lab server in Settings to browse and import organization cases.'
        ),
        canOpenLabSettings: true,
        canRetry: false
      }
    case 'signed-out':
      return {
        level: 'info',
        title: t('Sign in to Lab'),
        description: t(
          'Sign in to your Lab account in Settings to view cases shared in your organization.'
        ),
        canOpenLabSettings: true,
        canRetry: false
      }
    case 'expired':
      return {
        level: 'warning',
        title: t('Your Lab session expired'),
        description: t(
          'Sign in again in Lab Settings to continue searching and importing organization cases.'
        ),
        canOpenLabSettings: true,
        canRetry: true
      }
    case 'storage-not-configured':
      return {
        level: 'warning',
        title: t('Case sharing is not configured'),
        description: t(
          'Object storage for organization case sharing is not configured on this Lab server yet.'
        ),
        canOpenLabSettings: false,
        canRetry: true
      }
    case 'storage-unavailable':
      return {
        level: 'warning',
        title: t('Case storage is temporarily unavailable'),
        description: t(
          'The organization case storage service could not be reached. Please try again shortly.'
        ),
        canOpenLabSettings: false,
        canRetry: true
      }
    case 'not-found':
      return {
        level: 'warning',
        title: t('Organization case not found'),
        description: t(
          'This case may have been deleted or may no longer be visible in your organization.'
        ),
        canOpenLabSettings: false,
        canRetry: false
      }
    case 'license-inactive':
      return {
        level: 'error',
        title: t('Lab license inactive'),
        description: t('Your Lab organization does not have an active license for case sharing.'),
        canOpenLabSettings: true,
        canRetry: false
      }
    case 'seat-required':
      return {
        level: 'error',
        title: t('Lab seat required'),
        description: t(
          'An assigned Lab seat is required before you can access organization cases.'
        ),
        canOpenLabSettings: true,
        canRetry: false
      }
    case 'org-inactive':
      return {
        level: 'error',
        title: t('Organization inactive'),
        description: t('Your Lab organization is currently inactive. Contact your administrator.'),
        canOpenLabSettings: true,
        canRetry: false
      }
    case 'account-disabled':
      return {
        level: 'error',
        title: t('Account disabled'),
        description: t('Your Lab account is disabled. Contact your Lab administrator for access.'),
        canOpenLabSettings: true,
        canRetry: false
      }
    case 'no-organization':
      return {
        level: 'warning',
        title: t('No Lab organization assigned'),
        description: t('Join an organization in Lab before browsing or importing shared cases.'),
        canOpenLabSettings: true,
        canRetry: false
      }
    case 'forbidden':
      return {
        level: 'error',
        title: t('Permission denied'),
        description: t('Your Lab role does not have permission to access organization cases.'),
        canOpenLabSettings: true,
        canRetry: false
      }
    case 'rate-limited':
      return {
        level: 'warning',
        title: t('Too many requests'),
        description: t('Please wait a moment before searching or downloading again.'),
        canOpenLabSettings: false,
        canRetry: true
      }
    case 'package-too-large':
      return {
        level: 'error',
        title: t('Package exceeds upload limit'),
        description: t(
          'This Session package exceeds the maximum upload size allowed by your Lab server.'
        ),
        canOpenLabSettings: false,
        canRetry: false
      }
    case 'package-invalid':
      return {
        level: 'error',
        title: t('Invalid package or case details'),
        description: t(
          'Lab rejected the package or case details. Check the case name and try again.'
        ),
        canOpenLabSettings: false,
        canRetry: true
      }
    case 'unsupported-package':
      return {
        level: 'error',
        title: t('Unsupported package format'),
        description: t(
          'This Lab server rejected the package format as unsupported. Check the server version or package contents.'
        ),
        canOpenLabSettings: false,
        canRetry: false
      }
    case 'upload-in-progress':
      return {
        level: 'warning',
        title: t('Upload still processing'),
        description: t(
          'Lab is still processing this upload. Wait a moment and refresh organization cases before retrying.'
        ),
        canOpenLabSettings: false,
        canRetry: true
      }
    case 'upload-timeout':
      return {
        level: 'warning',
        title: t('Upload timed out'),
        description: t(
          'Uploading or validating the organization case timed out. Check your connection and try again.'
        ),
        canOpenLabSettings: false,
        canRetry: true
      }
    case 'url-expired':
      return {
        level: 'warning',
        title: t('Download link expired'),
        description: t(
          'The temporary download link expired before completion. Please try importing again.'
        ),
        canOpenLabSettings: false,
        canRetry: true
      }
    case 'verification-failed':
      return {
        level: 'error',
        title: t('Package verification failed'),
        description: t(
          'The downloaded .science package did not match the expected size or SHA-256 checksum, so import did not start.'
        ),
        canOpenLabSettings: false,
        canRetry: true
      }
    case 'capacity':
      return {
        level: 'error',
        title: t('Not enough disk space'),
        description: t(
          'Free up disk space or check package size limits before importing this organization case.'
        ),
        canOpenLabSettings: false,
        canRetry: false
      }
    case 'import-busy':
      return {
        level: 'warning',
        title: t('Another download or import is already in progress'),
        description: t('Finish or cancel the current case transfer before starting another one.'),
        canOpenLabSettings: false,
        canRetry: true
      }
    case 'timeout':
      return {
        level: 'warning',
        title: t('Request timed out'),
        description: t(
          'The Lab server took too long to respond. Check your connection and try again.'
        ),
        canOpenLabSettings: false,
        canRetry: true
      }
    case 'network':
      return {
        level: 'warning',
        title: t('Could not connect to Lab'),
        description: t(
          'Check your network connection and Lab server address in Settings, then try again.'
        ),
        canOpenLabSettings: true,
        canRetry: true
      }
    case 'invalid-response':
      return {
        level: 'error',
        title: t('Unexpected response from Lab'),
        description: t('The Lab server returned an invalid organization case response.'),
        canOpenLabSettings: false,
        canRetry: true
      }
    case 'cancelled':
      return {
        level: 'info',
        title: t('Operation cancelled'),
        description: t('The organization case request was cancelled.'),
        canOpenLabSettings: false,
        canRetry: true
      }
    default:
      return {
        level: 'error',
        title: t('Could not load organization cases'),
        description: t('An unexpected error occurred while communicating with Lab.'),
        canOpenLabSettings: false,
        canRetry: true
      }
  }
}

export function orgCaseErrorNoticeActions(
  presentation: OrgCaseErrorPresentation,
  t: TFunction,
  options: {
    onOpenLabSettings?: () => void
    onRetry?: () => void
  }
): {
  primaryButton?: { label: string; onClick: () => void }
  secondaryButton?: { label: string; onClick: () => void }
} {
  const settingsButton =
    presentation.canOpenLabSettings && options.onOpenLabSettings
      ? { label: t('Open Lab Settings'), onClick: options.onOpenLabSettings }
      : undefined
  const retryButton =
    presentation.canRetry && options.onRetry
      ? { label: t('Retry'), onClick: options.onRetry }
      : undefined
  return {
    primaryButton: settingsButton ?? retryButton,
    secondaryButton: settingsButton && retryButton ? retryButton : undefined
  }
}

export function formatOrgCaseDownloadLabel(
  snapshot: OrgCaseDownloadSnapshot,
  t: TFunction
): string {
  if (snapshot.state === 'verifying') return t('Verifying download…')
  if (snapshot.state === 'downloading' && snapshot.totalBytes && snapshot.totalBytes > 0) {
    const percent = Math.min(
      100,
      Math.max(0, Math.round((snapshot.completedBytes / snapshot.totalBytes) * 100))
    )
    return t('Downloading {{percent}}%', { percent })
  }
  return t('Preparing download…')
}
