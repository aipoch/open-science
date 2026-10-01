import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  LiteratureCollectionView,
  LiteratureItemType,
  LiteratureItemView
} from '../../../../shared/literature'
import type { SmartCollectionView } from '../../../../shared/literature-smart-collections'
import { LiteratureItemRow, LiteratureRowActions } from './LiteratureItemRow'
import { LiteratureSelectPageCheckbox } from './LiteratureSelection'
import {
  LiteratureTable,
  LiteratureTableScrollArea,
  LiteratureTextTooltip
} from './LiteratureTable'
import { type SmartCollectionCellActions } from './SmartCollectionDecision'
import { useAttachmentOperations } from './literature-attachment-operations'
import { LiteratureRowNumbers } from './literature-row-numbers'
import type { LiteratureSelectionStore } from './literature-selection'
import { useLiteratureSmartReevaluation } from './useLiteratureSmartReevaluation'
import { useLiteratureTable } from './useLiteratureTable'

export function LiteratureResultsTable({
  tableScrollRef,
  tableMinWidth,
  selectedCollection,
  smartTableBlocked,
  items,
  selectionStore,
  visibleOrderedTableColumns,
  tableColumnLabels,
  rowNumbers,
  section,
  isBatching,
  pendingDecisions,
  collectionId,
  smartRunningCollection,
  smartView,
  completedReevaluation,
  singleReevaluation,
  attachmentOperations,
  smartCellActions,
  itemTypeLabels,
  rowActions,
  entriesPageTransitionLoading,
  entriesPagination
}: {
  tableScrollRef: React.RefObject<HTMLDivElement | null>
  tableMinWidth: number
  selectedCollection: LiteratureCollectionView | undefined
  smartTableBlocked: boolean
  items: LiteratureItemView[]
  selectionStore: LiteratureSelectionStore
  visibleOrderedTableColumns: ReturnType<typeof useLiteratureTable>['visibleOrderedTableColumns']
  tableColumnLabels: ReturnType<typeof useLiteratureTable>['tableColumnLabels']
  rowNumbers: Map<string, number>
  section: 'library' | 'trash'
  isBatching: boolean
  pendingDecisions: Set<string>
  collectionId: string | undefined
  smartRunningCollection: string | undefined
  smartView: SmartCollectionView | undefined
  completedReevaluation: ReturnType<typeof useLiteratureSmartReevaluation>['completedReevaluation']
  singleReevaluation: ReturnType<typeof useLiteratureSmartReevaluation>['singleReevaluation']
  attachmentOperations: ReturnType<typeof useAttachmentOperations.getState>['operations']
  smartCellActions: React.RefObject<SmartCollectionCellActions>
  itemTypeLabels: Record<LiteratureItemType, string>
  rowActions: React.RefObject<LiteratureRowActions>
  entriesPageTransitionLoading: boolean
  entriesPagination: React.JSX.Element | null
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="isolate flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-300/80 bg-bg-000">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <LiteratureTableScrollArea
          viewportRef={tableScrollRef}
          data-slot="literature-table-scroll"
          className="h-full overflow-auto pb-3 [scrollbar-gutter:stable]"
        >
          <LiteratureTable
            className="w-full table-fixed text-left text-sm"
            style={{
              minWidth: tableMinWidth + (selectedCollection?.smart ? 272 : 0)
            }}
          >
            <thead className="sticky top-0 z-40 border-b border-border-300/80 bg-bg-200 text-xs font-medium text-muted-foreground">
              <tr>
                <th className="w-11 px-3 py-2.5">
                  <LiteratureSelectPageCheckbox
                    disabled={smartTableBlocked}
                    itemIds={items.map((item) => item.id)}
                    label={t('Select all references')}
                    store={selectionStore}
                    className="size-4"
                  />
                </th>
                <th
                  scope="col"
                  className="w-12 min-w-12 max-w-12 px-2 py-2.5 text-center tabular-nums"
                >
                  #
                </th>
                <th scope="col" className="w-72 px-2 py-2.5">
                  {t('Title')}
                </th>
                {selectedCollection?.smart && (
                  <>
                    <th scope="col" className="w-40 px-2 py-2.5">
                      {t('Evaluation')}
                    </th>
                    <th scope="col" className="w-28 px-2 py-2.5">
                      {t('Actions')}
                    </th>
                  </>
                )}
                {visibleOrderedTableColumns.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className={cn(
                      'px-3 py-2.5',
                      column.startsWith('journal:') && 'w-[180px] max-w-[180px]',
                      column === 'type' && 'w-40',
                      column === 'authors' && 'w-56',
                      column === 'year' && 'w-20 tabular-nums',
                      column === 'publication' && 'w-56',
                      column === 'tags' && 'w-52 px-2',
                      column === 'abstract' && 'w-80',
                      column === 'rating' && 'w-[152px]',
                      column === 'notes' && 'w-[280px]',
                      column === 'url' && 'w-20 text-center'
                    )}
                  >
                    {column.startsWith('journal:') ? (
                      <LiteratureTextTooltip text={tableColumnLabels[column]}>
                        <span className="block max-w-full truncate">
                          {tableColumnLabels[column]}
                        </span>
                      </LiteratureTextTooltip>
                    ) : (
                      tableColumnLabels[column]
                    )}
                  </th>
                ))}
                <th
                  scope="col"
                  className="sticky right-12 z-30 w-28 min-w-28 max-w-28 border-l border-transparent bg-bg-200 group-data-[overflow-right=true]/journal-scroll:border-border-300/60 px-2 py-2.5 text-center text-[11px] whitespace-nowrap before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-2 before:bg-linear-to-l before:from-foreground/5 before:to-transparent before:opacity-0 group-data-[overflow-right=true]/journal-scroll:before:opacity-100"
                >
                  {t('Attachment')}
                </th>
                <th
                  scope="col"
                  className="sticky right-0 z-30 w-12 min-w-12 max-w-12 bg-bg-200 px-2 py-2.5 text-right"
                >
                  <span className="sr-only">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <TooltipProvider disableHoverableContent delayDuration={150} skipDelayDuration={300}>
              <LiteratureRowNumbers.Provider value={rowNumbers}>
                <tbody className="divide-y divide-border-300/70">
                  {items.map((entry) => (
                    <LiteratureItemRow
                      key={entry.id}
                      entry={entry}
                      trash={section === 'trash'}
                      smart={Boolean(selectedCollection?.smart)}
                      smartTableBlocked={smartTableBlocked}
                      isBatching={isBatching}
                      decisionDisabled={
                        isBatching ||
                        pendingDecisions.has(`${collectionId}:${entry.id}`) ||
                        smartRunningCollection === collectionId
                      }
                      updateDisabled={
                        pendingDecisions.has(`${collectionId}:${entry.id}`) ||
                        isBatching ||
                        smartTableBlocked ||
                        !smartView?.configured ||
                        !smartView?.sourceAvailable
                      }
                      completed={
                        completedReevaluation?.collectionId === collectionId &&
                        completedReevaluation?.itemId === entry.id
                      }
                      evaluating={
                        singleReevaluation?.collectionId === collectionId &&
                        singleReevaluation?.itemId === entry.id
                      }
                      attachmentPending={attachmentOperations.some(
                        (operation) => operation.itemId === entry.id && operation.pending
                      )}
                      selectionStore={selectionStore}
                      smartCellActions={smartCellActions}
                      visibleOrderedTableColumns={visibleOrderedTableColumns}
                      itemTypeLabels={itemTypeLabels}
                      actions={rowActions}
                    />
                  ))}
                </tbody>
              </LiteratureRowNumbers.Provider>
            </TooltipProvider>
          </LiteratureTable>
        </LiteratureTableScrollArea>
        {entriesPageTransitionLoading ? (
          <div
            role="status"
            className="pointer-events-none absolute inset-x-0 top-10 bottom-0 z-30 flex items-center justify-center bg-bg-000/80 text-muted-foreground backdrop-blur-[1px]"
          >
            <LoaderCircle
              className="size-5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            <span className="sr-only">{t('Loading…')}</span>
          </div>
        ) : null}
      </div>
      {entriesPagination}
    </div>
  )
}
