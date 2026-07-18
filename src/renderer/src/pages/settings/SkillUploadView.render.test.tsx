// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SkillUploadView } from './SkillUploadView'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

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
    importSkillZip: vi
      .fn()
      .mockResolvedValue({ status: 'imported', id: 'imported-zip', skills: [] }),
    previewSkillZip: vi.fn().mockResolvedValue([
      {
        subPath: 'skills/one',
        name: 'One',
        description: 'First bundled skill',
        files: ['SKILL.md'],
        alreadyImported: false
      },
      {
        subPath: 'skills/two',
        name: 'Two',
        description: 'Second bundled skill',
        files: ['SKILL.md'],
        alreadyImported: false
      }
    ])
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

    const importSkillZip = useSettingsStore.getState().importSkillZip
    expect(importSkillZip).toHaveBeenCalledTimes(2)
    expect(importSkillZip).toHaveBeenCalledWith(expect.any(String), {
      subPath: 'skills/one',
      replaceId: undefined
    })
    expect(importSkillZip).toHaveBeenCalledWith(expect.any(String), {
      subPath: 'skills/two',
      replaceId: undefined
    })
    expect(onUploaded).toHaveBeenCalled()
  })

  it('parses a markdown file into a candidate that routes to createSkill', async () => {
    act(() => {
      root.render(<SkillUploadView onUploaded={vi.fn()} onWriteInstead={vi.fn()} />)
    })

    const md = new File(['---\nname: Solo\ndescription: A solo skill\n---\n# Body'], 'solo.md', {
      type: 'text/markdown'
    })
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
      body: '# Body'
    })
  })
})
