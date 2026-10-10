import { TrustedPrivateServices } from './TrustedPrivateServices'
import { SettingsSection } from './SettingsLayout'
import { InlineNotice } from '@/components/ui/inline-notice'
import { Plus, Trash2, LoaderCircle, ChevronRight } from 'lucide-react'
import { useEffect, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import {
  OPEN_SCIENCE_DOMAIN_GROUPS,
  validateCustomAllowedDomain,
  type NotebookNetworkSettings,
  type NotebookNetworkStatus,
  type NotebookNetworkStatusReason,
  type OpenScienceDomainGroupId
} from '../../../../shared/notebook-network'
import { DownloadProgressLine } from '@/components/DownloadProgressLine'
import { ErrorNotice } from '@/components/error-notice'
import { Notice } from '@/components/notice'
import { formatBytes } from '../../../../shared/update'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/stores/settings-store'

const GROUP_LABELS: Record<OpenScienceDomainGroupId, string> = {
  packageRegistries: 'Package registries and source code',
  nih: 'NIH and NCBI',
  genomics: 'Genomics and pathways',
  proteomics: 'Proteomics and structures',
  literature: 'Scientific literature',
  clinical: 'Clinical and translational research'
}
const DOMAIN_EXAMPLE = 'data.example.org'
// Product/runtime names are technical identifiers, shared unchanged across locales.
const RUNTIME_COMPONENT_NAMES = { node: 'Node.js', powershell: 'PowerShell' } as const
type FormMessage = Readonly<{ kind: 'success' | 'error'; text: string }>

const statusReasonLabel = (
  reason: NotebookNetworkStatusReason,
  t: ReturnType<typeof useTranslation>['t']
): string => {
  switch (reason) {
    case 'linuxBubblewrapMissing':
      return t('Install bubblewrap to use Notebook isolation on Linux.')
    case 'macSeatbeltUnavailable':
      return t('The macOS sandbox service is unavailable.')
    case 'trustBundleInvalid':
      return t('The configured CA bundle could not be read or is not a valid PEM bundle.')
    case 'windowsHostMissing':
      return t('The Windows sandbox component is missing. Reinstall Open-Science.')
    case 'windowsGatewayPortUnavailable':
      return t('The Windows sandbox gateway port is unavailable. Set up the sandbox again.')
    case 'windowsLoopbackMissing':
    case 'windowsNetworkFenceMissing':
    case 'windowsOwnershipMissing':
    case 'windowsProfileMissing':
      return t('The Windows sandbox needs administrator setup.')
    case 'runtimeFailure':
      return t('Could not check Notebook network protection.')
  }
}

export type NetworkEditorLeaveState = Readonly<{ dirty: boolean; busy: boolean }>
const NotebookNetworkDomainsForm = ({
  onLeaveStateChange
}: {
  onLeaveStateChange?: (state: NetworkEditorLeaveState | null) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const saved = useSettingsStore((state) => state.notebookNetwork)
  const setNotebookNetwork = useSettingsStore((state) => state.setNotebookNetwork)
  const [draft, setDraft] = useState<NotebookNetworkSettings>(saved)
  const [baseAllowedDomains, setBaseAllowedDomains] = useState(saved.allowedDomains)
  const [baseline, setBaseline] = useState(saved)
  const [privateEditing, setPrivateEditing] = useState(false)
  const [domainError, setDomainError] = useState('')
  const mounted = useRef(true)
  const [newDomain, setNewDomain] = useState('')
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(baseline) || Boolean(newDomain) || privateEditing
  const [message, setMessage] = useState<FormMessage | undefined>()
  const [isSaving, setIsSaving] = useState(false)
  const [status, setStatus] = useState<NotebookNetworkStatus>({ kind: 'checking' })
  const [isInstalling, setIsInstalling] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [isSwitchingMode, setIsSwitchingMode] = useState(false)
  const [modeError, setModeError] = useState(false)
  const [cancelError, setCancelError] = useState(false)
  useEffect(() => {
    onLeaveStateChange?.({ dirty, busy: isSaving })
  }, [dirty, isSaving, onLeaveStateChange])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      onLeaveStateChange?.(null)
    }
  }, [onLeaveStateChange])
  const preparing = isInstalling || status.kind === 'checking'
  const busy = preparing || isRemoving || isSwitchingMode || isSaving
  const preparation = status.kind === 'checking' ? status.runtimePreparation : undefined
  const failure = status.windowsRuntimeSetup?.failure
  const failureDescription = status.windowsRuntimeSetup?.cancelled
    ? t(
        'Preparation cancelled. Verified downloads are kept. Retry setup or remove protection to return to standard execution.'
      )
    : failure
      ? failure.phase === 'downloading'
        ? t('Could not download {{component}}. Check your connection and try again.', {
            component: RUNTIME_COMPONENT_NAMES[failure.component]
          })
        : t(
            'Could not prepare {{component}}. Retry setup or remove protection to return to standard execution.',
            { component: RUNTIME_COMPONENT_NAMES[failure.component] }
          )
      : status.kind === 'error'
        ? statusReasonLabel(status.reason, t)
        : ''

  useEffect(() => {
    if (!preparing) return
    let active = true
    const timer = setInterval(() => {
      void window.api.settings.getNotebookNetworkStatus().then(
        (next) => {
          if (active && (!isInstalling || next.kind === 'checking')) setStatus(next)
        },
        () => undefined
      )
    }, 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [preparing, isInstalling])

  useEffect(() => {
    void window.api.settings
      .getNotebookNetworkStatus()
      .then(setStatus, () => setStatus({ kind: 'error', reason: 'runtimeFailure' }))
  }, [])

  const refreshStatus = async (): Promise<void> => {
    setStatus({ kind: 'checking' })
    try {
      setStatus(await window.api.settings.getNotebookNetworkStatus())
    } catch {
      setStatus({ kind: 'error', reason: 'runtimeFailure' })
    }
  }

  const selectProtection = async (enabled: boolean): Promise<void> => {
    if (busy) return
    setIsSwitchingMode(true)
    setModeError(false)
    try {
      const next = await setNotebookNetwork(
        saved,
        saved.allowedDomains,
        saved.trustedPrivateDestinations ?? [],
        enabled
      )
      if (!mounted.current) return
      setDraft((current) => ({
        ...current,
        windowsProtectionEnabled: next.windowsProtectionEnabled
      }))
      setBaseline((current) => ({
        ...current,
        windowsProtectionEnabled: next.windowsProtectionEnabled
      }))
      await refreshStatus()
    } catch {
      if (mounted.current) setModeError(true)
    } finally {
      if (mounted.current) setIsSwitchingMode(false)
    }
  }

  const installWindowsSandbox = async (): Promise<void> => {
    if (busy) return
    setIsInstalling(true)
    setIsCancelling(false)
    setCancelError(false)
    setStatus({ kind: 'checking', windowsRuntimeSetup: status.windowsRuntimeSetup })
    try {
      setStatus(await window.api.settings.installNotebookNetwork())
    } catch {
      const latest = await window.api.settings.getNotebookNetworkStatus().catch(() => undefined)
      setStatus({
        kind: 'error',
        reason: 'runtimeFailure',
        windowsRuntimeSetup: latest?.windowsRuntimeSetup
      })
    } finally {
      setIsInstalling(false)
      setIsCancelling(false)
    }
  }

  const removeWindowsSandbox = async (): Promise<void> => {
    if (busy) return
    setIsRemoving(true)
    try {
      setStatus(await window.api.settings.removeNotebookNetwork())
    } catch {
      setStatus({ kind: 'error', reason: 'runtimeFailure' })
    } finally {
      setIsRemoving(false)
    }
  }

  const cancelPreparation = async (): Promise<void> => {
    setIsCancelling(true)
    setCancelError(false)
    try {
      if (!(await window.api.settings.cancelNotebookNetworkSetup())) setIsCancelling(false)
    } catch {
      setIsCancelling(false)
      setCancelError(true)
    }
  }

  const toggleGroup = (id: OpenScienceDomainGroupId, enabled: boolean): void => {
    setMessage(undefined)
    const disabled = new Set(draft.disabledOpenScienceDomainGroups)
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    setDraft({ ...draft, disabledOpenScienceDomainGroups: [...disabled] })
  }

  const toggleBuiltInDomain = (domain: string, enabled: boolean): void => {
    setMessage(undefined)
    const disabled = new Set(draft.disabledOpenScienceDomains)
    if (enabled) disabled.delete(domain)
    else disabled.add(domain)
    setDraft({ ...draft, disabledOpenScienceDomains: [...disabled] })
  }

  const addDomain = (): void => {
    setMessage(undefined)
    const result = validateCustomAllowedDomain(newDomain)
    if (!result.ok) {
      setDomainError(
        t('Enter an exact hostname without a scheme, path, port, wildcard, or IP address.')
      )
      return
    }
    if (draft.allowedDomains.includes(result.hostname)) {
      setDomainError(t('This hostname is already in the list.'))
      return
    }
    setDomainError('')
    setDraft({
      ...draft,
      allowedDomains: [...new Set([...draft.allowedDomains, result.hostname])].sort()
    })
    setNewDomain('')
  }

  const save = async (): Promise<void> => {
    if (isSaving || privateEditing || newDomain) return
    setIsSaving(true)
    setMessage(undefined)
    try {
      const next = await setNotebookNetwork(
        draft,
        baseAllowedDomains,
        baseline.trustedPrivateDestinations ?? []
      )
      if (!mounted.current) return
      setBaseline(next)
      setDraft(next)
      setBaseAllowedDomains(next.allowedDomains)
      setMessage({ kind: 'success', text: t('Network rules saved.') })
    } catch {
      if (!mounted.current) return
      setMessage({
        kind: 'error',
        text: t(
          'Could not save network rules. Reopen this page if another window changed them, or review changed private addresses again.'
        )
      })
    } finally {
      if (mounted.current) setIsSaving(false)
    }
  }

  return (
    <div className="space-y-6 p-5">
      <section aria-label={t('Notebook network protection')}>
        <div className="rounded-xl border border-border bg-bg-10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 basis-60">
              <p className="text-sm font-medium text-foreground">
                {t('Notebook network protection')}
              </p>
              {preparing ? (
                <div className="mt-2" aria-live="polite">
                  <Notice
                    inline
                    role="status"
                    icon={LoaderCircle}
                    iconClassName="animate-spin motion-reduce:animate-none"
                    title={
                      isCancelling
                        ? t('Cancelling…')
                        : preparation
                          ? preparation.phase === 'verifying'
                            ? t('Verifying {{component}}…', {
                                component: RUNTIME_COMPONENT_NAMES[preparation.component]
                              })
                            : preparation.phase === 'checking'
                              ? t('Checking {{component}}…', {
                                  component: RUNTIME_COMPONENT_NAMES[preparation.component]
                                })
                              : RUNTIME_COMPONENT_NAMES[preparation.component]
                          : isInstalling
                            ? t('Setting up…')
                            : t('Checking…')
                    }
                  />
                  {preparation?.download ? (
                    <DownloadProgressLine progress={preparation.download} />
                  ) : null}
                </div>
              ) : null}
              <p
                className="mt-1 text-xs leading-relaxed text-muted-foreground"
                hidden={preparing || (window.api.platform === 'win32' && status.kind === 'error')}
              >
                {status.kind === 'checking'
                  ? t('Checking…')
                  : status.kind === 'standard'
                    ? t('Standard mode')
                    : status.kind === 'ready'
                      ? window.api.platform === 'win32'
                        ? t('Status: Active')
                        : t('Notebook network protection is active.')
                      : status.kind === 'setupRequired'
                        ? status.platform === 'win32'
                          ? t('Status: Not set up')
                          : t('Notebook network protection needs setup before notebooks can run.')
                        : status.kind === 'unsupported'
                          ? t('Notebook network protection is not supported on this platform.')
                          : window.api.platform === 'win32'
                            ? t('Status: Setup failed')
                            : statusReasonLabel(status.reason, t)}
              </p>
              {window.api.platform === 'win32' &&
              (status.kind === 'ready' || status.kind === 'standard') ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t('Existing conversations use the selected mode on their next turn.')}
                </p>
              ) : null}
              {status.kind === 'standard' ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t('Notebook continues using standard execution. No protected mode is active.')}
                </p>
              ) : null}
              {window.api.platform === 'win32' ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t(
                    'Switching modes stops running Notebook processes. Installed protection components are kept.'
                  )}
                </p>
              ) : null}
              {modeError ? (
                <ErrorNotice
                  inline
                  className="mt-2"
                  role="alert"
                  description={t('Could not switch execution mode. Try again.')}
                />
              ) : null}
              {status.kind === 'setupRequired' && status.platform === 'win32' ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {status.windowsProtectionEnabled === true
                    ? t('Notebook network protection needs setup before notebooks can run.')
                    : t(
                        'Route Notebook Python, R, REPL, Bash, and package downloads through network protection with approved domains and restricted public HTTPS reads. Until set up, Notebook continues using standard execution.'
                      )}
                </p>
              ) : null}
              {window.api.platform === 'win32' && status.kind === 'error' ? (
                <ErrorNotice
                  inline
                  className="mt-2"
                  role="alert"
                  title={
                    status.windowsRuntimeSetup?.cancelled
                      ? t('Cancelled')
                      : t('Status: Setup failed')
                  }
                  description={failureDescription}
                />
              ) : null}
              {preparing && isInstalling && !preparation ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('The Windows sandbox needs administrator setup.')}
                </p>
              ) : null}
              {cancelError ? (
                <ErrorNotice
                  inline
                  className="mt-2"
                  role="alert"
                  description={t('Could not cancel the setup.')}
                />
              ) : null}
              {window.api.platform === 'win32' &&
              !preparing &&
              status.kind !== 'ready' &&
              Boolean(status.windowsRuntimeSetup?.downloadBytes) ? (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {t(
                    'Missing components may download up to {{size}}. Verified components are reused across conversations and app updates.',
                    { size: formatBytes(status.windowsRuntimeSetup!.downloadBytes) }
                  )}
                </p>
              ) : null}
              {status.kind === 'setupRequired' && status.reasons.length > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {[...new Set(status.reasons.map((reason) => statusReasonLabel(reason, t)))].join(
                    ' · '
                  )}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {window.api.platform === 'win32' && !preparing ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void selectProtection(status.kind === 'standard')}
                >
                  {status.kind === 'standard' ? t('Use protected mode') : t('Use standard mode')}
                </Button>
              ) : null}
              {preparing && window.api.platform === 'win32' ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={!status.windowsRuntimeSetup?.canCancel || isCancelling}
                  onClick={() => void cancelPreparation()}
                >
                  {isCancelling ? t('Cancelling…') : t('Cancel')}
                </Button>
              ) : null}
              {!preparing && status.kind === 'setupRequired' && status.platform === 'win32' ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void installWindowsSandbox()}
                >
                  {isInstalling ? t('Setting up…') : t('Set up')}
                </Button>
              ) : null}
              {!preparing &&
              window.api.platform === 'win32' &&
              (status.kind === 'ready' || status.kind === 'standard') ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void refreshStatus()}
                  >
                    {t('Check again')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void removeWindowsSandbox()}
                  >
                    {isRemoving ? t('Removing…') : t('Remove…')}
                  </Button>
                </>
              ) : null}
              {!preparing && window.api.platform === 'win32' && status.kind === 'error' ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={isInstalling}
                  onClick={() =>
                    void (status.reason === 'trustBundleInvalid'
                      ? refreshStatus()
                      : installWindowsSandbox())
                  }
                >
                  {status.reason === 'trustBundleInvalid'
                    ? t('Check again')
                    : isInstalling
                      ? t('Setting up…')
                      : t('Try again')}
                </Button>
              ) : null}
              {!preparing && window.api.platform === 'win32' && status.kind === 'error' ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void removeWindowsSandbox()}
                >
                  {isRemoving ? t('Removing…') : t('Remove…')}
                </Button>
              ) : null}
            </div>
          </div>
          {window.api.platform === 'win32' &&
          (status.kind === 'ready' ||
            (status.kind === 'setupRequired' && status.platform === 'win32')) ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('Administrator permission is required only when you choose Set up or Remove.')}
            </p>
          ) : null}
        </div>
      </section>

      <SettingsSection
        title={t('Public internet access')}
        description={t(
          'Some public HTTPS reads work without approval. Other requests need approval unless covered by a built-in or custom domain rule.'
        )}
      >
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {t(
            'Domain grants permit sending data, not just downloads. Even restricted reads send the requested URL.'
          )}
        </p>
        {status.kind !== 'checking' && status.kind !== 'ready' ? (
          <InlineNotice className="mt-3" level="warning">
            {t('Protection is not active. These rules apply only to protected execution.')}
          </InlineNotice>
        ) : null}
      </SettingsSection>

      <section aria-label={t('Custom public domains')}>
        <h3 className="mb-1 text-sm font-semibold text-foreground">{t('Custom public domains')}</h3>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          {t(
            'Exact hostnames only; subdomains are not included. Private addresses stay blocked. These rules also allow supported conversation-link previews and icons.'
          )}
        </p>
        <div className="rounded-xl border border-border p-4">
          <label htmlFor="public-hostname" className="mb-1.5 block text-sm font-medium">
            {t('Domain hostname')}
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="public-hostname"
              className="min-w-0 flex-1 basis-48"
              aria-invalid={Boolean(domainError)}
              aria-describedby={domainError ? 'public-domain-error' : undefined}
              value={newDomain}
              disabled={isSaving}
              aria-label={t('Domain hostname')}
              placeholder={DOMAIN_EXAMPLE}
              onChange={(event) => {
                setDomainError('')
                setNewDomain(event.target.value)
                setMessage(undefined)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addDomain()
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={addDomain}
              disabled={isSaving || !newDomain}
            >
              <Plus aria-hidden="true" />
              {t('Add to list')}
            </Button>
          </div>
          {domainError ? (
            <p id="public-domain-error" className="mt-2 text-xs text-status-failure" role="alert">
              {domainError}
            </p>
          ) : null}
          {draft.allowedDomains.length > 0 ? (
            <ul className="mt-3 divide-y divide-border">
              {draft.allowedDomains.map((domain) => (
                <li key={domain} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <code className="break-all">{domain}</code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={isSaving}
                    aria-label={t('Remove {{domain}}', { domain })}
                    onClick={() => {
                      setMessage(undefined)
                      setDraft({
                        ...draft,
                        allowedDomains: draft.allowedDomains.filter((item) => item !== domain)
                      })
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">{t('No custom domains added.')}</p>
          )}
        </div>
      </section>

      <section aria-label={t('Built-in services')}>
        <h3 className="mb-1 text-sm font-semibold text-foreground">{t('Built-in services')}</h3>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          {t(
            'Turning off automatic access requires approval. It does not block the service. Custom public rules still apply.'
          )}
        </p>
        <div className="divide-y divide-border rounded-xl border border-border">
          {OPEN_SCIENCE_DOMAIN_GROUPS.map((group) => {
            const groupEnabled = !draft.disabledOpenScienceDomainGroups.includes(group.id)
            return (
              <details key={group.id} className="group px-4 py-3">
                <summary className="flex cursor-pointer list-none items-center gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <ChevronRight
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {t(GROUP_LABELS[group.id])}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('{{count}} domains', {
                        count: new Set(group.domains).size,
                        defaultValue_one: '{{count}} domain'
                      })}
                    </p>
                  </div>
                  {group.locked ? (
                    <span className="text-xs text-muted-foreground">{t('Required')}</span>
                  ) : null}
                  <Switch
                    checked={groupEnabled}
                    disabled={isSaving || group.locked}
                    aria-label={t('Automatic access for {{name}}', {
                      name: t(GROUP_LABELS[group.id])
                    })}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={(checked) => toggleGroup(group.id, checked)}
                  />
                </summary>
                <div className="mt-3 grid gap-2 border-t border-border pt-3">
                  {[...new Set(group.domains)].map((domain) => (
                    <label key={domain} className="flex items-center justify-between gap-3 text-xs">
                      <code className="break-all text-foreground">{domain}</code>
                      <Switch
                        size="sm"
                        disabled={isSaving || !groupEnabled || group.locked}
                        checked={groupEnabled && !draft.disabledOpenScienceDomains.includes(domain)}
                        aria-label={t('Automatic access for {{domain}}', { domain })}
                        onCheckedChange={(checked) => toggleBuiltInDomain(domain, checked)}
                      />
                    </label>
                  ))}
                </div>
              </details>
            )
          })}
        </div>
      </section>

      <TrustedPrivateServices
        rules={draft.trustedPrivateDestinations ?? []}
        disabled={isSaving}
        onEditingChange={setPrivateEditing}
        onChange={(rules) => {
          setMessage(undefined)
          setDraft({ ...draft, trustedPrivateDestinations: rules })
        }}
      />

      {message?.kind === 'error' ? (
        <InlineNotice level="error" role="alert">
          {message.text}
        </InlineNotice>
      ) : message ? (
        <p className="text-xs text-muted-foreground" role="status">
          {message.text}
        </p>
      ) : null}
      <div className="sticky bottom-0 -mx-5 border-t border-border bg-card px-5 py-3">
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          {t('Saving rules resets protected connections and may interrupt transfers.')}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground" role="status">
            {dirty ? t('Unsaved changes') : t('No unsaved changes')}
          </p>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              disabled={isSaving || privateEditing}
              onClick={() => {
                setDraft(saved)
                setBaseline(saved)
                setBaseAllowedDomains(saved.allowedDomains)
                setNewDomain('')
                setDomainError('')
                setMessage(undefined)
              }}
            >
              {t('Cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => void save()}
              disabled={isSaving || privateEditing || Boolean(newDomain)}
            >
              {isSaving ? t('Saving…') : t('Save changes')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export { NotebookNetworkDomainsForm }
