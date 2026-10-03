import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import type { TrustedPrivateDestination } from '../../../../shared/notebook-network'
import { validateCustomAllowedDomain } from '../../../../shared/notebook-network'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InlineNotice } from '@/components/ui/inline-notice'
import { SettingsSection } from './SettingsLayout'

type Props = {
  rules: readonly TrustedPrivateDestination[]
  disabled: boolean
  onChange: (rules: readonly TrustedPrivateDestination[]) => void
  onEditingChange: (editing: boolean) => void
}

// Owns only the transient review. The parent owns the saved/draft rule list.
export function TrustedPrivateServices({
  rules,
  disabled,
  onChange,
  onEditingChange
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [hostname, setHostname] = useState('')
  const [port, setPort] = useState('443')
  const [reviewed, setReviewed] = useState<TrustedPrivateDestination>()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const hostInput = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)
  useEffect(() => {
    if (editing) hostInput.current?.focus()
    else if (wasEditing.current) addButton.current?.focus()
    wasEditing.current = editing
  }, [editing])
  const available = typeof window.api.settings.reviewNotebookPrivateDestination === 'function'
  useEffect(() => {
    onEditingChange(editing)
  }, [editing, onEditingChange])
  useEffect(
    () => () => {
      generation.current += 1
      onEditingChange(false)
    },
    [onEditingChange]
  )
  const invalidate = (): void => {
    generation.current += 1
    setReviewed(undefined)
    setChecking(false)
    setError('')
  }
  const close = (): void => {
    invalidate()
    setEditing(false)
    setHostname('')
    setPort('443')
  }
  const review = async (): Promise<void> => {
    const host = validateCustomAllowedDomain(hostname)
    if (!host.ok || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      setError(t('Enter an exact hostname and a port from 1 to 65535.'))
      return
    }
    const current = ++generation.current
    setChecking(true)
    setReviewed(undefined)
    setError('')
    try {
      const result = await window.api.settings.reviewNotebookPrivateDestination({
        hostname: host.hostname,
        port: Number(port)
      })
      if (current !== generation.current) return
      if (result.ok) setReviewed(result.destination)
      else
        setError(
          result.reason === 'dns'
            ? t('Could not resolve this hostname. Check your network or VPN and try again.')
            : result.reason === 'invalid'
              ? t('Enter an exact hostname and a port from 1 to 65535.')
              : t(
                  'Only private service addresses are supported. Localhost, this computer, and reserved addresses remain blocked.'
                )
        )
    } catch {
      if (current === generation.current) setError(t('Could not review the service. Try again.'))
    } finally {
      if (current === generation.current) setChecking(false)
    }
  }
  return (
    <SettingsSection
      separated
      title={t('Trusted private services')}
      description={t(
        'Allow a specific service on your private network. Other private destinations stay blocked.'
      )}
      action={
        !editing ? (
          <Button
            variant="outline"
            ref={addButton}
            disabled={disabled || !available}
            onClick={() => setEditing(true)}
          >
            <Plus aria-hidden="true" />
            {t('Add service')}
          </Button>
        ) : undefined
      }
    >
      {!available ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {t('Configure private services in the local desktop app.')}
        </p>
      ) : null}
      {rules.length ? (
        <ul className="mt-3 divide-y divide-border">
          {rules.map((rule) => (
            <li
              key={`${rule.hostname}:${rule.port}`}
              className="flex items-start justify-between gap-3 py-3"
            >
              <div className="min-w-0 text-sm">
                <code className="break-all">
                  {rule.hostname}:{rule.port}
                </code>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {t('Approved addresses: {{addresses}}', {
                    addresses: rule.approvedAddresses.join(', ')
                  })}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  disabled={disabled || editing || !available}
                  onClick={() => {
                    invalidate()
                    setHostname(rule.hostname)
                    setPort(String(rule.port))
                    setEditing(true)
                  }}
                >
                  {t('Review service')}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled || editing}
                  aria-label={t('Remove {{domain}}', { domain: `${rule.hostname}:${rule.port}` })}
                  onClick={() => onChange(rules.filter((entry) => entry !== rule))}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : !editing ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('No private services trusted.')}</p>
      ) : null}
      {editing ? (
        <div className="mt-4 space-y-4 rounded-xl border border-border p-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
            <div>
              <label htmlFor="private-hostname" className="mb-1.5 block text-sm font-medium">
                {t('Hostname')}
              </label>
              <Input
                id="private-hostname"
                ref={hostInput}
                value={hostname}
                placeholder="research.internal.example"
                disabled={disabled}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'private-service-error' : 'private-service-help'}
                onChange={(event) => {
                  invalidate()
                  setHostname(event.target.value)
                }}
              />
            </div>
            <div>
              <label htmlFor="private-port" className="mb-1.5 block text-sm font-medium">
                {t('Port')}
              </label>
              <Input
                id="private-port"
                inputMode="numeric"
                value={port}
                disabled={disabled}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'private-service-error' : 'private-service-help'}
                onChange={(event) => {
                  invalidate()
                  setPort(event.target.value)
                }}
              />
            </div>
          </div>
          <p id="private-service-help" className="text-xs leading-5 text-muted-foreground">
            {t('No wildcards or IP addresses. Review checks DNS addresses, not connectivity.')}
          </p>
          {error ? (
            <InlineNotice id="private-service-error" level="error" role="alert">
              {error}
            </InlineNotice>
          ) : null}
          {reviewed ? (
            <div className="space-y-2 text-sm" role="status">
              <p className="font-medium">{t('Review private access')}</p>
              <code className="block break-all">
                {reviewed.hostname}:{reviewed.port}
              </code>
              <p className="break-all text-xs text-muted-foreground">
                {t('Approved addresses: {{addresses}}', {
                  addresses: reviewed.approvedAddresses.join(', ')
                })}
              </p>
              <p className="leading-5">
                {t(
                  'Protected Notebook and Shell code can send data to this service across all projects. Address changes require another review.'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('The rule takes effect after you save changes.')}
              </p>
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={disabled} onClick={close}>
              {t('Cancel')}
            </Button>
            {reviewed ? (
              <Button
                disabled={disabled}
                onClick={() => {
                  onChange(
                    [
                      ...rules.filter(
                        (entry) =>
                          entry.hostname !== reviewed.hostname || entry.port !== reviewed.port
                      ),
                      reviewed
                    ].sort((a, b) => a.hostname.localeCompare(b.hostname) || a.port - b.port)
                  )
                  close()
                }}
              >
                {t('Add to trusted services')}
              </Button>
            ) : (
              <Button
                disabled={disabled || checking || !hostname || !port}
                onClick={() => void review()}
              >
                {checking ? t('Checking…') : t('Review service')}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </SettingsSection>
  )
}
