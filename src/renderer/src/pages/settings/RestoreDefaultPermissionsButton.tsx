/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · component: restore-default-permissions button · genre: modern-minimal
 * theme: Open Science Settings
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (40–41) · icons: pass (30) · tokens: pass (48) · responsive: pass (49)
 */
import { AlertTriangle, Check, LoaderCircle, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PermissionDefaultsRestoreState } from '@/stores/permission-grants-store'

type RestoreDefaultPermissionsPreviewState =
  'default' | 'hover' | 'focus' | 'active' | 'disabled' | 'loading' | 'error' | 'success'

type RestoreDefaultPermissionsButtonProps = {
  state: PermissionDefaultsRestoreState
  disabled?: boolean
  onRestore: () => void
  previewState?: RestoreDefaultPermissionsPreviewState
}

const RestoreDefaultPermissionsButton = ({
  state,
  disabled = false,
  onRestore,
  previewState
}: RestoreDefaultPermissionsButtonProps): React.JSX.Element => {
  const { t } = useTranslation()
  const visualState = previewState ?? (state === 'idle' ? 'default' : state)
  const loading = visualState === 'loading'
  const isDisabled = disabled || visualState === 'disabled' || loading
  const error = visualState === 'error'
  const success = visualState === 'success'
  const label = loading
    ? t('Restoring…')
    : success
      ? t('Defaults restored')
      : error
        ? t('Try again')
        : t('Restore defaults')
  const Icon = loading ? LoaderCircle : success ? Check : error ? AlertTriangle : RotateCcw

  return (
    <Button
      type="button"
      variant={error ? 'destructive' : 'outline'}
      disabled={isDisabled}
      aria-invalid={error || undefined}
      aria-label={label}
      className={cn(
        'min-h-11 w-full whitespace-nowrap disabled:pointer-events-auto disabled:cursor-not-allowed sm:w-auto',
        success &&
          'border-status-success-accent/30 bg-status-success-surface text-status-success-foreground hover:bg-status-success-surface dark:bg-status-success-dark-surface dark:text-status-success-dark-foreground',
        previewState === 'hover' && 'bg-muted',
        previewState === 'focus' && 'border-ring ring-3 ring-ring/50',
        previewState === 'active' && 'translate-y-px'
      )}
      onClick={onRestore}
    >
      <Icon
        className={cn('size-4', loading && 'animate-spin motion-reduce:animate-none')}
        aria-hidden="true"
      />
      <span aria-live="polite">{label}</span>
    </Button>
  )
}

export { RestoreDefaultPermissionsButton }
export type { RestoreDefaultPermissionsPreviewState }
