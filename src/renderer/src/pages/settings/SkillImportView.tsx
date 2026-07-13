import { useState } from 'react'

import type { ScannedSkillView, SkillView } from '../../../../shared/settings'
import { Input } from '@/components/ui/input'
import { useSettingsStore } from '@/stores/settings-store'

type SkillImportViewProps = {
  onImported: () => void
}

// Full-page GitHub import. "Preview" a repo or skill folder (owner/repo, owner/repo@ref, or a URL)
// to list every skill directory it contains, then batch-select the ones to import.
const SkillImportView = ({ onImported }: SkillImportViewProps): React.JSX.Element => {
  const skills = useSettingsStore((state) => state.skills)
  const importSkill = useSettingsStore((state) => state.importSkill)
  const scanRepoSkills = useSettingsStore((state) => state.scanRepoSkills)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [scanned, setScanned] = useState<ScannedSkillView[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const imported = skills.filter((skill: SkillView) => skill.source === 'imported')

  const runPreview = async (): Promise<void> => {
    const value = input.trim()
    if (!value || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await scanRepoSkills(value)
      setScanned(result.skills)
      // Pre-select every skill that isn't already imported.
      setSelected(
        new Set(result.skills.filter((skill) => !skill.alreadyImported).map((skill) => skill.url))
      )
      if (result.skills.length === 0) setMessage('No skills found in that repo.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Scan failed.')
    } finally {
      setBusy(false)
    }
  }

  const importSelected = async (): Promise<void> => {
    if (busy || selected.size === 0) return
    setBusy(true)
    setMessage(null)
    let done = 0
    try {
      for (const url of selected) {
        await importSkill(url)
        done += 1
      }
      setMessage(`Imported ${done} skill${done === 1 ? '' : 's'}.`)
      setScanned(null)
      onImported()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Imported ${done}, then failed.`)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (url: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })

  const allSelected = scanned !== null && scanned.length > 0 && selected.size === scanned.length

  const toggleAll = (): void =>
    setSelected(() =>
      allSelected ? new Set() : new Set((scanned ?? []).map((skill) => skill.url))
    )

  const invertSelection = (): void =>
    setSelected((prev) => {
      const next = new Set<string>()
      for (const skill of scanned ?? []) {
        if (!prev.has(skill.url)) next.add(skill.url)
      }
      return next
    })

  return (
    <div className="max-w-2xl p-5">
      <h2 className="text-lg font-semibold text-foreground">Import from GitHub</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Preview a repo or skill folder (owner/repo, owner/repo@ref, or a github.com URL), then pick
        the skills you want to import.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <Input
          aria-label="GitHub skill URL or repo"
          placeholder="owner/repo, owner/repo@ref, or a github.com URL"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void runPreview()
          }}
        />
        <button
          type="button"
          onClick={() => void runPreview()}
          disabled={busy || input.trim().length === 0}
          className="inline-flex h-8 shrink-0 items-center rounded-lg border border-border px-3 text-sm text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Preview'}
        </button>
      </div>
      {message ? <p className="mt-2 text-xs text-muted-foreground">{message}</p> : null}

      {scanned && scanned.length > 0 ? (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-foreground">
                Found {scanned.length} skill{scanned.length === 1 ? '' : 's'}
              </h3>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="size-4 shrink-0"
                />
                Select all
              </label>
              <button
                type="button"
                onClick={invertSelection}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Invert
              </button>
            </div>
            <button
              type="button"
              onClick={() => void importSelected()}
              disabled={busy || selected.size === 0}
              className="inline-flex h-8 items-center rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
            >
              Import selected ({selected.size})
            </button>
          </div>
          <ul className="mt-2 flex flex-col divide-y divide-border">
            {scanned.map((skill) => (
              <li key={skill.url} className="flex items-center gap-3 py-2.5">
                <input
                  type="checkbox"
                  aria-label={`Select ${skill.name}`}
                  checked={selected.has(skill.url)}
                  onChange={() => toggle(skill.url)}
                  className="size-4 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{skill.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{skill.path}</span>
                </div>
                {skill.alreadyImported ? (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    Imported
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <h3 className="mt-8 text-sm font-semibold text-foreground">Imported skills</h3>
      {imported.length > 0 ? (
        <ul className="mt-2 flex flex-col divide-y divide-border">
          {imported.map((skill) => (
            <li key={skill.id} className="flex items-center gap-2 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{skill.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{skill.id}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 py-2 text-xs text-muted-foreground">
          No imported skills yet. Repos you import from will appear here.
        </p>
      )}
    </div>
  )
}

export { SkillImportView }
