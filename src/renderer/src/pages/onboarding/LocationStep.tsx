import { X } from 'lucide-react'
import { AlertDialog } from 'radix-ui'
import { useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardFooter, CardHeader } from '@/components/ui/card'
import {
  dialogBodyClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { Separator } from '@/components/ui/separator'
import type { StorageInfo } from '../../../../shared/storage'
import { DataRootWarning } from '@/components/DataRootWarning'
import { onboardingErrorMessage } from './onboarding-error'

type LocationStepProps = {
  // Fetched once by the wizard shell up front, so this step has the default location to show.
  dataRootInfo: StorageInfo | null
  dataRootError: string | undefined
  locationDraft: LocationDraft
  onLocationDraftChange: (draft: LocationDraft) => void
  relaunchError: string | undefined
  onRelaunchErrorChange: (error: string | undefined) => void
  onRetryDataRootInfo: () => void
  onInteractionStart: () => void
  onBack: () => void
  onContinue: () => void
  isResolvingDefaultLocation: boolean
  // Relaunch replaces the whole wizard with a bare "Setting up…" screen, so the flag lives in the
  // shell and this step only reports it.
  setIsRelaunching: (value: boolean) => void
}

type LocationDraft = {
  chosenParent: string
  chosenDataRoot: string
  chosenKind: 'move' | 'adopt' | null
}
// Early storage step: pick where large data lives, then either continue with the current default or
// confirm a restart that activates a custom root before runtime installation. Only `dataRoot` is
// ever touched here — the config root (settings, sessions, db, claude, skills) stays fixed.
const LocationStep = ({
  dataRootInfo,
  dataRootError,
  locationDraft,
  onLocationDraftChange,
  relaunchError,
  onRelaunchErrorChange,
  onRetryDataRootInfo,
  onInteractionStart,
  onBack,
  onContinue,
  isResolvingDefaultLocation,
  setIsRelaunching
}: LocationStepProps): React.JSX.Element => {
  const { t } = useTranslation()
  const { chosenParent, chosenDataRoot, chosenKind } = locationDraft
  const isLoadingDefaultLocation = isResolvingDefaultLocation && dataRootInfo === null
  const [locationError, setLocationError] = useState<string | undefined>(undefined)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const requestInFlightRef = useRef(false)
  const [requestInFlight, setRequestInFlight] = useState(false)

  const runExclusive = async (request: () => Promise<void>): Promise<void> => {
    if (requestInFlightRef.current) return

    requestInFlightRef.current = true
    setRequestInFlight(true)
    try {
      await request()
    } finally {
      requestInFlightRef.current = false
      setRequestInFlight(false)
    }
  }

  const handleBrowseLocation = async (): Promise<void> => {
    onInteractionStart()
    await runExclusive(async () => {
      setLocationError(undefined)
      try {
        const picked = await window.api.storage.pickDirectory()
        if (!picked) return

        const result = await window.api.storage.inspectDataRoot(picked)
        if (result.kind !== 'move' && result.kind !== 'adopt') {
          setLocationError(result.error ?? t('The selected folder is not usable.'))
          return
        }

        onLocationDraftChange({
          chosenParent: picked,
          chosenDataRoot: result.dataRoot,
          chosenKind: result.kind
        })
        onRelaunchErrorChange(undefined)
      } catch (error) {
        setLocationError(
          onboardingErrorMessage(error, t('Could not choose the data location. Try again.'))
        )
      }
    })
  }

  const handleResetLocation = (): void => {
    if (requestInFlightRef.current) return

    onLocationDraftChange({ chosenParent: '', chosenDataRoot: '', chosenKind: null })
    onRelaunchErrorChange(undefined)
    setLocationError(undefined)
  }

  const handleContinueLocation = (): void => {
    if (requestInFlightRef.current) return

    if (chosenParent) {
      setConfirmRestart(true)
    } else {
      onRelaunchErrorChange(undefined)
      onContinue()
    }
  }

  const handleKeepDefault = (): void => {
    setConfirmRestart(false)
    onLocationDraftChange({ chosenParent: '', chosenDataRoot: '', chosenKind: null })
    onRelaunchErrorChange(undefined)
    setLocationError(undefined)
    onContinue()
  }

  const handleRestart = async (): Promise<void> => {
    await runExclusive(async () => {
      setConfirmRestart(false)
      onRelaunchErrorChange(undefined)
      setIsRelaunching(true)

      // Onboarding is intentionally still incomplete. The persisted custom dataRoot is the resume
      // signal after relaunch, and the wizard continues at Agent before finishing at Notebook.
      try {
        const result = await window.api.storage.setDataRootAndRelaunch(chosenParent, false)
        if (result.ok) return

        // The app is not relaunching; the gate was never flipped, so we're still on the wizard -
        // surface the error here and let the user retry or fall back to Keep default.
        setIsRelaunching(false)
        onRelaunchErrorChange(result.error ?? 'Could not restart to apply the new location.')
      } catch (error) {
        setIsRelaunching(false)
        onRelaunchErrorChange(
          onboardingErrorMessage(error, 'Could not restart to apply the new location.')
        )
      }
    })
  }

  return (
    <>
      <CardHeader className="gap-1 rounded-t-lg px-4 py-5 sm:px-6">
        <h2 tabIndex={-1} className="text-[15px] font-semibold">
          {t('Where should Open Science store your data?')}
        </h2>
        <CardDescription className="text-xs leading-5">
          {t(
            'Large files (artifacts, notebooks, environments) go here. Your settings and history always stay in the default location. You can change this later in Settings.'
          )}
        </CardDescription>
      </CardHeader>
      <Separator className="bg-border-200" />

      <CardContent className="flex-1 px-4 py-5 sm:px-6">
        <section
          aria-label={t('Choose data location')}
          aria-busy={requestInFlight || isResolvingDefaultLocation}
          className="space-y-5"
        >
          {dataRootError ? (
            <div
              className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive sm:flex-row sm:items-center sm:justify-between"
              role="alert"
            >
              <span>
                {t('Could not load the default data location:')} {dataRootError}
              </span>
              <Button
                type="button"
                variant="link"
                size="xs"
                onClick={onRetryDataRootInfo}
                disabled={requestInFlight}
                className="h-auto self-start p-0 text-destructive hover:text-text-000 sm:self-auto"
              >
                {t('Retry')}
              </Button>
            </div>
          ) : null}

          {relaunchError ? (
            <p
              className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              {t('Could not finish setting up storage:')} {t(relaunchError)}{' '}
              {t('You can retry or keep the default location.')}
            </p>
          ) : null}

          <div className="rounded-xl border border-border-200 p-4">
            <span className="text-xs font-medium text-text-100">{t('Location')}</span>
            <div className="mt-1 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
              <p
                aria-label={t('Data location path')}
                className="min-w-0 flex-1 truncate rounded-lg border border-border-200 bg-bg-000 px-2.5 py-1.5 font-mono text-xs"
              >
                {chosenDataRoot || dataRootInfo?.dataRoot || ''}
              </p>
              <button
                type="button"
                onClick={() => void handleBrowseLocation()}
                disabled={requestInFlight}
                className="inline-flex shrink-0 items-center justify-center rounded-lg border border-border-200 px-3 py-1.5 text-sm font-medium text-text-000 transition-colors hover:bg-bg-10"
              >
                {t('Browse…')}
              </button>
            </div>

            {chosenDataRoot ? (
              <p className="mt-2 text-xs text-text-100">
                {/* Trans keeps the path's mono styling and the reset button inline while letting each
                    locale place them where its own word order needs them. */}
                <Trans
                  i18nKey="Your data will be stored in <path>{{path}}</path>. Open Science will restart to set this up. <reset>Use default location instead</reset>"
                  values={{ path: chosenDataRoot }}
                  components={{
                    path: <span className="font-mono" />,
                    reset: (
                      <button
                        type="button"
                        onClick={handleResetLocation}
                        disabled={requestInFlight}
                        className="underline underline-offset-2 hover:text-text-000"
                      />
                    )
                  }}
                />
              </p>
            ) : null}

            {chosenKind === 'adopt' ? (
              <p className="mt-2 text-xs text-text-100">
                {t(
                  'This folder already contains Open Science data — it will be used as-is (nothing is moved).'
                )}
              </p>
            ) : null}

            {locationError ? (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {locationError}
              </p>
            ) : null}
          </div>

          <DataRootWarning />
        </section>
      </CardContent>
      <CardFooter className="mt-auto justify-end gap-2 rounded-b-lg border-border-200 bg-bg-10 px-4 py-3 sm:px-6">
        <Button type="button" variant="outline" onClick={onBack} disabled={requestInFlight}>
          {t('Back', { context: 'step' })}
        </Button>
        <Button
          type="button"
          onClick={handleContinueLocation}
          disabled={requestInFlight || isLoadingDefaultLocation}
          className="px-4"
        >
          {t('Continue')}
        </Button>
      </CardFooter>

      <AlertDialog.Root open={confirmRestart} onOpenChange={setConfirmRestart}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <AlertDialog.Title className={dialogTitleClassName}>
                  {t('Restart to set up your data?')}
                </AlertDialog.Title>
              </div>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Close')}
                  disabled={requestInFlight}
                  className={dialogCloseButtonClassName}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </AlertDialog.Cancel>
            </div>

            <div className={dialogBodyClassName}>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                <Trans
                  i18nKey="Open Science will restart to set up your data at <path>{{path}}</path>."
                  values={{ path: chosenDataRoot }}
                  components={{ path: <span className="font-mono" /> }}
                />
              </AlertDialog.Description>
            </div>

            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleKeepDefault}
                  disabled={requestInFlight}
                >
                  {t('Keep default')}
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  type="button"
                  onClick={() => void handleRestart()}
                  disabled={requestInFlight}
                >
                  {t('Restart')}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  )
}

export { LocationStep }
export type { LocationDraft }
