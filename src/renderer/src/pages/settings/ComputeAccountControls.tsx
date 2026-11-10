import { ComputePythonEnvironmentControl } from './ComputePythonEnvironmentControl'
import { useComputePythonEnvironment } from './use-compute-python-environment'
import type { TFunction } from 'i18next'
import { useEffect, useRef, useState } from 'react'
import { Copy, ExternalLink, LoaderCircle, Terminal, X } from 'lucide-react'
import * as AlertDialog from '@/components/ui/alert-dialog'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { InlineNotice } from '@/components/ui/inline-notice'
import { useTranslation } from 'react-i18next'
import type {
  ComputeAccountProvider,
  ComputeAccountStatus
} from '../../../../shared/compute-accounts'
import huggingFaceIcon from '@/assets/provider-icons/huggingface.svg'
import modalIcon from '@/assets/provider-icons/modal.svg'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'

import {
  useComputeAccount,
  computeAccountStatusLabel,
  type ComputeAccountController as Controller
} from './use-compute-account'
const accountNames = { 'hugging-face': 'Hugging Face', modal: 'Modal' } as const
function accountReasonLabel(
  reason: NonNullable<ComputeAccountStatus['reason']>,
  t: TFunction
): string {
  switch (reason) {
    case 'missing':
      return t('No local sign-in found. Connect in browser to sign in.')
    case 'dependency':
      return t('Sign-in tools unavailable')
    case 'storage':
      return t('Secure credential storage unavailable')
    case 'authorization':
      return t('Authorization was not completed')
    case 'timeout':
      return t('Authorization timed out')
    case 'cancelled':
      return t('Authorization cancelled')
    case 'network':
      return t('Connection unavailable')
  }
}

function AccountStatus({ account }: { account: Controller }): React.JSX.Element {
  const { t } = useTranslation()
  const { status, error } = account
  const label = computeAccountStatusLabel(account, t)
  const detail = !error && status?.reason ? accountReasonLabel(status.reason, t) : undefined
  return (
    <p role="status" className="min-w-0 break-words text-xs text-muted-foreground">
      {label}
      {status?.identity && (
        <>
          {' '}
          · <bdi>{status.identity}</bdi>
        </>
      )}
      {status?.source && <> · {status.source === 'local' ? t('Local CLI') : t('App-managed')}</>}
      {detail && detail !== label && <> · {detail}</>}
    </p>
  )
}

export function ComputeAccountRow({
  provider,
  onManage
}: {
  provider: ComputeAccountProvider
  onManage: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const account = useComputeAccount(provider)
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
        <img
          src={provider === 'hugging-face' ? huggingFaceIcon : modalIcon}
          alt=""
          className="size-5"
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{accountNames[provider]}</div>
        <AccountStatus account={account} />
      </div>
      <Button variant="outline" onClick={onManage}>
        {account.status?.state === 'disconnected' ? t('Connect') : t('Manage')}
      </Button>
    </div>
  )
}

type AccountDialogProps = {
  provider: ComputeAccountProvider
  account: Controller
  open: boolean
  description?: string
  onClose: () => void
  onConnected: () => void
}
type SignInMethod = 'connectAccount' | 'useLocalAccount'

export function ComputeAccountDialog({
  open,
  ...props
}: AccountDialogProps): React.JSX.Element | null {
  return open ? <OpenAccountDialog key={props.provider} {...props} /> : null
}

