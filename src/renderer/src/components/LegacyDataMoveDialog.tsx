import { AlertDialog } from 'radix-ui'
import { FolderInput, FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

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
import { StorageMigrationModal } from '@/pages/settings/StorageMigrationModal'
import type { DataRootInspection, DataRootRecoveryStatus } from '../../../shared/storage'

type LegacyDataMoveDialogProps = {
  // App Shell presentation ownership may temporarily cover this prompt without discarding its state.
  active?: boolean
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
  active = true,
  currentDataRoot,
  defaultParent,
  onDismiss
}: LegacyDataMoveDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  // When set, hand off to the shared migration modal targeting this parent; a durable interrupted
  // copy carries its recovery status so the modal resumes instead of recopying.
  const [migrationTarget, setMigrationTarget] = useState<{
    path: string
    recoveryStatus?: DataRootRecoveryStatus
  } | null>(null)
  // The exact <home>/OpenScience path "Move to OpenScience" would create. Resolved server-side via
  // inspectDataRoot(defaultParent) rather than getInfo's dataRoot, which for a legacy install is the
  // hidden config root itself.
  const [defaultInspectionState, setDefaultInspectionState] = useState<
    { parent: string; result: DataRootInspection } | undefined
  >(undefined)
  const defaultInspection =
    defaultInspectionState?.parent === defaultParent ? defaultInspectionState.result : undefined
  const [pickError, setPickError] = useState<string | undefined>(undefined)
  const [isPicking, setIsPicking] = useState(false)

  useEffect(() => {
    void window.api.storage.inspectDataRoot(defaultParent).then((result) => {
      setDefaultInspectionState({ parent: defaultParent, result })
    })
  }, [defaultParent])

  const refreshDefaultDestination = (): void => {
    setDefaultInspectionState(undefined)
    void window.api.storage.inspectDataRoot(defaultParent).then((result) => {
      setDefaultInspectionState({ parent: defaultParent, result })
    })
  }

  const handleMigrationClose = (): void => {
    const resolvedTarget = migrationTarget
    setMigrationTarget(null)
    if (resolvedTarget?.path === defaultParent) {
      refreshDefaultDestination()
    }
  }

  const handleMoveToDefault = (): void => {
    setPickError(undefined)
    if (!defaultInspection) return
    if (defaultInspection.kind === 'move' || defaultInspection.kind === 'recover') {
      setMigrationTarget({
        path: defaultParent,
        recoveryStatus:
          defaultInspection.kind === 'recover' ? defaultInspection.recoveryStatus : undefined
      })
      return
    }
    setPickError(
      defaultInspection.kind === 'adopt'
        ? t(
            'That folder already contains Open Science data. Pick an empty folder, or use the default location.'
          )
        : (defaultInspection.error ?? t('That folder can’t be used. Pick another one.'))
    )
  }

  const handleChooseFolder = async (): Promise<void> => {
    setPickError(undefined)
    const picked = await window.api.storage.pickDirectory()
    if (!picked) return

    setIsPicking(true)
    try {
      const inspection = await window.api.storage.inspectDataRoot(picked)
      if (inspection.kind === 'move' || inspection.kind === 'recover') {
        setMigrationTarget({
          path: picked,
          recoveryStatus: inspection.kind === 'recover' ? inspection.recoveryStatus : undefined
        })
        return
      }
      // This prompt moves data into a fresh location or resumes the same interrupted move. An
      // 'adopt' target (already holds unrelated data) would mean abandoning the legacy data, which
      // isn't what "move it out" should do here.
      setPickError(
        inspection.kind === 'adopt'
          ? t(
              'That folder already contains Open Science data. Pick an empty folder, or use the default location.'
            )
          : (inspection.error ?? t('That folder can’t be used. Pick another one.'))
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
        active={active}
        targetPath={migrationTarget.path}
        recoveryStatus={migrationTarget.recoveryStatus}
        onClose={handleMigrationClose}
      />
    )
  }

  return (
    <AlertDialog.Root open={active}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(460px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <AlertDialog.Title className={dialogTitleClassName}>
              {t('Move your data to a visible folder?')}
            </AlertDialog.Title>
          </div>

          <div className={cn(dialogBodyClassName, 'space-y-4')}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {t(
                'Your research data is in a hidden folder. Moving it into a visible OpenScience folder makes it easy to find and back up — your settings and history stay where they are.'
              )}
            </AlertDialog.Description>
            <div>
              <span className="text-xs font-medium text-text-100">{t('Current (hidden)')}</span>
              <pre
                className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-border-200 bg-bg-10 px-2.5 py-1.5 font-mono text-xs text-text-000"
                aria-label={t('Current data location')}
              >
                {currentDataRoot}
              </pre>
            </div>
            <div>
              <span className="text-xs font-medium text-text-100">{t('New location')}</span>
              <pre
                className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-border-200 bg-bg-10 px-2.5 py-1.5 font-mono text-xs text-text-000"
                aria-label={t('New data location')}
              >
                {defaultInspection?.dataRoot ?? t('Resolving…')}
              </pre>
            </div>

            {pickError ? (
              <p className="text-xs text-destructive" role="alert">
                {pickError}
              </p>
            ) : null}
          </div>

          <div className={cn(dialogFooterClassName, 'flex-col items-stretch')}>
            <Button
              type="button"
              disabled={isPicking || defaultInspection === undefined}
              onClick={handleMoveToDefault}
            >
              <FolderInput aria-hidden="true" />
              {t('Move to OpenScience')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isPicking}
              onClick={() => void handleChooseFolder()}
            >
              <FolderOpen aria-hidden="true" />
              {isPicking ? t('Checking…') : t('Choose another folder…')}
            </Button>
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="ghost" disabled={isPicking} onClick={handleKeepHere}>
                {t('Keep it in the current folder')}
              </Button>
            </AlertDialog.Cancel>
            <p className="text-xs text-muted-foreground">
              {t(
                "You can always change this later in Settings → Data location. We won't ask again."
              )}
            </p>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { LegacyDataMoveDialog }
