import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import {
  dialogBodyClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { X } from 'lucide-react'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'
import {
  researchEnvironmentVariableSchema,
  researchNetworkHostSchema,
  type ResearchExecutionConfigurationSnapshot,
  type ResearchExecutionProfileView,
  type ResearchExecutionPreflight
} from '../../../shared/research-execution-profile'

const fieldClass = 'w-full rounded-md border border-border-200 bg-bg-100 px-2 py-1.5 text-sm'
const lines = (value: string): string[] =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
type VariableRow = { id: string; name: string; value: string }
const profileRows = (profile?: ResearchExecutionProfileView): VariableRow[] =>
  Object.entries(profile?.variables ?? {}).map(([name, value]) => ({
    id: crypto.randomUUID(),
    name,
    value
  }))

/** This native form is the only renderer surface that sends credential values to Main.
 * It is bound to the broker's request, never to whichever research is currently selected. */
export const ResearchExecutionConfigurationForm = ({
  request,
  onResolved
}: {
  request: ResearchExecutionConfigurationSnapshot
  onResolved: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const initial = request.preflight.profiles.find(
    (profile) => profile.profileId === request.preflight.selectedProfileId
  )
  const [preflight, setPreflight] = useState(request.preflight)
  const [profileId, setProfileId] = useState(initial?.profileId)
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '')
  const [variables, setVariables] = useState<VariableRow[]>(() => profileRows(initial))
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [hosts, setHosts] = useState(initial?.allowedNetworkHosts.join('\n') ?? '')
  const [changes, setChanges] = useState(initial?.conditionChanges.join('\n') ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const selected = preflight.profiles.find((profile) => profile.profileId === profileId)
  const configured = new Set(selected?.configuredCredentialKeys ?? [])
  const missingCredentials = preflight.slots.some(
    (slot) => slot.required && !configured.has(slot.key) && !credentials[slot.key]
  )
  const hostnames = lines(hosts)
  const invalidHosts =
    hostnames.some((hostname) => !researchNetworkHostSchema.safeParse(hostname).success) ||
    hostnames.length > 32
  const enteredVariables = variables.filter((row) => row.name || row.value)
  const invalidVariables =
    enteredVariables.some(
      (row) => !researchEnvironmentVariableSchema.safeParse(row.name).success
    ) || new Set(enteredVariables.map((row) => row.name)).size !== enteredVariables.length
  const issueLabels: Record<ResearchExecutionPreflight['issues'][number]['code'], string> = {
    'description-unavailable': t('The required research description is unavailable.'),
    'plan-unavailable': t('The selected research plan is unavailable.'),
    'material-unavailable': t('Required research materials are unavailable.'),
    'runtime-unavailable': t('A compatible execution runtime is unavailable.'),
    'profile-required': t('Configure local settings for this research plan.'),
    'profile-unavailable': t('The requested local configuration is unavailable.'),
    'credential-required': t('A required credential has not been configured.'),
    'credential-unavailable': t('A configured credential could not be accessed.')
  }
  const resetFields = (profile?: ResearchExecutionProfileView): void => {
    setProfileId(profile?.profileId)
    setDisplayName(profile?.displayName ?? '')
    setVariables(profileRows(profile))
    setHosts(profile?.allowedNetworkHosts.join('\n') ?? '')
    setChanges(profile?.conditionChanges.join('\n') ?? '')
    setCredentials({})
  }
  const inspect = async (nextId?: string): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(false)
    setCredentials({})
    try {
      const next = await window.api.researchExecutionProfiles.inspect({
        ...request.scope,
        profileId: nextId
      })
      if (!mounted.current) return
      setPreflight(next)
      resetFields(next.profiles.find((profile) => profile.profileId === nextId))
    } catch {
      if (mounted.current) setError(true)
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const dismiss = async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(false)
    setCredentials({})
    try {
      await window.api.researchExecutionProfiles.resolve({
        configurationId: request.configurationId,
        outcome: 'dismissed'
      })
      if (mounted.current) onResolved()
    } catch {
      if (mounted.current) setError(true)
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const save = async (): Promise<void> => {
    if (
      pending.current ||
      !preflight.binding ||
      !displayName.trim() ||
      invalidHosts ||
      invalidVariables ||
      missingCredentials
    )
      return
    pending.current = true
    setBusy(true)
    setError(false)
    try {
      const profile = await window.api.researchExecutionProfiles.save({
        ...request.scope,
        ...preflight.binding,
        profileId,
        displayName: displayName.trim(),
        variables: Object.fromEntries(enteredVariables.map((row) => [row.name, row.value])),
        credentials: Object.fromEntries(
          Object.entries(credentials).filter(([, value]) => value.length > 0)
        ),
        allowedNetworkHosts: [...new Set(hostnames)],
        conditionChanges: lines(changes)
      })
      if (!mounted.current) return
      setCredentials({})
      setProfileId(profile.profileId)
      setPreflight((current) => ({
        ...current,
        profiles: [
          profile,
          ...current.profiles.filter((item) => item.profileId !== profile.profileId)
        ]
      }))
      await window.api.researchExecutionProfiles.resolve({
        configurationId: request.configurationId,
        outcome: 'configured',
        profileId: profile.profileId
      })
      if (mounted.current) onResolved()
    } catch {
      if (mounted.current) setError(true)
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (pending.current || !profileId) return
    pending.current = true
    setBusy(true)
    setError(false)
    setCredentials({})
    try {
      await window.api.researchExecutionProfiles.remove({ ...request.scope, profileId })
      const next = await window.api.researchExecutionProfiles.inspect({
        ...request.scope,
        profileId: undefined
      })
      if (!mounted.current) return
      setPreflight(next)
      resetFields()
    } catch {
      if (mounted.current) setError(true)
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) void dismiss()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName('w-[min(640px,calc(100vw-2rem))] p-0')}
          aria-busy={busy}
        >
          <div className={dialogHeaderClassName}>
            <Dialog.Title className={dialogTitleClassName}>
              {t('Configure research execution')}
            </Dialog.Title>
            <Button
              variant="ghost"
              size="icon-sm"
              className={dialogCloseButtonClassName}
              aria-label={t('Close')}
              disabled={busy}
              onClick={() => void dismiss()}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div className={`${dialogBodyClassName} max-h-[65vh] space-y-4 overflow-y-auto`}>
            <Dialog.Description className={dialogDescriptionClassName}>
              {t(
                'Prepare local configuration for the requested research plan. Saving does not start an experiment.'
              )}
            </Dialog.Description>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words text-xs">
              <dt>{t('Research')}</dt>
              <dd>{preflight.sourceTitle ?? request.scope.sourceSessionId}</dd>
              <dt>{t('Research plan')}</dt>
              <dd>{preflight.planTitle ?? request.scope.planKey}</dd>
            </dl>
            {preflight.issues.length ? (
              <div className="space-y-1 text-xs text-status-warning-foreground">
                {preflight.issues.map((issue, index) => (
                  <p key={index}>
                    {issueLabels[issue.code]}
                    {issue.key ? ` (${issue.key})` : ''}
                  </p>
                ))}
              </div>
            ) : null}
            {error ? (
              <ErrorNotice
                inline
                tone="amber"
                description={t(
                  'Could not update this local configuration. Your experiment has not been started.'
                )}
              />
            ) : null}
            <label className="block space-y-1 text-sm">
              <span>{t('Local configuration')}</span>
              <select
                className={fieldClass}
                value={profileId ?? ''}
                disabled={busy}
                onChange={(event) => void inspect(event.target.value || undefined)}
              >
                <option value="">{t('New local configuration')}</option>
                {preflight.profiles.map((profile) => (
                  <option key={profile.profileId} value={profile.profileId}>
                    {profile.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1 text-sm">
              <span>{t('Configuration name')}</span>
              <input
                className={fieldClass}
                value={displayName}
                maxLength={160}
                disabled={busy}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            {preflight.slots.length ? (
              <fieldset className="space-y-3" disabled={busy}>
                <legend className="text-sm font-medium">{t('Private credentials')}</legend>
                <p className="text-xs text-text-300">
                  {t(
                    'Credential values stay on this device and are not sent to the Agent or exported with the research. Leave an existing credential blank to keep it.'
                  )}
                </p>
                {preflight.slots.map((slot) => (
                  <label key={slot.key} className="block space-y-1 text-sm">
                    <span>
                      {slot.description} · <code>{slot.environmentVariable}</code>
                    </span>
                    <input
                      className={fieldClass}
                      type="password"
                      autoComplete="off"
                      value={credentials[slot.key] ?? ''}
                      maxLength={16384}
                      placeholder={
                        configured.has(slot.key)
                          ? t('Already configured')
                          : slot.required
                            ? t('Required credential')
                            : t('Optional credential')
                      }
                      onChange={(event) =>
                        setCredentials((current) => ({
                          ...current,
                          [slot.key]: event.target.value
                        }))
                      }
                    />
                  </label>
                ))}
              </fieldset>
            ) : null}
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="text-sm font-medium">
                {t('Non-secret environment variables')}
              </legend>
              <p className="text-xs text-text-300">
                {t(
                  'Use these fields for model names and other public settings. Put API keys in the credential fields.'
                )}
              </p>
              {variables.map((row) => (
                <div key={row.id} className="flex flex-wrap gap-2">
                  <input
                    className={`${fieldClass} min-w-32 flex-1`}
                    value={row.name}
                    maxLength={128}
                    aria-label={t('Variable name')}
                    onChange={(event) =>
                      setVariables((current) =>
                        current.map((item) =>
                          item.id === row.id ? { ...item, name: event.target.value } : item
                        )
                      )
                    }
                  />
                  <input
                    className={`${fieldClass} min-w-32 flex-1`}
                    value={row.value}
                    maxLength={4096}
                    aria-label={t('Variable value')}
                    onChange={(event) =>
                      setVariables((current) =>
                        current.map((item) =>
                          item.id === row.id ? { ...item, value: event.target.value } : item
                        )
                      )
                    }
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setVariables((current) => current.filter((item) => item.id !== row.id))
                    }
                  >
                    {t('Remove')}
                  </Button>
                </div>
              ))}
              {invalidVariables ? (
                <p className="text-xs text-status-warning-foreground">
                  {t(
                    'Use unique uppercase environment variable names. Runtime control variables are not allowed.'
                  )}
                </p>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setVariables((current) => [
                    ...current,
                    { id: crypto.randomUUID(), name: '', value: '' }
                  ])
                }
              >
                {t('Add environment variable')}
              </Button>
            </fieldset>
            <label className="block space-y-1 text-sm">
              <span>{t('Allowed service hostnames')}</span>
              <textarea
                className={fieldClass}
                rows={3}
                value={hosts}
                disabled={busy}
                onChange={(event) => setHosts(event.target.value)}
              />
              <span className="block text-xs text-text-300">
                {t(
                  'Enter one exact public hostname per line, without a URL or wildcard. Saving authorizes only these hosts for this configuration.'
                )}
              </span>
            </label>
            {invalidHosts ? (
              <p className="text-xs text-status-warning-foreground">
                {t('Enter valid public hostnames without ports, paths, or IP addresses.')}
              </p>
            ) : null}
            <label className="block space-y-1 text-sm">
              <span>{t('Changes from the original experiment')}</span>
              <textarea
                className={fieldClass}
                rows={3}
                value={changes}
                disabled={busy}
                onChange={(event) => setChanges(event.target.value)}
              />
              <span className="block text-xs text-text-300">
                {t(
                  'Record changed models, services, or parameters, one change per line. These differences will accompany the results.'
                )}
              </span>
            </label>
            <p className="text-xs text-text-300">
              {t(
                'Local readiness does not verify external credentials or confirm that the research has been reproduced.'
              )}
            </p>
          </div>
          <div className={`${dialogFooterClassName} flex-wrap`}>
            {profileId ? (
              <Button variant="ghost" disabled={busy} onClick={() => void remove()}>
                {t('Delete local configuration')}
              </Button>
            ) : null}
            <Button variant="outline" disabled={busy} onClick={() => void dismiss()}>
              {t('Not now')}
            </Button>
            <Button
              disabled={
                busy ||
                !preflight.binding ||
                !displayName.trim() ||
                invalidHosts ||
                invalidVariables ||
                missingCredentials
              }
              onClick={() => void save()}
            >
              {busy ? t('Saving…') : t('Save configuration')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Broker discovery is global: a Codex request can arrive while Home or another project is open. */
export const ResearchExecutionConfigurationDialog = (): React.JSX.Element | null => {
  const [requests, setRequests] = useState<ResearchExecutionConfigurationSnapshot[]>([])
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (
      document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) === 'true' ||
      typeof window.api?.researchExecutionProfiles?.pending !== 'function'
    )
      return
    let active = true
    let loading = false
    const refresh = async (): Promise<void> => {
      if (!active || loading) return
      loading = true
      try {
        const pending = await window.api.researchExecutionProfiles.pending()
        if (active) setRequests(pending.filter((request) => request.status === 'pending'))
      } catch {
        // A temporary broker failure must not discard a user's unsaved private form.
      } finally {
        loading = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [revision])
  const current = requests[0]
  return current ? (
    <ResearchExecutionConfigurationForm
      key={current.configurationId}
      request={current}
      onResolved={() => {
        setRequests((items) =>
          items.filter((request) => request.configurationId !== current.configurationId)
        )
        setRevision((value) => value + 1)
      }}
    />
  ) : null
}
