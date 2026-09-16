import { ErrorNotice } from '@/components/error-notice'
import { LoaderCircle, SearchX, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { SkillSource } from '../../../../shared/settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BatchManageLayout, BatchManageReview } from './BatchManageLayout'
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
  const operationRef = useRef(false)

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

  const resultIds = visible.map((skill) => skill.id)
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
    if (validSelectedIds.size === 0 || operationRef.current) return
    operationRef.current = true
    setPendingEnabled(enabled)
    setBulkError(undefined)
    setBulkResult(undefined)
    try {
      await setSkillsEnabled([...validSelectedIds], enabled)
      setShowSelectedOnly(true)
      setBulkResult(
        t('Updated: {{completed}} / {{total}}', {
          completed: validSelectedIds.size,
          total: validSelectedIds.size
        })
      )
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
      operationRef.current = false
    }
  }

  const deleteSelected = async (): Promise<void> => {
    if (deletableSkills.length === 0 || operationRef.current) return
    operationRef.current = true
    setDeleteBusy(true)
    setBulkError(undefined)
    setBulkResult(undefined)
    const deletedIds = new Set<string>()
    const failures: string[] = []
    for (const { skill } of deletableSkills) {
      if (skill.source === 'featured') continue
      try {
        await deleteSkill(skill.id, skill.source, skill.directoryName)
        deletedIds.add(skill.id)
      } catch (error) {
        failures.push(errorMessage(error) || skill.displayName)
      }
    }

    setSelectedIds((current) => new Set([...current].filter((id) => !deletedIds.has(id))))
    setShowSelectedOnly(protectedSkills.length > 0 || failures.length > 0)
    setDeleteOpen(false)
    setDeleteBusy(false)
    operationRef.current = false

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
    <BatchManageLayout
      description={
        <>
          {t(
            'Enable or disable imported and personal Skills in bulk. Featured Skills are not changed.'
          )}
        </>
      }
      filters={
        <>
          <SettingsSearchInput
            disabled={busy || deleteOpen}
            aria-label={t('Search manageable skills')}
            placeholder={t('Search skills…')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setShowSelectedOnly(false)
            }}
            containerClassName="min-w-0 flex-[2] @max-[30rem]:[&>span]:hidden!"
            className="@max-[30rem]:[&:placeholder-shown:not(:focus)]:pr-2.5"
          />
          <Select
            disabled={busy || deleteOpen}
            value={sourceFilter}
            onValueChange={(value) => {
              setSourceFilter(value as SourceFilter)
              setShowSelectedOnly(false)
            }}
          >
            <SelectTrigger
              aria-label={t('Filter manageable skills by source')}
              className="min-w-0 flex-1 @min-[30rem]:flex-none w-36"
            >
              <span>{t(SOURCE_LABEL_KEYS[sourceFilter])}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('All sources')}</SelectItem>
              <SelectItem value="imported">{t('Imported')}</SelectItem>
              <SelectItem value="personal">{t('Personal')}</SelectItem>
            </SelectContent>
          </Select>
          <Select
            disabled={busy || deleteOpen}
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value as StatusFilter)
              setShowSelectedOnly(false)
            }}
          >
            <SelectTrigger
              aria-label={t('Filter manageable skills by status')}
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
      controlsLabel={t('Bulk Skill controls')}
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
            onClick={() => {
              if (operationRef.current) return
              setBulkError(undefined)
              setBulkResult(undefined)
              setDeleteOpen(true)
            }}
            disabled={busy || validSelectedIds.size === 0}
          >
            <Trash2 aria-hidden="true" />
            {t('Delete…')}
          </Button>
        </>
      }
      feedback={
        bulkError || bulkResult ? (
          <>
            {bulkResult ? (
              <p role="status" className="text-sm font-medium text-foreground">
                {bulkResult}
              </p>
            ) : null}
            {bulkError ? <ErrorNotice role="alert" tone="amber" description={bulkError} /> : null}
          </>
        ) : undefined
      }
      onDone={
        bulkError || bulkResult
          ? () => {
              setBulkError(undefined)
              setBulkResult(undefined)
            }
          : undefined
      }
      review={
        deleteOpen ? (
          <BatchManageReview
            title={t('Delete selected Skills?')}
            description={
              <p
                data-slot="skill-bulk-delete-description"
                className="text-xs leading-5 text-muted-foreground"
              >
                {t('Deleted Skills are removed from this device and cannot be recovered.')}
              </p>
            }
            summary={
              <>
                <h3
                  data-slot="skill-bulk-delete-primary-summary"
                  className="text-sm font-medium leading-5 text-foreground"
                >
                  {t('{{count}} selected Skills can be deleted.', {
                    count: deletableSkills.length,
                    defaultValue_one: '{{count}} selected Skill can be deleted.'
                  })}
                </h3>
                {protectedSkills.length > 0 ? (
                  <h3
                    data-slot="skill-bulk-delete-protected-summary"
                    className="text-sm font-medium leading-5 text-foreground"
                  >
                    {t('{{count}} protected Skills will be kept.', {
                      count: protectedSkills.length,
                      defaultValue_one: '{{count}} protected Skill will be kept.'
                    })}
                  </h3>
                ) : null}
              </>
            }
            details={
              <>
                {deletableSkills.length > 0 ? (
                  <ul
                    data-slot="skill-bulk-delete-deletable-list"
                    className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground"
                  >
                    {deletableSkills.map(({ skill }) => (
                      <li key={skill.id} className="break-words">
                        {skill.displayName}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {protectedSkills.length > 0 ? (
                  <ul
                    data-slot="skill-bulk-delete-protected-list"
                    className="mt-2 space-y-2 text-xs leading-5"
                  >
                    {protectedSkills.map(({ skill, owners, usages }) => (
                      <li key={skill.id}>
                        <p className="break-words text-foreground">{skill.displayName}</p>
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
                disabled={deleteBusy || deletableSkills.length === 0}
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
                    t('Delete {{count}} Skills', {
                      count: deletableSkills.length,
                      defaultValue_one: 'Delete {{count}} Skill'
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
          {visible.map((skill) => (
            <li key={skill.id} data-slot="bulk-skill-row" className="min-w-0">
              <label className="flex min-h-14 min-w-0 cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring has-[:disabled]:cursor-default has-[:disabled]:opacity-60 [@media(hover:hover)]:hover:bg-muted/60">
                <span className="flex size-4 shrink-0 items-center justify-center [@media(pointer:coarse)]:size-11">
                  <input
                    type="checkbox"
                    aria-label={t('Select {{name}}', { name: skill.displayName })}
                    checked={validSelectedIds.has(skill.id)}
                    onChange={() => toggleSelected(skill.id)}
                    disabled={busy || deleteOpen}
                    className="size-4 shrink-0 accent-primary"
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {skill.displayName}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {skill.description}
                  </span>
                </span>
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                  {skill.source === 'imported' ? t('Imported') : t('Personal')}
                </span>
                <Badge
                  variant={skill.enabled ? 'secondary' : 'outline'}
                  data-skill-status={skill.enabled ? 'enabled' : 'disabled'}
                >
                  {skill.enabled ? t('Enabled') : t('Disabled')}
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
              ? t('No Skills are selected.')
              : manageableSkills.length === 0
                ? t('No imported or personal Skills yet.')
                : t('No manageable Skills match these filters.')}
          </p>
          {manageableSkills.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resetFilters}
              disabled={busy || deleteOpen}
            >
              {t('Show all manageable Skills')}
            </Button>
          ) : null}
        </div>
      )}
    </BatchManageLayout>
  )
}

export { SkillBulkManageView }
