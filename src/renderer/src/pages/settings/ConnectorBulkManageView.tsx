import { ErrorNotice } from '@/components/error-notice'
import { LoaderCircle, SearchX, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { CustomServerView } from '../../../../shared/settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BatchManageLayout, BatchManageReview } from './BatchManageLayout'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import type { SpecialistListItem } from '../../../../shared/specialist'
import { SettingsSearchInput } from './SettingsSearchInput'
import { SettingsLoadNotice } from './SettingsLayout'
import { specialistsUsingConnector, type SpecialistUsage } from './specialist-resource-scope'
import { cannotEnableCustomServer } from './connector-enablement'

type GroupFilter = 'all' | 'featured' | 'directory' | 'custom'
type StatusFilter = 'all' | 'enabled' | 'disabled'
type ConnectorRow = {
  id: string
  name: string
  displayName: string
  description: string
  enabled: boolean
  group: Exclude<GroupFilter, 'all'>
  custom?: CustomServerView
}
type DeletionEntry = { connector: ConnectorRow; usages: SpecialistUsage[] }

const GROUP_LABEL_KEYS = {
  all: 'All groups',
  featured: 'Featured',
  directory: 'Directory',
  custom: 'Custom'
} as const satisfies Record<GroupFilter, string>
const STATUS_LABEL_KEYS = {
  all: 'Any status',
  enabled: 'Enabled',
  disabled: 'Disabled'
} as const satisfies Record<StatusFilter, string>

const ConnectorBulkManageView = (): React.JSX.Element => {
  const { t } = useTranslation()
  const connectors = useSettingsStore((state) => state.connectors)
  const customServers = useSettingsStore((state) => state.customServers)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [query, setQuery] = useState('')
  const [showSelectedOnly, setShowSelectedOnly] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [pendingEnabled, setPendingEnabled] = useState<boolean | undefined>()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [checkingDeletion, setCheckingDeletion] = useState(false)
  const [deletionPreview, setDeletionPreview] = useState<DeletionEntry[]>([])
  const [bulkError, setBulkError] = useState<string | undefined>()
  const [bulkResult, setBulkResult] = useState<string | undefined>()
  const [incompleteDeletions, setIncompleteDeletions] = useState<ConnectorRow[]>([])
  const operationRef = useRef(false)
  const busy = pendingEnabled !== undefined || deleteBusy || checkingDeletion

  useEffect(() => {
    let active = true
    void loadConnectors().then(
      () => {
        if (active) setLoadState('ready')
      },
      () => {
        if (active) setLoadState('error')
      }
    )
    return () => {
      active = false
    }
  }, [loadConnectors, loadAttempt])

  const manageableConnectors = useMemo<ConnectorRow[]>(
    () =>
      [
        ...connectors.map((connector) => ({
          ...connector,
          group: connector.group ?? ('featured' as const)
        })),
        ...customServers.map((server) => ({
          id: server.id,
          name: server.name,
          displayName: server.displayName,
          description: server.description ?? server.name,
          enabled: server.enabled,
          group: 'custom' as const,
          custom: server
        }))
      ].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [connectors, customServers]
  )
  const validSelectedIds = new Set(
    manageableConnectors.filter((item) => selectedIds.has(item.id)).map((item) => item.id)
  )
  const filteredConnectors = manageableConnectors.filter((item) => {
    if (groupFilter !== 'all' && item.group !== groupFilter) return false
    if (statusFilter !== 'all' && item.enabled !== (statusFilter === 'enabled')) return false
    const term = query.trim().toLowerCase()
    return (
      !term ||
      [item.name, item.displayName, item.description].some((text) =>
        text.toLowerCase().includes(term)
      )
    )
  })
  const visible = showSelectedOnly
    ? manageableConnectors.filter((item) => validSelectedIds.has(item.id))
    : filteredConnectors
  const resultIds = visible.map((item) => item.id)
  const allResultsSelected =
    resultIds.length > 0 && resultIds.every((id) => validSelectedIds.has(id))
  const selectedConnectors = manageableConnectors.filter((item) => validSelectedIds.has(item.id))
  const deletableConnectors = deletionPreview.filter(
    ({ connector, usages }) => connector.custom && usages.length === 0
  )
  const protectedConnectors = deletionPreview.filter(
    ({ connector, usages }) => !connector.custom || usages.length > 0
  )

  const toggleSelected = (id: string): void => {
    if (operationRef.current || deleteOpen) return
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAllResults = (): void => {
    if (operationRef.current || deleteOpen) return
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const id of resultIds) {
        if (allResultsSelected) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }
  const clearSelection = (): void => {
    setSelectedIds(new Set())
    setShowSelectedOnly(false)
    setBulkError(undefined)
    setBulkResult(undefined)
    setIncompleteDeletions([])
  }
  const resetFilters = (): void => {
    setGroupFilter('all')
    setStatusFilter('all')
    setQuery('')
    setShowSelectedOnly(false)
  }

  const updateSelected = async (enabled: boolean): Promise<void> => {
    if (operationRef.current || selectedConnectors.length === 0) return
    operationRef.current = true
    setPendingEnabled(enabled)
    setBulkError(undefined)
    setBulkResult(undefined)
    const failed: ConnectorRow[] = []
    // Snapshot targets and serialize existing commands: each response reconciles the entire catalog.
    for (const connector of selectedConnectors) {
      try {
        const store = useSettingsStore.getState()
        if (connector.custom) {
          const current = store.customServers.find((item) => item.id === connector.id)
          if (!current || (enabled && cannotEnableCustomServer(current)))
            throw new Error('Unavailable')
          if (current.enabled !== enabled) await store.setCustomServerEnabled(connector.id, enabled)
        } else {
          const current = store.connectors.find((item) => item.id === connector.id)
          if (!current) throw new Error('Unavailable')
          if (current.enabled !== enabled) await store.setConnectorEnabled(connector.id, enabled)
        }
      } catch {
        failed.push(connector)
      }
    }
    if (failed.length > 0) {
      setSelectedIds(new Set(failed.map((item) => item.id)))
      setBulkError(
        t(
          'Could not update these Connectors: {{names}}. They remain selected. Check their configuration and try again.',
          { names: failed.map((item) => item.displayName).join(', ') }
        )
      )
    }
    setBulkResult(
      t('Updated: {{completed}} / {{total}}', {
        completed: selectedConnectors.length - failed.length,
        total: selectedConnectors.length
      })
    )
    setShowSelectedOnly(true)
    setPendingEnabled(undefined)
    operationRef.current = false
  }

  const refreshSpecialistUsage = async (): Promise<SpecialistListItem[]> => {
    if (typeof window.api?.specialist?.list !== 'function') throw new Error('Usage unavailable')
    // Consume this request's snapshot directly; a store refresh may be superseded concurrently.
    const snapshot = await window.api.specialist.list()
    if (snapshot.integrity.status !== 'ok') throw new Error('Usage unavailable')
    return snapshot.items
  }

  const retryCleanup = async (): Promise<void> => {
    if (operationRef.current) return
    operationRef.current = true
    setDeleteBusy(true)
    const failed: ConnectorRow[] = []
    const remaining: string[] = []
    for (const connector of incompleteDeletions) {
      try {
        const snapshot = await window.api.settings.listConnectors()
        if (snapshot.customServers.some((item) => item.id === connector.id)) {
          // Existing (or recreated) configurations need a new reviewed deletion, not cleanup retry.
          remaining.push(connector.displayName)
        } else if (snapshot.reservedCustomServerIds?.includes(connector.id)) {
          await useSettingsStore.getState().removeCustomServer(connector.id)
        }
      } catch {
        failed.push(connector)
      }
    }
    setIncompleteDeletions(failed)
    if (remaining.length > 0)
      setBulkError(
        t('These Connectors were not deleted: {{names}}. Review their usage and try again.', {
          names: remaining.join(', ')
        })
      )
    setDeleteBusy(false)
    operationRef.current = false
  }

  const previewDeletion = async (): Promise<void> => {
    if (operationRef.current || selectedConnectors.length === 0) return
    operationRef.current = true
    setCheckingDeletion(true)
    setBulkError(undefined)
    setBulkResult(undefined)
    try {
      const items = await refreshSpecialistUsage()
      setDeletionPreview(
        selectedConnectors.map((connector) => ({
          connector,
          usages: specialistsUsingConnector(items, connector)
        }))
      )
      setDeleteOpen(true)
    } catch {
      setBulkError(t('Could not check Specialist usage. Try again before deleting Connectors.'))
    } finally {
      setCheckingDeletion(false)
      operationRef.current = false
    }
  }

  const deleteSelected = async (): Promise<void> => {
    if (operationRef.current || deletableConnectors.length === 0) return
    operationRef.current = true
    setDeleteBusy(true)
    setBulkError(undefined)
    const deleted = new Set<string>()
    const kept: string[] = []
    try {
      const items = await refreshSpecialistUsage()
      // Only remove reviewed targets. A newly referenced Connector is kept, never forced through.
      for (const { connector } of deletableConnectors) {
        const current = useSettingsStore
          .getState()
          .customServers.find((item) => item.id === connector.id)
        if (!current || specialistsUsingConnector(items, current).length > 0) {
          kept.push(connector.displayName)
          continue
        }
        try {
          await useSettingsStore.getState().removeCustomServer(connector.id)
          deleted.add(connector.id)
          setIncompleteDeletions((previous) => previous.filter((item) => item.id !== connector.id))
        } catch {
          // Removal persists before cleanup. Keep the reviewed identity even if the catalog drops it.
          setIncompleteDeletions((previous) => [
            ...previous.filter((item) => item.id !== connector.id),
            connector
          ])
        }
      }
      setSelectedIds((current) => new Set([...current].filter((id) => !deleted.has(id))))
      setShowSelectedOnly(true)
      setDeleteOpen(false)
      setBulkResult(
        t('Deleted: {{completed}} / {{total}}', {
          completed: deleted.size,
          total: deletableConnectors.length
        })
      )
      if (kept.length > 0)
        setBulkError(
          t('These Connectors were not deleted: {{names}}. Review their usage and try again.', {
            names: kept.join(', ')
          })
        )
    } catch {
      setDeleteOpen(false)
      setBulkError(t('Could not check Specialist usage. Try again before deleting Connectors.'))
    } finally {
      setDeleteBusy(false)
      operationRef.current = false
    }
  }

  if (loadState !== 'ready')
    return (
      <div className="p-5">
        <SettingsLoadNotice
          state={loadState}
          loadingLabel={t('Loading Connectors…')}
          errorMessage={t('Open Science could not load Connectors.')}
          onRetry={() => {
            setLoadState('loading')
            setLoadAttempt((value) => value + 1)
          }}
        />
      </div>
    )

  return (
    <BatchManageLayout
      description={
        <>
          {t(
            'Changes to Main Agent availability are saved for future sessions. Specialist assignments and approval settings are unchanged.'
          )}
        </>
      }
      filters={
        <>
          <SettingsSearchInput
            aria-label={t('Search manageable connectors')}
            placeholder={t('Search connectors…')}
            value={query}
            disabled={busy || deleteOpen}
            onChange={(event) => {
              setQuery(event.target.value)
              setShowSelectedOnly(false)
            }}
            containerClassName="min-w-0 flex-[2] @max-[30rem]:[&>span]:hidden!"
            className="@max-[30rem]:[&:placeholder-shown:not(:focus)]:pr-2.5"
          />
          <Select
            value={groupFilter}
            disabled={busy || deleteOpen}
            onValueChange={(value) => {
              setGroupFilter(value as GroupFilter)
              setShowSelectedOnly(false)
            }}
          >
            <SelectTrigger
              aria-label={t('Filter manageable connectors by group')}
              className="min-w-0 flex-1 @min-[30rem]:flex-none w-36"
            >
              <span>{t(GROUP_LABEL_KEYS[groupFilter])}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('All groups')}</SelectItem>
              <SelectItem value="featured">{t('Featured')}</SelectItem>
              <SelectItem value="directory">{t('Directory')}</SelectItem>
              <SelectItem value="custom">{t('Custom')}</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={statusFilter}
            disabled={busy || deleteOpen}
            onValueChange={(value) => {
              setStatusFilter(value as StatusFilter)
              setShowSelectedOnly(false)
            }}
          >
            <SelectTrigger
              aria-label={t('Filter manageable connectors by status')}
              className="min-w-0 flex-1 @min-[30rem]:flex-none w-32"
            >
              <span>{t(STATUS_LABEL_KEYS[statusFilter])}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('Any status')}</SelectItem>
              <SelectItem value="enabled">{t('Enabled')}</SelectItem>
              <SelectItem value="disabled">{t('Disabled')}</SelectItem>
            </SelectContent>
          </Select>
        </>
      }
      controlsLabel={t('Bulk Connector controls')}
      visibleCount={visible.length}
      visibleSelectedCount={visible.filter((item) => validSelectedIds.has(item.id)).length}
      selectedCount={validSelectedIds.size}
      selectedOnly={showSelectedOnly}
      busy={busy}
      onToggleAll={toggleAllResults}
      onToggleSelectedOnly={() => setShowSelectedOnly((current) => !current)}
      onClear={clearSelection}
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void updateSelected(true)}
            disabled={busy || validSelectedIds.size === 0}
            aria-busy={Boolean(pendingEnabled === true)}
          >
            <span key={String(pendingEnabled === true)} className="button-feedback">
              {pendingEnabled === true ? (
                <>
                  <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
                  {t('Enabling…')}
                </>
              ) : (
                t('Enable')
              )}
            </span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void updateSelected(false)}
            disabled={busy || validSelectedIds.size === 0}
            aria-busy={Boolean(pendingEnabled === false)}
          >
            <span key={String(pendingEnabled === false)} className="button-feedback">
              {pendingEnabled === false ? (
                <>
                  <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
                  {t('Disabling…')}
                </>
              ) : (
                t('Disable')
              )}
            </span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            data-batch-delete-trigger
            className="text-destructive hover:text-destructive"
            size="sm"
            onClick={() => void previewDeletion()}
            disabled={busy || validSelectedIds.size === 0}
            aria-busy={Boolean(checkingDeletion)}
          >
            <span key={String(checkingDeletion)} className="button-feedback">
              {checkingDeletion ? (
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Trash2 aria-hidden="true" />
              )}
              {t('Delete…')}
            </span>
          </Button>
        </>
      }
      feedback={
        bulkError || bulkResult || incompleteDeletions.length > 0 ? (
          <>
            {bulkResult ? (
              <p role="status" className="text-sm font-medium text-foreground">
                {bulkResult}
              </p>
            ) : null}
            {incompleteDeletions.length > 0 ? (
              <ErrorNotice
                role="alert"
                tone="amber"
                description={t(
                  'Deletion or cleanup did not finish for: {{names}}. Retry cleanup; any remaining configurations require a new deletion confirmation.',
                  { names: incompleteDeletions.map((item) => item.displayName).join(', ') }
                )}
                primaryButton={{
                  label: t('Retry cleanup'),
                  onClick: () => void retryCleanup(),
                  disabled: busy || deleteOpen,
                  loading: deleteBusy
                }}
              />
            ) : null}
            {bulkError ? (
              <ErrorNotice inline role="alert" tone="amber" description={bulkError} />
            ) : null}
          </>
        ) : undefined
      }
      onDone={
        bulkError || bulkResult || incompleteDeletions.length > 0
          ? () => {
              setBulkError(undefined)
              setBulkResult(undefined)
              setIncompleteDeletions([])
            }
          : undefined
      }
      review={
        deleteOpen ? (
          <BatchManageReview
            title={t('Delete selected Connectors?')}
            description={
              <p
                data-slot="connector-bulk-delete-description"
                className="text-xs leading-5 text-muted-foreground"
              >
                {t(
                  'Selected custom Connector configurations will be removed from this device. Shared credentials are kept.'
                )}
              </p>
            }
            summary={
              <>
                <h3
                  data-slot="connector-bulk-delete-primary-summary"
                  className="text-sm font-medium leading-5 text-foreground"
                >
                  {t('{{count}} selected Connectors can be deleted.', {
                    count: deletableConnectors.length,
                    defaultValue_one: '{{count}} selected Connector can be deleted.'
                  })}
                </h3>
                {protectedConnectors.length > 0 ? (
                  <h3
                    data-slot="connector-bulk-delete-protected-summary"
                    className="text-sm font-medium leading-5 text-foreground"
                  >
                    {t('{{count}} protected Connectors will be kept.', {
                      count: protectedConnectors.length,
                      defaultValue_one: '{{count}} protected Connector will be kept.'
                    })}
                  </h3>
                ) : null}
              </>
            }
            details={
              <>
                {deletableConnectors.length > 0 ? (
                  <ul
                    data-slot="connector-bulk-delete-deletable-list"
                    className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground"
                  >
                    {deletableConnectors.map(({ connector }) => (
                      <li key={connector.id} className="break-words">
                        {connector.displayName}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {protectedConnectors.length > 0 ? (
                  <ul
                    data-slot="connector-bulk-delete-protected-list"
                    className="mt-2 space-y-2 text-xs leading-5"
                  >
                    {protectedConnectors.map(({ connector, usages }) => (
                      <li key={connector.id}>
                        <p className="break-words text-foreground">{connector.displayName}</p>
                        <p className="text-muted-foreground">
                          {connector.custom ? t('Used by a Specialist.') : t('Built-in Connector.')}
                          {usages.length > 0
                            ? ` ${usages.map((item) => item.name).join(', ')}`
                            : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            }
            busy={busy}
            onCancel={() => setDeleteOpen(false)}
            actions={
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy || deletableConnectors.length === 0}
                onClick={(event) => {
                  event.preventDefault()
                  void deleteSelected()
                }}
                aria-busy={Boolean(deleteBusy)}
              >
                <span key={String(deleteBusy)} className="button-feedback">
                  {deleteBusy ? (
                    <>
                      <LoaderCircle
                        className="animate-spin motion-reduce:animate-none"
                        aria-hidden
                      />
                      {t('Deleting…')}
                    </>
                  ) : (
                    t('Delete {{count}} Connectors', {
                      count: deletableConnectors.length,
                      defaultValue_one: 'Delete {{count}} Connector'
                    })
                  )}
                </span>
              </Button>
            }
          />
        ) : undefined
      }
    >
      {visible.length > 0 ? (
        <ul className="mt-3 flex flex-col">
          {visible.map((connector) => (
            <li key={connector.id} data-slot="bulk-connector-row" className="min-w-0">
              <label className="flex min-h-14 min-w-0 cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring has-[:disabled]:cursor-default has-[:disabled]:opacity-60 [@media(hover:hover)]:hover:bg-muted/60">
                <span className="flex size-4 shrink-0 items-center justify-center [@media(pointer:coarse)]:size-11">
                  <input
                    type="checkbox"
                    aria-label={t('Select {{name}}', { name: connector.displayName })}
                    checked={validSelectedIds.has(connector.id)}
                    onChange={() => toggleSelected(connector.id)}
                    disabled={busy || deleteOpen}
                    className="size-4 shrink-0 accent-primary"
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {connector.displayName}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {connector.description}
                  </span>
                  {connector.custom && cannotEnableCustomServer(connector.custom) ? (
                    <span className="block text-xs text-muted-foreground">
                      {t('Sign in or configure credentials before enabling this Connector.')}
                    </span>
                  ) : null}
                </span>
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                  {t(GROUP_LABEL_KEYS[connector.group])}
                </span>
                <Badge
                  variant={connector.enabled ? 'secondary' : 'outline'}
                  data-connector-status={connector.enabled ? 'enabled' : 'disabled'}
                >
                  {connector.enabled ? t('Enabled') : t('Disabled')}
                </Badge>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-start gap-2 py-10 text-sm text-muted-foreground">
          <SearchX className="size-5" aria-hidden="true" />
          <p>
            {showSelectedOnly
              ? t('No Connectors are selected.')
              : manageableConnectors.length === 0
                ? t('No connectors yet.')
                : t('No manageable Connectors match these filters.')}
          </p>
          {manageableConnectors.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resetFilters}
              disabled={busy || deleteOpen}
            >
              {t('Show all manageable Connectors')}
            </Button>
          ) : null}
        </div>
      )}
    </BatchManageLayout>
  )
}

export { ConnectorBulkManageView }
