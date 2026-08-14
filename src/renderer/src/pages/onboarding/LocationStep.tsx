import { X } from 'lucide-react'
import { AlertDialog } from 'radix-ui'
import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
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
import { useSettingsStore } from '@/stores/settings-store'
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
  onBack: () => void
  // Relaunch replaces the whole wizard with a bare "Setting up…" screen, so the flag lives in the
  // shell and this step only reports it.
  setIsRelaunching: (value: boolean) => void
}

type LocationDraft = {
  chosenParent: string
  chosenDataRoot: string
  chosenKind: 'move' | 'adopt' | null
}
// Final step (doubles as Finish): pick where large data lives, then either completeOnboarding
// (default kept) or confirm a restart that applies the new root. Only `dataRoot` is ever touched
// here — the config root (settings, sessions, db, claude, skills) always stays at its fixed default.
const LocationStep = ({
  dataRootInfo,
  dataRootError,
  locationDraft,
  onLocationDraftChange,
  relaunchError,
  onRelaunchErrorChange,
  onRetryDataRootInfo,
  onBack,
  setIsRelaunching
}: LocationStepProps): React.JSX.Element => {
  const completeOnboarding = useSettingsStore((state) => state.completeOnboarding)
  const { chosenParent, chosenDataRoot, chosenKind } = locationDraft
  const [locationError, setLocationError] = useState<string | undefined>(undefined)
  const [confirmRestart, setConfirmRestart] = useState(false)
  // Guards against handleKeepDefault's completeOnboarding firing spuriously after Restart:
  // AlertDialog.Action fires onOpenChange(false) on click (same as Cancel), and closures inside
  // that handler can't see isRelaunching's update from the same synchronous batch, so a ref is
  // used instead of state for this check.
  const isRestartingRef = useRef(false)

  const handleBrowseLocation = async (): Promise<void> => {
    const picked = await window.api.storage.pickDirectory()
    if (!picked) return

    const result = await window.api.storage.inspectDataRoot(picked)
    if (result.kind === 'invalid') {
      setLocationError(result.error)
      return
    }

    onLocationDraftChange({
      chosenParent: picked,
      chosenDataRoot: result.dataRoot,
      chosenKind: result.kind
    })
    onRelaunchErrorChange(undefined)
    setLocationError(undefined)
  }

  const handleResetLocation = (): void => {
    onLocationDraftChange({ chosenParent: '', chosenDataRoot: '', chosenKind: null })
    onRelaunchErrorChange(undefined)
    setLocationError(undefined)
  }

  const completeWithDefaultLocation = async (): Promise<void> => {
    onRelaunchErrorChange(undefined)
    try {
      await completeOnboarding()
    } catch (error) {
      onRelaunchErrorChange(
        onboardingErrorMessage(error, 'Could not finish setup with the default data location.')
      )
    }
  }

  const handleFinishLocation = async (): Promise<void> => {
    if (chosenParent) {
      // A custom location was chosen: gate completeOnboarding behind the user's confirmation.
      // Calling completeOnboarding immediately would flip the App-level startup gate to 'app'
      // and unmount this wizard (and this confirm dialog) before it could ever be shown.
      setConfirmRestart(true)
    } else {
      // Default kept: nothing more to do, the App gate takes it from here — no relaunch.
      await completeWithDefaultLocation()
    }
  }

  const handleKeepDefault = async (): Promise<void> => {
    // AlertDialog.Action also fires onOpenChange(false) on click (it closes the dialog like Cancel
    // does), which would otherwise call this a second time right after handleRestart. A ref (not
    // isRelaunching state) is required here: both handlers run synchronously in the same click
    // event, so a state-based check would still read the pre-update closure value.
    if (isRestartingRef.current) return

    setConfirmRestart(false)
    await completeWithDefaultLocation()
  }

  const handleRestart = async (): Promise<void> => {
    isRestartingRef.current = true
    setConfirmRestart(false)
    onRelaunchErrorChange(undefined)
    setIsRelaunching(true)

    // Deliberately NOT calling the renderer completeOnboarding() here: it flips
    // onboardingCompletedAt immediately, which would make App.tsx's startup gate swap this
    // wizard for Home (showing the OLD data root) before setDataRootAndRelaunch even runs, and
    // would turn the failure branch below into dead code. Instead the main-process handler marks
    // onboarding complete itself, in the same step as setDataRoot, right before it relaunches -
    // so the gate only flips once the new location is actually persisted.
    try {
      const result = await window.api.storage.setDataRootAndRelaunch(chosenParent, true)
      if (result.ok) return

      // The app is not relaunching; the gate was never flipped, so we're still on the wizard -
      // surface the error here and let the user retry or fall back to Keep default.
      isRestartingRef.current = false
      setIsRelaunching(false)
      onRelaunchErrorChange(result.error ?? 'Could not restart to apply the new location.')
    } catch (error) {
      isRestartingRef.current = false
      setIsRelaunching(false)
      onRelaunchErrorChange(
        onboardingErrorMessage(error, 'Could not restart to apply the new location.')
      )
    }
  }

  return (
    <>
      <CardHeader className="gap-1 rounded-t-lg px-4 py-5 sm:px-6">
        <CardTitle className="text-[15px] font-semibold">
          Where should Open Science store your data?
        </CardTitle>
        <CardDescription className="text-xs leading-5">
          Large files (artifacts, notebooks, environments) go here. Your settings and history always
          stay in the default location. You can change this later in Settings.
        </CardDescription>
      </CardHeader>
      <Separator className="bg-border-200" />

      <CardContent className="flex-1 px-4 py-5 sm:px-6">
        <section aria-label="Choose data location" className="space-y-5">
          {dataRootError ? (
            <div
              className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive sm:flex-row sm:items-center sm:justify-between"
              role="alert"
            >
              <span>Could not load the default data location: {dataRootError}</span>
              <Button
                type="button"
                variant="link"
                size="xs"
                onClick={onRetryDataRootInfo}
                className="h-auto self-start p-0 text-destructive hover:text-text-000 sm:self-auto"
              >
                Retry
              </Button>
            </div>
          ) : null}

          {relaunchError ? (
            <p
              className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              Could not finish setting up storage: {relaunchError} You can retry or keep the default
              location.
            </p>
          ) : null}

          <div className="rounded-xl border border-border-200 p-4">
            <span className="text-xs font-medium text-text-100">Location</span>
            <div className="mt-1 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
              <p
                aria-label="Data location path"
                className="min-w-0 flex-1 truncate rounded-lg border border-border-200 bg-bg-000 px-2.5 py-1.5 font-mono text-xs"
              >
                {chosenDataRoot || dataRootInfo?.dataRoot || ''}
              </p>
              <button
                type="button"
                onClick={() => void handleBrowseLocation()}
                className="inline-flex shrink-0 items-center justify-center rounded-lg border border-border-200 px-3 py-1.5 text-sm font-medium text-text-000 transition-colors hover:bg-bg-10"
              >
                Browse…
              </button>
            </div>

            {chosenDataRoot ? (
              <p className="mt-2 text-xs text-text-100">
                Your data will be stored in <span className="font-mono">{chosenDataRoot}</span>.
                Open Science will restart to set this up.{' '}
                <button
                  type="button"
                  onClick={handleResetLocation}
                  className="underline underline-offset-2 hover:text-text-000"
                >
                  Use default location instead
                </button>
              </p>
            ) : null}

            {chosenKind === 'adopt' ? (
              <p className="mt-2 text-xs text-text-100">
                This folder already contains Open Science data — it will be used as-is (nothing is
                moved).
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
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={() => void handleFinishLocation()} className="px-4">
          Finish
        </Button>
      </CardFooter>

      <AlertDialog.Root
        open={confirmRestart}
        onOpenChange={(open) => {
          if (!open) void handleKeepDefault()
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <AlertDialog.Title className={dialogTitleClassName}>
                  Restart to set up your data?
                </AlertDialog.Title>
              </div>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  className={dialogCloseButtonClassName}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </AlertDialog.Cancel>
            </div>

            <div className={dialogBodyClassName}>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                Open Science will restart to set up your data at{' '}
                <span className="font-mono">{chosenDataRoot}</span>.
              </AlertDialog.Description>
            </div>

            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline">
                  Keep default
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button type="button" onClick={() => void handleRestart()}>
                  Restart
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
