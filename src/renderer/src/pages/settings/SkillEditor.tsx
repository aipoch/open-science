import { FileUp, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { SkillReference } from '../../../../shared/settings'
import { Input } from '@/components/ui/input'
import { useSettingsStore } from '@/stores/settings-store'

export type SkillDraft = {
  id?: string
  name: string
  description: string
  body: string
  slug?: string
  references?: SkillReference[]
}

// Reserved id namespaces a user-authored skill may not claim (mirrors the main-process rule):
// `os-` is the app's own materialized prefix, `mcp-` is reserved for MCP-provided skills.
const RESERVED_SLUG_PREFIXES = ['os-', 'mcp-']

// Reads a File as base64 (for binary-safe reference transport to the main process).
const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

// Renderer-side slug preview mirroring the main-process slug rule (lowercase a–z, 0–9, hyphens).
const toSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)

// Pulls name/description out of a pasted SKILL.md frontmatter block, returning the stripped body.
const consumeFrontmatter = (
  text: string
): { name?: string; description?: string; body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!match) return { body: text }

  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (field) fields[field[1].toLowerCase()] = field[2].trim()
  }
  return {
    name: fields.name,
    description: fields.description,
    body: text.slice(match[0].length).replace(/^\n+/, '')
  }
}

type SkillEditorProps = {
  initial: SkillDraft
  onCancel: () => void
  onSave: (draft: SkillDraft) => Promise<void>
}

