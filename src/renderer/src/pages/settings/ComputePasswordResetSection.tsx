import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ComputeHost } from '../../../../shared/compute'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useComputeStore } from '@/stores/compute-store'
import { MaskedPasswordField } from './MaskedPasswordField'
import {
  computeAuthenticationPresentation,
  isComputeAuthenticationErrorCode
} from './compute-authentication-presentation'

type ComputePasswordResetSectionProps = Readonly<{
  host: ComputeHost
  isEditing: boolean
  onEditingChange: (isEditing: boolean) => void
}>

export function ComputePasswordResetSection({
  host,
  isEditing,
  onEditingChange
}: ComputePasswordResetSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const resetPassword = useComputeStore((state) => state.resetPassword)
  const [password, setPassword] = useState('')
  const [isResetting, setIsResetting] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [succeeded, setSucceeded] = useState(false)
  const [operationId, setOperationId] = useState<string | undefined>()
  const [previousEditing, setPreviousEditing] = useState(isEditing)

  if (previousEditing !== isEditing) {
    setPreviousEditing(isEditing)
    setPassword('')
    setError(undefined)
    setOperationId(undefined)
  }

  const clearCandidate = (): void => {
    setPassword('')
    setError(undefined)
    setOperationId(undefined)
  }

  const submit = async (): Promise<void> => {
    if (!host.authentication || password.length === 0) {
      setError(t('Enter a new password.'))
      return
    }
    const currentOperationId = operationId ?? crypto.randomUUID()
    setOperationId(currentOperationId)
    setIsResetting(true)
    setError(undefined)
    setSucceeded(false)
    try {
      await resetPassword({
        providerId: host.providerId,
        password,
        operationId: currentOperationId,
        expectedAuthenticationRevision: host.authentication.revision
      })
      clearCandidate()
      onEditingChange(false)
      setSucceeded(true)
    } catch (caught) {
      const code = (caught as { code?: string }).code
      const presentation = isComputeAuthenticationErrorCode(code)
        ? computeAuthenticationPresentation(code, 'password_reset')
        : undefined
      setError(presentation?.copy(t) ?? t('Could not update the saved password.'))
      if (code === 'credential_conflict') setOperationId(undefined)
    } finally {
      setIsResetting(false)
    }
  }

  if (host.authentication?.mode !== 'password') return <></>

  if (!isEditing) {
    return succeeded ? (
      <p role="status" className="mt-3 text-xs text-muted-foreground">
        {t('Saved password updated successfully.')}
      </p>
    ) : (
      <></>
    )
  }

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold text-foreground">{t('Update saved password')}</h4>
        <p className="text-xs text-muted-foreground">
          {t('Running Compute Jobs may continue. Only the locally saved password will change.')}
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="compute-reset-username" className="text-sm font-medium">
            {t('Username')}
          </Label>
          <Input
            id="compute-reset-username"
            value={host.sshOverrides?.user ?? ''}
            readOnly
            aria-describedby="compute-reset-username-help"
            className="bg-background/70 text-muted-foreground"
          />
          <p id="compute-reset-username-help" className="text-xs text-muted-foreground">
            {t('(unchanged)')}
          </p>
          <Label htmlFor="compute-reset-password" className="text-sm font-medium">
            {t('New password')}
          </Label>
          <MaskedPasswordField
            id="compute-reset-password"
            value={password}
            onChange={(value) => {
              setPassword(value)
              setError(undefined)
              setOperationId(undefined)
            }}
            aria-describedby={error ? 'compute-reset-password-error' : undefined}
            aria-invalid={error !== undefined}
          />
          {error ? (
            <p id="compute-reset-password-error" role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('The saved password changes only after this connection test succeeds.')}
        </p>
        {isResetting ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t('Testing connection… No authentication change is committed until this succeeds.')}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isResetting}
            onClick={() => {
              clearCandidate()
              onEditingChange(false)
            }}
          >
            {t('Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={isResetting || password.length === 0}
            aria-busy={isResetting}
            onClick={() => void submit()}
          >
            {isResetting ? t('Testing…') : t('Test and update')}
          </Button>
        </div>
      </div>
    </div>
  )
}
