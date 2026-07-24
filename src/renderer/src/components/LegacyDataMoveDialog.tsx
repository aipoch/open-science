import { AlertDialog } from 'radix-ui'
import { FolderInput, FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { StorageMigrationModal } from '@/pages/settings/StorageMigrationModal'

type LegacyDataMoveDialogProps = {
  // The hidden config root where a legacy install's data currently lives (e.g. ~/.open-science).
  currentDataRoot: string
  // The parent the "Move to OpenScience" action relocates into; its derived data root (resolved via
  // inspectDataRoot below) is the visible <parent>/OpenScience folder.
  defaultParent: string
  // Called after the user declines and the "don't ask again" flag has been persisted.
  onDismiss: () => void
}

// One-time, non-forced upgrade prompt for a pre-§20 legacy install whose data still sits in the
// hidden config root. Offers to move it into the visible OpenScience folder (default or a folder the
// user picks), or to keep it where it is - the last choice is remembered so it never re-appears.
// Accepting reuses the ordinary relocation flow (StorageMigrationModal): a reversible copy, then a
// restart. Moving sets settings.dataRoot, which by itself disqualifies the prompt on the next launch,
// so only the "keep it here" path needs to persist a dismissal.
const LegacyDataMoveDialog = ({
  currentDataRoot,
  defaultParent,
  onDismiss
}: LegacyDataMoveDialogProps): React.JSX.Element => {
  // When set, hand off to the shared migration modal targeting this parent; null returns to the prompt.
  const [migrationTarget, setMigrationTarget] = useState<string | null>(null)
  // The exact <home>/OpenScience path "Move to OpenScience" would create. Resolved server-side via
  // inspectDataRoot(defaultParent) rather than getInfo's dataRoot, which for a legacy install is the
  // hidden config root itself.
  const [destination, setDestination] = useState<string | undefined>(undefined)
  const [pickError, setPickError] = useState<string | undefined>(undefined)
  const [isPicking, setIsPicking] = useState(false)

  useEffect(() => {
    void window.api.storage.inspectDataRoot(defaultParent).then((result) => {
      setDestination(result.dataRoot)
    })
  }, [defaultParent])

  const handleMoveToDefault = (): void => {
    setPickError(undefined)
    setMigrationTarget(defaultParent)
  }

  const handleChooseFolder = async (): Promise<void> => {
    setPickError(undefined)
    const picked = await window.api.storage.pickDirectory()
    if (!picked) return

    setIsPicking(true)
    try {
      const inspection = await window.api.storage.inspectDataRoot(picked)
      if (inspection.kind === 'move') {
        setMigrationTarget(picked)
        return
      }
      // This prompt only moves data into a fresh location; an 'adopt' target (already holds data)
      // would mean abandoning the legacy data, which isn't what "move it out" should do here.
      setPickError(
        inspection.kind === 'adopt'
          ? 'That folder already contains Open Science data. Pick an empty folder, or use the default location.'
          : (inspection.error ?? 'That folder can’t be used. Pick another one.')
      )
    } finally {
      setIsPicking(false)
    }
  }

  const handleKeepHere = (): void => {
    void window.api.storage.dismissLegacyMovePrompt().finally(() => onDismiss())
  }

  // Accepted a move: the shared modal drives detect → copy → Restart/Keep. Cancelling it returns here.
  if (migrationTarget !== null) {
    return (
      <StorageMigrationModal
        targetPath={migrationTarget}
        onClose={() => setMigrationTarget(null)}
      />
    )
  }

  return (
    <AlertDialog.Root open>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content className={dialogPanelClassName('w-[min(460px,calc(100vw-2rem))]')}>
          <AlertDialog.Title className={dialogTitleClassName}>
            Move your data to a visible folder?
          </AlertDialog.Title>
          <AlertDialog.Description className={dialogDescriptionClassName}>
            Your research data is in a hidden folder. Moving it into a visible OpenScience folder
            makes it easy to find and back up — your settings and history stay where they are.
          </AlertDialog.Description>

          <div className="mt-4 space-y-3">
            <div>
              <span className="text-xs font-medium text-text-100">Current (hidden)</span>
              <pre
                className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-border-200 bg-bg-10 px-2.5 py-1.5 font-mono text-xs text-text-000"
                aria-label="Current data location"
              >
                {currentDataRoot}
              </pre>
            </div>
            <div>
              <span className="text-xs font-medium text-text-100">New location</span>
              <pre
                className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-border-200 bg-bg-10 px-2.5 py-1.5 font-mono text-xs text-text-000"
                aria-label="New data location"
              >
                {destination ?? 'Resolving…'}
              </pre>
            </div>
          </div>

          {pickError ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {pickError}
            </p>
          ) : null}

          <div className="mt-6 flex flex-col gap-2">
            <Button type="button" disabled={isPicking} onClick={handleMoveToDefault}>
              <FolderInput aria-hidden="true" />
              Move to OpenScience
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isPicking}
              onClick={() => void handleChooseFolder()}
            >
              <FolderOpen aria-hidden="true" />
              {isPicking ? 'Checking…' : 'Choose another folder…'}
            </Button>
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="ghost" disabled={isPicking} onClick={handleKeepHere}>
                Keep it in the current folder
              </Button>
            </AlertDialog.Cancel>
            <p className="text-xs text-muted-foreground">
              You can always change this later in Settings → Data location. We won&apos;t ask again.
            </p>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { LegacyDataMoveDialog }