// Create/edit form for a personal skill: Identity (name/id/description) + Content (SKILL.md body).
// Pasting a full SKILL.md with a frontmatter block auto-fills name/description.
const SkillEditor = ({ initial, onCancel, onSave }: SkillEditorProps): React.JSX.Element => {
  const isCreate = !initial.id
  const skills = useSettingsStore((state) => state.skills)
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  const [body, setBody] = useState(initial.body)
  const [contentMode, setContentMode] = useState<'write' | 'upload'>('write')
  const [references, setReferences] = useState<{ path: string; dataBase64?: string }[]>(() =>
    (initial.references ?? []).map((ref) => ({ path: ref.path, dataBase64: ref.dataBase64 }))
  )
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [saving, setSaving] = useState(false)

  // The effective id: the user's typed value once they edit it, otherwise derived from the name.
  const currentSlug = isCreate && !slugTouched ? toSlug(name) : slug

  // Validates the chosen id against the same rules the main process enforces, plus a live
  // collision check against already-loaded personal skills. Only meaningful when creating.
  const slugError = useMemo((): string | null => {
    if (!isCreate) return null
    if (!currentSlug) return 'Skill ID is required.'
    if (!/^[a-z0-9-]+$/.test(currentSlug)) {
      return 'Only lowercase letters, numbers, and hyphens.'
    }
    if (RESERVED_SLUG_PREFIXES.some((prefix) => currentSlug.startsWith(prefix))) {
      return `Can't start with ${RESERVED_SLUG_PREFIXES.join(' or ')}.`
    }
    if (skills.some((entry) => entry.id === `personal-${currentSlug}`)) {
      return 'A skill with this ID already exists.'
    }
    return null
  }, [isCreate, currentSlug, skills])

  const canSave = name.trim().length > 0 && body.trim().length > 0 && !slugError && !saving

  const handleBodyChange = (value: string): void => {
    const parsed = consumeFrontmatter(value)
    if (parsed.name || parsed.description) {
      if (parsed.name && !name.trim()) setName(parsed.name)
      if (parsed.description && !description.trim()) setDescription(parsed.description)
      setBody(parsed.body)
    } else {
      setBody(value)
    }
  }

  // Uploads a text/markdown file into the content body, then flips back to the Write editor.
  const uploadContent = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt,text/*'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      handleBodyChange(await file.text())
      setContentMode('write')
    }
    input.click()
  }

  // Adds one or more supporting files to the references list (base64-encoded), replacing any
  // existing entry with the same name.
  const addReferences = async (files: FileList | null): Promise<void> => {
    if (!files) return
    const added = await Promise.all(
      Array.from(files).map(async (file) => ({
        path: file.name,
        dataBase64: await fileToBase64(file)
      }))
    )
    setReferences((prev) => [
      ...prev.filter((ref) => !added.some((a) => a.path === ref.path)),
      ...added
    ])
  }

  const handleSave = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    try {
      await onSave({
        id: initial.id,
        name: name.trim(),
        description: description.trim(),
        body,
        slug: isCreate ? currentSlug : undefined,
        references: references.map((ref) => ({ path: ref.path, dataBase64: ref.dataBase64 }))
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-2xl p-5">
          <section>
            <h3 className="text-base font-semibold text-foreground">Identity</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              How this skill appears in the catalog and to the agent.
            </p>
            <div className="mt-4 flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Name</span>
                <Input
                  aria-label="Skill name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Changelog style"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Skill ID</span>
                <Input
                  aria-label="Skill ID"
                  value={isCreate ? currentSlug : (initial.id ?? '').replace(/^personal-/, '')}
                  onChange={
                    isCreate
                      ? (event) => {
                          setSlugTouched(true)
                          setSlug(event.target.value.toLowerCase())
                        }
                      : undefined
                  }
                  readOnly={!isCreate}
                  aria-invalid={slugError ? true : undefined}
                  className={`font-mono ${
                    isCreate
                      ? slugError
                        ? 'border-danger-000 text-foreground'
                        : 'text-foreground'
                      : 'text-muted-foreground'
                  }`}
                />
                {slugError ? (
                  <span className="text-xs text-danger-000">{slugError}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {isCreate
                      ? 'Used as the folder name — lowercase a–z, 0–9, hyphens. Locked after creation.'
                      : 'The skill ID is fixed after creation.'}
                  </span>
                )}
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Description</span>
                <textarea
                  aria-label="Skill description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={2}
                  placeholder="One sentence — what does this skill teach the agent, and when does it apply?"
                  className="w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                <span className="text-xs text-muted-foreground">
                  This is how the agent decides when to use the skill — be specific.
                </span>
              </label>
            </div>
          </section>

          <div className="my-6 h-px bg-border" />

          <section>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-foreground">Content</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Markdown shown to the agent when the skill is invoked.
                </p>
              </div>
              <div
                role="radiogroup"
                aria-label="Content mode"
                className="inline-flex shrink-0 items-center rounded-lg bg-muted p-0.5"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={contentMode === 'write'}
                  onClick={() => setContentMode('write')}
                  className={`inline-flex h-7 items-center rounded-md px-2.5 text-sm transition-colors ${
                    contentMode === 'write'
                      ? 'bg-card font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Write
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={contentMode === 'upload'}
                  onClick={() => setContentMode('upload')}
                  className={`inline-flex h-7 items-center rounded-md px-2.5 text-sm transition-colors ${
                    contentMode === 'upload'
                      ? 'bg-card font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Upload
                </button>
              </div>
            </div>

            {contentMode === 'write' ? (
              <>
                <textarea
                  aria-label="Skill body"
                  value={body}
                  onChange={(event) => handleBodyChange(event.target.value)}
                  rows={16}
                  placeholder={'# Instructions\n\nStep-by-step guidance for the agent…'}
                  className="mt-4 min-h-64 w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Paste a full SKILL.md — if it has a <code className="font-mono">---</code>{' '}
                  metadata block at the top, the fields above auto-fill.
                </p>
              </>
            ) : (
              <button
                type="button"
                onClick={uploadContent}
                className="mt-4 flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-8 text-center transition-colors hover:bg-muted/50"
              >
                <Upload className="size-5 text-muted-foreground" aria-hidden="true" />
                <span className="text-sm font-medium text-foreground">
                  Upload a SKILL.md or text file
                </span>
                <span className="text-xs text-muted-foreground">
                  Its contents fill the editor; switch back to Write to tweak.
                </span>
              </button>
            )}
          </section>

          <div className="my-6 h-px bg-border" />

          <section>
            <h3 className="text-base font-semibold text-foreground">References</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Supporting files (scripts, templates, data) the skill can read at runtime.
            </p>

            <label className="mt-4 flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-6 text-center transition-colors hover:bg-muted/50">
              <input
                type="file"
                multiple
                aria-label="Add reference files"
                className="hidden"
                onChange={(event) => void addReferences(event.target.files)}
              />
              <FileUp className="size-5 text-muted-foreground" aria-hidden="true" />
              <span className="text-sm font-medium text-foreground">
                Drop reference files or click to browse
              </span>
              <span className="text-xs text-muted-foreground">
                Saved under <code className="font-mono">references/</code> in the skill.
              </span>
            </label>

            {references.length > 0 ? (
              <ul className="mt-3 flex flex-col divide-y divide-border">
                {references.map((ref) => (
                  <li key={ref.path} className="flex items-center gap-2 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                      references/{ref.path}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${ref.path}`}
                      onClick={() =>
                        setReferences((prev) => prev.filter((item) => item.path !== ref.path))
                      }
                      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-card px-5 py-3">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-8 items-center rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canSave}
          className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        >
          {saving ? 'Saving…' : initial.id ? 'Save' : 'Publish'}
        </button>
      </div>
    </div>
  )
}

type SkillEditLoaderProps = {
  skillId: string
  onDone: () => void
}

// Loads an existing personal skill's content, then renders the editor pre-filled.
const SkillEditLoader = ({ skillId, onDone }: SkillEditLoaderProps): React.JSX.Element => {
  const updateSkill = useSettingsStore((state) => state.updateSkill)
  const [draft, setDraft] = useState<SkillDraft | null>(null)

  useEffect(() => {
    let active = true
    void window.api.settings.getSkillDetail(skillId).then((detail) => {
      if (active) {
        setDraft({
          id: detail.id,
          name: detail.name,
          description: detail.description,
          body: detail.body,
          references: detail.references.map((ref) => ({ path: ref.path }))
        })
      }
    })
    return () => {
      active = false
    }
  }, [skillId])

  if (!draft) return <div className="p-5 text-sm text-muted-foreground">Loading…</div>

  return (
    <SkillEditor
      initial={draft}
      onCancel={onDone}
      onSave={async (next) => {
        await updateSkill({
          id: next.id ?? skillId,
          name: next.name,
          description: next.description,
          body: next.body,
          references: next.references
        })
        onDone()
      }}
    />
  )
}

export { SkillEditor, SkillEditLoader }
