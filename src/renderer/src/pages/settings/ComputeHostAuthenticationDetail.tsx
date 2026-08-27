import { KeyRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  ComputeAuthenticationMode,
  ComputeHost,
  ComputePasswordCapability
} from '../../../../shared/compute'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { MaskedPasswordField } from './MaskedPasswordField'

type Props = Readonly<{
  host: ComputeHost
  isEditing: boolean
  onEditingChange: (isEditing: boolean) => void
  onUpdatePassword: () => void
  changeAuthentication: ReturnType<
    typeof import('@/stores/compute-store').useComputeStore.getState
  >['changeAuthentication']
}>

const operationId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `compute-auth-${Date.now()}-${Math.random()}`

type AuthenticationOperation = Readonly<{
  operationId: string
  providerId: string
  expectedRevision: number
  identityFile?: string
}>

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : error instanceof Error
      ? error.message
      : undefined

export function ComputeHostAuthenticationDetail({
  host,
  isEditing,
  onEditingChange,
  onUpdatePassword,
  changeAuthentication
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const currentMode = host.authentication?.mode ?? 'ssh_config'
  const currentRevision = host.authentication?.revision ?? 1
  const [mode, setMode] = useState<ComputeAuthenticationMode>(currentMode)
  const [username, setUsername] = useState(host.sshOverrides?.user ?? '')
  const [port, setPort] = useState(String(host.sshOverrides?.port ?? 22))
  const identityFile = host.sshOverrides?.identityFile ?? ''
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<
    { kind: 'success' | 'error'; text: string } | undefined
  >()
  const [validationError, setValidationError] = useState<
    { field: 'username' | 'port' | 'password'; text: string } | undefined
  >()
  const [passwordCapability, setPasswordCapability] = useState<
    ComputePasswordCapability | undefined
  >()
  const [previousEditing, setPreviousEditing] = useState(isEditing)
  const [preserveFeedbackAfterSave, setPreserveFeedbackAfterSave] = useState(false)
  const [authenticationOperation, setAuthenticationOperation] = useState<
    AuthenticationOperation | undefined
  >()

  if (previousEditing !== isEditing) {
    setPreviousEditing(isEditing)
    setAuthenticationOperation(undefined)
    if (preserveFeedbackAfterSave) setPreserveFeedbackAfterSave(false)
    else setFeedback(undefined)
    setValidationError(undefined)
    setPassword('')
    if (!isEditing) {
      setMode(currentMode)
      setUsername(host.sshOverrides?.user ?? '')
      setPort(String(host.sshOverrides?.port ?? 22))
    }
  }

  useEffect(() => {
    let mounted = true
    const capability = window.api.compute.passwordCapability
    if (capability) {
      void capability()
        .then((result) => {
          if (mounted) setPasswordCapability(result)
        })
        .catch(() => {
          if (mounted) {
            setPasswordCapability({ available: false, reason: 'secure_storage_unavailable' })
          }
        })
    }
    return () => {
      mounted = false
    }
  }, [])

  const resetEditor = (): void => {
    setAuthenticationOperation(undefined)
    onEditingChange(false)
    setMode(currentMode)
    setUsername(host.sshOverrides?.user ?? '')
    setPort(String(host.sshOverrides?.port ?? 22))
    setPassword('')
    setValidationError(undefined)
  }

  const selectMode = (nextMode: ComputeAuthenticationMode): void => {
    setPassword('')
    setFeedback(undefined)
    setValidationError(undefined)
    setMode(nextMode)
    setAuthenticationOperation(undefined)
  }

  const save = async (): Promise<void> => {
    const parsedPort = Number(port)
    const normalizedUsername = username.trim() || undefined
    if (mode === 'password' && !normalizedUsername) {
      setValidationError({ field: 'username', text: t('Username is required.') })
      return
    }
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
      setValidationError({
        field: 'port',
        text: t('Port must be an integer from 1 through 65535.')
      })
      return
    }
    const normalizedIdentityFile =
      mode === 'ssh_config' ? identityFile.trim() || undefined : undefined
    const modeChanged = mode !== currentMode
    const usernameChanged = normalizedUsername !== (host.sshOverrides?.user || undefined)
    const portChanged = parsedPort !== (host.sshOverrides?.port ?? 22)
    const identityFileChanged =
      mode === 'ssh_config' &&
      normalizedIdentityFile !== (host.sshOverrides?.identityFile || undefined)
    const hasMaterialChange = modeChanged || usernameChanged || portChanged || identityFileChanged
    if (mode === 'password' && hasMaterialChange && !password) {
      setValidationError({ field: 'password', text: t('Password is required.') })
      return
    }
    setBusy(true)
    setFeedback(undefined)
    setValidationError(undefined)
    const operationStillBound =
      authenticationOperation?.providerId === host.providerId &&
      authenticationOperation.expectedRevision === currentRevision &&
      authenticationOperation.identityFile === normalizedIdentityFile
    const currentOperationId = operationStillBound
      ? authenticationOperation.operationId
      : operationId()
    setAuthenticationOperation({
      operationId: currentOperationId,
      providerId: host.providerId,
      expectedRevision: currentRevision,
      ...(normalizedIdentityFile ? { identityFile: normalizedIdentityFile } : {})
    })
    try {
      await changeAuthentication({
        providerId: host.providerId,
        expectedRevision: currentRevision,
        operationId: currentOperationId,
        authenticationMode: mode,
        username: normalizedUsername,
        port: parsedPort,
        ...(mode === 'ssh_config' && identityFile.trim()
          ? { identityFile: identityFile.trim() }
          : {}),
        ...(mode === 'password' && password ? { password } : {})
      })
      setAuthenticationOperation(undefined)
      setPassword('')
      setPreserveFeedbackAfterSave(true)
      onEditingChange(false)
      setFeedback({
        kind: 'success',
        text: modeChanged
          ? mode === 'ssh_config'
            ? t(
                'SSH configuration verified and activated. Saved password deleted. Select this Compute Host again as an execution target in each Session and approve new Permission Grants.'
              )
            : t(
                'Password authentication verified and activated. Select this Compute Host again as an execution target in each Session and approve new Permission Grants.'
              )
          : usernameChanged
            ? t(
                'Username changed. Select this Compute Host again as an execution target in each Session and approve new Permission Grants.'
              )
            : hasMaterialChange
              ? t(
                  'Connection settings verified and saved. Select this Compute Host again as an execution target in each Session and approve new Permission Grants.'
                )
              : t('Authentication settings are already up to date.')
      })
    } catch (error) {
      const code = errorCode(error)
      if (code === 'credential_conflict') setAuthenticationOperation(undefined)
      setFeedback({
        kind: 'error',
        text:
          code === 'credential_change_blocked_by_jobs'
            ? t(
                'Authentication change blocked. Finish or safely delete active and unharvested Compute Jobs first.'
              )
            : code === 'credential_conflict'
              ? t(
                  'Authentication changed in another window. Review the current settings and retry.'
                )
              : t('Authentication could not be verified. The previous identity remains active.')
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {!isEditing ? (
        <div>
          <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-6 gap-y-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5 text-sm">
            <dt className="text-muted-foreground">{t('Authentication method')}</dt>
            <dd className="col-span-2">
              {currentMode === 'password' ? t('Username and password') : t('SSH configuration')}
            </dd>
            <dt className="text-muted-foreground">{t('Username')}</dt>
            <dd className="col-span-2">{host.sshOverrides?.user || t('From SSH configuration')}</dd>
            <dt className="text-muted-foreground">{t('Port')}</dt>
            <dd className="col-span-2">{host.sshOverrides?.port ?? 22}</dd>
            <dt className="text-muted-foreground">
              {currentMode === 'password' ? t('Saved password') : t('Credential')}
            </dt>
            <dd>
              {currentMode === 'password'
                ? host.authentication?.credentialStatus === 'configured'
                  ? t('Configured · cannot be viewed')
                  : host.authentication?.credentialStatus === 'unavailable'
                    ? t('Saved credential unavailable')
                    : t('Password required')
                : t('System SSH configuration and ssh-agent')}
            </dd>
            <dd>
              {currentMode === 'password' ? (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label={t('Update saved password')}
                        onClick={onUpdatePassword}
                      >
                        <KeyRound className="size-3.5" aria-hidden="true" />
                        <span className="sr-only">{t('Update', { context: 'verb' })}</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('Update saved password')}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
            </dd>
            <dt className="text-muted-foreground">{t('Last verified')}</dt>
            <dd className="col-span-2">
              {host.authentication?.lastVerifiedAt
                ? new Date(host.authentication.lastVerifiedAt).toLocaleString()
                : t('Not yet verified')}
            </dd>
          </dl>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-foreground">{t('Edit configuration')}</h4>
          <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            {t(
              'The candidate authentication configuration is verified before commit. Session enablement and Permission Grants will be cleared.'
            )}
          </p>
          <div className="flex flex-col gap-3">
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium">{t('Authentication method')}</legend>
              {(['password', 'ssh_config'] as const).map((choice) => (
                <Label
                  key={choice}
                  className={`flex items-start gap-2 rounded-lg border p-3 ${
                    mode === choice ? 'border-primary bg-primary/5' : 'border-border'
                  } ${
                    busy || (choice === 'password' && passwordCapability?.available === false)
                      ? 'cursor-not-allowed opacity-50'
                      : 'cursor-pointer'
                  }`}
                >
                  <input
                    type="radio"
                    name={`compute-detail-authentication-${host.id}`}
                    value={choice}
                    checked={mode === choice}
                    disabled={
                      busy || (choice === 'password' && passwordCapability?.available === false)
                    }
                    className="mt-0.5 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none"
                    onChange={() => selectMode(choice)}
                  />
                  <span>
                    <span className="block text-sm font-medium">
                      {choice === 'ssh_config'
                        ? t('SSH configuration')
                        : t('Username and password')}
                    </span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {choice === 'ssh_config'
                        ? t('Use ~/.ssh/config, IdentityFile, and ssh-agent. Recommended.')
                        : passwordCapability?.available === false
                          ? t('Password authentication is unavailable on this device.')
                          : t('Uses the saved password only, with no key or agent fallback.')}
                    </span>
                  </span>
                </Label>
              ))}
            </fieldset>
            <Label htmlFor="compute-detail-username">{t('Username')}</Label>
            <Input
              autoFocus
              id="compute-detail-username"
              value={username}
              placeholder={mode === 'ssh_config' ? t('From SSH configuration') : undefined}
              onChange={(event) => {
                setUsername(event.target.value)
                setAuthenticationOperation(undefined)
                if (validationError?.field === 'username') setValidationError(undefined)
              }}
              aria-invalid={validationError?.field === 'username' || undefined}
              aria-describedby={
                validationError?.field === 'username' ? 'compute-detail-username-error' : undefined
              }
            />
            {validationError?.field === 'username' ? (
              <p
                id="compute-detail-username-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {validationError.text}
              </p>
            ) : null}
            <Label htmlFor="compute-detail-port">{t('Port')}</Label>
            <Input
              id="compute-detail-port"
              inputMode="numeric"
              value={port}
              onChange={(event) => {
                setPort(event.target.value)
                setAuthenticationOperation(undefined)
                if (validationError?.field === 'port') setValidationError(undefined)
              }}
              aria-invalid={validationError?.field === 'port' || undefined}
              aria-describedby={
                validationError?.field === 'port' ? 'compute-detail-port-error' : undefined
              }
            />
            {validationError?.field === 'port' ? (
              <p id="compute-detail-port-error" role="alert" className="text-xs text-destructive">
                {validationError.text}
              </p>
            ) : null}
            {mode === 'password' ? (
              <>
                <Label htmlFor="compute-detail-password">{t('Password for this username')}</Label>
                <MaskedPasswordField
                  id="compute-detail-password"
                  value={password}
                  onChange={(value) => {
                    setPassword(value)
                    setAuthenticationOperation(undefined)
                    if (validationError?.field === 'password') setValidationError(undefined)
                  }}
                  aria-invalid={validationError?.field === 'password' || undefined}
                  aria-describedby={
                    validationError?.field === 'password'
                      ? 'compute-detail-password-error'
                      : undefined
                  }
                />
                {validationError?.field === 'password' ? (
                  <p
                    id="compute-detail-password-error"
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {validationError.text}
                  </p>
                ) : null}
              </>
            ) : currentMode === 'password' ? (
              <p className="text-xs text-muted-foreground">
                {t('After SSH configuration is verified, the saved password is deleted.')}
              </p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={resetEditor}>
              {t('Cancel')}
            </Button>
            <Button type="button" disabled={busy} onClick={() => void save()}>
              {busy ? t('Testing…') : t('Test and save')}
            </Button>
          </div>
        </div>
      )}

      {busy ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {t('Testing connection…')}{' '}
          {t('No authentication change is committed until this succeeds.')}
        </p>
      ) : null}
      {feedback ? (
        <p
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          className={feedback.kind === 'error' ? 'mt-3 text-sm text-destructive' : 'mt-3 text-sm'}
        >
          {feedback.text}
        </p>
      ) : null}
    </div>
  )
}
