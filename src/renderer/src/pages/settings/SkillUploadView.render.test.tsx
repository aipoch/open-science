// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SkillUploadView } from './SkillUploadView'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { SKILL_IMPORT_LIMITS } from '../../../../shared/skill-import-limits'

let container: HTMLDivElement
let root: Root

// Lets the async drop pipeline settle before assertions: dispatch -> Promise.all(parseFile) ->
// FileReader.readAsDataURL (a macrotask) -> previewSkillZip -> setState. That's several event-loop
// turns, so pump multiple macrotask cycles rather than a single one — a single tick was enough locally
// but flaked on loaded CI runners (the FileReader onload hadn't fired yet). Ten turns is ample and
// still runs in a few ms.
const flush = async (cycles = 10): Promise<void> => {
  for (let i = 0; i < cycles; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await Promise.resolve()
    })
  }
}

// Drops files onto the upload label, matching how the real drag-and-drop hook receives them.
const dropFiles = async (files: File[]): Promise<void> => {
  const label = document.body.querySelector('label')
  const dropEvent = new Event('drop', { bubbles: true })
  Object.defineProperty(dropEvent, 'dataTransfer', { value: { types: ['Files'], files } })
  await act(async () => {
    label?.dispatchEvent(dropEvent)
  })
  await flush()
}

const clickButton = (label: string): void => {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim().includes(label)
  )
  act(() => button?.click())
}

