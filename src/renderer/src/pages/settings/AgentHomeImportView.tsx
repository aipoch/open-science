import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  AgentHomeSkillRef,
  AgentHomeSkillSource,
  AgentHomeSkillView
} from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/settings-store'

type AgentHomeImportViewProps = {
  onImported: () => void
}

const SOURCE_INFO: Record<AgentHomeSkillSource, { label: string; path: string }> = {
  agents: { label: 'Shared', path: '~/.agents/skills' },
  claude: { label: 'Claude Code', path: '~/.claude/skills' },
  codex: { label: 'Codex', path: '~/.codex/skills' }
}

const skillKey = (skill: AgentHomeSkillRef): string => `${skill.source}:${skill.slug}`

// Lists skills installed outside Open Science's isolated agent profile, then copies the checked
// directories through the existing imported-skill pipeline. Main owns source routing and path
// containment; this view handles only renderer-safe source ids, slugs, and display metadata.
const AgentHomeImportView = ({ onImported }: AgentHomeImportViewProps): React.JSX.Element => {
  const listAgentHomeSkills = useSettingsStore((state) => state.listAgentHomeSkills)
  const importAgentHomeSkills = useSettingsStore((state) => state.importAgentHomeSkills)
  const activeFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const [scanning, setScanning] = useState(true)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [skills, setSkills] = useState<AgentHomeSkillView[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const frameworkSource =
    activeFrameworkId === 'codex'
      ? SOURCE_INFO.codex
      : activeFrameworkId === 'claude-code'
        ? SOURCE_INFO.claude
        : undefined

  const applyScan = useCallback((items: AgentHomeSkillView[]): void => {
    setSkills(items)
    setSelected(
      new Set(items.filter((skill) => !skill.alreadyImported).map((skill) => skillKey(skill)))
    )
  }, [])

  // Discovery is local and bounded to one directory per visible source, so load eagerly. Including
  // the framework id makes an already-open view follow a framework switch without retaining stale
  // source rows.
  useEffect(() => {
    let cancelled = false
    listAgentHomeSkills()
      .then((items) => {
        if (cancelled) return
        applyScan(items)
      })
      .catch((error) => {
        if (cancelled) return
        setMessage(error instanceof Error ? error.message : 'Scan failed.')
      })
      .finally(() => {
        if (cancelled) return
        setScanning(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeFrameworkId, applyScan, listAgentHomeSkills])

  const selectable = useMemo(
    () => skills?.filter((skill) => !skill.alreadyImported) ?? [],
    [skills]
  )
  const allSelected = selectable.length > 0 && selected.size === selectable.length

  const rescan = async (): Promise<void> => {
    setScanning(true)
    setMessage(null)
    try {
      applyScan(await listAgentHomeSkills())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Scan failed.')
    } finally {
      setScanning(false)
    }
  }

  const toggle = (skill: AgentHomeSkillRef): void =>
    setSelected((previous) => {
      const next = new Set(previous)
      const key = skillKey(skill)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const toggleAll = (): void =>
    setSelected(() =>
      allSelected ? new Set() : new Set(selectable.map((skill) => skillKey(skill)))
    )

  const invertSelection = (): void =>
    setSelected((previous) => {
      const next = new Set<string>()
      for (const skill of selectable) {
        const key = skillKey(skill)
        if (!previous.has(key)) next.add(key)
      }
      return next
    })

  const importSelected = async (): Promise<void> => {
    if (importing || selected.size === 0 || !skills) return

    const requested = skills
      .filter((skill) => selected.has(skillKey(skill)) && !skill.alreadyImported)
      .map(({ source, slug }) => ({ source, slug }))
    if (requested.length === 0) return

    setImporting(true)
    setMessage(null)
    try {
      const result = await importAgentHomeSkills(requested)
      const failures = result.results.filter((item) => item.error !== undefined)
      const importedCount = result.results.length - failures.length

      if (failures.length === 0) {
        setMessage(`Imported ${importedCount} skill${importedCount === 1 ? '' : 's'}.`)
      } else {
        setMessage(
          `Imported ${importedCount}; ${failures.length} failed. ${failures[0]?.error ?? ''}`.trim()
        )
      }
      if (importedCount > 0) onImported()
      applyScan(await listAgentHomeSkills())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not import the selected skills.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="p-5">
      <h2 className="text-base font-semibold text-foreground">Import installed skills</h2>
      <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
        Scan <code className="font-mono">{SOURCE_INFO.agents.path}</code>
        {frameworkSource ? (
          <>
            {' and '}
            <code className="font-mono">{frameworkSource.path}</code>
          </>
        ) : null}{' '}
        on this computer. Check skills to copy into Open Science; the originals stay in place.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void rescan()}
          disabled={scanning || importing}
        >
          {scanning ? 'Scanning…' : 'Rescan'}
        </Button>
        {skills ? (
          <span className="text-xs text-muted-foreground">
            {skills.length} skill{skills.length === 1 ? '' : 's'} found
          </span>
        ) : null}
      </div>
      {message ? <p className="mt-2 text-xs text-muted-foreground">{message}</p> : null}

      {skills && skills.length > 0 ? (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  aria-label="Select all installed skills"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={selectable.length === 0 || importing}
                  className="size-4 shrink-0"
                />
                Select all
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={invertSelection}
                disabled={selectable.length === 0 || importing}
              >
                Invert
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void importSelected()}
              disabled={importing || selected.size === 0}
            >
              {importing ? 'Importing…' : `Import selected (${selected.size})`}
            </Button>
          </div>

          <ul className="mt-2 flex flex-col divide-y divide-border">
            {skills.map((skill) => {
              const source = SOURCE_INFO[skill.source]
              return (
                <li key={skillKey(skill)} className="flex items-center gap-3 py-2.5">
                  <input
                    type="checkbox"
                    aria-label={`Select ${skill.name}`}
                    checked={selected.has(skillKey(skill))}
                    onChange={() => toggle(skill)}
                    disabled={skill.alreadyImported || importing}
                    className="size-4 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{skill.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {skill.description || skill.slug} · {source.path}
                    </span>
                  </div>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {skill.alreadyImported ? 'Imported' : source.label}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      ) : !scanning && skills && skills.length === 0 ? (
        <p className="mt-5 text-xs text-muted-foreground">
          No installed skills found in the scanned global folders.
        </p>
      ) : null}
    </div>
  )
}

export { AgentHomeImportView }
