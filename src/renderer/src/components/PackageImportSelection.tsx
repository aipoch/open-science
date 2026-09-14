import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, FolderPlus, GalleryVerticalEnd, PackageOpen, Plus } from 'lucide-react'
import { ProjectPicker } from '@/components/ProjectPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/error-notice'
import {
  dialogBodyClassName,
  dialogFooterClassName,
  dialogCancelButtonClassName,
  dialogFormInputClassName
} from '@/components/ui/dialog-chrome'
import { PROJECT_NAME_MAX_LENGTH } from '../../../shared/projects'
import { useProjectStore } from '@/stores/project-store'
import {
  formatPackageBytes,
  type PackageOperationSnapshot,
  type SessionPackageImportRequest
} from '../../../shared/session-package'

export const PackageImportSelection = ({
  operation,
  error,
  onCancel,
  onContinue
}: {
  operation: PackageOperationSnapshot
  error?: string
  onCancel: () => void
  onContinue: (target?: SessionPackageImportRequest) => Promise<void>
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { projects, loadProjects, loadError, isLoaded } = useProjectStore()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState('')
  const [name, setName] = useState('')
  const [creatingProject, setCreatingProject] = useState(false)
  const createFormId = useId()
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const wasCreating = useRef(false)
  const [pending, setPending] = useState(false)
  const [localError, setError] = useState<string>()
  const preview = operation.importPreview
  useEffect(() => {
    void loadProjects().catch(() => undefined)
  }, [loadProjects])
  useEffect(() => {
    if (creatingProject) nameRef.current?.focus()
    else if (wasCreating.current) createButtonRef.current?.focus()
    wasCreating.current = creatingProject
  }, [creatingProject])
  const available = projects.filter((project) => project.archivedAt === undefined)
  const selectedProject = available.find((project) => project.id === selected)
  const destination = projects.find((project) => project.id === operation.importTarget?.projectId)
  const create = async (): Promise<void> => {
    if (pending || !name.trim()) return
    setPending(true)
    setError(undefined)
    try {
      await onContinue({ projectName: name.trim() })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <div
        className={`${dialogBodyClassName} min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]`}
      >
        {preview ? (
          <>
            {preview.title ? (
              <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-4">
                <PackageOpen className="size-6 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0 space-y-1">
                  <p className="break-words text-sm font-medium">{preview.title}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t('{{branches}} branches · {{messages}} messages · {{files}} files', {
                      branches: preview.branchCount,
                      messages: preview.messageCount,
                      files: preview.fileCount
                    })}
                  </p>
                </div>
              </div>
            ) : null}
            <dl className="space-y-3 text-sm">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">{t('Destination project')}</dt>
                <dd className="flex min-w-0 items-center gap-2 text-right font-medium">
                  <GalleryVerticalEnd
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="break-words">
                    {destination?.name ?? operation.importTarget?.projectName ?? t('New project')}
                  </span>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">{t('Uncompressed content')}</dt>
                <dd className="shrink-0 font-medium tabular-nums">
                  {formatPackageBytes(preview.totalBytes)}
                </dd>
              </div>
            </dl>
            {!preview.title ? (
              <p className="text-xs text-muted-foreground">
                {t('{{branches}} branches · {{messages}} messages · {{files}} files', {
                  branches: preview.branchCount,
                  messages: preview.messageCount,
                  files: preview.fileCount
                })}
              </p>
            ) : null}
            {preview.omissions.length ? (
              <details className="border-t border-border pt-4 text-sm">
                <summary className="w-fit cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-ring">
                  {t('Not included ({{total}})', { total: preview.omissions.length })}
                </summary>
                <ul className="mt-3 space-y-3 text-xs leading-relaxed text-muted-foreground">
                  {preview.omissions.map((item, index) => (
                    <li className="break-words" key={index}>
                      {item.description ===
                      'Account credentials, permission grants and provider continuation identities are excluded.'
                        ? t(
                            'Account credentials, permission grants and provider continuation identities are excluded.'
                          )
                        : item.description ===
                            'Files left on remote Compute hosts are not included.'
                          ? t('Files left on remote Compute hosts are not included.')
                          : item.description ===
                              'Some protected Compute evidence could not be decrypted on this computer.'
                            ? t(
                                'Some protected Compute evidence could not be decrypted on this computer.'
                              )
                            : item.description}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : creatingProject ? (
          <form
            id={createFormId}
            className="space-y-5"
            aria-busy={pending}
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <div className="flex items-center gap-2 pt-1">
              <FolderPlus className="size-5 text-muted-foreground" aria-hidden="true" />
              <h3 className="text-base font-semibold">{t('New project')}</h3>
            </div>
            <div className="space-y-2">
              <label htmlFor={`${createFormId}-name`} className="block text-sm font-medium">
                {t('Project name')}
              </label>
              <Input
                ref={nameRef}
                id={`${createFormId}-name`}
                value={name}
                maxLength={PROJECT_NAME_MAX_LENGTH}
                disabled={pending}
                aria-required
                aria-invalid={Boolean(localError)}
                onChange={(event) => {
                  setName(event.target.value)
                  setError(undefined)
                }}
                className={`${dialogFormInputClassName} h-9 px-3 text-sm`}
              />
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {t('Created when you confirm the import.')}
            </p>
          </form>
        ) : (
          <>
            <ProjectPicker
              projects={available}
              query={search}
              onQueryChange={setSearch}
              selectedId={selected}
              onSelect={setSelected}
              label={t('Destination project')}
              headerAction={
                <Button
                  ref={createButtonRef}
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5 text-xs"
                  disabled={pending}
                  onClick={() => {
                    setError(undefined)
                    setCreatingProject(true)
                  }}
                >
                  <Plus className="size-4 shrink-0" aria-hidden="true" />
                  {t('New project')}
                </Button>
              }
              loaded={isLoaded}
              disabled={pending}
              alwaysShowSearch
              emptyContent={
                <p className="text-sm text-muted-foreground">
                  {t('Create a project to import this Session.')}
                </p>
              }
            />
          </>
        )}
        {error || localError || loadError ? (
          <ErrorNotice
            className="border-0 bg-transparent p-0 [&_[role=alert]]:basis-0"
            role="alert"
            tone="amber"
            description={error ?? localError ?? loadError}
          />
        ) : null}
      </div>
      <div className={`${dialogFooterClassName} shrink-0 flex-wrap`}>
        {creatingProject && !preview ? (
          <>
            <Button
              variant="ghost"
              className={dialogCancelButtonClassName}
              disabled={pending}
              onClick={() => {
                setCreatingProject(false)
                setError(undefined)
              }}
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              {t('Back')}
            </Button>
            <Button type="submit" form={createFormId} disabled={pending || !name.trim()}>
              {t('Continue')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              className={dialogCancelButtonClassName}
              disabled={pending}
              onClick={onCancel}
            >
              {t('Cancel')}
            </Button>
            <Button
              disabled={pending || (!preview && !selectedProject)}
              onClick={() => {
                setPending(true)
                void onContinue(preview ? undefined : { projectId: selected }).finally(() =>
                  setPending(false)
                )
              }}
            >
              {preview ? t('Import') : t('Continue')}
            </Button>
          </>
        )}
      </div>
    </>
  )
}
