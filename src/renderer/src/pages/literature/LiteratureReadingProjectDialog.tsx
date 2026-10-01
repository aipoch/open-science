import { ProjectPicker } from '@/components/ProjectPicker'
import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogBodyClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useProjectFormDialog } from '@/hooks/useProjectFormDialog'
import { cn } from '@/lib/utils'
import type { PdfReadingDocument } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { FolderPlus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LiteratureItemView } from '../../../../shared/literature'

export function LiteratureReadingProjectDialog({
  pendingLiteratureReading,
  readingProjectFormDialog,
  startingReadingProjectId,
  setReadingProjectQuery,
  setPendingLiteratureReading,
  setReadingProjectError,
  readingProjectError,
  readingSelectionEntries,
  setBatchReading,
  projectsLoaded,
  activeProjects,
  readingProjectQuery,
  startReadingInProject
}: {
  pendingLiteratureReading: readonly PdfReadingDocument[] | undefined
  readingProjectFormDialog: ReturnType<typeof useProjectFormDialog>
  startingReadingProjectId: string | undefined
  setReadingProjectQuery: React.Dispatch<React.SetStateAction<string>>
  setPendingLiteratureReading: React.Dispatch<
    React.SetStateAction<readonly PdfReadingDocument[] | undefined>
  >
  setReadingProjectError: React.Dispatch<React.SetStateAction<string | undefined>>
  readingProjectError: string | undefined
  readingSelectionEntries: LiteratureItemView[] | undefined
  setBatchReading: React.Dispatch<
    React.SetStateAction<{ entries?: LiteratureItemView[]; error?: string } | undefined>
  >
  projectsLoaded: boolean
  activeProjects: ReturnType<typeof useProjectStore.getState>['projects']
  readingProjectQuery: string
  startReadingInProject: (
    targetProjectId: string,
    reading?: readonly PdfReadingDocument[] | undefined
  ) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog.Root
      open={Boolean(pendingLiteratureReading) && !readingProjectFormDialog.dialogProps.open}
      onOpenChange={(open) => {
        if (open || startingReadingProjectId) return
        setReadingProjectQuery('')
        setPendingLiteratureReading(undefined)
        setReadingProjectError(undefined)
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[calc(100svh-2rem)] w-[min(440px,calc(100vw-2rem))] flex-col p-0'
          )}
        >
          <div className={cn(dialogHeaderClassName, 'shrink-0')}>
            <div>
              <Dialog.Title className={dialogTitleClassName}>{t('Read with agent')}</Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                {t('Choose a project for this Reading session.')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Close')}
                disabled={Boolean(startingReadingProjectId)}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <ScrollArea className="grid min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:h-auto [&>[data-slot=scroll-area-viewport]]:min-h-0">
            <div className={dialogBodyClassName}>
              {readingProjectError ? (
                <div className="mb-3">
                  <p role="alert" className="text-sm text-danger-000">
                    {readingProjectError}
                  </p>
                  {readingSelectionEntries ? (
                    <Button
                      className="mt-2"
                      variant="outline"
                      size="sm"
                      disabled={Boolean(startingReadingProjectId)}
                      onClick={() => {
                        setPendingLiteratureReading(undefined)
                        setReadingProjectError(undefined)
                        setBatchReading({ entries: readingSelectionEntries })
                      }}
                    >
                      {t('Back')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {projectsLoaded ? (
                activeProjects.length > 0 ? (
                  <ProjectPicker
                    projects={activeProjects}
                    query={readingProjectQuery}
                    onQueryChange={setReadingProjectQuery}
                    disabled={Boolean(startingReadingProjectId)}
                    pendingId={startingReadingProjectId}
                    onSelect={(id) => void startReadingInProject(id)}
                  />
                ) : (
                  <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border-300/80 bg-bg-100 p-4">
                    <FolderPlus className="size-5 text-muted-foreground" aria-hidden="true" />
                    <div>
                      <h3 className="text-sm font-medium">{t('No projects yet')}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {pendingLiteratureReading && pendingLiteratureReading.length > 1
                          ? t(
                              'Create a project to keep these papers and their Reading session together.'
                            )
                          : t(
                              'Create a project to keep this paper and its Reading session together.'
                            )}
                      </p>
                    </div>
                    <Button
                      type="button"
                      disabled={Boolean(startingReadingProjectId)}
                      onClick={readingProjectFormDialog.openCreateDialog}
                    >
                      <FolderPlus className="size-4" aria-hidden="true" />
                      {t('Create project')}
                    </Button>
                  </div>
                )
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  {t('Loading…')}
                </p>
              )}
            </div>
          </ScrollArea>
          {projectsLoaded && activeProjects.length > 0 ? (
            <div
              className={`${dialogFooterClassName} shrink-0 flex-wrap items-center [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:h-auto [&_button]:min-h-8 [&_button]:py-1`}
            >
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(startingReadingProjectId)}
                onClick={readingProjectFormDialog.openCreateDialog}
              >
                <FolderPlus className="size-4" aria-hidden="true" />
                {t('New project')}
              </Button>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
