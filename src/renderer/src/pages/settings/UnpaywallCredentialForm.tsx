import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSettingsStore } from '@/stores/settings-store'

export const UnpaywallCredentialForm = ({
  disabled = false,
  onSaved,
  onCancel,
  onBusyChange
}: {
  disabled?: boolean
  onSaved: () => void
  onCancel: () => void
  onBusyChange?: (busy: boolean) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const id = useId()
  const storedEmail = useSettingsStore((state) => state.ncbi.contactEmail ?? '')
  const save = useSettingsStore((state) => state.setNcbiCredentials)
  const load = useSettingsStore((state) => state.loadConnectors)
  const [draft, setDraft] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    void load().catch(() => undefined)
  }, [load])
  const email = draft ?? storedEmail
  const submit = async (value: string): Promise<void> => {
    if (busy || disabled) return
    setBusy(true)
    onBusyChange?.(true)
    setError(false)
    try {
      // Omitting apiKey preserves the NCBI key owned by the shared research credentials.
      await save({ contactEmail: value.trim() })
      setDraft(undefined)
      onSaved()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit(email)
      }}
    >
      <div className="space-y-1.5">
        <label htmlFor={id} className="text-xs font-medium">
          {t('Contact email')}
        </label>
        <Input
          id={id}
          type="email"
          required
          value={email}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="you@example.com"
          disabled={busy || disabled}
          autoFocus
        />
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {t(
          'Shared with Literature access in Credentials. Sent to Unpaywall for DOI lookups; never sent to PDF hosts.'
        )}
      </p>
      {error ? (
        <p role="alert" className="text-xs text-danger-000">
          {t('Could not save the contact email. Try again.')}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {t('Cancel')}
        </Button>
        {storedEmail ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || disabled}
            onClick={() => void submit('')}
          >
            {t('Remove email')}
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={busy || disabled || !email.trim()}>
          {busy ? t('Saving…') : t('Save')}
        </Button>
      </div>
    </form>
  )
}