function OpenAccountDialog({
  provider,
  account,
  description,
  onClose,
  onConnected
}: Omit<AccountDialogProps, 'open'>): React.JSX.Element {
  const { t } = useTranslation()
  const { status, error, busy } = account
  const environment = useComputePythonEnvironment(provider, account)
  const pending = status?.state === 'pending'
  const flow = useRef<'idle' | 'starting' | 'managed' | 'local'>(
    pending ? (status.source ?? 'managed') : 'idle'
  )
  const active = useRef(true)
  const browserButton = useRef<HTMLButtonElement>(null)
  const focusWhenReady = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const [method, setMethod] = useState<SignInMethod>()
  const [copy, setCopy] = useState<'idle' | 'copied' | 'error'>('idle')
  const reason = status?.reason
  const failure = error
    ? t('Connection unavailable')
    : reason
      ? accountReasonLabel(reason, t)
      : undefined
  const waiting = pending || (busy && !!method)
  const waitingLabel = pending ? computeAccountStatusLabel(account, t) : t('Working…')
  const userCode = pending && status.source !== 'local' ? status.userCode : undefined

  useEffect(() => {
    if (focusWhenReady.current && !environment.blocked && !browserButton.current?.disabled) {
      focusWhenReady.current = false
      browserButton.current?.focus()
    }
  }, [environment.blocked])

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  useEffect(() => {
    if (!active.current) return
    if (pending) {
      // Changing the environment retires the previous login intent, even while its cancel
      // response still reports pending or preserves an already connected account.
      if (flow.current !== 'idle') flow.current = status.source ?? 'managed'
      return
    }
    const expected = flow.current
    if (expected === 'idle' || expected === 'starting' || busy || !status || error) return
    flow.current = 'idle'
    if (status.state === 'connected' && status.source === expected && !status.reason) {
      active.current = false
      onConnected()
    }
  }, [status, pending, busy, error, onConnected])

  async function signIn(operation: SignInMethod): Promise<void> {
    if (busy || !active.current) return
    flow.current = 'starting'
    setMethod(operation)
    setCopy('idle')
    const next = await environment.signIn(operation)
    if (!active.current || !next) return
    flow.current = next?.state === 'pending' ? (next.source ?? 'managed') : 'idle'
    if (next?.state === 'connected' && !next.reason) {
      active.current = false
      onConnected()
    }
  }

  function close(): void {
    if (!active.current) return
    active.current = false
    if (flow.current !== 'idle') {
      flow.current = 'idle'
    }
    environment.cancel()
    onClose()
  }
  return (
    <AlertDialog.Root open onOpenChange={(next) => !next && close()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(440px,92vw)] p-0')}
          onPointerDown={() => {
            focusWhenReady.current = false
          }}
          onKeyDown={() => {
            focusWhenReady.current = false
          }}
          onCloseAutoFocus={(event) => {
            if (returnFocus.current?.isConnected) {
              event.preventDefault()
              returnFocus.current.focus({ preventScroll: true })
            }
          }}
          onOpenAutoFocus={(event) => {
            if (
              document.activeElement instanceof HTMLElement &&
              document.activeElement !== document.body
            ) {
              returnFocus.current = document.activeElement
            }
            focusWhenReady.current = !!browserButton.current?.disabled
            if (browserButton.current && !browserButton.current.disabled) {
              event.preventDefault()
              browserButton.current.focus()
            }
          }}
        >
          <div className={dialogHeaderClassName}>
            <AlertDialog.Title className={dialogTitleClassName}>
              {t('Connect {{provider}}', { provider: accountNames[provider] })}
            </AlertDialog.Title>
            <AlertDialog.Cancel asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className={dialogCloseButtonClassName}
                aria-label={t('Close')}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </AlertDialog.Cancel>
          </div>
          <div className={dialogBodyClassName}>
            <AlertDialog.Description
              className={description && !waiting ? `${dialogDescriptionClassName} mb-4` : 'sr-only'}
            >
              {waiting ? waitingLabel : (description ?? t('Connect in browser'))}
            </AlertDialog.Description>
            {
              <ComputePythonEnvironmentControl
                provider={accountNames[provider]}
                environment={environment}
                onSelect={(selection) => {
                  flow.current = 'idle'
                  setMethod(undefined)
                  void environment.select(selection)
                }}
                onRetry={() => {
                  if (!environment.snapshot) void environment.load()
                  else if (environment.retrySelection)
                    void environment.select(environment.selection)
                  else if (method) void signIn(method)
                }}
              />
            }
            {waiting && (
              <div className="space-y-4">
                {userCode && (
                  <div
                    role="group"
                    aria-label={t('Verification code')}
                    className="rounded-lg border border-border bg-muted/30 p-4 text-center"
                  >
                    <code
                      className="block select-all break-all text-2xl font-semibold tracking-widest"
                      dir="ltr"
                    >
                      {userCode}
                    </code>
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      className="mt-2"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(userCode)
                          setCopy('copied')
                        } catch {
                          setCopy('error')
                        }
                      }}
                    >
                      <Copy className="size-4" aria-hidden="true" />
                      {copy === 'copied' ? t('Copied') : t('Copy code')}
                    </Button>
                    {copy === 'error' && (
                      <p role="alert" className="text-xs text-destructive">
                        {t('Could not copy code. Try again.')}
                      </p>
                    )}
                  </div>
                )}
                <p
                  role="status"
                  className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
                >
                  <LoaderCircle
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  {waitingLabel}
                </p>
              </div>
            )}
            {
              <div className="grid gap-2">
                <Button
                  ref={browserButton}
                  type="button"
                  disabled={busy || pending || environment.blocked}
                  onClick={() => void signIn('connectAccount')}
                >
                  <ExternalLink className="size-4" aria-hidden="true" />
                  {t('Connect in browser')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || pending || environment.blocked}
                  onClick={() => void signIn('useLocalAccount')}
                >
                  <Terminal className="size-4" aria-hidden="true" />
                  {t('Use local sign-in')}
                </Button>
              </div>
            }
            {failure && !busy && !status?.runtimeError && (
              <InlineNotice level="error" role="alert" className="mt-3">
                {!error && reason === 'dependency'
                  ? t('Preparation failed. Retry or choose another environment.')
                  : failure}
              </InlineNotice>
            )}
          </div>
          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline" className={dialogCancelButtonClassName}>
                {t('Cancel')}
              </Button>
            </AlertDialog.Cancel>
            {failure && !waiting && method && !status?.runtimeError && (
              <Button type="button" onClick={() => void signIn(method)}>
                {t('Retry')}
              </Button>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

function ComputeAccountControls({
  provider,
  account
}: {
  provider: ComputeAccountProvider
  account: Controller
}): React.JSX.Element {
  const { t } = useTranslation()
  const [connect, setConnect] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const { status, busy, run } = account
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <AccountStatus account={account} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setConnect(true)}>
          {status?.state === 'connected' || status?.state === 'expired'
            ? t('Reconnect')
            : t('Connect')}
        </Button>
        {status?.source && status.state !== 'pending' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(true)}>
            {t('Disconnect')}
          </Button>
        )}
      </div>
      <ComputeAccountDialog
        provider={provider}
        account={account}
        open={connect}
        onClose={() => setConnect(false)}
        onConnected={() => setConnect(false)}
      />
      <ConfirmActionDialog
        open={confirm}
        title={t('Disconnect {{provider}}?', { provider: accountNames[provider] })}
        description={t(
          'Disconnecting stops this app from using the account. Remote jobs may continue running and incur charges. To revoke access, open your {{service}} account settings.',
          { service: accountNames[provider] }
        )}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Disconnect')}
        destructive
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false)
          void run('disconnectAccount')
        }}
      />
    </div>
  )
}

export function ComputeCredentialDetail({
  provider
}: {
  provider: ComputeAccountProvider
}): React.JSX.Element {
  const account = useComputeAccount(provider)
  return (
    <div className="p-5">
      <ComputeAccountControls provider={provider} account={account} />
    </div>
  )
}
