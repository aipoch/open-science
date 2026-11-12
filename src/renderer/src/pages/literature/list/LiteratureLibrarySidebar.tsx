import type { ComparisonTableSummary } from '../../../../../shared/literature-comparison'
import { useLiteratureHost } from '../renderer-host'
import { SmartCollectionIcon } from '@/components/app-icons/custom-glyphs'
import {
  ArrowLeft,
  BookOpenText,
  Copy,
  Download,
  Ellipsis,
  SlidersHorizontal,
  FileCog,
  FolderOpen,
  FolderPlus,
  GalleryVerticalEnd,
  Inbox,
  LibraryBig,
  PanelLeft,
  Plus,
  Table2,
  Trash2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

import type { LiteratureCollectionView } from '@aipoch/literature-library/contracts'
import {
  LiteratureDuplicateCount,
  type LiteratureDuplicateCountHandle
} from '../duplicates/LiteratureDuplicatesView'
import { LiteratureLibraryCount } from './LiteratureLibraryCount'

import {
  LiteratureSidebarGroup,
  LiteratureSidebarHint,
  LiteratureSidebarState
} from './LiteratureSidebarGroups'

export type LibrarySection = 'inbox' | 'library' | 'trash'

type SidebarNavigation = {
  section: LibrarySection
  collectionId?: string
  projectId?: string
  citationStylesOpen: boolean
  journalsOpen: boolean
  duplicatesOpen: boolean
  selectSection: (section: Exclude<LibrarySection, 'library'>) => void
  selectLibrary: (collectionId?: string) => void
  selectProject: (projectId: string) => void
  openDuplicates: () => void
  openJournals: () => void
  openCitationStyles: () => void
}

export function LiteratureLibrarySidebar({
  comparisons,
  navigation,
  counts,
  activeProjects,
  displayCollections,
  libraryEntryRef,
  returnLabel,
  openCreateCollection
}: {
  comparisons?: {
    tables: ComparisonTableSummary[]
    selectedId?: string
    onCreate: () => void
    onOpen: (id: string, action?: 'configure' | 'export') => void
    onDelete: (table: ComparisonTableSummary) => void
  }
  navigation: SidebarNavigation
  counts: {
    inboxPendingCount?: number
    libraryCountRevision: number
    projectItemCounts: Record<string, number>
    duplicateCountRef: React.RefObject<LiteratureDuplicateCountHandle | null>
  }
  activeProjects: Array<{ id: string; name: string }>
  displayCollections: LiteratureCollectionView[]
  libraryEntryRef: React.RefObject<HTMLButtonElement | null>
  returnLabel: string
  openCreateCollection: () => void
}): React.JSX.Element {
  const { useNavigationStore } = useLiteratureHost()

  const { api: hostApi } = useLiteratureHost()

  const { t } = useTranslation()
  const returnFromLibrary = useNavigationStore((state) => state.returnFromLibrary)
  const {
    section,
    collectionId,
    projectId,
    citationStylesOpen,
    journalsOpen,
    duplicatesOpen,
    selectSection,
    selectLibrary,
    selectProject,
    openDuplicates,
    openJournals,
    openCitationStyles
  } = navigation
  const { inboxPendingCount, libraryCountRevision, projectItemCounts, duplicateCountRef } = counts
  return (
    <LiteratureSidebarState>
      {(sidebarCollapsed, toggleSidebar, sidebarRef) => {
        const navButtonClassName = cn(
          'relative flex h-9 w-full items-center rounded-lg text-sm hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-bg-300 disabled:cursor-not-allowed disabled:opacity-50',
          sidebarCollapsed ? 'justify-center px-0' : 'gap-2 px-3'
        )
        return (
          <aside
            ref={sidebarRef}
            className={cn(
              'flex shrink-0 flex-col border-r border-border-300/80 bg-bg-000 py-3',
              sidebarCollapsed ? 'w-14 px-2' : 'w-60 px-3'
            )}
          >
            <div
              className={cn(
                'mb-3 flex min-h-10 items-center',
                sidebarCollapsed ? 'justify-center' : 'gap-2 px-1'
              )}
            >
              {!sidebarCollapsed ? (
                <>
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-bg-200 text-primary">
                    <BookOpenText className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h1 className="truncate text-sm font-semibold">{t('Literature library')}</h1>
                    <p className="truncate text-xs text-muted-foreground">
                      {t('Your research references')}
                    </p>
                  </div>
                </>
              ) : null}
              <LiteratureSidebarHint
                label={sidebarCollapsed ? t('Expand sidebar panel') : t('Collapse sidebar panel')}
                collapsed
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn('shrink-0', !sidebarCollapsed && 'ml-auto')}
                  aria-label={
                    sidebarCollapsed ? t('Expand sidebar panel') : t('Collapse sidebar panel')
                  }
                  aria-expanded={!sidebarCollapsed}
                  aria-controls="literature-sidebar-navigation"
                  aria-keyshortcuts={hostApi?.platform === 'darwin' ? 'Meta+B' : 'Control+B'}
                  onClick={toggleSidebar}
                >
                  <PanelLeft className="size-4" aria-hidden="true" />
                </Button>
              </LiteratureSidebarHint>
            </div>
            <div className="mb-3 border-b border-border-300/80 pb-3">
              <LiteratureSidebarHint label={returnLabel} collapsed={sidebarCollapsed}>
                <button
                  type="button"
                  className={navButtonClassName}
                  aria-label={returnLabel}
                  onClick={() => returnFromLibrary('user')}
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  {!sidebarCollapsed ? <span>{returnLabel}</span> : null}
                </button>
              </LiteratureSidebarHint>
            </div>
            <nav
              id="literature-sidebar-navigation"
              className="flex min-h-0 flex-1 flex-col"
              aria-label={t('Literature library')}
            >
              <div className="space-y-1">
                <LiteratureSidebarHint label={t('Inbox')} collapsed={sidebarCollapsed}>
                  <button
                    type="button"
                    className={cn(
                      navButtonClassName,
                      !comparisons?.selectedId &&
                        !citationStylesOpen &&
                        !journalsOpen &&
                        !duplicatesOpen &&
                        section === 'inbox' &&
                        'bg-bg-300 font-medium'
                    )}
                    aria-current={
                      !comparisons?.selectedId &&
                      !citationStylesOpen &&
                      !journalsOpen &&
                      !duplicatesOpen &&
                      section === 'inbox'
                        ? 'page'
                        : undefined
                    }
                    aria-label={t('Inbox')}
                    onClick={() => selectSection('inbox')}
                  >
                    <Inbox className="size-4" aria-hidden="true" />
                    {!sidebarCollapsed ? <span>{t('Inbox')}</span> : null}
                    {!sidebarCollapsed &&
                    inboxPendingCount !== undefined &&
                    inboxPendingCount > 0 ? (
                      <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                        {inboxPendingCount}
                      </span>
                    ) : null}
                    {sidebarCollapsed &&
                    inboxPendingCount !== undefined &&
                    inboxPendingCount > 0 ? (
                      <span
                        className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary"
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>
                </LiteratureSidebarHint>
                <LiteratureSidebarHint label={t('All references')} collapsed={sidebarCollapsed}>
                  <button
                    type="button"
                    className={cn(
                      navButtonClassName,
                      !comparisons?.selectedId &&
                        !citationStylesOpen &&
                        !journalsOpen &&
                        !duplicatesOpen &&
                        section === 'library' &&
                        !collectionId &&
                        !projectId &&
                        'bg-bg-300 font-medium'
                    )}
                    ref={libraryEntryRef}
                    aria-current={
                      !comparisons?.selectedId &&
                      !citationStylesOpen &&
                      !journalsOpen &&
                      !duplicatesOpen &&
                      section === 'library' &&
                      !collectionId &&
                      !projectId
                        ? 'page'
                        : undefined
                    }
                    aria-label={t('All references')}
                    onClick={() => selectLibrary()}
                  >
                    <BookOpenText className="size-4" aria-hidden="true" />
                    {!sidebarCollapsed ? <span>{t('All references')}</span> : null}
                    <LiteratureLibraryCount
                      revision={libraryCountRevision}
                      hidden={sidebarCollapsed}
                    />
                  </button>
                </LiteratureSidebarHint>
                <LiteratureSidebarHint label={t('Duplicates')} collapsed={sidebarCollapsed}>
                  <button
                    type="button"
                    className={cn(navButtonClassName, duplicatesOpen && 'bg-bg-300 font-medium')}
                    aria-current={
                      !comparisons?.selectedId &&
                      !citationStylesOpen &&
                      !journalsOpen &&
                      duplicatesOpen
                        ? 'page'
                        : undefined
                    }
                    aria-label={t('Duplicates')}
                    onClick={openDuplicates}
                  >
                    <Copy className="size-4" aria-hidden="true" />
                    {!sidebarCollapsed ? <span>{t('Duplicates')}</span> : null}
                    <LiteratureDuplicateCount ref={duplicateCountRef} hidden={sidebarCollapsed} />
                  </button>
                </LiteratureSidebarHint>
                <LiteratureSidebarHint label={t('Trash')} collapsed={sidebarCollapsed}>
                  <button
                    type="button"
                    className={cn(
                      navButtonClassName,
                      !comparisons?.selectedId &&
                        !citationStylesOpen &&
                        !journalsOpen &&
                        !duplicatesOpen &&
                        section === 'trash' &&
                        'bg-bg-300 font-medium'
                    )}
                    aria-current={
                      !comparisons?.selectedId &&
                      !citationStylesOpen &&
                      !journalsOpen &&
                      !duplicatesOpen &&
                      section === 'trash'
                        ? 'page'
                        : undefined
                    }
                    aria-label={t('Trash')}
                    onClick={() => selectSection('trash')}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    {!sidebarCollapsed ? <span>{t('Trash')}</span> : null}
                  </button>
                </LiteratureSidebarHint>
              </div>
              <div
                className={cn(
                  'min-h-0 flex-1 overflow-y-auto',
                  sidebarCollapsed ? 'mt-3 border-t border-border-300/80 pt-3' : 'mt-2'
                )}
              >
                {!sidebarCollapsed ? (
                  <div
                    role="separator"
                    aria-orientation="horizontal"
                    className="mx-2 mb-2 mt-2 h-px bg-border-300/80"
                  />
                ) : null}
                <LiteratureSidebarGroup
                  collapsed={sidebarCollapsed}
                  entries={activeProjects}
                  groupId="literature-sidebar-projects"
                  label={t('Projects')}
                  navButtonClassName={navButtonClassName}
                  selectedId={duplicatesOpen ? undefined : projectId}
                  showAllLabel={t('Show all projects')}
                  showAllText={t('Show all')}
                  showFewerLabel={t('Show fewer projects')}
                  showLessText={t('Show less')}
                  renderEntry={(project) => (
                    <LiteratureSidebarHint
                      key={project.id}
                      label={project.name}
                      collapsed={sidebarCollapsed}
                    >
                      <button
                        type="button"
                        className={cn(
                          navButtonClassName,
                          !comparisons?.selectedId &&
                            !citationStylesOpen &&
                            !journalsOpen &&
                            !duplicatesOpen &&
                            projectId === project.id &&
                            'bg-bg-300 font-medium'
                        )}
                        aria-current={
                          !comparisons?.selectedId &&
                          !citationStylesOpen &&
                          !journalsOpen &&
                          !duplicatesOpen &&
                          section === 'library' &&
                          projectId === project.id
                            ? 'page'
                            : undefined
                        }
                        aria-label={project.name}
                        onClick={() => selectProject(project.id)}
                      >
                        <GalleryVerticalEnd className="size-4" aria-hidden="true" />
                        {!sidebarCollapsed ? (
                          <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                        ) : null}
                        {!sidebarCollapsed ? (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {projectItemCounts[project.id] ?? 0}
                          </span>
                        ) : null}
                      </button>
                    </LiteratureSidebarHint>
                  )}
                />
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  className={cn(
                    'mx-2 h-px bg-border-300/80',
                    sidebarCollapsed ? 'my-3' : 'mb-2 mt-4'
                  )}
                />
                <LiteratureSidebarGroup
                  collapsed={sidebarCollapsed}
                  entries={displayCollections}
                  groupId="literature-sidebar-collections"
                  label={t('Collections')}
                  action={
                    <LiteratureSidebarHint label={t('New collection')} collapsed>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-lg"
                        className="text-muted-foreground hover:bg-bg-300 hover:text-foreground active:bg-bg-300 transition-none"
                        aria-label={t('New collection')}
                        onClick={openCreateCollection}
                      >
                        {sidebarCollapsed ? (
                          <FolderPlus className="size-4" aria-hidden="true" />
                        ) : (
                          <Plus className="size-4" aria-hidden="true" />
                        )}
                      </Button>
                    </LiteratureSidebarHint>
                  }
                  navButtonClassName={navButtonClassName}
                  selectedId={duplicatesOpen ? undefined : collectionId}
                  showAllLabel={t('Show all collections')}
                  showAllText={t('Show all')}
                  showFewerLabel={t('Show fewer collections')}
                  showLessText={t('Show less')}
                  renderEntry={(collection) => (
                    <LiteratureSidebarHint
                      key={collection.id}
                      label={collection.name}
                      collapsed={sidebarCollapsed}
                    >
                      <button
                        type="button"
                        className={cn(
                          navButtonClassName,
                          !duplicatesOpen &&
                            collectionId === collection.id &&
                            'bg-bg-300 font-medium'
                        )}
                        aria-current={
                          !comparisons?.selectedId &&
                          !citationStylesOpen &&
                          !journalsOpen &&
                          !duplicatesOpen &&
                          section === 'library' &&
                          collectionId === collection.id
                            ? 'page'
                            : undefined
                        }
                        aria-label={collection.name}
                        onClick={() => selectLibrary(collection.id)}
                      >
                        <span aria-hidden="true">
                          {collection.smart ? (
                            <SmartCollectionIcon
                              className="size-4 text-primary"
                              aria-hidden="true"
                            />
                          ) : (
                            <FolderOpen className="size-4" />
                          )}
                        </span>
                        {!sidebarCollapsed ? (
                          <span className="min-w-0 flex-1 truncate text-left">
                            {collection.name}
                          </span>
                        ) : null}
                        {!sidebarCollapsed ? (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {collection.itemCount}
                          </span>
                        ) : null}
                      </button>
                    </LiteratureSidebarHint>
                  )}
                />
                {comparisons && (
                  <LiteratureSidebarGroup
                    collapsed={sidebarCollapsed}
                    entries={comparisons.tables}
                    groupId="literature-sidebar-comparisons"
                    label={t('Comparison tables')}
                    selectedId={comparisons.selectedId}
                    navButtonClassName={navButtonClassName}
                    showAllLabel={t('Show all comparison tables')}
                    showAllText={t('Show all')}
                    showFewerLabel={t('Show fewer comparison tables')}
                    showLessText={t('Show less')}
                    action={
                      <LiteratureSidebarHint label={t('New comparison table')} collapsed>
                        <Button
                          variant="ghost"
                          size="icon-lg"
                          className="text-muted-foreground hover:text-foreground transition-none"
                          aria-label={t('New comparison table')}
                          onClick={comparisons.onCreate}
                        >
                          <Plus className="size-4" aria-hidden="true" />
                        </Button>
                      </LiteratureSidebarHint>
                    }
                    renderEntry={(table) => (
                      <div
                        key={table.id}
                        className="group relative mb-1 flex items-center rounded-lg hover:bg-bg-300 focus-within:bg-bg-300"
                      >
                        <LiteratureSidebarHint label={table.name} collapsed={sidebarCollapsed}>
                          <button
                            type="button"
                            className={cn(
                              navButtonClassName,
                              'min-w-0 flex-1',
                              !sidebarCollapsed && 'pr-9',
                              comparisons.selectedId === table.id && 'bg-bg-300 font-medium'
                            )}
                            aria-current={comparisons.selectedId === table.id ? 'page' : undefined}
                            aria-label={table.name}
                            onClick={() => comparisons.onOpen(table.id)}
                          >
                            <Table2
                              className="size-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                            {!sidebarCollapsed && (
                              <span
                                title={table.name}
                                className="min-w-0 flex-1 truncate text-left"
                              >
                                {table.name}
                              </span>
                            )}
                          </button>
                        </LiteratureSidebarHint>
                        {!sidebarCollapsed && (
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="absolute inset-y-0 right-1 my-auto pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 aria-expanded:pointer-events-auto aria-expanded:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
                                aria-label={t('Actions for {{name}}', { name: table.name })}
                              >
                                <Ellipsis className="size-4" aria-hidden="true" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              side="right"
                              align="start"
                              sideOffset={8}
                              collisionPadding={8}
                            >
                              <DropdownMenuItem
                                className="gap-2"
                                disabled={
                                  table.state === 'running' ||
                                  (table.state === 'paused' && table.running > 0)
                                }
                                onSelect={() => comparisons.onOpen(table.id, 'configure')}
                              >
                                <SlidersHorizontal aria-hidden="true" className="size-4" />
                                {t('Table settings')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="gap-2"
                                onSelect={() => comparisons.onOpen(table.id, 'export')}
                              >
                                <Download aria-hidden="true" className="size-4" />
                                {t('Export')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="gap-2 text-destructive"
                                disabled={table.state === 'running'}
                                title={
                                  table.state === 'running'
                                    ? t('Pause extraction before deleting this table.')
                                    : undefined
                                }
                                aria-label={t('Delete comparison table: {{name}}', {
                                  name: table.name
                                })}
                                onSelect={() => comparisons.onDelete(table)}
                              >
                                <Trash2 aria-hidden="true" className="size-4" />
                                {t('Delete')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    )}
                  />
                )}
              </div>
              <div
                className={cn(
                  'mt-auto space-y-1 border-t border-border-300/80 pt-2',
                  sidebarCollapsed && 'flex flex-col items-center'
                )}
              >
                <LiteratureSidebarHint label={t('Journals')} collapsed={sidebarCollapsed}>
                  <button
                    type="button"
                    className={cn(navButtonClassName, journalsOpen && 'bg-bg-300 font-medium')}
                    aria-current={journalsOpen ? 'page' : undefined}
                    aria-label={t('Journals')}
                    onClick={openJournals}
                  >
                    <LibraryBig className="size-4" aria-hidden="true" />
                    {!sidebarCollapsed ? <span>{t('Journals')}</span> : null}
                  </button>
                </LiteratureSidebarHint>
                <LiteratureSidebarHint label={t('Citation styles')} collapsed={sidebarCollapsed}>
                  <button
                    type="button"
                    className={cn(
                      navButtonClassName,
                      citationStylesOpen && 'bg-bg-300 font-medium'
                    )}
                    aria-current={citationStylesOpen ? 'page' : undefined}
                    aria-label={t('Citation styles')}
                    onClick={openCitationStyles}
                  >
                    <FileCog className="size-4" aria-hidden="true" />
                    {!sidebarCollapsed ? <span>{t('Citation styles')}</span> : null}
                  </button>
                </LiteratureSidebarHint>
              </div>
            </nav>
          </aside>
        )
      }}
    </LiteratureSidebarState>
  )
}
