import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
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
import { useLiteratureHost, type LiteratureProject } from '../renderer-host'

/** Only chooses the destination Project. The ordinary Composer owns the user's question. */
export function LiteratureScopeProjectDialog({
  collection,
  projects,
  projectsLoaded,
  onClose,
  onSelectProject
}: {
  collection: { id: string; name: string }
  projects: LiteratureProject[]
  projectsLoaded: boolean
  onClose: () => void
  onSelectProject: (projectId: string) => boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { useProjectFormDialog } = useLiteratureHost()
  const [query, setQuery] = useState('')
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const selectProject = (id: string): void => {
    if (active.current && onSelectProject(id)) onClose()
  }
  const projectForm = useProjectFormDialog({ onCreated: (created) => selectProject(created.id) })
  return (
    <>
      <Dialog.Root open={!projectForm.isOpen} onOpenChange={(open) => !open && onClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))] p-0')}>
            <div className={dialogHeaderClassName}>
              <div>
                <Dialog.Title className={dialogTitleClassName}>
                  {t('Ask about this collection')}
                </Dialog.Title>
                <Dialog.Description className={dialogDescriptionClassName}>
                  {t('Choose a project for this conversation.')}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Close')}>
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </Dialog.Close>
            </div>
            <div className={dialogBodyClassName}>
              <p className="mb-3 text-sm text-muted-foreground">
                {t('Scope')}: {collection.name}
              </p>
              <ProjectPicker
                projects={projects}
                loaded={projectsLoaded}
                query={query}
                onQueryChange={setQuery}
                onSelect={selectProject}
              />
            </div>
            <div className={dialogFooterClassName}>
              <Button type="button" variant="outline" onClick={projectForm.openCreateDialog}>
                {t('New project')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {projectForm.dialog}
    </>
  )
}
