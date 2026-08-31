import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  OPEN_SCIENCE_DOMAIN_GROUPS,
  validateCustomAllowedDomain,
  type NotebookNetworkSettings,
  type NotebookNetworkStatus,
  type NotebookNetworkStatusReason,
  type OpenScienceDomainGroupId
} from '../../../../shared/notebook-network'
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
      return t('The Windows sandbox component is missing. Reinstall Open Science.')
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

const NotebookNetworkDomainsForm = (): React.JSX.Element => {
  const { t } = useTranslation()
  const saved = useSettingsStore((state) => state.notebookNetwork)
  const setNotebookNetwork = useSettingsStore((state) => state.setNotebookNetwork)
  const [draft, setDraft] = useState<NotebookNetworkSettings>(saved)
  const [baseAllowedDomains, setBaseAllowedDomains] = useState(saved.allowedDomains)
  const [newDomain, setNewDomain] = useState('')
  const [message, setMessage] = useState<FormMessage | undefined>()
  const [isSaving, setIsSaving] = useState(false)
  const [status, setStatus] = useState<NotebookNetworkStatus>({ kind: 'checking' })
  const [isInstalling, setIsInstalling] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)

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

  const installWindowsSandbox = async (): Promise<void> => {
    setIsInstalling(true)
    try {
      setStatus(await window.api.settings.installNotebookNetwork())
    } catch {
      setStatus({ kind: 'error', reason: 'runtimeFailure' })
    } finally {
      setIsInstalling(false)
    }
  }

  const removeWindowsSandbox = async (): Promise<void> => {
    setIsRemoving(true)
    try {
      setStatus(await window.api.settings.removeNotebookNetwork())
    } catch {
      setStatus({ kind: 'error', reason: 'runtimeFailure' })
    } finally {
      setIsRemoving(false)
    }
  }

  const toggleGroup = (id: OpenScienceDomainGroupId, enabled: boolean): void => {
    const disabled = new Set(draft.disabledOpenScienceDomainGroups)
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    setDraft({ ...draft, disabledOpenScienceDomainGroups: [...disabled] })
  }

  const toggleBuiltInDomain = (domain: string, enabled: boolean): void => {
    const disabled = new Set(draft.disabledOpenScienceDomains)
    if (enabled) disabled.delete(domain)
    else disabled.add(domain)
    setDraft({ ...draft, disabledOpenScienceDomains: [...disabled] })
  }

  const addDomain = (): void => {
    setMessage(undefined)
    const result = validateCustomAllowedDomain(newDomain)
    if (!result.ok) {
      setMessage({
        kind: 'error',
        text:
          result.reason === 'reserved'
            ? t('Localhost, private addresses, and IP addresses cannot be allowed.')
            : t('Enter a hostname only, without a scheme, path, port, or wildcard.')
      })
      return
    }
    setDraft({
      ...draft,
      allowedDomains: [...new Set([...draft.allowedDomains, result.hostname])].sort()
    })
    setNewDomain('')
  }

  const save = async (): Promise<void> => {
    setIsSaving(true)
    setMessage(undefined)
    try {
      const next = await setNotebookNetwork(draft, baseAllowedDomains)
      setDraft(next)
      setBaseAllowedDomains(next.allowedDomains)
      setMessage({ kind: 'success', text: t('Notebook network access saved.') })
    } catch {
      setMessage({ kind: 'error', text: t('Could not save Notebook network access.') })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-6 p-5">
      <section aria-label={t('Notebook network protection')}>
        <div className="rounded-xl border border-border bg-bg-10 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                {t('Notebook network protection')}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {status.kind === 'checking'
                  ? t('Checking…')
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
              {window.api.platform === 'win32' && status.kind === 'ready' ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t('Protected using Windows sandboxing. New Notebook sessions are protected.')}
                </p>
              ) : null}
              {status.kind === 'setupRequired' && status.platform === 'win32' ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t(
                    'Securely route Notebook Python, R, REPL, Bash, and package downloads through your approved domains. Until set up, Notebook continues using standard execution.'
                  )}
                </p>
              ) : null}
              {window.api.platform === 'win32' && status.kind === 'error' ? (
                <>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t('Notebook continues using standard execution. No protected mode is active.')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {statusReasonLabel(status.reason, t)}
                  </p>
                </>
              ) : null}
              {status.kind === 'setupRequired' && status.reasons.length > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {status.reasons.map((reason) => statusReasonLabel(reason, t)).join(' · ')}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {status.kind === 'setupRequired' && status.platform === 'win32' ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={isInstalling}
                  onClick={() => void installWindowsSandbox()}
                >
                  {isInstalling ? t('Setting up…') : t('Set up')}
                </Button>
              ) : null}
              {window.api.platform === 'win32' && status.kind === 'ready' ? (
                <>
                  <Button type="button" variant="outline" onClick={() => void refreshStatus()}>
                    {t('Check again')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isRemoving}
                    onClick={() => void removeWindowsSandbox()}
                  >
                    {isRemoving ? t('Removing…') : t('Remove…')}
                  </Button>
                </>
              ) : null}
              {window.api.platform === 'win32' && status.kind === 'error' ? (
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

      <section aria-label={t('Open Science domains')}>
        <h3 className="mb-1 text-sm font-semibold text-foreground">{t('Open Science domains')}</h3>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          {t(
            'Notebook Python, R, REPL, Bash, and package downloads use enabled scientific services and domains you add below. Protected execution blocks other outbound domains.'
          )}
        </p>
        <div className="divide-y divide-border rounded-xl border border-border">
          {OPEN_SCIENCE_DOMAIN_GROUPS.map((group) => {
            const groupEnabled = !draft.disabledOpenScienceDomainGroups.includes(group.id)
            return (
              <details key={group.id} className="group px-4 py-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {t(GROUP_LABELS[group.id])}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('{{count}} domains', {
                        count: group.domains.length,
                        defaultValue_one: '{{count}} domain'
                      })}
                    </p>
                  </div>
                  <Switch
                    checked={groupEnabled}
                    disabled={group.locked}
                    aria-label={t('Allow {{name}}', { name: t(GROUP_LABELS[group.id]) })}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={(checked) => toggleGroup(group.id, checked)}
                  />
                </summary>
                <div className="mt-3 grid gap-2 border-t border-border pt-3">
                  {group.domains.map((domain) => (
                    <label key={domain} className="flex items-center justify-between gap-3 text-xs">
                      <code className="break-all text-foreground">{domain}</code>
                      <Switch
                        size="sm"
                        disabled={!groupEnabled || group.locked}
                        checked={groupEnabled && !draft.disabledOpenScienceDomains.includes(domain)}
                        aria-label={t('Allow {{domain}}', { domain })}
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

      <section aria-label={t('Allowed domains')}>
        <h3 className="mb-1 text-sm font-semibold text-foreground">{t('Allowed domains')}</h3>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          {t(
            'Add exact hostnames required by your research. Wildcards and IP addresses are blocked.'
          )}
        </p>
        <div className="rounded-xl border border-border p-4">
          <div className="flex gap-2">
            <Input
              value={newDomain}
              aria-label={t('Domain hostname')}
              placeholder={DOMAIN_EXAMPLE}
              onChange={(event) => setNewDomain(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addDomain()
                }
              }}
            />
            <Button type="button" variant="outline" onClick={addDomain} disabled={!newDomain}>
              <Plus aria-hidden="true" />
              {t('Add')}
            </Button>
          </div>
          {draft.allowedDomains.length > 0 ? (
            <ul className="mt-3 divide-y divide-border">
              {draft.allowedDomains.map((domain) => (
                <li key={domain} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <code className="break-all">{domain}</code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('Remove {{domain}}', { domain })}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        allowedDomains: draft.allowedDomains.filter((item) => item !== domain)
                      })
                    }
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

      {message?.kind === 'error' ? (
        <p
          className="rounded-lg border border-status-failure-border bg-status-failure-subtle/50 px-3 py-2 text-xs text-status-failure-strong"
          role="alert"
        >
          {message.text}
        </p>
      ) : message ? (
        <p className="text-xs text-muted-foreground" role="status">
          {message.text}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="button" onClick={() => void save()} disabled={isSaving}>
          {isSaving ? t('Saving…') : t('Save changes')}
        </Button>
      </div>
    </div>
  )
}

export { NotebookNetworkDomainsForm }
