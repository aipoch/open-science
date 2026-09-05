import { ChevronDown, FolderOpen, FolderPlus, LoaderCircle, Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const SEARCH_THRESHOLD = 5

type Destination = Readonly<{
  id: string
  name: string
}>

const destinationButtonClassName =
  'flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none transition-colors duration-150 hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'

const LiteratureBatchDestinationMenus = ({
  collections,
  disabled,
  moveBetweenCollections,
  onCreateCollection,
  onCreateProject,
  onSelectCollection,
  onSelectProject,
  projects,
  projectsLoaded
}: Readonly<{
  collections: readonly Destination[]
  disabled: boolean
  moveBetweenCollections: boolean
  onCreateCollection: (name: string) => Promise<boolean>
  onCreateProject: () => void
  onSelectCollection: (id: string) => void
  onSelectProject: (id: string) => void
  projects: readonly Destination[]
  projectsLoaded: boolean
}>): React.JSX.Element => {
  const { t } = useTranslation()
  const [collectionCreateMode, setCollectionCreateMode] = useState(false)
  const [collectionName, setCollectionName] = useState('')
  const [projectQuery, setProjectQuery] = useState('')
  const normalizedProjectQuery =
    projects.length > SEARCH_THRESHOLD ? projectQuery.trim().toLocaleLowerCase() : ''
  const visibleProjects = normalizedProjectQuery
    ? projects.filter((project) =>
        project.name.toLocaleLowerCase().includes(normalizedProjectQuery)
      )
    : projects

  return (
    <>
      <Popover
        onOpenChange={(open) => {
          if (!open) {
            setCollectionCreateMode(false)
            setCollectionName('')
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            aria-label={moveBetweenCollections ? t('Move to collection') : t('Add to collection')}
            disabled={disabled}
          >
            <FolderOpen className="size-3.5" aria-hidden="true" />
            {moveBetweenCollections ? t('Move to collection') : t('Add to collection')}
            <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          data-slot="literature-batch-collection-popover"
          align="start"
          sideOffset={6}
          className="w-72 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-menu"
        >
          <div className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">
            {t('Collections')}
          </div>
          {collections.length > 0 ? (
            <div className="max-h-56 overflow-y-auto">
              {collections.map((collection) => (
                <PopoverClose key={collection.id} asChild>
                  <button
                    type="button"
                    disabled={disabled}
                    className={destinationButtonClassName}
                    onClick={() => onSelectCollection(collection.id)}
                  >
                    <FolderOpen
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                  </button>
                </PopoverClose>
              ))}
            </div>
          ) : (
            <div className="flex gap-2 px-2 py-3">
              <FolderPlus
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('No collections')}</p>
                <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
                  {t('Create a collection for the selected references.')}
                </p>
              </div>
            </div>
          )}
          <div className="mt-1 border-t border-border pt-1">
            {collectionCreateMode ? (
              <form
                className="flex gap-1"
                onSubmit={(event) => {
                  event.preventDefault()
                  const name = collectionName.trim()
                  if (!name) return
                  void onCreateCollection(name).then((created) => {
                    if (!created) return
                    setCollectionCreateMode(false)
                    setCollectionName('')
                  })
                }}
              >
                <Input
                  autoFocus
                  value={collectionName}
                  onChange={(event) => setCollectionName(event.target.value)}
                  placeholder={t('New collection')}
                  aria-label={t('Collection name')}
                  className="h-8 min-w-0 text-xs"
                />
                <Button
                  type="submit"
                  size="icon"
                  className="size-8"
                  disabled={!collectionName.trim() || disabled}
                  aria-label={t('Create collection')}
                >
                  {disabled ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Plus className="size-4" aria-hidden="true" />
                  )}
                </Button>
              </form>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => setCollectionCreateMode(true)}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                {t('New collection')}
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <Popover onOpenChange={(open) => !open && setProjectQuery('')}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            disabled={disabled}
          >
            <FolderPlus className="size-3.5" aria-hidden="true" />
            {t('Add to project')}
            <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          data-slot="literature-batch-project-popover"
          align="start"
          sideOffset={6}
          className={cn(
            'max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-menu',
            projectsLoaded && projects.length === 0 ? 'w-max' : 'w-72'
          )}
        >
          <div className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">
            {t('Projects')}
          </div>
          {projectsLoaded && projects.length > SEARCH_THRESHOLD ? (
            <div className="relative mb-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                aria-label={t('Search projects')}
                placeholder={t('Search projects…')}
                value={projectQuery}
                autoComplete="off"
                className="h-8 pl-8 text-xs"
                onChange={(event) => setProjectQuery(event.currentTarget.value)}
              />
            </div>
          ) : null}
          {projectsLoaded ? (
            visibleProjects.length > 0 ? (
              <div className="max-h-56 overflow-y-auto">
                {visibleProjects.map((project) => (
                  <PopoverClose key={project.id} asChild>
                    <button
                      type="button"
                      disabled={disabled}
                      className={destinationButtonClassName}
                      onClick={() => onSelectProject(project.id)}
                    >
                      <FolderOpen
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    </button>
                  </PopoverClose>
                ))}
              </div>
            ) : projects.length === 0 ? (
              <div className="flex gap-2 px-2 py-3">
                <FolderPlus
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t('No active projects')}</p>
                  <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
                    {t('Create a project for the selected references.')}
                  </p>
                </div>
              </div>
            ) : (
              <p className="px-2 py-3 text-sm text-muted-foreground">{t('No matching projects')}</p>
            )
          ) : (
            <p role="status" className="px-2 py-3 text-sm text-muted-foreground">
              {t('Loading…')}
            </p>
          )}
          <div className="mt-1 border-t border-border pt-1">
            <PopoverClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={onCreateProject}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                {t('New project')}
              </Button>
            </PopoverClose>
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}

export { LiteratureBatchDestinationMenus }
