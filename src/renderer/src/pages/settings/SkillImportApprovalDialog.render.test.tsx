// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SkillBundlePreview } from '../../../../shared/settings'
import { SkillImportApprovalDialog } from './SkillImportApprovalDialog'
import { createInitialSkillImportState, useSkillImportStore } from '@/stores/skill-import-store'

let container: HTMLDivElement
let root: Root
const respond = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  window.api = {
    settings: { respondSkillImportApproval: respond }
  } as unknown as Window['api']
  respond.mockClear()
  useSkillImportStore.setState(createInitialSkillImportState())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const button = (text: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === text
  )

const importCandidate = (subPath: string, name: string): SkillBundlePreview => ({
  subPath,
  name,
  description: '',
  metadata: {},
  body: '',
  files: ['SKILL.md'],
  alreadyImported: false
})

describe('SkillImportApprovalDialog', () => {
  it('preselects one candidate and returns the confirmed import target', () => {
    useSkillImportStore.getState().enqueue({
      id: 'approval-1',
      sessionId: 'session-1',
      attachmentName: 'paper-finder.skill',
      previews: [
        {
          subPath: 'paper-finder',
          name: 'Paper Finder',
          description: 'Finds relevant papers.',
          metadata: {},
          body: 'Follow the workflow.',
          files: ['SKILL.md'],
          alreadyImported: false
        }
      ],
      skipped: []
    })

    act(() => root.render(<SkillImportApprovalDialog />))

    expect(document.body.textContent).toContain('Import Skill package?')
    expect(document.body.textContent).toContain('paper-finder.skill')
    expect(document.body.textContent).toContain('Paper Finder')
    expect(
      document.body.querySelector<HTMLInputElement>('input[aria-label="Select Paper Finder"]')
        ?.checked
    ).toBe(true)

    act(() => button('Import 1 Skill')?.click())
    expect(respond).toHaveBeenCalledWith({
      id: 'approval-1',
      items: [{ subPath: 'paper-finder' }]
    })
  })

  it('requires an explicit choice when a package contains multiple candidates', () => {
    useSkillImportStore.getState().enqueue({
      id: 'approval-2',
      sessionId: 'session-1',
      attachmentName: 'many.zip',
      previews: [
        importCandidate('first', 'First Skill'),
        importCandidate('second', 'Second Skill')
      ],
      skipped: []
    })

    act(() => root.render(<SkillImportApprovalDialog />))

    expect(button('Import selected')?.disabled).toBe(true)
  })

  it('selects and clears every candidate with Select all', () => {
    useSkillImportStore.getState().enqueue({
      id: 'approval-select-all',
      sessionId: 'session-1',
      attachmentName: 'many.zip',
      previews: [
        importCandidate('first', 'First Skill'),
        importCandidate('second', 'Second Skill')
      ],
      skipped: []
    })

    act(() => root.render(<SkillImportApprovalDialog />))

    const selectAll = document.body.querySelector<HTMLInputElement>('[aria-label="Select all"]')
    expect(selectAll?.checked).toBe(false)

    act(() => selectAll?.click())
    expect(selectAll?.checked).toBe(true)
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Select First Skill"]')?.checked
    ).toBe(true)
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Select Second Skill"]')?.checked
    ).toBe(true)
    expect(button('Import 2 Skills')?.disabled).toBe(false)

    act(() => selectAll?.click())
    expect(selectAll?.checked).toBe(false)
    expect(button('Import selected')?.disabled).toBe(true)
  })

  it('inverts the current candidate selection', () => {
    useSkillImportStore.getState().enqueue({
      id: 'approval-invert',
      sessionId: 'session-1',
      attachmentName: 'many.zip',
      previews: [
        importCandidate('first', 'First Skill'),
        importCandidate('second', 'Second Skill')
      ],
      skipped: []
    })

    act(() => root.render(<SkillImportApprovalDialog />))

    const firstCheckbox = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Select First Skill"]'
    )
    const secondCheckbox = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Select Second Skill"]'
    )
    act(() => firstCheckbox?.click())
    expect(firstCheckbox?.checked).toBe(true)
    expect(secondCheckbox?.checked).toBe(false)

    act(() => button('Invert')?.click())
    expect(firstCheckbox?.checked).toBe(false)
    expect(secondCheckbox?.checked).toBe(true)

    act(() => button('Import 1 Skill')?.click())
    expect(respond).toHaveBeenCalledWith({
      id: 'approval-invert',
      items: [{ subPath: 'second' }]
    })
  })

  it('cancels without importing anything', () => {
    useSkillImportStore.getState().enqueue({
      id: 'approval-3',
      sessionId: 'session-1',
      attachmentName: 'paper-finder.skill',
      previews: [],
      skipped: []
    })
    act(() => root.render(<SkillImportApprovalDialog />))

    act(() => button('Cancel')?.click())
    expect(respond).toHaveBeenCalledWith({ id: 'approval-3', cancelled: true })
  })

  it('drops a settled request so the next approval can be shown', () => {
    const candidate = {
      subPath: 'demo',
      name: 'Demo Skill',
      description: '',
      metadata: {},
      body: '',
      files: ['SKILL.md'],
      alreadyImported: false
    }
    useSkillImportStore.getState().enqueue({
      id: 'stale',
      sessionId: 'session-1',
      attachmentName: 'stale.skill',
      previews: [candidate],
      skipped: []
    })
    useSkillImportStore.getState().enqueue({
      id: 'next',
      sessionId: 'session-2',
      attachmentName: 'next.skill',
      previews: [{ ...candidate, name: 'Next Skill' }],
      skipped: []
    })

    useSkillImportStore.getState().dismiss('stale')
    act(() => root.render(<SkillImportApprovalDialog />))

    expect(document.body.textContent).toContain('next.skill')
    expect(document.body.textContent).toContain('Next Skill')
    expect(document.body.textContent).not.toContain('stale.skill')
  })
})