beforeEach(() => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    skills: [
      {
        id: 'a',
        name: 'Alpha',
        description: 'First',
        source: 'featured' as const,
        updatedAt: '2026-07-08T00:00:00.000Z',
        enabled: true
      }
    ],
    createSkill: vi.fn().mockResolvedValue(undefined),
    importSkillZipBatch: vi.fn().mockResolvedValue({
      results: [
        { subPath: 'skills/one', status: 'imported', id: 'imported-one' },
        { subPath: 'skills/two', status: 'imported', id: 'imported-two' }
      ],
      skills: []
    }),
    previewSkillZip: vi.fn().mockResolvedValue({
      previews: [
        {
          subPath: 'skills/one',
          name: 'One',
          description: 'First bundled skill',
          metadata: { author: 'Ada' },
          body: '# First bundle body',
          files: ['SKILL.md'],
          alreadyImported: false
        },
        {
          subPath: 'skills/two',
          name: 'Two',
          description: 'Second bundled skill',
          metadata: {},
          body: '',
          previewError: 'SKILL.md preview content exceeds the 4 MB cumulative limit.',
          files: ['SKILL.md'],
          alreadyImported: false
        }
      ],
      skipped: []
    })
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('SkillUploadView (batch upload)', () => {
  it('renders the multi-file upload affordance and returns to create on "Write from scratch instead"', () => {
    const onWriteInstead = vi.fn()
    act(() => {
      root.render(<SkillUploadView onUploaded={vi.fn()} onWriteInstead={onWriteInstead} />)
    })

    expect(document.body.textContent).toContain('Upload skills')
    expect(document.body.textContent).toContain('Drag and drop or click to upload')
    // The file picker accepts multiple files.
    const input = document.body.querySelector<HTMLInputElement>('[aria-label="Upload skill files"]')
    expect(input?.multiple).toBe(true)

    clickButton('Write from scratch instead')
    expect(onWriteInstead).toHaveBeenCalledTimes(1)
  })

  it('expands a bundle into one unchecked row per skill root; Select all + Import forwards each subPath', async () => {
    const onUploaded = vi.fn()
    act(() => {
      root.render(<SkillUploadView onUploaded={onUploaded} onWriteInstead={vi.fn()} />)
    })

    const bundle = new File([new Uint8Array([1, 2, 3])], 'pack.zip', { type: 'application/zip' })
    await dropFiles([bundle])

    // Both skill roots inside the bundle become checklist rows, unchecked by default.
    expect(useSettingsStore.getState().previewSkillZip).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Found 2 skills')
    const rowChecks = document.body.querySelectorAll<HTMLInputElement>('[aria-label^="Select "]')
    // Two row checkboxes + the "Select all" checkbox.
    const rows = Array.from(rowChecks).filter(
      (checkbox) => checkbox.getAttribute('aria-label') !== 'Select all'
    )
    expect(rows).toHaveLength(2)
    expect(rows.every((checkbox) => !checkbox.checked)).toBe(true)
    expect(document.body.textContent).toContain('Import selected (0)')

    // Select all checks every row.
    const selectAll = document.body.querySelector<HTMLInputElement>('[aria-label="Select all"]')
    act(() => selectAll?.click())
    expect(document.body.textContent).toContain('Import selected (2)')

    clickButton('Import selected')
    await flush()

    // Both roots came from one file, so they import in a single batch call carrying every subPath.
    const importSkillZipBatch = useSettingsStore.getState().importSkillZipBatch
    expect(importSkillZipBatch).toHaveBeenCalledTimes(1)
    expect(importSkillZipBatch).toHaveBeenCalledWith(expect.any(String), [
      { subPath: 'skills/one', replaceId: undefined },
      { subPath: 'skills/two', replaceId: undefined }
    ])
    expect(onUploaded).toHaveBeenCalled()
  })

  it('opens bundle candidate content from the bounded parse result without changing selection', async () => {
    act(() => {
      root.render(<SkillUploadView onUploaded={vi.fn()} onWriteInstead={vi.fn()} />)
    })
    await dropFiles([
      new File([new Uint8Array([1, 2, 3])], 'pack.zip', { type: 'application/zip' })
    ])

    const checkbox = document.body.querySelector<HTMLInputElement>('[aria-label="Select One"]')
    expect(checkbox?.checked).toBe(false)

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Preview One"]')?.click()
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().previewSkillZip).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      'First bundle body'
    )
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Ada')
    expect(checkbox?.checked).toBe(false)

    act(() => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')?.click()
    })
    expect(checkbox?.checked).toBe(false)
    act(() => checkbox?.click())
    expect(checkbox?.checked).toBe(true)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps a bundle candidate importable when its preview body exceeds the cumulative cap', async () => {
    act(() => {
      root.render(<SkillUploadView onUploaded={vi.fn()} onWriteInstead={vi.fn()} />)
    })
    await dropFiles([
      new File([new Uint8Array([1, 2, 3])], 'pack.zip', { type: 'application/zip' })
    ])

    const checkbox = document.body.querySelector<HTMLInputElement>('[aria-label="Select Two"]')
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Preview Two"]')?.click()
      await Promise.resolve()
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toMatch(
      /preview content exceeds the 4 MB cumulative limit/i
    )
    expect(checkbox?.checked).toBe(false)

    act(() => dialog?.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')?.click())
    act(() => checkbox?.click())
    clickButton('Import selected')
    await flush()

    expect(useSettingsStore.getState().importSkillZipBatch).toHaveBeenCalledWith(
      expect.any(String),
      [{ subPath: 'skills/two', replaceId: undefined }]
    )
  })

  it('rejects an oversized markdown file on file.size, before reading its contents', async () => {
    act(() => {
      root.render(<SkillUploadView onUploaded={vi.fn()} onWriteInstead={vi.fn()} />)
    })

    // 51 MiB exceeds the 50 MiB per-file cap. file.size is checked before file.text() runs.
    const big = new File(['x'], 'big.md', { type: 'text/markdown' })
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 })
    const textSpy = vi.spyOn(big, 'text')

    await dropFiles([big])

    expect(textSpy).not.toHaveBeenCalled()
    expect(document.body.textContent).toMatch(/too large/)
    expect(document.body.textContent).not.toContain('Found 1 skill')
  })

  it('rejects a batch whose total selected size exceeds the cap, before reading any file', async () => {
    act(() => {
      root.render(<SkillUploadView onUploaded={vi.fn()} onWriteInstead={vi.fn()} />)
    })

    // Two 130 MiB bundles: each is under the per-bundle cap, but together they exceed the total cap.
    const a = new File([new Uint8Array([1])], 'a.zip', { type: 'application/zip' })
    const b = new File([new Uint8Array([2])], 'b.zip', { type: 'application/zip' })
    Object.defineProperty(a, 'size', { value: 130 * 1024 * 1024 })
    Object.defineProperty(b, 'size', { value: 130 * 1024 * 1024 })

    await dropFiles([a, b])

    expect(useSettingsStore.getState().previewSkillZip).not.toHaveBeenCalled()
    expect(document.body.textContent).toMatch(/too large/)
  })

  it('rejects a single oversized bundle on file.size, without previewing it', async () => {
    act(() => {
      root.render(<SkillUploadView onUploaded={vi.fn()} onWriteInstead={vi.fn()} />)
    })

    // A 257 MiB bundle exceeds the per-bundle cap; it must be rejected before previewSkillZip reads it.
    const big = new File([new Uint8Array([1])], 'huge.zip', { type: 'application/zip' })
    Object.defineProperty(big, 'size', { value: 257 * 1024 * 1024 })

    await dropFiles([big])

    expect(useSettingsStore.getState().previewSkillZip).not.toHaveBeenCalled()
    expect(document.body.textContent).toMatch(/too large/)
    expect(document.body.textContent).not.toContain('Found')
  })

  it('parses a markdown file into a candidate that routes to createSkill', async () => {
    act(() => {
      root.render(<SkillUploadView onUploaded={vi.fn()} onWriteInstead={vi.fn()} />)
    })

    const md = new File(
      ['---\nname: Solo\ndescription: A solo skill\nauthor: Ada\nlicense: MIT\n---\n# Body'],
      'solo.md',
      { type: 'text/markdown' }
    )
    await dropFiles([md])

    // A single markdown candidate appears, unchecked; the bundle preview path is not used.
    expect(useSettingsStore.getState().previewSkillZip).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Found 1 skill')

    const rowCheck = document.body.querySelector<HTMLInputElement>('[aria-label="Select Solo"]')
    expect(rowCheck?.checked).toBe(false)
    act(() => rowCheck?.click())

    clickButton('Import selected')
    await flush()

    expect(useSettingsStore.getState().createSkill).toHaveBeenCalledWith({
      name: 'Solo',
      description: 'A solo skill',
      metadata: { author: 'Ada', license: 'MIT' },
      body: '# Body'
    })
  })

  it('preserves YAML lists and block scalars from a markdown candidate', async () => {
    act(() => {
      root.render(<SkillUploadView onUploaded={vi.fn()} onWriteInstead={vi.fn()} />)
    })

    const md = new File(
      [
        [
          '---',
          'name: Complex',
          'description: >',
          '  A folded',
          '  description.',
          'tags:',
          '  - alpha',
          '  - beta',
          'notes: |',
          '  line one',
          '  line two',
          '---',
          '# Body'
        ].join('\n')
      ],
      'complex.md',
      { type: 'text/markdown' }
    )
    await dropFiles([md])

    act(() =>
      document.body.querySelector<HTMLInputElement>('[aria-label="Select Complex"]')?.click()
    )
    clickButton('Import selected')
    await flush()

    expect(useSettingsStore.getState().createSkill).toHaveBeenCalledWith({
      name: 'Complex',
      description: 'A folded description.\n',
      metadata: { tags: 'alpha, beta', notes: 'line one\nline two\n' },
      body: '# Body'
    })
  })

  it('previews a bare Markdown candidate from its in-renderer body without changing selection', async () => {
    act(() => {
      root.render(<SkillUploadView onUploaded={vi.fn()} onWriteInstead={vi.fn()} />)
    })
    const md = new File(
      ['---\nname: Solo\ndescription: A solo skill\nauthor: Ada\n---\n# Bare body'],
      'solo.md',
      { type: 'text/markdown' }
    )
    await dropFiles([md])

    const checkbox = document.body.querySelector<HTMLInputElement>('[aria-label="Select Solo"]')
    expect(checkbox?.checked).toBe(false)

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Preview Solo"]')?.click()
      await Promise.resolve()
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.textContent).toContain('Bare body')
    expect(dialog?.textContent).toContain('Ada')
    expect(dialog?.textContent).toContain('solo.md')
    expect(checkbox?.checked).toBe(false)

    act(() => dialog?.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')?.click())
    expect(checkbox?.checked).toBe(false)
  })

  it('blocks an oversized bare Markdown preview while keeping the candidate importable', async () => {
    act(() => {
      root.render(<SkillUploadView onUploaded={vi.fn()} onWriteInstead={vi.fn()} />)
    })
    const md = new File(
      ['---\nname: Large\ndescription: Importable but not previewable\n---\n# Large body'],
      'large.md',
      { type: 'text/markdown' }
    )
    Object.defineProperty(md, 'size', {
      value: SKILL_IMPORT_LIMITS.maxPreviewContentBytes + 1
    })
    await dropFiles([md])

    const checkbox = document.body.querySelector<HTMLInputElement>('[aria-label="Select Large"]')
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Preview Large"]')?.click()
      await Promise.resolve()
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toMatch(
      /preview exceeds the 4 MB limit/i
    )
    expect(dialog?.textContent).not.toContain('Large body')
    expect(checkbox?.checked).toBe(false)

    act(() => dialog?.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')?.click())
    act(() => checkbox?.click())
    clickButton('Import selected')
    await flush()

    expect(useSettingsStore.getState().createSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Large', body: '# Large body' })
    )
  })
})
