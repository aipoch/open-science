import { AlertTriangle, KeyRound } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  ConnectorCredentialRequest,
  OpenAlexCredentialValidation
} from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { MaskedPasswordField } from './MaskedPasswordField'

type ConnectorCredentialControlsProps = {
  request: ConnectorCredentialRequest
  embedded?: boolean
}

// Shared recovery controls for a Connector call whose declared credential is absent. Saving goes
// through the same Connector settings owner as the Credentials page; only then is the parked call
// resumed. Session calls embed these controls in the Composer lane; sessionless calls use the
// dialog fallback below.
export function ConnectorCredentialControls({
  request,
  embedded = false
}: ConnectorCredentialControlsProps): React.JSX.Element {
  const { t } = useTranslation()
  const setOpenAlexCredential = useSettingsStore((state) => state.setOpenAlexCredential)
  const validateOpenAlexCredential = useSettingsStore((state) => state.validateOpenAlexCredential)
  const respond = useSettingsStore((state) => state.respondCredentialRequest)
  const encryptionAvailable = useSettingsStore((state) => state.encryptionAvailable)
  const inputId = useId()
  const [draft, setDraft] = useState<{ requestId: string; value: string }>()
  const [busy, setBusy] = useState(false)
  const [failedRequestId, setFailedRequestId] = useState<string>()
  const [validation, setValidation] = useState<{
    requestId: string
    result: OpenAlexCredentialValidation
  }>()
  const apiKey = draft?.requestId === request.id ? draft.value : ''
  const candidate = apiKey.trim()
  const validCandidate = candidate.length > 0 && !/\s/u.test(candidate)

  const cancel = (): void => {
    if (busy) return
    setBusy(true)
    void respond(request.id, false)
      .catch(() => setFailedRequestId(request.id))
      .finally(() => setBusy(false))
  }

  const save = (): void => {
    if (busy || !validCandidate || !encryptionAvailable) return
    const requestId = request.id
    setBusy(true)
    setFailedRequestId(undefined)
    setValidation(undefined)
    void validateOpenAlexCredential({ apiKey: candidate })
      .then(async (result) => {
        setValidation({ requestId, result })
        if (!result.valid) return
        await setOpenAlexCredential({ apiKey: candidate })
        await respond(requestId, true)
      })
      .catch(() => setFailedRequestId(requestId))
      .finally(() => setBusy(false))
  }

  const currentValidation = validation?.requestId === request.id ? validation.result : undefined
  const validationError =
    currentValidation?.valid === false
      ? currentValidation.reason === 'invalid-format'
        ? t('Enter a valid OpenAlex API key without spaces.')
        : currentValidation.reason === 'rejected'
          ? t('OpenAlex rejected this API key.')
          : t('OpenAlex validation is temporarily unavailable. Try again.')
      : undefined

  return (
    <div
      data-testid="connector-credential-controls"
      role={embedded ? 'group' : undefined}
      aria-label={embedded ? t('Add your OpenAlex API key') : undefined}
      aria-busy={busy}
      className={cn(embedded && 'flex min-h-full flex-col bg-card text-card-foreground')}
    >
      <div
        className={cn(
          dialogHeaderClassName,
          'items-start justify-start',
          embedded && 'sticky top-0 z-10 bg-card'
        )}
      >
        <KeyRound className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden="true" />
        <div className="min-w-0">
          {embedded ? (
            <h2 className={dialogTitleClassName}>{t('Add your OpenAlex API key')}</h2>
          ) : (
            <Dialog.Title className={dialogTitleClassName}>
              {t('Add your OpenAlex API key')}
            </Dialog.Title>
          )}
          {embedded ? (
            <p className={cn(dialogDescriptionClassName, 'text-xs [text-wrap:pretty]')}>
              {t(
                'This Connector call needs an OpenAlex API key. Save it once and the waiting call will continue automatically.'
              )}
            </p>
          ) : (
            <Dialog.Description
              className={cn(dialogDescriptionClassName, 'text-xs [text-wrap:pretty]')}
            >
              {t(
                'This Connector call needs an OpenAlex API key. Save it once and the waiting call will continue automatically.'
              )}
            </Dialog.Description>
          )}
        </div>
      </div>

      <div className={cn(dialogBodyClassName, 'space-y-2')}>
        <label htmlFor={inputId} className="text-sm font-medium">
          {t('API key')}
        </label>
        <MaskedPasswordField
          id={inputId}
          value={apiKey}
          onChange={(value) => setDraft({ requestId: request.id, value })}
          placeholder={t('Paste your OpenAlex API key')}
          autoFocus
          disabled={busy}
        />
        <p className="text-xs text-muted-foreground">
          {t('Stored encrypted on this computer and sent only to api.openalex.org.')}
        </p>
        {!encryptionAvailable ? (
          <p className="text-xs text-danger-000">
            {t('Secure key storage is unavailable. Unlock the system keychain and try again.')}
          </p>
        ) : null}
        {failedRequestId === request.id ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{t('Could not save this credential. Try again.')}</span>
          </div>
        ) : null}
        {validationError ? (
          <p role="alert" className="text-xs text-danger-000">
            {validationError}
          </p>
        ) : null}
      </div>

      <div className={cn(dialogFooterClassName, embedded && 'sticky bottom-0 z-10 bg-card')}>
        <Button type="button" variant="outline" disabled={busy} onClick={cancel}>
          {t('Not now')}
        </Button>
        <Button
          type="button"
          disabled={busy || !validCandidate || !encryptionAvailable}
          onClick={save}
        >
          {busy ? t('Saving…') : t('Save key')}
        </Button>
      </div>
    </div>
  )
}

// Calls without a Session cannot own a Composer lane, so they retain the blocking dialog fallback.
export function ConnectorCredentialDialog({
  active = true
}: {
  active?: boolean
}): React.JSX.Element | null {
  const request = useSettingsStore((state) =>
    state.pendingCredentialRequests.find((candidate) => !candidate.sessionId)
  )

  if (!request) return null

  return (
    <Dialog.Root open={active}>
      <Dialog.Portal>
        <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
        <Dialog.Content
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          className={dialogPanelClassName(
            'z-[60] w-[min(460px,calc(100vw-2rem))] overscroll-contain p-0'
          )}
        >
          <ConnectorCredentialControls key={request.id} request={request} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
