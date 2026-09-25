// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SkillBundlePreview } from '../../../../shared/settings'
import { SkillImportApprovalDialog, DeferredSkillImportNotice } from './SkillImportApprovalDialog'
import { createInitialSkillImportState, useSkillImportStore } from '@/stores/skill-import-store'

let container: HTMLDivElement
let root: Root
const respond = vi.fn().mockResolvedValue(undefined)
const previewGitHubSkill = vi.fn().mockResolvedValue({
  name: 'Slide Master',
  description: 'Creates polished presentations.',
  sourceLabel: 'github.com/acme/skills@main/slide-master',
  metadata: {},
  body: 'Follow the workflow.',
  files: ['SKILL.md']
})

beforeEach(() => {
  window.api = {
    settings: { respondSkillImportApproval: respond, previewGitHubSkill }
  } as unknown as Window['api']
  respond.mockReset().mockResolvedValue(undefined)
  previewGitHubSkill.mockClear()
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

const expectUnifiedDialogChrome = (): void => {
  const classNames = Array.from(document.body.querySelectorAll<HTMLElement>('*')).map((element) =>
    String(element.className)
  )

  expect(
    classNames.some((className) => className.includes('border-b border-border-300/90 px-5 py-3.5'))
  ).toBe(true)
  expect(
    classNames.some((className) => className.includes('border-t border-border-300/90 px-5 py-3.5'))
  ).toBe(true)
  expect(
    classNames.some((className) => className.includes('text-lg font-semibold text-text-000'))
  ).toBe(true)
}

describe('SkillImportApprovalDialog', () => {
  it('keeps a covered approval queued while suppressing its presentation', () => {
    useSkillImportStore.getState().enqueue({
      id: 'approval-covered',
      sessionId: 'session-1',
      source: { kind: 'attachment', label: 'paper-finder.skill' },
      previews: [importCandidate('paper-finder', 'Paper Finder')],
      skipped: []
    })

    act(() => root.render(<SkillImportApprovalDialog active={false} />))

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(useSkillImportStore.getState().pending).toHaveLength(1)
  })

  it('keeps approvals for the open Side chat parent queued without showing its dialog', () => {
    useSkillImportStore.getState().enqueue({
      id: 'approval-side',
      sessionId: 'session-side',
      source: { kind: 'attachment', label: 'paper-finder.skill' },
      previews: [importCandidate('paper-finder', 'Paper Finder')],
      skipped: []
    })

    act(() =>
      root.render(<SkillImportApprovalDialog blockedSessionIds={new Set(['session-side'])} />)
    )

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(useSkillImportStore.getState().pending).toHaveLength(1)
  })

  it('preselects one candidate and returns the confirmed import target', () => {
    useSkillImportStore.getState().enqueue({
      id: 'approval-1',
      sessionId: 'session-1',
      source: { kind: 'attachment', label: 'paper-finder.skill' },
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
    expectUnifiedDialogChrome()
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

  it('shows scanned GitHub candidates and preselects only skills not already imported', async () => {
    useSkillImportStore.getState().enqueue({
      id: 'approval-github',
      sessionId: 'session-1',
      source: { kind: 'github', label: 'https://github.com/acme/skills' },
      previews: [
        {
          ...importCandidate('slide-master', 'Slide Master'),
          githubUrl: 'https://github.com/acme/skills/tree/main/slide-master'
        },
        {
          ...importCandidate('already-there', 'Already There'),
          githubUrl: 'https://github.com/acme/skills/tree/main/already-there',
          alreadyImported: true
        }
      ],
      skipped: []
    })

    await act(async () => root.render(<SkillImportApprovalDialog />))

    expect(document.body.textContent).toContain('Import Skills from GitHub?')
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Select Slide Master"]')?.checked
    ).toBe(true)
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Select Already There"]')?.checked
    ).toBe(false)
    expect(document.body.textContent).toContain('Imported')
    expect(button('Import selected (1)')?.className).toContain('border')

    await act(async () => button('Preview')?.click())
    expect(previewGitHubSkill).toHaveBeenCalledWith({
      url: 'https://github.com/acme/skills/tree/main/slide-master'
    })
  })

  it('requires an explicit choice when a package contains multiple candidates', () => {
    useSkillImportStore.getState().enqueue({
      id: 'approval-2',
      sessionId: 'session-1',
      source: { kind: 'attachment', label: 'many.zip' },
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
      source: { kind: 'attachment', label: 'many.zip' },
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
      source: { kind: 'attachment', label: 'many.zip' },
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
      source: { kind: 'attachment', label: 'paper-finder.skill' },
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
      source: { kind: 'attachment', label: 'stale.skill' },
      previews: [candidate],
      skipped: []
    })
    useSkillImportStore.getState().enqueue({
      id: 'next',
      sessionId: 'session-2',
      source: { kind: 'attachment', label: 'next.skill' },
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

describe('Skill import recovery', () => {
  const enqueue = (id = 'recoverable'): void =>
    useSkillImportStore.getState().enqueue({
      id,
      sessionId: 'session-1',
      source: { kind: 'attachment', label: 'example.skill' },
      previews: [importCandidate('example', 'Example')],
      skipped: []
    })
  const renderRecovery = (): void =>
    root.render(
      <>
        <SkillImportApprovalDialog />
        <DeferredSkillImportNotice />
      </>
    )

  it('reports repeated failures, allows deferral, and resumes without responding', async () => {
    respond.mockRejectedValue(new Error('transport offline'))
    enqueue()
    await act(async () => renderRecovery())
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => button('Cancel')!.click())
      expect(document.body.textContent).toContain('Could not send your response.')
    }
    await act(async () => button('Finish later')!.click())
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(useSkillImportStore.getState().pending).toHaveLength(1)
    expect(respond).toHaveBeenCalledTimes(3)
    // Replayed requests must not steal focus from the user again.
    await act(async () => enqueue())
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => button('Review')!.click())
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    respond.mockResolvedValue(undefined)
    await act(async () => button('Cancel')!.click())
    expect(useSkillImportStore.getState().pending).toHaveLength(0)
    expect(useSkillImportStore.getState().deferredIds).toEqual([])
    expect(button('Review')).toBeUndefined()
  })

  it('keeps an in-flight response guarded across deferral and reopening', async () => {
    let finish!: () => void
    respond.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    enqueue()
    await act(async () => renderRecovery())
    await act(async () => {
      button('Cancel')!.click()
      button('Cancel')!.click()
    })
    expect(respond).toHaveBeenCalledOnce()
    expect(button('Cancel')!.disabled).toBe(true)
    await act(async () => button('Finish later')!.click())
    await act(async () => button('Review')!.click())
    expect(button('Cancel')!.disabled).toBe(true)
    await act(async () =>
      useSkillImportStore.getState().respond({ id: 'recoverable', cancelled: true })
    )
    expect(respond).toHaveBeenCalledOnce()
    await act(async () => finish())
    expect(useSkillImportStore.getState().respondingIds).toEqual([])
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows the next request and removes deferred reminders on settlement', async () => {
    enqueue('first')
    enqueue('second')
    await act(async () => renderRecovery())
    await act(async () => button('Finish later')!.click())
    expect(useSkillImportStore.getState().deferredIds).toEqual(['first'])
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => button('Cancel')!.click())
    expect(respond).toHaveBeenCalledWith({ id: 'second', cancelled: true })
    await act(async () => useSkillImportStore.getState().dismiss('first'))
    expect(useSkillImportStore.getState().deferredIds).toEqual([])
    expect(button('Review')).toBeUndefined()
  })
})
