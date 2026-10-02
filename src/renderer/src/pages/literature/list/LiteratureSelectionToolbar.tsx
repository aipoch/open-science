import { Button } from '@/components/ui/button'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useProjectFormDialog } from '@/hooks/useProjectFormDialog'
import { useProjectStore } from '@/stores/project-store'
import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  Download,
  Merge,
  MoreHorizontal,
  RotateCcw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LiteratureCollectionView, LiteratureItemView } from '../../../../../shared/literature'
import type { SmartCollectionView } from '../../../../../shared/literature-smart-collections'
import { LiteratureBatchDestinationMenus } from '../collections/LiteratureBatchDestinationMenus'
import { type BatchLookupMode } from '../workflows/LiteratureBatchLookupDialog'
import { LiteratureHoverDropdown, LiteratureHoverMenuGroup } from '../LiteratureHoverMenus'
import { LiteratureExportMenu } from './LiteratureLibraryMenus'
import type { LiteratureSelectionStore } from './literature-selection'
import type { useSmartDecisionBatch } from '../collections/useSmartDecisionBatch'

const LITERATURE_BATCH_COMMAND_SIZE = 200

export function LiteratureSelectionToolbar({
  selectedItemCount,
  selection,
  allLoadedItemsSelected,
  entriesOffset,
  nextEntriesOffset,
  formattedMatchingCount,
  isBatching,
  selectionStore,
  clearSelection,
  smartDecisionBatch,
  collectionId,
  selectedCollection,
  pendingDecisions,
  confirmSmartDecision,
  smartView,
  prepareSmartReevaluation,
  section,
  startingReadingProjectId,
  requestReadSelection,
  batchCollections,
  activeProjects,
  projectsLoaded,
  createCollectionForSelection,
  batchProjectFormDialog,
  moveSelectedItems,
  addSelectedItemsToProject,
  items,
  previewRestoreSelection,
  exportSelectedItems,
  requestBatchLookup,
  setMergeSurvivorId,
  setMergeFieldSources,
  setMergeError,
  setMergeOpen,
  runLifecycleAction,
  requestPermanentDeletion
}: {
  selectedItemCount: number
  selection: ReturnType<LiteratureSelectionStore['getSnapshot']>
  allLoadedItemsSelected: boolean
  entriesOffset: number
  nextEntriesOffset: number | undefined
  formattedMatchingCount: string
  isBatching: boolean
  selectionStore: LiteratureSelectionStore
  clearSelection: () => void
  smartDecisionBatch: ReturnType<typeof useSmartDecisionBatch>
  collectionId: string | undefined
  selectedCollection: LiteratureCollectionView | undefined
  pendingDecisions: Set<string>
  confirmSmartDecision: (
    decision: 'include' | 'exclude' | 'automatic',
    itemIds?: string[],
    singleRecord?: boolean
  ) => Promise<void>
  smartView: SmartCollectionView | undefined
  prepareSmartReevaluation: (ids?: string[], detailItemId?: string) => Promise<void>
  section: 'library' | 'trash'
  startingReadingProjectId: string | undefined
  requestReadSelection: () => Promise<void>
  batchCollections: LiteratureCollectionView[]
  activeProjects: ReturnType<typeof useProjectStore.getState>['projects']
  projectsLoaded: boolean
  createCollectionForSelection: (name: string) => Promise<boolean>
  batchProjectFormDialog: ReturnType<typeof useProjectFormDialog>
  moveSelectedItems: (collectionId: string) => Promise<void>
  addSelectedItemsToProject: (projectId: string) => Promise<void>
  items: LiteratureItemView[]
  previewRestoreSelection: () => Promise<void>
  exportSelectedItems: (format: 'bibtex' | 'ris') => Promise<boolean>
  requestBatchLookup: (mode: BatchLookupMode) => Promise<void>
  setMergeSurvivorId: React.Dispatch<React.SetStateAction<string>>
  setMergeFieldSources: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setMergeError: React.Dispatch<React.SetStateAction<string | undefined>>
  setMergeOpen: React.Dispatch<React.SetStateAction<boolean>>
  runLifecycleAction: (state: 'active' | 'deleted') => Promise<void>
  requestPermanentDeletion: (itemIds: string[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      data-slot="literature-selection-toolbar"
      className="w-full min-w-0 rounded-lg border border-primary/20 bg-primary/5 px-2 py-1"
    >
      <div
        data-slot="literature-selection-common-actions"
        className="flex min-h-9 min-w-0 items-center gap-2 overflow-x-auto [&>button]:shrink-0"
      >
        <span className="shrink-0 whitespace-nowrap px-1 text-sm font-medium tabular-nums">
          {t('{{count}} selected', { count: selectedItemCount })}
        </span>
        {!selection.allMatchingSelected &&
        allLoadedItemsSelected &&
        (entriesOffset > 0 || nextEntriesOffset !== undefined) ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`${t('Select all matching references')} ${formattedMatchingCount}`}
            disabled={isBatching}
            onClick={selectionStore.selectAllMatching}
            className="shrink-0 whitespace-nowrap"
          >
            <span>{t('Select all')}</span>
            <span className="text-muted-foreground tabular-nums">{formattedMatchingCount}</span>
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('Clear selection')}
          title={t('Clear selection')}
          disabled={isBatching}
          onClick={clearSelection}
        >
          <X className="size-3.5" aria-hidden="true" />
        </Button>
        {smartDecisionBatch.progress &&
        smartDecisionBatch.progress.collectionId === collectionId ? (
          <>
            <span role="status" className="text-sm tabular-nums">
              {t('Saving decisions: {{done}}/{{total}}', smartDecisionBatch.progress)}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={smartDecisionBatch.stop}
              disabled={smartDecisionBatch.progress.stopping}
            >
              {t('Stop')}
            </Button>
          </>
        ) : (
          selectedCollection?.smart && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={isBatching || pendingDecisions.size > 0}
                onClick={() => void confirmSmartDecision('include')}
              >
                {t('Include')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={isBatching || pendingDecisions.size > 0}
                onClick={() => void confirmSmartDecision('exclude')}
              >
                {t('Exclude')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  isBatching ||
                  pendingDecisions.size > 0 ||
                  !smartView?.configured ||
                  !smartView?.sourceAvailable ||
                  smartView?.run?.state === 'running' ||
                  smartView?.run?.state === 'queued'
                }
                onClick={() => void prepareSmartReevaluation()}
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
                {t('Re-evaluate selected')}
              </Button>
            </>
          )
        )}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto shrink-0" disabled={isBatching}>
              {t('More actions')}
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-64 max-w-[calc(100vw-2rem)] space-y-1 rounded-xl border border-border bg-bg-000 p-1.5 text-foreground [&_button]:h-8 [&_button]:w-full [&_button]:justify-start [&_button]:border-transparent [&_button]:bg-transparent [&_button]:shadow-none [&_button:hover]:bg-bg-200"
          >
            <LiteratureHoverMenuGroup>
              <div className="flex flex-col gap-0.5">
                {section === 'library' ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 whitespace-nowrap"
                    disabled={isBatching || Boolean(startingReadingProjectId)}
                    onClick={() => void requestReadSelection()}
                  >
                    <BookOpenText className="size-3.5" aria-hidden="true" />
                    {t('Read with agent')}
                  </Button>
                ) : null}
                {section === 'library' ? (
                  <LiteratureBatchDestinationMenus
                    collections={batchCollections}
                    disabled={isBatching}
                    moveBetweenCollections={Boolean(collectionId)}
                    projects={activeProjects}
                    projectsLoaded={projectsLoaded}
                    onCreateCollection={createCollectionForSelection}
                    onCreateProject={batchProjectFormDialog.openCreateDialog}
                    onSelectCollection={(id) => void moveSelectedItems(id)}
                    onSelectProject={(id) => void addSelectedItemsToProject(id)}
                  />
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={
                      isBatching ||
                      (!selection.allMatchingSelected &&
                        [...selection.selectedIds].every((id) =>
                          items.some((item) => item.id === id && Boolean(item.mergedIntoItemId))
                        ))
                    }
                    onClick={() => void previewRestoreSelection()}
                  >
                    <RotateCcw className="size-3.5" aria-hidden="true" />
                    {t('Restore')}
                  </Button>
                )}
                <LiteratureExportMenu
                  disabled={isBatching || section === 'trash'}
                  onExport={exportSelectedItems}
                />
                {section === 'library' ||
                (section === 'trash' &&
                  !selection.allMatchingSelected &&
                  selection.selectedIds.size <= LITERATURE_BATCH_COMMAND_SIZE) ? (
                  <LiteratureHoverDropdown
                    disabled={isBatching}
                    trigger={
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        aria-label={t('Actions')}
                        disabled={isBatching}
                      >
                        <MoreHorizontal className="size-3.5" aria-hidden="true" />
                        {t('Actions')}
                        <ChevronRight className="ml-auto size-3.5 opacity-60" aria-hidden="true" />
                      </Button>
                    }
                  >
                    {section === 'library' ? (
                      <>
                        <PopoverClose asChild>
                          <DropdownMenuItem onSelect={() => void requestBatchLookup('metadata')}>
                            <Search className="mr-2 size-4" aria-hidden="true" />
                            {t('Complete metadata')}
                          </DropdownMenuItem>
                        </PopoverClose>
                        <PopoverClose asChild>
                          <DropdownMenuItem onSelect={() => void requestBatchLookup('full-text')}>
                            <Download className="mr-2 size-4" aria-hidden="true" />
                            {t('Find full-text PDF')}
                          </DropdownMenuItem>
                        </PopoverClose>
                        <DropdownMenuSeparator />
                        {!selection.allMatchingSelected &&
                        selection.selectedIds.size > 1 &&
                        selection.selectedIds.size <= 20 ? (
                          <>
                            <PopoverClose asChild>
                              <DropdownMenuItem
                                onSelect={() => {
                                  const firstSelected = items.find((item) =>
                                    selection.selectedIds.has(item.id)
                                  )
                                  setMergeSurvivorId(firstSelected?.id ?? '')
                                  setMergeFieldSources({})
                                  setMergeError(undefined)
                                  setMergeOpen(true)
                                }}
                              >
                                <Merge className="mr-2 size-4" aria-hidden="true" />
                                {t('Merge')}
                              </DropdownMenuItem>
                            </PopoverClose>
                            <DropdownMenuSeparator />
                          </>
                        ) : null}
                        <PopoverClose asChild>
                          <DropdownMenuItem onSelect={() => void runLifecycleAction('deleted')}>
                            <Trash2 className="mr-2 size-4" aria-hidden="true" />
                            {t('Move to Trash')}
                          </DropdownMenuItem>
                        </PopoverClose>
                      </>
                    ) : (
                      <>
                        <PopoverClose asChild>
                          <DropdownMenuItem
                            className="text-danger-000 focus:text-danger-000"
                            onSelect={() => requestPermanentDeletion([...selection.selectedIds])}
                          >
                            <Trash2 className="mr-2 size-4" aria-hidden="true" />
                            {t('Delete permanently')}
                          </DropdownMenuItem>
                        </PopoverClose>
                      </>
                    )}
                  </LiteratureHoverDropdown>
                ) : null}
              </div>
              {selectedCollection?.smart && (
                <div
                  data-slot="smart-selection-actions"
                  className="flex flex-col gap-0.5 border-t border-border pt-1"
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isBatching}
                    onClick={() => void confirmSmartDecision('automatic')}
                  >
                    {t('Use model decision')}
                  </Button>
                </div>
              )}
            </LiteratureHoverMenuGroup>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
