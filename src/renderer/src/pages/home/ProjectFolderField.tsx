import { useRef } from 'react'
import { Cloud, Folder, FolderOpen, HardDrive } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ProjectFolderNotice } from '@/components/ProjectFolderNotice'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { dialogFormHelpClassName, dialogFormLabelClassName } from '@/components/ui/dialog-chrome'
import type { ProjectFolderForm } from '@/lib/project-folder'
import { cn } from '@/lib/utils'

// Creation is the only binding surface. Project settings expose the saved location read-only.
export const ProjectFolderField = ({
  folder,
  disabled
}: {
  folder: ProjectFolderForm
  disabled: boolean
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const chooseButton = useRef<HTMLButtonElement>(null)
  if (folder.mode === 'edit' && !folder.path) return null
  const busy = disabled || folder.isBusy
  const isCreate = folder.mode === 'create'
  const isCustom = folder.storage === 'folder'
  return (
    <section className="space-y-2" aria-labelledby="project-folder-label" aria-busy={folder.isBusy}>
      <h3 id="project-folder-label" className={dialogFormLabelClassName}>
        {isCreate ? t('Project file location') : t('Project folder')}
      </h3>
      {isCreate ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/50 px-3 py-2">
          <div
            aria-live="polite"
            className={cn(
              'flex min-w-0 items-center gap-2',
              isCustom ? 'w-full' : 'flex-[1_1_10rem]'
            )}
          >
            <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {isCustom ? (
              <span className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">
                {folder.path || t('No folder selected')}
              </span>
            ) : (
              <span className="min-w-0 text-sm font-medium">{t('Default data location')}</span>
            )}
          </div>
          <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1">
            {isCustom ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto min-h-7 max-w-full px-2 py-1 whitespace-normal text-muted-foreground"
                disabled={disabled}
                onClick={() => {
                  folder.onUseAppStorage()
                  chooseButton.current?.focus()
                }}
              >
                {t('Use app storage')}
              </Button>
            ) : null}
            <Button
              ref={chooseButton}
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto min-h-7 max-w-full px-2 py-1 whitespace-normal text-primary aria-disabled:opacity-60"
              disabled={disabled || !folder.canSelect}
              aria-disabled={folder.isBusy || undefined}
              aria-describedby={!folder.canSelect ? 'project-folder-desktop-only' : undefined}
              onClick={folder.onChoose}
            >
              {folder.isBusy
                ? t('Checking…')
                : isCustom
                  ? t('Change folder…')
                  : t('Choose folder…')}
            </Button>
          </div>
        </div>
      ) : isCustom ? (
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-all font-mono text-xs">{folder.path}</span>
        </div>
      ) : null}
      {isCreate && !folder.canSelect ? (
        <p id="project-folder-desktop-only" className={dialogFormHelpClassName}>
          {t('Available in the desktop app')}
        </p>
      ) : null}
      {isCustom ? (
        <>
          {isCreate ? (
            <p className={dialogFormHelpClassName}>
              {t('Use your existing data and save results in this folder.')}
            </p>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !folder.canSelect}
              onClick={folder.onReveal}
            >
              <FolderOpen className="size-4" aria-hidden="true" />
              {window.api.platform === 'darwin' ? t('Reveal in Finder') : t('Reveal in folder')}
            </Button>
          )}
        </>
      ) : null}
      {folder.validation?.ok
        ? folder.validation.warnings?.map((warning) => (
            <ErrorNotice
              key={warning}
              level="warning"
              role="note"
              icon={warning === 'cloud-synced' ? Cloud : HardDrive}
              title={
                warning === 'cloud-synced'
                  ? t('Cloud-synced folder')
                  : warning === 'removable'
                    ? t('Removable drive')
                    : t('Network location')
              }
              description={
                warning === 'cloud-synced'
                  ? t('Changes may sync to other devices.')
                  : warning === 'removable'
                    ? t('Keep this drive connected while working.')
                    : t('Keep this location connected while working.')
              }
            />
          ))
        : folder.validation && <ProjectFolderNotice problem={folder.validation} />}
    </section>
  )
}
