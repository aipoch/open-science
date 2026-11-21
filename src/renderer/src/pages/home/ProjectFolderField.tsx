import { useRef, useState } from 'react'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { Cloud, Folder, FolderOpen, HardDrive } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ProjectFolderNotice } from '@/components/ProjectFolderNotice'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { dialogFormHelpClassName, dialogFormLabelClassName } from '@/components/ui/dialog-chrome'
import type { ProjectFolderForm } from '@/lib/project-folder'

// Creation is the only binding surface. Project settings expose the saved location read-only.
export const ProjectFolderField = ({
  folder,
  disabled
}: {
  folder: ProjectFolderForm
  disabled: boolean
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [confirmOutputs, setConfirmOutputs] = useState(false)
  const outputCheckbox = useRef<HTMLInputElement>(null)
  if (folder.mode === 'edit' && !folder.path) return null
  const busy = disabled || folder.isBusy
  return (
    <section className="space-y-2" aria-labelledby="project-folder-label" aria-busy={folder.isBusy}>
      <h3 id="project-folder-label" className={dialogFormLabelClassName}>
        {t('Project folder')}
      </h3>
      {folder.mode === 'create' ? (
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="sr-only">{t('Project folder')}</legend>
          {(['managed', 'folder'] as const).map((storage) => (
            <label
              key={storage}
              className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm ${folder.storage === storage ? 'border-primary bg-primary/5' : 'border-border'} ${storage === 'folder' && !folder.canSelect ? 'opacity-60' : 'cursor-pointer'}`}
            >
              <input
                type="radio"
                name="project-storage"
                value={storage}
                checked={folder.storage === storage}
                disabled={storage === 'folder' && !folder.canSelect}
                onChange={() => folder.onStorageChange(storage)}
                className="size-3.5 accent-primary"
              />
              <span>
                {storage === 'managed'
                  ? t('Managed by Open Science')
                  : t('A folder on this computer')}
                {storage === 'folder' && !folder.canSelect ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t('Available in the desktop app')}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {folder.storage === 'folder' ? (
        <>
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
            <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 break-all font-mono text-xs">
              {folder.path || t('No folder selected')}
            </span>
            {folder.mode === 'create' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || !folder.canSelect}
                onClick={folder.onChoose}
              >
                {folder.isBusy ? t('Checking…') : t('Choose…')}
              </Button>
            ) : null}
          </div>
          {folder.mode === 'create' ? (
            <p className={dialogFormHelpClassName}>
              {t('Use your existing data and save results in this folder.')}
              <span className="mt-1 block">
                {t(
                  'New projects use session folders for published files and generated Notebook outputs and require project records version 2. Existing projects keep their layout.'
                )}
              </span>
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
          {folder.mode === 'edit' && folder.outputLayout ? (
            <div className="space-y-2 border-t border-border pt-3">
              <h4 className={dialogFormLabelClassName}>{t('Session outputs')}</h4>
              <p className={dialogFormHelpClassName}>
                {t(
                  'Future published files and generated Notebook outputs use separate folders for each session. Existing files stay in place.'
                )}
              </p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {'artifacts/<projectId>/<sessionId>/'}
                <br />
                {'notebooks/<projectId>/<sessionId>/data/'}
              </p>
              {folder.outputLayout === 'session-v1' ? (
                <p className="text-sm text-muted-foreground">{t('Session outputs enabled')}</p>
              ) : (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    ref={outputCheckbox}
                    type="checkbox"
                    checked={Boolean(folder.enableSessionOutputs)}
                    disabled={busy}
                    onChange={(event) => {
                      if (event.target.checked) setConfirmOutputs(true)
                      else folder.onEnableSessionOutputsChange?.(false)
                    }}
                  />
                  {t('Enable session outputs when saving')}
                </label>
              )}
              <ConfirmActionDialog
                open={confirmOutputs && folder.outputLayout === 'legacy'}
                title={t('Enable session outputs?')}
                description={t(
                  'This upgrades project records. Older clients that support only version 1 cannot open this project. Finish or stop running work before saving. Existing files and saved versions stay in place; future outputs from every session use session folders. Managed undo backups remain on this computer. Native code using a bare relative output path still follows its working directory.'
                )}
                cancelLabel={t('Cancel')}
                confirmLabel={t('Enable session outputs')}
                onCloseAutoFocus={(event) => {
                  if (!outputCheckbox.current?.isConnected) return
                  event.preventDefault()
                  outputCheckbox.current.focus({ preventScroll: true })
                }}
                onCancel={() => setConfirmOutputs(false)}
                onConfirm={() => {
                  folder.onEnableSessionOutputsChange?.(true)
                  setConfirmOutputs(false)
                }}
              />
            </div>
          ) : null}
          {folder.validation?.ok ? (
            folder.validation.warnings?.map((warning) => (
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
          ) : folder.validation ? (
            <ProjectFolderNotice problem={folder.validation} />
          ) : null}
        </>
      ) : null}
    </section>
  )
}
