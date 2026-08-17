/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · component: settings form · genre: modern-minimal · theme: project system
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (project semantic tokens) · slop: pass (component scope)
 */
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import {
  networkProxyValidationMessage,
  type NetworkProxyMode,
  type NetworkProxySettings
} from '../../../../shared/network-proxy'
import { useSettingsStore } from '../../stores/settings-store'
import { SettingsRow, SettingsSection } from './SettingsLayout'

type NetworkProxyFormProps = Readonly<{ onDone: () => void }>

const NetworkProxyForm = ({ onDone }: NetworkProxyFormProps): React.JSX.Element => {
  const { t } = useTranslation()
  const saved = useSettingsStore((state) => state.networkProxy)
  const setNetworkProxy = useSettingsStore((state) => state.setNetworkProxy)
  const [draft, setDraft] = useState<NetworkProxySettings>(saved)
  const [isSaving, setIsSaving] = useState(false)
  const [serverTouched, setServerTouched] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [isSuccess, setIsSuccess] = useState(false)
  const successTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(
    () => () => {
      if (successTimer.current) clearTimeout(successTimer.current)
    },
    []
  )

  const validationMessage = networkProxyValidationMessage(draft)
  const showServerError = draft.mode === 'manual' && serverTouched && validationMessage

  const handleModeChange = (mode: NetworkProxyMode): void => {
    setMessage(undefined)
    setIsSuccess(false)
    setDraft((current) => ({
      mode,
      ...(mode === 'manual'
        ? { server: current.server ?? '', bypassRules: current.bypassRules }
        : {})
    }))
  }

  const handleSave = async (): Promise<void> => {
    setServerTouched(true)
    setMessage(undefined)
    setIsSuccess(false)
    if (validationMessage) return

    setIsSaving(true)
    try {
      await setNetworkProxy(draft)
      setIsSuccess(true)
      if (successTimer.current) clearTimeout(successTimer.current)
      successTimer.current = setTimeout(() => setIsSuccess(false), 4_000)
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : t('Could not save the proxy configuration.')
      )
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-5 p-5">
      <SettingsSection
        title={t('Proxy')}
        description={t(
          'Choose how Open Science reaches the internet. Changes apply to new app requests and processes.'
        )}
        aria-label={t('Proxy settings')}
      >
        <SettingsRow
          label={t('Mode')}
          description={t(
            'System follows your device proxy for app requests. Agent processes inherit only the proxy environment Open Science started with; choose Manual to give them a fixed proxy.'
          )}
          className="pt-0"
        >
          <Select
            value={draft.mode}
            onValueChange={(value) => handleModeChange(value as NetworkProxyMode)}
          >
            <SelectTrigger aria-label={t('Proxy mode')}>
              <span>
                {t(
                  draft.mode === 'system' ? 'System' : draft.mode === 'manual' ? 'Manual' : 'Direct'
                )}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('System')}</SelectItem>
              <SelectItem value="manual">{t('Manual')}</SelectItem>
              <SelectItem value="direct">{t('Direct')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>

        {draft.mode === 'manual' ? (
          <>
            <SettingsRow
              label={t('Proxy server')}
              description={t(
                'HTTP, HTTPS, SOCKS, SOCKS4, or SOCKS5 URL. Embedded credentials are not supported.'
              )}
            >
              <div className="space-y-1.5">
                <Input
                  id="network-proxy-server"
                  aria-label={t('Proxy server')}
                  aria-invalid={showServerError ? true : undefined}
                  aria-describedby="network-proxy-server-help"
                  value={draft.server ?? ''}
                  placeholder={t('http://127.0.0.1:1086')}
                  onBlur={() => setServerTouched(true)}
                  onChange={(event) => {
                    const server = event.target.value
                    setDraft((current) => ({ ...current, server }))
                    setMessage(undefined)
                    setIsSuccess(false)
                  }}
                />
                <p
                  id="network-proxy-server-help"
                  className={
                    showServerError
                      ? 'min-h-[1lh] text-xs text-destructive'
                      : 'min-h-[1lh] text-xs text-muted-foreground'
                  }
                  role={showServerError ? 'alert' : undefined}
                >
                  {showServerError || t('Example: http://127.0.0.1:1086')}
                </p>
              </div>
            </SettingsRow>

            <SettingsRow
              label={t('Bypass rules')}
              description={t(
                'Optional comma-separated hosts that should connect directly. Localhost is always bypassed.'
              )}
            >
              <Input
                id="network-proxy-bypass"
                aria-label={t('Proxy bypass rules')}
                value={draft.bypassRules ?? ''}
                placeholder={t('*.internal.example, 10.0.0.0/8')}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, bypassRules: event.target.value }))
                }
              />
            </SettingsRow>
          </>
        ) : null}
      </SettingsSection>

      <div className="rounded-lg bg-bg-10 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground ring-1 ring-border-200">
        {t(
          'Existing agent sessions, notebook kernels, and installers keep their current connection. New requests and processes use the saved setting.'
        )}
      </div>

      {message ? (
        <p className="text-xs text-destructive" role="alert">
          {message}
        </p>
      ) : null}
      {isSuccess ? (
        <p className="flex items-center gap-1.5 text-xs text-success-000" role="status">
          <CheckCircle2 className="size-4" aria-hidden="true" />
          {t('Proxy settings saved.')}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={isSaving}>
          {t('Done')}
        </Button>
        <Button type="button" onClick={() => void handleSave()} disabled={isSaving}>
          {isSaving ? (
            <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : null}
          {isSaving ? t('Saving…') : t('Save')}
        </Button>
      </div>
    </div>
  )
}

export { NetworkProxyForm }
