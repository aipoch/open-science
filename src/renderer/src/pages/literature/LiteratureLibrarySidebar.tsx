import { SmartCollectionIcon } from '@/components/app-icons/custom-glyphs'
import {
  ArrowLeft,
  BookOpenText,
  Copy,
  FileCog,
  FolderOpen,
  FolderPlus,
  GalleryVerticalEnd,
  Inbox,
  LibraryBig,
  PanelLeft,
  Plus,
  Trash2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation-store'
import type { LiteratureCollectionView } from '../../../../shared/literature'
import {
  LiteratureDuplicateCount,
  type LiteratureDuplicateCountHandle
} from './LiteratureDuplicatesView'
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
  navigation,
  counts,
  activeProjects,
  displayCollections,
  libraryEntryRef,
  returnLabel,
  openCreateCollection
}: {
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
      {(sidebarCollapsed, toggleSidebar) => {
        const navButtonClassName = cn(
          'relative flex h-9 w-full items-center rounded-lg text-sm hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-bg-300 disabled:cursor-not-allowed disabled:opacity-50',
          sidebarCollapsed ? 'justify-center px-0' : 'gap-2 px-3'
        )
        return (
          <aside
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
                  aria-keyshortcuts={window.api?.platform === 'darwin' ? 'Meta+B' : 'Control+B'}
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
                      !citationStylesOpen &&
                        !journalsOpen &&
                        !duplicatesOpen &&
                        section === 'inbox' &&
                        'bg-bg-300 font-medium'
                    )}
                    aria-current={
                      !citationStylesOpen &&
                      !journalsOpen &&
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
                      !citationStylesOpen && !journalsOpen && duplicatesOpen ? 'page' : undefined
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
                      !citationStylesOpen &&
                        !journalsOpen &&
                        !duplicatesOpen &&
                        section === 'trash' &&
                        'bg-bg-300 font-medium'
                    )}
                    aria-current={
                      !citationStylesOpen && !journalsOpen && !duplicatesOpen && section === 'trash'
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
                          !citationStylesOpen &&
                            !journalsOpen &&
                            !duplicatesOpen &&
                            projectId === project.id &&
                            'bg-bg-300 font-medium'
                        )}
                        aria-current={
                          !citationStylesOpen &&
                          !journalsOpen &&
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
