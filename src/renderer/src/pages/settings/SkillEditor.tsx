/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4 */
import { ChevronDown, FileUp, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { SkillReference } from '../../../../shared/settings'
import { parseSkillDocument } from '../../../../shared/skill-frontmatter'
import { FileDropOverlay } from '@/components/FileDropOverlay'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useFileDropZone } from '@/hooks/useFileDropZone'
import { useSettingsStore } from '@/stores/settings-store'
import { SettingsIconAction } from './SettingsLayout'

export type SkillDraft = {
  id?: string
  name: string
  description: string
  body: string
  metadata?: Record<string, string>
  references?: SkillReference[]
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_NAME_MAX_LENGTH = 64

// Reserved name namespaces a user-authored skill may not claim (mirrors the main-process rule):
// `os-` is the app's own materialized prefix, `mcp-` is reserved for MCP-provided skills.
const RESERVED_SKILL_NAME_PREFIXES = ['os-', 'mcp-']

// Reads a File as base64 (for binary-safe reference transport to the main process).
const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

type SkillEditorProps = {
  initial: SkillDraft
  onCancel: () => void
  onSave: (draft: SkillDraft) => Promise<void>
}

// Create/edit form for a personal skill: Identity (name/description) + Content (SKILL.md body).
// Pasting a full SKILL.md with a frontmatter block auto-fills name/description.
const SkillEditor = ({ initial, onCancel, onSave }: SkillEditorProps): React.JSX.Element => {
  const isCreate = !initial.id
  const skills = useSettingsStore((state) => state.skills)
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  const [body, setBody] = useState(initial.body)
  const [metadata, setMetadata] = useState(initial.metadata)
  const [frontmatterImportMode, setFrontmatterImportMode] = useState(false)
  const [contentMode, setContentMode] = useState<'write' | 'upload'>('write')
  const [references, setReferences] = useState<{ path: string; dataBase64?: string }[]>(() =>
    (initial.references ?? []).map((ref) => ({ path: ref.path, dataBase64: ref.dataBase64 }))
  )
  const [advancedOpen, setAdvancedOpen] = useState((initial.references?.length ?? 0) > 0)
  const [saving, setSaving] = useState(false)

  const currentName = name.trim()

  // Validates the immutable name against the same rules the main process enforces, plus a live
  // collision check against already-loaded personal skills. Only meaningful when creating.
  const nameError = useMemo((): string | null => {
    if (!isCreate) return null
    if (!currentName) return 'Name is required.'
    if (!SKILL_NAME_PATTERN.test(currentName) || currentName.length > SKILL_NAME_MAX_LENGTH) {
      return 'Use up to 64 lowercase letters, numbers, and single hyphens.'
    }
    if (RESERVED_SKILL_NAME_PREFIXES.some((prefix) => currentName.startsWith(prefix))) {
      return `Can't start with ${RESERVED_SKILL_NAME_PREFIXES.join(' or ')}.`
    }
    if (skills.some((entry) => entry.id === `personal-${currentName}`)) {
      return 'A skill with this name already exists.'
    }
    return null
  }, [isCreate, currentName, skills])

  const importedContent = frontmatterImportMode ? parseSkillDocument(body) : undefined
  const persistedBody = importedContent?.hasFrontmatter ? importedContent.body : body
  const persistedMetadata = importedContent?.hasFrontmatter ? importedContent.metadata : metadata
  const metadataEntries = Object.entries(persistedMetadata ?? {})
  const canSave = currentName.length > 0 && persistedBody.trim().length > 0 && !nameError && !saving

  // Plain textarea edits are always literal body content and keep the separately displayed metadata.
  // In import mode the visible frontmatter is authoritative, so removing it clears derived metadata.
  const handleBodyChange = (value: string): void => {
    if (frontmatterImportMode) {
      const parsed = parseSkillDocument(value)
      if (parsed.hasFrontmatter) {
        if (isCreate && parsed.name !== undefined) setName(parsed.name)
        if (parsed.description !== undefined) setDescription(parsed.description)
        setMetadata(parsed.metadata)
      } else {
        setMetadata(undefined)
        setFrontmatterImportMode(false)
      }
    }
    setBody(value)
  }

  // Explicit paste/upload/drop imports opt into frontmatter semantics. The raw block remains visible
  // in the textarea so users can edit or remove it; it is stripped only from the persisted body.
  const importContent = (value: string): void => {
    const parsed = parseSkillDocument(value)
    if (parsed.hasFrontmatter) {
      if (isCreate && parsed.name && !name.trim()) setName(parsed.name)
      if (parsed.description && !description.trim()) setDescription(parsed.description)
      setMetadata(parsed.metadata)
      setFrontmatterImportMode(true)
    } else {
      setMetadata(undefined)
      setFrontmatterImportMode(false)
    }
    setBody(value)
  }

  const handleBodyPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = event.clipboardData.getData('text/plain')
    const replacesAll =
      body.length === 0 ||
      (event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === body.length)
    if (!replacesAll || !parseSkillDocument(pasted).hasFrontmatter) return

    event.preventDefault()
    importContent(pasted)
  }

  // Uploads a text/markdown file into the content body, then flips back to the Write editor.
  const uploadContent = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt,text/*'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      importContent(await file.text())
      setContentMode('write')
    }
    input.click()
  }

  // Loads the first dropped text file into the body — the drop counterpart of uploadContent().
  const dropContent = async (files: File[]): Promise<void> => {
    importContent(await files[0].text())
    setContentMode('write')
  }

  // Adds one or more supporting files to the references list (base64-encoded), replacing any
  // existing entry with the same name.
  const addReferences = async (files: File[]): Promise<void> => {
    const added = await Promise.all(
      files.map(async (file) => ({
        path: file.name,
        dataBase64: await fileToBase64(file)
      }))
    )
    setReferences((prev) => [
      ...prev.filter((ref) => !added.some((a) => a.path === ref.path)),
      ...added
    ])
  }

  // Each content area is its own drop zone with an independent overlay state.
  const contentDrop = useFileDropZone({
    enabled: true,
    onFiles: (files) => void dropContent(files)
  })
  const referenceDrop = useFileDropZone({
    enabled: true,
    onFiles: (files) => void addReferences(files)
  })

  const handleSave = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    try {
      await onSave({
        id: initial.id,
        name: currentName,
        description: description.trim(),
        body: persistedBody,
        metadata: persistedMetadata,
        references: references.map((ref) => ({ path: ref.path, dataBase64: ref.dataBase64 }))
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-5">
          <label data-slot="settings-editor-field" className="grid min-w-0 gap-1.5">
            <span className="text-sm font-medium text-foreground">Name</span>
            <Input
              aria-label="Skill name"
              value={name}
              onChange={isCreate ? (event) => setName(event.target.value) : undefined}
              disabled={!isCreate}
              aria-invalid={nameError ? true : undefined}
              placeholder="e.g. changelog-style"
            />
            {nameError ? <span className="text-xs text-danger-000">{nameError}</span> : null}
          </label>
          <label data-slot="settings-editor-field" className="grid min-w-0 gap-1.5">
            <span className="text-sm font-medium text-foreground">Description</span>
            <Textarea
              aria-label="Skill description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              placeholder="One sentence — what does this skill teach the agent, and when does it apply?"
              className="resize-none text-sm"
            />
            <span className="text-xs text-muted-foreground">
              This is how the agent decides when to use the skill — be specific.
            </span>
          </label>
          <div data-slot="settings-editor-field" className="grid min-w-0 gap-1.5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">Content</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
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
                  className={`inline-flex h-7 items-center rounded-md px-2.5 text-sm transition-colors motion-reduce:transition-none ${
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
                  className={`inline-flex h-7 items-center rounded-md px-2.5 text-sm transition-colors motion-reduce:transition-none ${
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
                <Textarea
                  aria-label="Skill body"
                  value={body}
                  onChange={(event) => handleBodyChange(event.target.value)}
                  onPaste={handleBodyPaste}
                  rows={16}
                  placeholder={'# Instructions\n\nStep-by-step guidance for the agent…'}
                  className="min-h-64 resize-y font-mono text-[13px]"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Paste a full SKILL.md — if it has a <code className="font-mono">---</code>{' '}
                  metadata block at the top, the fields above auto-fill.
                </p>
                {!frontmatterImportMode && metadataEntries.length > 0 ? (
                  <div
                    aria-label="Skill metadata"
                    className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">Saved metadata</p>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {metadataEntries.map(([key, value]) => (
                          <span key={key} className="break-all">
                            {key}: {value}
                          </span>
                        ))}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Clear skill metadata"
                      onClick={() => setMetadata(undefined)}
                    >
                      Clear
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                onClick={uploadContent}
                {...contentDrop.dropZoneProps}
                className="relative flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-8 text-center transition-colors motion-reduce:transition-none hover:bg-muted/50"
              >
                {contentDrop.isDragging ? (
                  <FileDropOverlay label="Drop to upload" className="rounded-lg" />
                ) : null}
                <Upload className="size-5 text-muted-foreground" aria-hidden="true" />
                <span className="text-sm font-medium text-foreground">
                  Upload a SKILL.md or text file
                </span>
                <span className="text-xs text-muted-foreground">
                  Its contents fill the editor; switch back to Write to tweak.
                </span>
              </button>
            )}
          </div>

          <div>
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls="skill-advanced-settings"
              onClick={() => setAdvancedOpen((open) => !open)}
              className="flex min-h-8 w-full items-center gap-2 rounded-lg py-1.5 text-left text-sm font-medium whitespace-nowrap text-foreground transition-colors duration-150 outline-none motion-reduce:transition-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ChevronDown
                className={`size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${
                  advancedOpen ? '' : '-rotate-90'
                }`}
                aria-hidden="true"
              />
              Advanced settings
            </button>

            {advancedOpen ? (
              <section id="skill-advanced-settings" className="mt-3">
                <div>
                  <h2 className="text-sm font-medium text-foreground">References</h2>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    Supporting files (scripts, templates, data) the skill can read at runtime.
                  </p>
                </div>

                <label
                  {...referenceDrop.dropZoneProps}
                  className="relative mt-3 flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-6 text-center transition-colors motion-reduce:transition-none hover:bg-muted/50 focus-within:ring-3 focus-within:ring-ring/50"
                >
                  {referenceDrop.isDragging ? (
                    <FileDropOverlay label="Drop reference files" className="rounded-lg" />
                  ) : null}
                  <input
                    type="file"
                    multiple
                    aria-label="Add reference files"
                    className="sr-only"
                    onChange={(event) => void addReferences(Array.from(event.target.files ?? []))}
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
                        <SettingsIconAction
                          label={`Remove ${ref.path}`}
                          icon={X}
                          onClick={() =>
                            setReferences((prev) => prev.filter((item) => item.path !== ref.path))
                          }
                          className="size-6"
                          danger
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-card px-5 py-3">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void handleSave()} disabled={!canSave}>
          {saving ? 'Saving…' : initial.id ? 'Save' : 'Publish'}
        </Button>
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
          metadata: detail.metadata,
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
          description: next.description,
          body: next.body,
          metadata: next.metadata,
          references: next.references
        })
        onDone()
      }}
    />
  )
}

export { SkillEditor, SkillEditLoader }
