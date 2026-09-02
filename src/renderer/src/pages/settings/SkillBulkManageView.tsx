import { AlertTriangle, LoaderCircle, SearchX, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertDialog } from 'radix-ui'

import type { SkillSource } from '../../../../shared/settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { SettingsSearchInput } from './SettingsSearchInput'
import { specialistsOwningSkill, specialistsUsingSkill } from './specialist-resource-scope'

type ManageableSkillSource = Exclude<SkillSource, 'featured'>
type SourceFilter = 'all' | ManageableSkillSource
type StatusFilter = 'all' | 'enabled' | 'disabled'

const SOURCE_LABEL_KEYS = {
  all: 'All sources',
  imported: 'Imported',
  personal: 'Personal'
} as const satisfies Record<SourceFilter, string>

const STATUS_LABEL_KEYS = {
  all: 'Any status',
  enabled: 'Enabled',
  disabled: 'Disabled'
} as const satisfies Record<StatusFilter, string>

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}

const SkillBulkManageView = (): React.JSX.Element => {
  const { t } = useTranslation()
  const skills = useSettingsStore((state) => state.skills)
  const setSkillsEnabled = useSettingsStore((state) => state.setSkillsEnabled)
  const deleteSkill = useSettingsStore((state) => state.deleteSkill)
  const specialistItems = useSpecialistStore((state) => state.items)
  const loadSpecialists = useSpecialistStore((state) => state.load)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [query, setQuery] = useState('')
  const [showSelectedOnly, setShowSelectedOnly] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [pendingEnabled, setPendingEnabled] = useState<boolean | undefined>()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [bulkError, setBulkError] = useState<string | undefined>()
  const [bulkResult, setBulkResult] = useState<string | undefined>()

  useEffect(() => {
    void loadSpecialists()
  }, [loadSpecialists])

  const manageableSkills = useMemo(
    () =>
      skills.filter(
        (skill) =>
          skill.available !== false && (skill.source === 'imported' || skill.source === 'personal')
      ),
    [skills]
  )
  const manageableIds = useMemo(
    () => new Set(manageableSkills.map((skill) => skill.id)),
    [manageableSkills]
  )
  const validSelectedIds = useMemo(
    () => new Set([...selectedIds].filter((id) => manageableIds.has(id))),
    [manageableIds, selectedIds]
  )

  const filteredSkills = useMemo(() => {
    const term = query.trim().toLowerCase()
    return manageableSkills.filter((skill) => {
      if (sourceFilter !== 'all' && skill.source !== sourceFilter) return false
      if (statusFilter === 'enabled' && !skill.enabled) return false
      if (statusFilter === 'disabled' && skill.enabled) return false
      if (!term) return true
      return (
        skill.displayName.toLowerCase().includes(term) ||
        skill.name.toLowerCase().includes(term) ||
        skill.description.toLowerCase().includes(term)
      )
    })
  }, [manageableSkills, query, sourceFilter, statusFilter])
  const visible = showSelectedOnly
    ? manageableSkills.filter((skill) => validSelectedIds.has(skill.id))
    : filteredSkills

  const resultIds = filteredSkills.map((skill) => skill.id)
  const allResultsSelected =
    resultIds.length > 0 && resultIds.every((id) => validSelectedIds.has(id))
  const selectedSkills = manageableSkills.filter((skill) => validSelectedIds.has(skill.id))
  const deletionPreview = selectedSkills.map((skill) => {
    const owners = specialistsOwningSkill(specialistItems, skill.id)
    const usages = specialistsUsingSkill(specialistItems, skill.id)
    return { skill, owners, usages, protected: owners.length > 0 || usages.length > 0 }
  })
  const deletableSkills = deletionPreview.filter((item) => !item.protected)
  const protectedSkills = deletionPreview.filter((item) => item.protected)
  const busy = pendingEnabled !== undefined || deleteBusy

  const toggleSelected = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAllResults = (): void => {
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => manageableIds.has(id)))
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
  }

  const resetFilters = (): void => {
    setSourceFilter('all')
    setStatusFilter('all')
    setQuery('')
    setShowSelectedOnly(false)
    setBulkResult(undefined)
  }

  const updateSelected = async (enabled: boolean): Promise<void> => {
    if (validSelectedIds.size === 0 || busy) return
    setPendingEnabled(enabled)
    setBulkError(undefined)
    setBulkResult(undefined)
    try {
      await setSkillsEnabled([...validSelectedIds], enabled)
      setShowSelectedOnly(true)
    } catch (error) {
      setBulkError(
        errorMessage(error) ||
          t(
            enabled
              ? 'Could not enable the selected Skills. Try again.'
              : 'Could not disable the selected Skills. Try again.'
          )
      )
    } finally {
      setPendingEnabled(undefined)
    }
  }

  const deleteSelected = async (): Promise<void> => {
    if (deletableSkills.length === 0 || deleteBusy) return
    setDeleteBusy(true)
    setBulkError(undefined)
    setBulkResult(undefined)
    const deletedIds = new Set<string>()
    const failures: string[] = []
    for (const { skill } of deletableSkills) {
      try {
        await deleteSkill(skill.id)
        deletedIds.add(skill.id)
      } catch (error) {
        failures.push(errorMessage(error) || skill.displayName)
      }
    }

    setSelectedIds((current) => new Set([...current].filter((id) => !deletedIds.has(id))))
    setShowSelectedOnly(protectedSkills.length > 0 || failures.length > 0)
    setDeleteOpen(false)
    setDeleteBusy(false)

    if (deletedIds.size > 0) {
      setBulkResult(
        t('Deleted {{count}} Skills.', {
          count: deletedIds.size,
          defaultValue_one: 'Deleted {{count}} Skill.'
        })
      )
    }
    if (failures.length > 0) {
      setBulkError(t('Some selected Skills could not be deleted. They remain selected.'))
    }
  }

  return (
    <div className="p-5">
      <p className="text-[13px] leading-5 text-muted-foreground">
        {t(
          'Enable or disable imported and personal Skills in bulk. Featured Skills are not changed.'
        )}
      </p>

      <div className="sticky top-0 z-10 -mx-5 mt-4 bg-card px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={sourceFilter}
            onValueChange={(value) => {
              setSourceFilter(value as SourceFilter)
              setShowSelectedOnly(false)
            }}
          >
            <SelectTrigger aria-label={t('Filter manageable skills by source')} className="w-36">
              <span>{t(SOURCE_LABEL_KEYS[sourceFilter])}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('All sources')}</SelectItem>
              <SelectItem value="imported">{t('Imported')}</SelectItem>
              <SelectItem value="personal">{t('Personal')}</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value as StatusFilter)
              setShowSelectedOnly(false)
            }}
          >
            <SelectTrigger aria-label={t('Filter manageable skills by status')} className="w-32">
              <span>{t(STATUS_LABEL_KEYS[statusFilter])}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('Any status')}</SelectItem>
              <SelectItem value="enabled">{t('Enabled')}</SelectItem>
              <SelectItem value="disabled">{t('Disabled')}</SelectItem>
            </SelectContent>
          </Select>
          <SettingsSearchInput
            aria-label={t('Search manageable skills')}
            placeholder={t('Search skills…')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setShowSelectedOnly(false)
            }}
            containerClassName="min-w-48"
          />
        </div>

        <div
          role="group"
          aria-label={t('Bulk Skill controls')}
          className="mt-3 flex min-h-9 flex-wrap items-center gap-1.5"
        >
          <label className="flex min-h-9 items-center gap-1.5 pr-2 text-xs text-muted-foreground [@media(pointer:coarse)]:min-h-11">
            <input
              type="checkbox"
              aria-label={t('Select all results')}
              checked={allResultsSelected}
              onChange={toggleAllResults}
              disabled={busy || resultIds.length === 0}
              className="size-4 shrink-0"
            />
            {t('Select all results')}
          </label>
          <span className="mr-1 text-xs tabular-nums text-muted-foreground">
            {t('{{selectedCount}} selected', { selectedCount: validSelectedIds.size })}
          </span>
          <Button
            type="button"
            variant={showSelectedOnly ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={showSelectedOnly}
            onClick={() => setShowSelectedOnly((current) => !current)}
            disabled={busy || validSelectedIds.size === 0}
          >
            {t('Selected ({{selectedCount}})', { selectedCount: validSelectedIds.size })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearSelection}
            disabled={busy || validSelectedIds.size === 0}
          >
            {t('Clear selection')}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void updateSelected(true)}
              disabled={busy || validSelectedIds.size === 0}
            >
              {pendingEnabled === true ? (
                <>
                  <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
                  {t('Enabling…')}
                </>
              ) : (
                t('Enable selected ({{selectedCount}})', {
                  selectedCount: validSelectedIds.size
                })
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void updateSelected(false)}
              disabled={busy || validSelectedIds.size === 0}
            >
              {pendingEnabled === false ? (
                <>
                  <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
                  {t('Disabling…')}
                </>
              ) : (
                t('Disable selected ({{selectedCount}})', {
                  selectedCount: validSelectedIds.size
                })
              )}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                setBulkError(undefined)
                setBulkResult(undefined)
                setDeleteOpen(true)
              }}
              disabled={busy || validSelectedIds.size === 0}
            >
              <Trash2 aria-hidden="true" />
              {t('Delete selected ({{selectedCount}})', {
                selectedCount: validSelectedIds.size
              })}
            </Button>
          </div>
        </div>
      </div>

      {bulkResult ? (
        <p
          role="status"
          className="mt-3 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-foreground"
        >
          {bulkResult}
        </p>
      ) : null}

      {bulkError ? (
        <p
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{bulkError}</span>
        </p>
      ) : null}

      {visible.length > 0 ? (
        <ul className="mt-3 flex flex-col">
          {visible.map((skill) => (
            <li
              key={skill.id}
              data-slot="bulk-skill-row"
              className="flex min-h-14 items-center gap-3 py-2.5"
            >
              <span className="flex size-4 shrink-0 items-center justify-center [@media(pointer:coarse)]:size-11">
                <input
                  type="checkbox"
                  aria-label={t('Select {{name}}', { name: skill.displayName })}
                  checked={validSelectedIds.has(skill.id)}
                  onChange={() => toggleSelected(skill.id)}
                  disabled={busy}
                  className="size-4 shrink-0"
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{skill.displayName}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {skill.description}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {skill.source === 'imported' ? t('Imported') : t('Personal')}
              </span>
              <Badge
                variant={skill.enabled ? 'secondary' : 'outline'}
                data-skill-status={skill.enabled ? 'enabled' : 'disabled'}
              >
                {skill.enabled ? t('Enabled') : t('Disabled')}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-start gap-2 py-10 text-sm text-muted-foreground">
          <SearchX className="size-5" aria-hidden="true" />
          <p>
            {showSelectedOnly
              ? t('No Skills are selected.')
              : manageableSkills.length === 0
                ? t('No imported or personal Skills yet.')
                : t('No manageable Skills match these filters.')}
          </p>
          {manageableSkills.length > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={resetFilters}>
              {t('Show all manageable Skills')}
            </Button>
          ) : null}
        </div>
      )}

      <AlertDialog.Root
        open={deleteOpen}
        onOpenChange={(nextOpen) => {
          if (!deleteBusy) setDeleteOpen(nextOpen)
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            className={dialogPanelClassName('w-[min(520px,calc(100vw-2rem))] max-h-[85vh] p-0')}
          >
            <div data-slot="skill-bulk-delete-header" className={dialogHeaderClassName}>
              <AlertDialog.Title className={dialogTitleClassName}>
                {t('Delete selected Skills?')}
              </AlertDialog.Title>
            </div>

            <div className={`${dialogBodyClassName} max-h-[55vh] overflow-y-auto`}>
              <AlertDialog.Description
                data-slot="skill-bulk-delete-description"
                className={dialogDescriptionClassName}
              >
                {t('Deleted Skills are removed from this device and cannot be recovered.')}
              </AlertDialog.Description>

              <div className="mt-5 space-y-5">
                <section>
                  <h3
                    data-slot="skill-bulk-delete-primary-summary"
                    className="text-base font-semibold leading-6 text-foreground"
                  >
                    {t('{{count}} selected Skills can be deleted.', {
                      count: deletableSkills.length,
                      defaultValue_one: '{{count}} selected Skill can be deleted.'
                    })}
                  </h3>
                  {deletableSkills.length > 0 ? (
                    <ul
                      data-slot="skill-bulk-delete-deletable-list"
                      className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground"
                    >
                      {deletableSkills.map(({ skill }) => (
                        <li key={skill.id} className="truncate">
                          {skill.displayName}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>

                {protectedSkills.length > 0 ? (
                  <section data-slot="skill-bulk-delete-protected-section">
                    <h3
                      data-slot="skill-bulk-delete-protected-summary"
                      className="text-base font-semibold leading-6 text-foreground"
                    >
                      {t('{{count}} protected Skills will be kept.', {
                        count: protectedSkills.length,
                        defaultValue_one: '{{count}} protected Skill will be kept.'
                      })}
                    </h3>
                    <ul
                      data-slot="skill-bulk-delete-protected-list"
                      className="mt-2 space-y-2 text-xs leading-5"
                    >
                      {protectedSkills.map(({ skill, owners, usages }) => (
                        <li key={skill.id}>
                          <p className="truncate text-foreground">{skill.displayName}</p>
                          <p className="text-muted-foreground">
                            {owners.length > 0
                              ? t('Owned by a Specialist.')
                              : t('Used by a Specialist.')}
                            {owners.length + usages.length > 0
                              ? ` ${[...owners, ...usages]
                                  .map((item) => item.name)
                                  .filter((name, index, names) => names.indexOf(name) === index)
                                  .join(', ')}`
                              : ''}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            </div>

            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={dialogCancelButtonClassName}
                  disabled={deleteBusy}
                >
                  {t('Cancel')}
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={deleteBusy || deletableSkills.length === 0}
                  onClick={(event) => {
                    event.preventDefault()
                    void deleteSelected()
                  }}
                >
                  {deleteBusy ? (
                    <>
                      <LoaderCircle
                        className="animate-spin motion-reduce:animate-none"
                        aria-hidden
                      />
                      {t('Deleting…')}
                    </>
                  ) : (
                    t('Delete {{count}} Skills', {
                      count: deletableSkills.length,
                      defaultValue_one: 'Delete {{count}} Skill'
                    })
                  )}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

export { SkillBulkManageView }
