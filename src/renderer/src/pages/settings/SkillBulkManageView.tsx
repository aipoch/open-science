import { AlertTriangle, LoaderCircle, SearchX } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { SkillSource } from '../../../../shared/settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import { SettingsSearchInput } from './SettingsSearchInput'

type ManageableSkillSource = Exclude<SkillSource, 'featured'>
type SourceFilter = 'all' | ManageableSkillSource
type StatusFilter = 'all' | 'enabled' | 'disabled'

const SOURCE_LABELS: Record<SourceFilter, string> = {
  all: 'All sources',
  imported: 'Imported',
  personal: 'Personal'
}

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: 'Any status',
  enabled: 'Enabled',
  disabled: 'Disabled'
}

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}

const SkillBulkManageView = (): React.JSX.Element => {
  const skills = useSettingsStore((state) => state.skills)
  const setSkillsEnabled = useSettingsStore((state) => state.setSkillsEnabled)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [query, setQuery] = useState('')
  const [showSelectedOnly, setShowSelectedOnly] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [pendingEnabled, setPendingEnabled] = useState<boolean | undefined>()
  const [bulkError, setBulkError] = useState<string | undefined>()

  const manageableSkills = useMemo(
    () => skills.filter((skill) => skill.source === 'imported' || skill.source === 'personal'),
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
  const busy = pendingEnabled !== undefined

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
  }

  const resetFilters = (): void => {
    setSourceFilter('all')
    setStatusFilter('all')
    setQuery('')
    setShowSelectedOnly(false)
  }

  const updateSelected = async (enabled: boolean): Promise<void> => {
    if (validSelectedIds.size === 0 || busy) return
    setPendingEnabled(enabled)
    setBulkError(undefined)
    try {
      await setSkillsEnabled([...validSelectedIds], enabled)
      setShowSelectedOnly(true)
    } catch (error) {
      setBulkError(
        errorMessage(error) ||
          `Could not ${enabled ? 'enable' : 'disable'} the selected Skills. Try again.`
      )
    } finally {
      setPendingEnabled(undefined)
    }
  }

  return (
    <div className="p-5">
      <p className="text-[13px] leading-5 text-muted-foreground">
        Enable or disable imported and personal Skills in bulk. Featured Skills are not changed.
      </p>

      <div className="sticky top-0 z-10 -mx-5 mt-4 border-y border-border bg-card px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={sourceFilter}
            onValueChange={(value) => {
              setSourceFilter(value as SourceFilter)
              setShowSelectedOnly(false)
            }}
          >
            <SelectTrigger aria-label="Filter manageable skills by source" className="w-36">
              <span>{SOURCE_LABELS[sourceFilter]}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="imported">Imported</SelectItem>
              <SelectItem value="personal">Personal</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value as StatusFilter)
              setShowSelectedOnly(false)
            }}
          >
            <SelectTrigger aria-label="Filter manageable skills by status" className="w-32">
              <span>{STATUS_LABELS[statusFilter]}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              <SelectItem value="enabled">Enabled</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectContent>
          </Select>
          <SettingsSearchInput
            aria-label="Search manageable skills"
            placeholder="Search skills…"
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
          aria-label="Bulk Skill controls"
          className="mt-3 flex min-h-9 flex-wrap items-center gap-1.5"
        >
          <label className="flex min-h-9 items-center gap-1.5 pr-2 text-xs text-muted-foreground [@media(pointer:coarse)]:min-h-11">
            <input
              type="checkbox"
              aria-label="Select all results"
              checked={allResultsSelected}
              onChange={toggleAllResults}
              disabled={busy || resultIds.length === 0}
              className="size-4 shrink-0"
            />
            Select all results
          </label>
          <span className="mr-1 text-xs tabular-nums text-muted-foreground">
            {validSelectedIds.size} selected
          </span>
          <Button
            type="button"
            variant={showSelectedOnly ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={showSelectedOnly}
            onClick={() => setShowSelectedOnly((current) => !current)}
            disabled={busy || validSelectedIds.size === 0}
          >
            Selected ({validSelectedIds.size})
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearSelection}
            disabled={busy || validSelectedIds.size === 0}
          >
            Clear selection
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
                  Enabling…
                </>
              ) : (
                `Enable selected (${validSelectedIds.size})`
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
                  Disabling…
                </>
              ) : (
                `Disable selected (${validSelectedIds.size})`
              )}
            </Button>
          </div>
        </div>
      </div>

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
        <ul className="mt-3 flex flex-col divide-y divide-border">
          {visible.map((skill) => (
            <li
              key={skill.id}
              data-slot="bulk-skill-row"
              className="flex min-h-14 items-center gap-3 py-2.5"
            >
              <span className="flex size-4 shrink-0 items-center justify-center [@media(pointer:coarse)]:size-11">
                <input
                  type="checkbox"
                  aria-label={`Select ${skill.displayName}`}
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
                {skill.source === 'imported' ? 'Imported' : 'Personal'}
              </span>
              <Badge
                variant={skill.enabled ? 'secondary' : 'outline'}
                data-skill-status={skill.enabled ? 'enabled' : 'disabled'}
              >
                {skill.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-start gap-2 py-10 text-sm text-muted-foreground">
          <SearchX className="size-5" aria-hidden="true" />
          <p>
            {showSelectedOnly
              ? 'No Skills are selected.'
              : manageableSkills.length === 0
                ? 'No imported or personal Skills yet.'
                : 'No manageable Skills match these filters.'}
          </p>
          {manageableSkills.length > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={resetFilters}>
              Show all manageable Skills
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}

export { SkillBulkManageView }
