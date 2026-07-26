import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AgentFrameworkId,
  AgentHomeSkillRef,
  AgentHomeSkillSource,
  AgentHomeSkillView
} from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/settings-store'
import { SkillImportCandidatePreview } from './SkillImportCandidatePreview'
import { useSkillImportCandidatePreview } from './useSkillImportCandidatePreview'

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
  const previewAgentHomeSkill = useSettingsStore((state) => state.previewAgentHomeSkill)
  const activeFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const [scanning, setScanning] = useState(true)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [skills, setSkills] = useState<AgentHomeSkillView[] | null>(null)
  const [skillsFrameworkId, setSkillsFrameworkId] = useState<AgentFrameworkId | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const scanGeneration = useRef(0)
  const candidatePreview = useSkillImportCandidatePreview()
  const invalidateCandidatePreview = candidatePreview.invalidatePreview

  const frameworkSource =
    activeFrameworkId === 'codex'
      ? SOURCE_INFO.codex
      : activeFrameworkId === 'claude-code'
        ? SOURCE_INFO.claude
        : undefined

  const applyScan = useCallback(
    (items: AgentHomeSkillView[], frameworkId: AgentFrameworkId): void => {
      setSkills(items)
      setSkillsFrameworkId(frameworkId)
      setSelected(
        new Set(items.filter((skill) => !skill.alreadyImported).map((skill) => skillKey(skill)))
      )
    },
    []
  )

  // Every scan entry point shares one generation. A framework switch or newer manual/post-import
  // refresh invalidates older requests, so late results can never restore rows from a stale source.
  const runScan = useCallback(
    async (
      frameworkId: AgentFrameworkId,
      options: { preserveMessage?: boolean } = {}
    ): Promise<void> => {
      if (useSettingsStore.getState().agentFrameworkId !== frameworkId) return
      invalidateCandidatePreview()
      const generation = ++scanGeneration.current
      const isCurrent = (): boolean =>
        scanGeneration.current === generation &&
        useSettingsStore.getState().agentFrameworkId === frameworkId

      try {
        const items = await listAgentHomeSkills()
        if (!isCurrent()) return
        if (!options.preserveMessage) setMessage(null)
        applyScan(items, frameworkId)
      } catch (error) {
        if (!isCurrent()) return
        setSkills(null)
        setSkillsFrameworkId(frameworkId)
        setSelected(new Set())
        setMessage(error instanceof Error ? error.message : 'Scan failed.')
      } finally {
        if (isCurrent()) setScanning(false)
      }
    },
    [applyScan, invalidateCandidatePreview, listAgentHomeSkills]
  )

  // Discovery is local and bounded to one directory per visible source, so load eagerly. Including
  // the framework id makes an already-open view follow a framework switch without retaining stale
  // source rows.
  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) void runScan(activeFrameworkId)
    })

    return () => {
      cancelled = true
      scanGeneration.current += 1
    }
  }, [activeFrameworkId, runScan])

  const currentSkills = skillsFrameworkId === activeFrameworkId ? skills : null
  const isScanning = scanning || skillsFrameworkId !== activeFrameworkId

  const selectable = useMemo(
    () => currentSkills?.filter((skill) => !skill.alreadyImported) ?? [],
    [currentSkills]
  )
  const allSelected = selectable.length > 0 && selected.size === selectable.length

  const rescan = async (): Promise<void> => {
    setScanning(true)
    setMessage(null)
    await runScan(activeFrameworkId)
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
    if (isScanning || importing || selected.size === 0 || !currentSkills) return
    const frameworkId = activeFrameworkId

    const requested = currentSkills
      .filter((skill) => selected.has(skillKey(skill)) && !skill.alreadyImported)
      .map(({ source, slug }) => ({ source, slug }))
    if (requested.length === 0) return

    setImporting(true)
    setMessage(null)
    try {
      const result = await importAgentHomeSkills(requested)
      const failures = result.results.filter((item) => item.error !== undefined)
      const importedCount = result.results.length - failures.length
      if (importedCount > 0) onImported()
      if (useSettingsStore.getState().agentFrameworkId !== frameworkId) return

      if (failures.length === 0) {
        setMessage(`Imported ${importedCount} skill${importedCount === 1 ? '' : 's'}.`)
      } else {
        setMessage(
          `Imported ${importedCount}; ${failures.length} failed. ${failures[0]?.error ?? ''}`.trim()
        )
      }
      await runScan(frameworkId, { preserveMessage: true })
    } catch (error) {
      if (useSettingsStore.getState().agentFrameworkId === frameworkId) {
        setMessage(error instanceof Error ? error.message : 'Could not import the selected skills.')
      }
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
          disabled={isScanning || importing}
        >
          {isScanning ? 'Scanning…' : 'Rescan'}
        </Button>
        {currentSkills ? (
          <span className="text-xs text-muted-foreground">
            {currentSkills.length} skill{currentSkills.length === 1 ? '' : 's'} found
          </span>
        ) : null}
      </div>
      {skillsFrameworkId === activeFrameworkId && message ? (
        <p className="mt-2 text-xs text-muted-foreground">{message}</p>
      ) : null}

      {currentSkills && currentSkills.length > 0 ? (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  aria-label="Select all installed skills"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={isScanning || selectable.length === 0 || importing}
                  className="size-4 shrink-0"
                />
                Select all
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={invertSelection}
                disabled={isScanning || selectable.length === 0 || importing}
              >
                Invert
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void importSelected()}
              disabled={isScanning || importing || selected.size === 0}
            >
              {importing ? 'Importing…' : `Import selected (${selected.size})`}
            </Button>
          </div>

          <ul className="mt-2 flex flex-col divide-y divide-border">
            {currentSkills.map((skill) => {
              const source = SOURCE_INFO[skill.source]
              return (
                <li key={skillKey(skill)} className="flex items-center gap-3 py-2.5">
                  <input
                    type="checkbox"
                    aria-label={`Select ${skill.name}`}
                    checked={selected.has(skillKey(skill))}
                    onChange={() => toggle(skill)}
                    disabled={isScanning || skill.alreadyImported || importing}
                    className="size-4 shrink-0"
                  />
                  <button
                    type="button"
                    aria-label={`Preview ${skill.name}`}
                    onClick={() =>
                      candidatePreview.openPreview(() =>
                        previewAgentHomeSkill({ source: skill.source, slug: skill.slug })
                      )
                    }
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 px-1 py-1">
                      <span className="block truncate text-sm text-foreground">{skill.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {skill.description || skill.slug} · {source.path}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {skill.alreadyImported ? 'Imported' : source.label}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : !isScanning && currentSkills && currentSkills.length === 0 ? (
        <p className="mt-5 text-xs text-muted-foreground">
          No installed skills found in the scanned global folders.
        </p>
      ) : null}

      <SkillImportCandidatePreview {...candidatePreview.previewProps} />
    </div>
  )
}

export { AgentHomeImportView }
