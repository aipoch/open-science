import { useEffect, useState } from 'react'

import type { AgentHomeSkillView } from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/settings-store'

type AgentHomeImportViewProps = {
  onImported: () => void
}

// Imports skills from the user's machine-level Claude config (~/.claude/skills/). Surfaced as a
// separate sub-view rather than a card on the main list because the source is the user's own
// filesystem, not a public repo — the affordance needs a clear "this reads from your machine"
// framing so the user can give informed consent. Mirrors SkillImportView's structure (preview +
// import-selected) so the two paths feel familiar.
const AgentHomeImportView = ({ onImported }: AgentHomeImportViewProps): React.JSX.Element => {
  const listAgentHomeSkills = useSettingsStore((state) => state.listAgentHomeSkills)
  const importAgentHomeSkill = useSettingsStore((state) => state.importAgentHomeSkill)
  const [busy, setBusy] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [skills, setSkills] = useState<AgentHomeSkillView[] | null>(null)
  const [importing, setImporting] = useState<string | undefined>(undefined)

  // Auto-load on mount so the user sees what is available without an extra click. The list is
  // small (one entry per top-level subdirectory of ~/.claude/skills/) and the read is local, so
  // pulling it eagerly is cheap; deferring to a button would make the import source feel hidden.
  // `busy` starts true so the first render already shows the spinner without an effect-time setBusy
  // call. State updates only fire from the .then/.catch/.finally callbacks (response to the IPC),
  // which the React lint rule allows.
  useEffect(() => {
    let cancelled = false
    listAgentHomeSkills()
      .then((items) => {
        if (cancelled) return
        setSkills(items)
      })
      .catch((error) => {
        if (cancelled) return
        setMessage(error instanceof Error ? error.message : 'Scan failed.')
      })
      .finally(() => {
        if (cancelled) return
        setBusy(false)
      })

    return () => {
      cancelled = true
    }
  }, [listAgentHomeSkills])

  const rescan = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const items = await listAgentHomeSkills()
      setSkills(items)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Scan failed.')
    } finally {
      setBusy(false)
    }
  }

  const importOne = async (skill: AgentHomeSkillView): Promise<void> => {
    setImporting(skill.slug)
    setMessage(null)
    try {
      const result = await importAgentHomeSkill(skill.slug)
      setMessage(
        result.status === 'imported'
          ? `Imported "${skill.name}".`
          : result.status === 'updated'
            ? `Updated "${skill.name}".`
            : `Already imported "${skill.name}".`
      )
      // Re-pull the list so the row's "already imported" badge flips and the action button hides.
      const refreshed = await listAgentHomeSkills()
      setSkills(refreshed)
      onImported()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not import the skill.')
    } finally {
      setImporting(undefined)
    }
  }

  return (
    <div className="p-5">
      <h2 className="text-base font-semibold text-foreground">From your agent home</h2>
      <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
        Skills under <code className="font-mono">~/.claude/skills/</code> on this machine. Import
        one to copy it into Open Science; the source file stays where it is.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void rescan()}
          disabled={busy}
        >
          {busy ? 'Scanning…' : 'Rescan'}
        </Button>
        {skills ? (
          <span className="text-xs text-muted-foreground">
            {skills.length} skill{skills.length === 1 ? '' : 's'} found
          </span>
        ) : null}
      </div>
      {message ? <p className="mt-2 text-xs text-muted-foreground">{message}</p> : null}

      {skills && skills.length > 0 ? (
        <ul className="mt-5 flex flex-col divide-y divide-border">
          {skills.map((skill) => (
            <li key={skill.slug} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{skill.name}</span>
                {skill.description ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {skill.description}
                  </span>
                ) : (
                  <span className="block truncate text-xs text-muted-foreground">{skill.slug}</span>
                )}
              </div>
              {skill.alreadyImported ? (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  Imported
                </span>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void importOne(skill)}
                  disabled={importing !== undefined}
                >
                  {importing === skill.slug ? 'Importing…' : 'Import'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : !busy && skills && skills.length === 0 ? (
        <p className="mt-5 text-xs text-muted-foreground">
          No skills found under <code className="font-mono">~/.claude/skills/</code>.
        </p>
      ) : null}
    </div>
  )
}

export { AgentHomeImportView }