import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
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
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import type { ResearchNavigationGroup } from './research-navigation-model'

export const ResearchMembershipDialog = ({
  session,
  research,
  onClose
}: {
  session: ChatSession
  research: readonly ResearchNavigationGroup[]
  onClose: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const selectedResearch = research.find((group) => group.key === selected)
  const assign = async (): Promise<void> => {
    if (!selectedResearch || busy) return
    setBusy(true)
    setFailed(false)
    try {
      const source = selectedResearch.source
      const persisted = await window.api.sessionReplay.setResearchMembership({
        projectId: session.projectId,
        sessionId: session.id,
        expectedRevision: session.revision ?? 0,
        source: {
          projectId: source.sourceProjectId,
          sourceSessionId: source.sourceSessionId,
          importId: source.sourceImportId
        }
      })
      if (useSessionStore.getState().sessions.some((row) => row.id === session.id)) {
        useSessionStore.getState().upsertPersistedSession(persisted)
      }
      onClose()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))] p-0')}
          aria-busy={busy}
        >
          <div className={dialogHeaderClassName}>
            <Dialog.Title className={dialogTitleClassName}>{t('Assign to research')}</Dialog.Title>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('Close')}
              className={dialogCloseButtonClassName}
              disabled={busy}
              onClick={onClose}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div className={dialogBodyClassName}>
            <Dialog.Description className={dialogDescriptionClassName}>
              {t(
                'Choose the research that owns “{{title}}”. Its messages and reading references stay unchanged.',
                { title: session.title }
              )}
            </Dialog.Description>
            <div
              className="mt-4 grid max-h-64 gap-1 overflow-y-auto"
              role="group"
              aria-label={t('Imported research')}
            >
              {research.map((group) => (
                <Button
                  key={group.key}
                  variant={selected === group.key ? 'secondary' : 'ghost'}
                  className="justify-start"
                  aria-pressed={selected === group.key}
                  disabled={busy}
                  onClick={() => setSelected(group.key)}
                >
                  <span className="truncate">{group.session.title}</span>
                </Button>
              ))}
              {research.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('No imported research is available in this project.')}
                </p>
              ) : null}
            </div>
            {failed ? (
              <ErrorNotice
                className="mt-3"
                title={t('Could not update research ownership. Close this dialog and try again.')}
              />
            ) : null}
          </div>
          <div className={dialogFooterClassName}>
            <Button
              variant="outline"
              className={dialogCancelButtonClassName}
              disabled={busy}
              onClick={onClose}
            >
              {t('Cancel')}
            </Button>
            <Button disabled={!selectedResearch || busy} onClick={() => void assign()}>
              {t('Assign to research')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
