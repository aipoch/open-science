import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ComputeAuthenticationMode } from '../../../../shared/compute'
import { DETAILS_DOC_MAX_LENGTH } from '../../../../shared/compute'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useComputeStore } from '@/stores/compute-store'
import {
  ComputeAdvancedSettings,
  ComputeAuthenticationFields,
  ComputeAuthenticationIntroduction,
  ComputeAuthenticationSection
} from './ComputeAuthenticationSection'
import {
  computeAuthenticationErrorCopy,
  getComputeAuthenticationStrategy,
  type ComputeAuthenticationValues
} from './compute-authentication-form'

type ComputeAddFormProps = {
  // Called with the new host's provider id after a successful create (SettingsPage navigates to the
  // host detail shell).
  onCreated: (providerId: string) => void
  onCancel: () => void
}

export function ComputeAddForm({ onCreated, onCancel }: ComputeAddFormProps): React.JSX.Element {
  const { t } = useTranslation()
  const { t: tCommon } = useTranslation()
  const sshAliases = useComputeStore((state) => state.sshAliases)
  const loadSshAliases = useComputeStore((state) => state.loadSshAliases)
  const createHost = useComputeStore((state) => state.createHost)
  const createPasswordHost = useComputeStore((state) => state.createPasswordHost)
  const probeHost = useComputeStore((state) => state.probeHost)

  const [alias, setAlias] = useState('')
  const [detailsDoc, setDetailsDoc] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [user, setUser] = useState('')
  const [port, setPort] = useState('')
  const [identityFile, setIdentityFile] = useState('')
  const [authenticationMode, setAuthenticationMode] =
    useState<ComputeAuthenticationMode>('ssh_config')
  const [password, setPassword] = useState('')
  const [operationId] = useState(() => crypto.randomUUID())
  const [passwordCapability, setPasswordCapability] = useState<
    Awaited<ReturnType<Window['api']['compute']['passwordCapability']>> | undefined
  >()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    void loadSshAliases()
    void window.api.compute
      .passwordCapability()
      .then(setPasswordCapability)
      .catch(() =>
        setPasswordCapability({ available: false, reason: 'secure_storage_unavailable' })
      )
  }, [loadSshAliases])

  const detailsTooLong = detailsDoc.length > DETAILS_DOC_MAX_LENGTH
  const authenticationValues: ComputeAuthenticationValues = {
    mode: authenticationMode,
    user,
    port,
    identityFile,
    password
  }
  const authenticationStrategy = getComputeAuthenticationStrategy(authenticationMode)
  const canSubmit =
    alias.trim().length > 0 &&
    alias.trim().length <= 255 &&
    !detailsTooLong &&
    !isSubmitting &&
    authenticationStrategy.isValid(authenticationValues, passwordCapability)

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return
    setIsSubmitting(true)
    setError(undefined)

    try {
      const host = await authenticationStrategy.create(
        authenticationValues,
        {
          sshAlias: alias.trim(),
          detailsDoc: detailsDoc.trim() ? detailsDoc : undefined,
          operationId
        },
        { createSshConfigHost: createHost, createPasswordHost }
      )
      setPassword('')
      // Navigate to the detail page immediately; the probe runs in the background so the detail page
      // can show "Probing…" state (design.md §7: create record → auto-probe → redirect to detail).
      onCreated(host.providerId)
      // Fire-and-forget: errors are captured as probeResult.ok=false and surfaced in the detail UI.
      void probeHost(host.providerId).catch(() => undefined)
    } catch (err) {
      setError(computeAuthenticationErrorCopy(err, t))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="p-5">
      <p className="mb-5 text-[13px] leading-5 text-muted-foreground">
        <ComputeAuthenticationIntroduction />
      </p>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-foreground">{t('From ~/.ssh/config')}</label>
          <Select
            value={alias}
            onValueChange={(value) => setAlias(value)}
            disabled={sshAliases.length === 0}
          >
            <SelectTrigger aria-label={t('Pick a host from ~/.ssh/config')}>
              <SelectValue
                placeholder={
                  sshAliases.length === 0 ? t('No hosts in ~/.ssh/config') : t('Pick a host…')
                }
              />
            </SelectTrigger>
            <SelectContent>
              {sshAliases.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="compute-alias" className="text-sm font-medium text-foreground">
            {t('Or type a host alias')}
          </label>
          <Input
            id="compute-alias"
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
            placeholder={t('e.g. biowulf, lab-gpu, coder.myworkspace')}
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor="compute-details" className="text-sm font-medium text-foreground">
              {t('Anything Open Science should know? (optional)')}
            </label>
            <span
              className={`text-xs ${detailsTooLong ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {t('{{used}} / {{limit}} chars', {
                used: detailsDoc.length,
                limit: DETAILS_DOC_MAX_LENGTH
              })}
            </span>
          </div>
          <Textarea
            id="compute-details"
            value={detailsDoc}
            onChange={(event) => setDetailsDoc(event.target.value)}
            rows={4}
            placeholder={t(
              'How do jobs run here — sbatch, qsub, or just bash? Is it OK to pip/conda install, and where should new envs go? Any partition, account, or module to use?'
            )}
            aria-invalid={detailsTooLong || undefined}
          />
        </div>

        <ComputeAuthenticationSection
          mode={authenticationMode}
          passwordCapability={passwordCapability}
          onModeChange={(mode) => {
            const strategy = getComputeAuthenticationStrategy(mode)
            setAuthenticationMode(mode)
            setAdvancedOpen(false)
            if (!strategy.usesPassword) setPassword('')
          }}
        />

        {authenticationStrategy.fieldSet === 'password' ? (
          <div className="flex flex-col gap-4">
            <ComputeAuthenticationFields
              strategy={authenticationStrategy}
              user={user}
              port={port}
              identityFile={identityFile}
              password={password}
              onUserChange={setUser}
              onPortChange={setPort}
              onIdentityFileChange={setIdentityFile}
              onPasswordChange={setPassword}
            />
          </div>
        ) : (
          <ComputeAdvancedSettings
            strategy={authenticationStrategy}
            open={advancedOpen}
            user={user}
            port={port}
            identityFile={identityFile}
            password={password}
            onOpenChange={setAdvancedOpen}
            onUserChange={setUser}
            onPortChange={setPort}
            onIdentityFileChange={setIdentityFile}
            onPasswordChange={setPassword}
          />
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setPassword('')
              onCancel()
            }}
            disabled={isSubmitting}
          >
            {tCommon('Cancel')}
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {isSubmitting ? authenticationStrategy.progressLabel(t) : t('Add')}
          </Button>
        </div>
      </div>
    </div>
  )
}
