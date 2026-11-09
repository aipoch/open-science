import { QRCodeSVG } from '@rc-component/qrcode'
import { Copy, RefreshCw, Wifi, Globe2, Power, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RemoteAccessMode, RemoteAccessSnapshot } from '../../../../shared/remote-access'
import { Button } from '@/components/ui/button'

type ConnectMobilePanelProps = {
  /** Renders inside another surface (Settings) instead of owning the whole window. */
  embedded?: boolean
}

export const ConnectMobilePanel = ({
  embedded = false
}: ConnectMobilePanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<RemoteAccessSnapshot>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let mounted = true
    const load = (): void => {
      void window.api.remoteAccess
        .getSnapshot()
        .then((value) => {
          if (!mounted) return
          setSnapshot(value)
          setError(undefined)
        })
        .catch((cause: unknown) => {
          if (mounted) setError(String(cause))
        })
    }
    load()
    const unsubscribe = window.api.remoteAccess.onChanged(load)
    const timer = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(load, 5000)
    return () => {
      mounted = false
      unsubscribe()
      clearInterval(timer)
      clearInterval(poll)
    }
  }, [])

  const run = async (action: () => Promise<RemoteAccessSnapshot>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      setSnapshot(await action())
    } catch (cause) {
      setError(String(cause))
      const latest = await window.api.remoteAccess.getSnapshot().catch(() => undefined)
      if (latest) setSnapshot(latest)
    } finally {
      setBusy(false)
    }
  }

  const chooseMode = (mode: RemoteAccessMode): void => {
    void run(() => window.api.remoteAccess.setMode({ mode }))
  }

  const offer =
    snapshot?.enabled &&
    snapshot.lifecycle === 'running' &&
    snapshot.offer &&
    snapshot.offer.expiresAt > now
      ? snapshot.offer
      : undefined
  const devices = snapshot?.connectedDevices ?? snapshot?.trustedBrowsers ?? []
  const remaining = offer ? Math.ceil((offer.expiresAt - now) / 1000) : 0
  const isTunnel = snapshot?.mode === 'pinggy'
  const isLan = snapshot?.mode === 'lan'
  // Only the WiFi and Internet routes pair through this panel; Remote.it modes show no QR code here.
  const selectedMode: 'off' | 'lan' | 'pinggy' = isLan ? 'lan' : isTunnel ? 'pinggy' : 'off'
  const placeholder =
    selectedMode === 'off'
      ? t('Remote access is off')
      : snapshot?.lifecycle === 'error'
        ? t('Connection unavailable')
        : isTunnel
          ? t('Establishing secure tunnel…')
          : t('Preparing connection…')
  const shownError = error ?? snapshot?.error

  const modeSwitch = (
    <div
      className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1"
      role="radiogroup"
      aria-label={t('Connection mode')}
    >
      {(['off', 'lan', 'pinggy'] as const).map((mode) => {
        const Icon = mode === 'off' ? Power : mode === 'lan' ? Wifi : Globe2
        const selected = snapshot?.mode === mode
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={busy || !snapshot?.canManage}
            className={`flex h-8 items-center justify-center gap-2 rounded-md text-sm transition-colors disabled:cursor-not-allowed ${
              selected
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => {
              if (!selected) chooseMode(mode)
            }}
          >
            <Icon className="size-4" aria-hidden="true" />
            {mode === 'off' ? t('Off') : mode === 'lan' ? t('WiFi') : t('Internet')}
          </button>
        )
      })}
    </div>
  )

  const modeHint = (
    <p className="text-xs leading-relaxed text-muted-foreground">
      {selectedMode === 'off'
        ? t('Choose WiFi or Internet to connect a mobile device.')
        : isTunnel
          ? t(
              'Connect over the internet through Pinggy. Traffic passes through a third-party server.'
            )
          : t('Connect your mobile device to the same WiFi as this computer.')}
    </p>
  )

  const addressSelect =
    snapshot?.mode === 'lan' && (snapshot.lan?.addresses.length ?? 0) > 1 ? (
      <select
        className="h-8 w-full rounded-md border bg-background px-2 text-sm"
        value={snapshot.lan?.selectedAddress ?? ''}
        aria-label={t('Local network address')}
        disabled={busy}
        onChange={(event) =>
          void run(() => window.api.remoteAccess.selectLanAddress({ address: event.target.value }))
        }
      >
        {snapshot.lan?.addresses.map((address) => (
          <option key={address} value={address}>
            {address}
          </option>
        ))}
      </select>
    ) : null

  const qrCode = (size: number): React.JSX.Element =>
    offer ? (
      // Keep a white quiet zone so the code stays scannable in dark mode.
      <div className="rounded-lg bg-white p-2.5">
        <QRCodeSVG value={offer.url} size={size} />
      </div>
    ) : (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed px-3 text-center text-xs text-muted-foreground"
        style={{ width: size + 20, height: size + 20 }}
      >
        {placeholder}
      </div>
    )

  const linkRow = offer ? (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs"
        title={offer.url}
      >
        {offer.url}
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-8"
        title={t('Copy link')}
        aria-label={t('Copy link')}
        onClick={() => void navigator.clipboard.writeText(offer.url)}
      >
        <Copy className="size-4" />
      </Button>
    </div>
  ) : null

  const password =
    isTunnel && offer?.password ? (
      <p className="text-sm">
        {t('Connection password')}:{' '}
        <strong className="font-mono text-lg tracking-widest">{offer.password}</strong>
      </p>
    ) : null

  const notes = (
    <>
      {snapshot?.mode === 'lan' ? (
        <p className="text-xs text-muted-foreground">
          {t('Allow incoming connections if prompted by your system. Avoid public WiFi.')}
        </p>
      ) : null}
      {isTunnel && snapshot.pinggy?.tier === 'free' ? (
        <p className="text-xs text-muted-foreground">
          {t('Free tunnels change address every 60 minutes. Scan again after reconnection.')}
        </p>
      ) : null}
      {shownError ? (
        <p role="alert" className="text-xs text-destructive">
          {shownError}
        </p>
      ) : null}
    </>
  )

  const refreshButton = (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="size-8"
      disabled={!offer || busy}
      title={t('Refresh QR code')}
      aria-label={t('Refresh QR code')}
      onClick={() => void run(() => window.api.remoteAccess.refreshOffer())}
    >
      <RefreshCw className="size-4" />
    </Button>
  )

  const devicesBar = (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-muted-foreground">
        {t('Connected devices')} ({devices.length})
      </span>
      <div className="flex items-center gap-1">
        {devices.length ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            title={t('Revoke all')}
            aria-label={t('Revoke all')}
            onClick={() =>
              void run(() =>
                window.api.remoteAccess.revokeBrowsers({
                  browserIds: devices.map(({ id }) => id)
                })
              )
            }
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
        {embedded ? null : refreshButton}
      </div>
    </div>
  )

  if (embedded) {
    return (
      <div className="overflow-hidden rounded-xl border text-foreground">
        <div className="flex flex-col gap-5 p-4 sm:flex-row sm:items-start">
          <div className="flex shrink-0 justify-center">{qrCode(152)}</div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {modeSwitch}
            {modeHint}
            {addressSelect}
            {linkRow}
            {password}
            {offer ? (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>{t('Refreshes in {{seconds}} s', { seconds: remaining })}</span>
                {refreshButton}
              </div>
            ) : null}
            {notes}
          </div>
        </div>
        <div className="border-t bg-muted/30 px-4 py-2">{devicesBar}</div>
      </div>
    )
  }

  return (
    <main className="flex h-screen flex-col gap-3 overflow-auto bg-background px-6 py-5 text-foreground">
      <header className="text-center">
        <div className="text-sm font-semibold">Open-Science</div>
        <h1 className="mt-2 text-lg font-semibold">{t('Connect mobile device')}</h1>
      </header>
      {modeSwitch}
      <div className="min-h-10 text-center">{modeHint}</div>
      {addressSelect}
      <div className="flex shrink-0 justify-center">{qrCode(200)}</div>
      {linkRow}
      <div className="space-y-2 text-center">
        {password}
        {offer ? (
          <p className="text-xs text-muted-foreground">
            {t('Refreshes in {{seconds}} s', { seconds: remaining })}
          </p>
        ) : null}
        {notes}
      </div>
      <footer className="mt-auto border-t pt-3">{devicesBar}</footer>
    </main>
  )
}

export const ConnectMobileWindow = (): React.JSX.Element => <ConnectMobilePanel />
