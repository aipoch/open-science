import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { KeyRound, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogBodyClassName,
  dialogFooterClassName,
  dialogFormLabelClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { errorDetail } from '@/lib/error-detail'
import { Input } from '@/components/ui/input'
import { MaskedPasswordField } from './MaskedPasswordField'
import { SettingsSection, type SettingsEditorLeaveState } from './SettingsLayout'

type Action = { kind: 'add' } | { kind: 'replace' | 'remove'; endpoint: string }

export function RayCredentials({
  onLeaveStateChange
}: {
  onLeaveStateChange?: (state: SettingsEditorLeaveState | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [endpoints, setEndpoints] = useState<string[]>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [action, setAction] = useState<Action>()
  const [address, setAddress] = useState('')
  const [token, setToken] = useState('')
  const [errorMessage, setErrorMessage] = useState<string>()
  const [busy, setBusy] = useState(false)
  const addressHint = t('Use HTTPS or a loopback IP address with HTTP.')
  const invalidAddress = errorMessage === addressHint
  const opener = useRef<HTMLElement | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const active = useRef(true)
  const writing = useRef(false)
  const readGeneration = useRef(0)
  const load = useCallback(async () => {
    const generation = ++readGeneration.current
    await window.api.compute.listRayTokens().then(
      (list) => {
        if (active.current && generation === readGeneration.current) {
          setEndpoints(list)
          setLoadFailed(false)
        }
      },
      () => {
        if (active.current && generation === readGeneration.current) setLoadFailed(true)
      }
    )
  }, [])
  useEffect(() => {
    active.current = true
    void load()
    return () => {
      active.current = false
    }
  }, [load])
  const dirty = Boolean(token || address)
  useLayoutEffect(() => {
    onLeaveStateChange?.({ dirty, busy })
  }, [dirty, busy, onLeaveStateChange])
  useLayoutEffect(() => () => onLeaveStateChange?.(null), [onLeaveStateChange])

  function open(next: Action, button: HTMLElement): void {
    opener.current = button
    setAddress('')
    setToken('')
    setErrorMessage(undefined)
    setAction(next)
  }
  function close(): void {
    if (writing.current) return
    setToken('')
    setAddress('')
    setErrorMessage(undefined)
    setAction(undefined)
  }
  function restoreFocus(event: Event): void {
    event.preventDefault()
    const target = opener.current?.isConnected ? opener.current : addButton.current
    target?.focus()
  }
  async function save(): Promise<void> {
    if (!action || writing.current) return
    writing.current = true
    setBusy(true)
    setErrorMessage(undefined)
    try {
      if (action.kind === 'remove') await window.api.compute.removeRayToken(action.endpoint)
      else
        await window.api.compute.setRayToken(
          action.kind === 'replace' ? action.endpoint : address.trim(),
          token
        )
    } catch (error) {
      if (active.current) {
        const detail = errorDetail(error)
        if (
          detail?.endsWith('Ray Dashboard tokens require HTTPS or a loopback IP address.') ||
          detail?.endsWith('Invalid Ray Dashboard endpoint.')
        )
          setErrorMessage(addressHint)
        else if (detail?.endsWith('Invalid Ray Dashboard access token.'))
          setErrorMessage(t('Paste a valid Ray access token without spaces or line breaks.'))
        else if (detail?.endsWith('Secure credential storage unavailable.'))
          setErrorMessage(
            t(
              'Secure credential storage is locked or unavailable. Unlock the system credential store and retry.'
            )
          )
        else
          setErrorMessage(
            action.kind === 'remove'
              ? t('Could not remove credential.')
              : t('Could not save credential.')
          )
      }
      return
    } finally {
      writing.current = false
      if (active.current) setBusy(false)
    }
    if (active.current) {
      if (action.kind === 'remove') opener.current = addButton.current
      close()
      await load()
    }
  }
  return (
    <div className="p-5">
      <SettingsSection
        title={t('Dashboard access tokens')}
        description={t(
          'Each access token is used only for its Dashboard URL, including the gateway path.'
        )}
        headingAs="h2"
        action={
          <Button
            ref={addButton}
            type="button"
            disabled={!endpoints || loadFailed}
            onClick={(e) => open({ kind: 'add' }, e.currentTarget)}
          >
            {t('Add access token')}
          </Button>
        }
      >
        {loadFailed ? (
          <div role="alert" className="flex items-center gap-2 text-sm">
            {t('Could not load credentials.')}
            <Button size="sm" variant="outline" onClick={() => void load()}>
              {t('Retry')}
            </Button>
          </div>
        ) : !endpoints || !endpoints.length ? (
          <p className="text-sm text-muted-foreground">
            {endpoints ? t('No saved tokens.') : t('Loading…')}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {endpoints.map((endpoint) => (
              <li key={endpoint} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-1 basis-40 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                    <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                  </span>
                  <bdi dir="ltr" className="min-w-0 break-all text-sm font-medium">
                    {endpoint}
                  </bdi>
                </div>
                <div className="ms-auto flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={(e) => open({ kind: 'replace', endpoint }, e.currentTarget)}
                  >
                    {t('Replace access token')}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('Remove {{name}}', { name: endpoint })}
                    title={t('Remove token')}
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={(e) => open({ kind: 'remove', endpoint }, e.currentTarget)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <Dialog.Root
        open={action?.kind === 'add' || action?.kind === 'replace'}
        onOpenChange={(v) => {
          if (!v) close()
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content
            className={dialogPanelClassName('w-[min(440px,92vw)] p-0')}
            onCloseAutoFocus={restoreFocus}
            aria-describedby="ray-address-hint"
            onInteractOutside={(e) => {
              if (busy || dirty) e.preventDefault()
            }}
          >
            <div className={dialogHeaderClassName}>
              <Dialog.Title className={dialogTitleClassName}>
                {action?.kind === 'replace' ? t('Replace access token') : t('Add access token')}
              </Dialog.Title>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              <div className={dialogBodyClassName + ' space-y-4'}>
                <div>
                  <label htmlFor="ray-token-endpoint" className={dialogFormLabelClassName}>
                    {t('Ray Dashboard URL')}
                  </label>
                  <Input
                    id="ray-token-endpoint"
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    dir="ltr"
                    required
                    aria-invalid={invalidAddress || undefined}
                    aria-describedby="ray-address-hint"
                    readOnly={action?.kind === 'replace'}
                    disabled={busy}
                    value={action?.kind === 'replace' ? action.endpoint : address}
                    onChange={(e) => {
                      setAddress(e.target.value)
                      if (invalidAddress) setErrorMessage(undefined)
                    }}
                  />
                  <Dialog.Description
                    id="ray-address-hint"
                    role={invalidAddress ? 'alert' : undefined}
                    className={
                      invalidAddress
                        ? 'mt-1.5 text-xs text-destructive'
                        : 'mt-1.5 text-xs text-muted-foreground'
                    }
                  >
                    {addressHint}
                  </Dialog.Description>
                </div>
                <div>
                  <label htmlFor="ray-access-token" className={dialogFormLabelClassName}>
                    {t('Access token')}
                  </label>
                  <MaskedPasswordField
                    id="ray-access-token"
                    value={token}
                    onChange={setToken}
                    required
                    disabled={busy}
                    dir="ltr"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        e.currentTarget.form?.requestSubmit()
                      }
                    }}
                  />
                </div>
                {errorMessage && !invalidAddress && (
                  <p role="alert" className="text-sm text-destructive">
                    {errorMessage}
                  </p>
                )}
              </div>
              <div className={dialogFooterClassName}>
                <Button type="button" variant="outline" disabled={busy} onClick={close}>
                  {t('Cancel')}
                </Button>
                <Button
                  type="submit"
                  disabled={busy || !token.trim() || (action?.kind === 'add' && !address.trim())}
                >
                  {busy ? t('Saving…') : t('Save')}
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <ConfirmActionDialog
        open={action?.kind === 'remove'}
        title={t('Remove token')}
        description={t('Stop sending the saved token to {{endpoint}}?', {
          endpoint: action?.kind === 'remove' ? action.endpoint : ''
        })}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Remove')}
        loading={busy}
        destructive
        onCancel={close}
        onConfirm={() => void save()}
        onCloseAutoFocus={restoreFocus}
      >
        {errorMessage && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {errorMessage}
          </p>
        )}
      </ConfirmActionDialog>
    </div>
  )
}
