import { useFileCredentialNotice } from '../settings/use-file-credential-notice'
import { useEffect, useId, useState } from 'react'
import { Check, Settings2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/settings-store'
import { MaskedPasswordField } from '../settings/MaskedPasswordField'

export const LiteratureOpenAlexCredential = ({
  disabled,
  onSaved,
  onBusyChange
}: {
  disabled: boolean
  onSaved: () => void
  onBusyChange: (busy: boolean) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const fileCredentialNotice = useFileCredentialNotice()
  const id = useId()
  const configured = useSettingsStore((state) => state.openAlex.hasApiKey)
  const encryptionAvailable = useSettingsStore((state) => state.encryptionAvailable)
  const load = useSettingsStore((state) => state.loadConnectors)
  const validate = useSettingsStore((state) => state.validateOpenAlexCredential)
  const save = useSettingsStore((state) => state.setOpenAlexCredential)
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    void load().catch(() => undefined)
  }, [load])
  const submit = async (): Promise<void> => {
    if (busy || disabled || !key.trim() || !encryptionAvailable) return
    setBusy(true)
    onBusyChange(true)
    setError(undefined)
    try {
      const result = await validate({ apiKey: key.trim() })
      if (!result.valid) {
        setError(
          result.reason === 'invalid-format'
            ? t('Enter a valid OpenAlex API key without spaces.')
            : result.reason === 'rejected'
              ? t('OpenAlex rejected this API key.')
              : t('OpenAlex validation is temporarily unavailable. Try again.')
        )
        return
      }
      await save({ apiKey: key.trim() })
      setKey('')
      setEditing(false)
      onSaved()
    } catch {
      setError(t('Could not save the OpenAlex API key.'))
    } finally {
      setBusy(false)
      onBusyChange(false)
    }
  }
  return (
    <div className="mt-2">
      {editing ? (
        <form
          className="space-y-2 border-t border-border pt-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label htmlFor={id} className="text-xs font-medium">
            {t('OpenAlex API key')}
          </label>
          <MaskedPasswordField
            id={id}
            value={key}
            onChange={setKey}
            autoFocus
            disabled={busy || disabled}
            placeholder={t('Paste your OpenAlex API key')}
          />
          <p className="text-xs text-muted-foreground">
            {fileCredentialNotice ??
              t('Stored encrypted on this computer and sent only to api.openalex.org.')}
          </p>
          {!encryptionAvailable ? (
            <p role="alert" className="text-xs text-danger-000">
              {t('Secure key storage is unavailable. Unlock the system keychain and try again.')}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-danger-000">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setKey('')
                setError(undefined)
              }}
            >
              {t('Cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={busy || disabled || !key.trim() || !encryptionAvailable}
            >
              {busy ? t('Saving…') : t('Save key')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-center gap-3">
          {configured ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Check className="size-3.5" aria-hidden="true" />
              {t('Configured')}
            </span>
          ) : null}
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0 py-1 text-xs"
            disabled={disabled}
            onClick={() => setEditing(true)}
          >
            <Settings2 className="size-3.5" aria-hidden="true" />
            {configured ? t('Edit') : t('Configure OpenAlex')}
          </Button>
        </div>
      )}
    </div>
  )
}
