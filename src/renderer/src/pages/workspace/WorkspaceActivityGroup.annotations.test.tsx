// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'
import { installCssHighlightsMock, type TestHighlightRegistry } from '@/test-utils/css-highlights'
import type { TextAnnotation } from '../../../../shared/annotations'
import { requestAnnotationReveal } from './annotations/annotation-reveal'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useMessageScroller: () => ({ scrollToMessage: vi.fn() })
}))

let highlights: TestHighlightRegistry

const createActivity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'activity-1',
  kind: 'tool',
  title: 'Tool',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1,
  updatedAt: 2,
  ...overrides
})

describe('WorkspaceActivityGroup text annotations', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    highlights = installCssHighlightsMock()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
    window.getSelection()?.removeAllRanges()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    container.remove()
  })

  const renderActivity = async (
    activity: ToolActivity,
    annotations: readonly TextAnnotation[],
    onAdd: (annotation: TextAnnotation) => undefined,
    revealRequest?: Readonly<{ requestId: number; itemId: string; sectionId?: string }>
  ): Promise<void> => {
    await act(async () => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: `group-${activity.id}`,
            type: 'activity-group',
            createdAt: activity.createdAt,
            sortIndex: activity.sortIndex,
            activities: [activity]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{ [activity.id]: true }}
          onToggleRow={vi.fn()}
          annotationPort={{
            sessionId: 'session-1',
            activeAnnotations: annotations,
            onAdd,
            onError: vi.fn()
          }}
          revealRequest={revealRequest}
        />
      )
    })
  }

  const selectAndAnnotate = async (element: HTMLElement): Promise<void> => {
    const range = document.createRange()
    range.selectNodeContents(element)
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          left: 10,
          right: 180,
          top: 20,
          bottom: 40,
          width: 170,
          height: 20,
          x: 10,
          y: 20,
          toJSON: () => ({})
        }) as DOMRect
    })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    await act(async () => element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    const trigger = document.querySelector<HTMLButtonElement>('[data-annotation-trigger]')
    expect(trigger).not.toBeNull()
    await act(async () => trigger?.click())
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .filter((button) => button.textContent === 'Annotate')
      .at(-1)
    await act(async () => confirm?.click())
  }

  it('annotates a Web Search query and result title without including or navigating its URL', async () => {
    const activity = createActivity({
      id: 'web-search-1',
      title: 'open science repositories',
      toolKind: 'search',
      providerToolName: 'WebSearch',
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              query: 'open science repositories',
              results: [
                {
                  title: 'Open Science Framework',
                  url: 'https://osf.io'
                },
                {
                  title: 'Zenodo',
                  url: 'https://zenodo.org'
                }
              ]
            })
          }
        }
      ]
    })
    const addedAnnotations: TextAnnotation[] = []
    const onAdd = vi.fn((annotation: TextAnnotation) => {
      addedAnnotations.push(annotation)
      return undefined
    })

    await renderActivity(activity, [], onAdd)
    const details = container.querySelector<HTMLElement>('[data-testid="tool-search-details"]')!
    const query = Array.from(details.querySelectorAll<HTMLElement>('span')).find(
      (element) => element.textContent === 'open science repositories'
    )!
    const title = details.querySelector<HTMLAnchorElement>('a')!
    const url = Array.from(details.querySelectorAll<HTMLElement>('div')).find(
      (element) => element.textContent === 'https://osf.io'
    )!
    expect(query.closest('[data-annotation-surface]')).not.toBeNull()
    expect(title.closest('[data-annotation-surface]')).not.toBeNull()
    expect(url.closest('[data-annotation-surface]')).toBeNull()

    await selectAndAnnotate(query)

    const titleRange = document.createRange()
    titleRange.selectNodeContents(title)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(titleRange)
    const clickAllowed = title.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    )
    expect(clickAllowed).toBe(false)
    await selectAndAnnotate(title)

    expect(addedAnnotations.map(({ quote, source }) => ({ quote, source }))).toEqual([
      {
        quote: 'open science repositories',
        source: {
          kind: 'session-item',
          sessionId: 'session-1',
          itemType: 'tool-activity',
          itemId: 'web-search-1',
          sectionId: 'query'
        }
      },
      {
        quote: 'Open Science Framework',
        source: {
          kind: 'session-item',
          sessionId: 'session-1',
          itemType: 'tool-activity',
          itemId: 'web-search-1',
          sectionId: 'result:https%3A%2F%2Fosf.io:title'
        }
      }
    ])

    await renderActivity(activity, addedAnnotations, onAdd)
    expect(
      Array.from(highlights.get('agent-annotation-draft') ?? []).map((range) => range.toString())
    ).toEqual(expect.arrayContaining(['open science repositories', 'Open Science Framework']))

    const reorderedActivity = createActivity({
      ...activity,
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              query: 'open science repositories',
              results: [
                { title: 'Zenodo', url: 'https://zenodo.org' },
                { title: 'Open Science Framework', url: 'https://osf.io' }
              ]
            })
          }
        }
      ]
    })
    await renderActivity(reorderedActivity, addedAnnotations, onAdd)
    const reorderedHighlights = Array.from(highlights.get('agent-annotation-draft') ?? []).map(
      (range) => range.toString()
    )
    expect(reorderedHighlights).toContain('Open Science Framework')
    expect(reorderedHighlights).not.toContain('Zenodo')
  })

  it('annotates only terminal package results, related changes, and failure details', async () => {
    const activity = createActivity({
      id: 'manage-packages-1',
      title: 'open-science-notebook.manage_packages',
      providerToolName: 'open-science-notebook.manage_packages',
      status: 'failed',
      rawInput: { language: 'python', packages: ['numpy'] },
      rawOutput: {
        structuredContent: {
          ok: false,
          method: 'conda',
          error: 'The analysis environment is read-only.',
          packageChanges: [
            {
              name: 'numpy',
              relationship: 'requested',
              change: 'installed',
              afterVersion: '2.1.0'
            },
            {
              name: 'S7',
              relationship: 'unattributed',
              change: 'updated',
              beforeVersion: '0.1.0',
              afterVersion: '0.2.0'
            }
          ]
        }
      }
    })
    const addedAnnotations: TextAnnotation[] = []
    const onAdd = vi.fn((annotation: TextAnnotation) => {
      addedAnnotations.push(annotation)
      return undefined
    })

    await renderActivity(activity, [], onAdd)
    const packageRow = container.querySelector<HTMLElement>(
      '[data-testid="manage-packages-package-row"]'
    )!
    const packageName = Array.from(packageRow.querySelectorAll<HTMLElement>('span')).find(
      (element) => element.textContent === 'numpy'
    )!
    const packageVersion = packageRow.querySelector<HTMLElement>(
      '[data-testid="manage-packages-package-version"]'
    )!
    const packageStatus = packageRow.querySelector<HTMLElement>(
      '[data-testid="manage-packages-package-status"]'
    )!
    const relatedRow = container.querySelector<HTMLElement>(
      '[data-testid="manage-packages-related-row"]'
    )!
    const relatedStatus = Array.from(relatedRow.querySelectorAll<HTMLElement>('span')).find(
      (element) => element.textContent === 'Updated'
    )!
    const relatedName = Array.from(relatedRow.querySelectorAll<HTMLElement>('span')).find(
      (element) => element.textContent === 'S7'
    )!
    const failure = Array.from(container.querySelectorAll<HTMLElement>('p')).find(
      (element) => element.textContent === 'The analysis environment is read-only.'
    )!
    const excludedFromAnnotation = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-testid="manage-packages-details"] > div:first-child > span'
      ),
      packageStatus,
      relatedStatus,
      container.querySelector<HTMLElement>('[data-testid="manage-packages-progress"] > button')!,
      container.querySelector<HTMLElement>('details > summary')!
    ]
    expect(
      excludedFromAnnotation.every(
        (element) => element.closest('[data-annotation-surface]') === null
      )
    ).toBe(true)
    expect(packageName.closest('[data-annotation-surface]')).not.toBeNull()
    expect(packageVersion.closest('[data-annotation-surface]')).not.toBeNull()
    expect(relatedName.closest('[data-annotation-surface]')).not.toBeNull()
    expect(failure.closest('[data-annotation-surface]')).not.toBeNull()

    await selectAndAnnotate(packageName)
    await selectAndAnnotate(relatedName)
    await selectAndAnnotate(failure)

    const sources = addedAnnotations.map(({ source }) => source)
    expect(sources[0]).toMatchObject({
      kind: 'session-item',
      sessionId: 'session-1',
      itemType: 'tool-activity',
      itemId: 'manage-packages-1'
    })
    expect(sources[0]?.kind === 'session-item' ? sources[0].sectionId : undefined).toMatch(
      /^package:[^:]+:[a-z0-9]+:identity$/u
    )
    expect(sources[1]).toMatchObject({
      kind: 'session-item',
      sessionId: 'session-1',
      itemType: 'tool-activity',
      itemId: 'manage-packages-1'
    })
    expect(sources[1]?.kind === 'session-item' ? sources[1].sectionId : undefined).toMatch(
      /^related-package:[^:]+:[a-z0-9]+:identity$/u
    )
    expect(sources[2]).toEqual({
      kind: 'session-item',
      sessionId: 'session-1',
      itemType: 'tool-activity',
      itemId: 'manage-packages-1',
      sectionId: 'failure'
    })

    await renderActivity(activity, addedAnnotations, onAdd)
    const restored = Array.from(highlights.get('agent-annotation-draft') ?? []).map((range) =>
      range.toString()
    )
    expect(restored).toEqual(
      expect.arrayContaining([
        expect.stringContaining('numpy'),
        expect.stringContaining('S7'),
        'The analysis environment is read-only.'
      ])
    )
  })

  it('restores and reveals equal package versions only in their stable package field', async () => {
    const activity = createActivity({
      id: 'manage-packages-duplicate-version',
      title: 'open-science-notebook.manage_packages',
      providerToolName: 'open-science-notebook.manage_packages',
      rawInput: { language: 'python', packages: ['alpha', 'beta'] },
      rawOutput: {
        structuredContent: {
          ok: true,
          method: 'conda',
          packageChanges: [
            {
              name: 'alpha',
              relationship: 'requested',
              change: 'installed',
              afterVersion: '1.0.0',
              source: { type: 'github', repository: 'science/shared', ref: 'v1' }
            },
            {
              name: 'beta',
              relationship: 'requested',
              change: 'installed',
              afterVersion: '1.0.0',
              source: { type: 'github', repository: 'science/shared', ref: 'v1' }
            }
          ]
        }
      }
    })
    const addedAnnotations: TextAnnotation[] = []
    const onAdd = vi.fn((annotation: TextAnnotation) => {
      addedAnnotations.push(annotation)
      return undefined
    })

    await renderActivity(activity, [], onAdd)
    const versions = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="manage-packages-package-version"]')
    )
    await selectAndAnnotate(versions[1]!)
    expect(addedAnnotations).toHaveLength(1)
    const sectionId =
      addedAnnotations[0]?.source.kind === 'session-item'
        ? addedAnnotations[0].source.sectionId
        : undefined
    expect(sectionId).toMatch(/^package:[^:]+:[a-z0-9]+:version$/u)
    expect(sectionId!.length).toBeLessThanOrEqual(72)

    await renderActivity(activity, addedAnnotations, onAdd)
    const restored = Array.from(highlights.get('agent-annotation-draft') ?? [])
    expect(restored).toHaveLength(1)
    expect(
      restored[0]?.startContainer.parentElement?.closest(
        '[data-testid="manage-packages-package-row"]'
      )?.textContent
    ).toContain('beta')

    const revealedRows: Element[] = []
    Element.prototype.scrollIntoView = function (): void {
      const row = this.closest('[data-testid="manage-packages-package-row"]')
      if (row) revealedRows.push(row)
    }
    await act(async () => requestAnnotationReveal(addedAnnotations[0]!))
    expect(revealedRows).toHaveLength(1)
    expect(revealedRows[0]?.textContent).toContain('beta')

    const reorderedActivity = createActivity({
      ...activity,
      rawInput: { language: 'python', packages: ['beta', 'alpha'] }
    })
    await renderActivity(reorderedActivity, addedAnnotations, onAdd)
    const reordered = Array.from(highlights.get('agent-annotation-draft') ?? [])
    expect(reordered).toHaveLength(1)
    expect(
      reordered[0]?.startContainer.parentElement?.closest(
        '[data-testid="manage-packages-package-row"]'
      )?.textContent
    ).toContain('beta')
  })

  it('keeps active package progress and changing result rows outside annotation surfaces', async () => {
    const activity = createActivity({
      id: 'manage-packages-active',
      title: 'open-science-notebook.manage_packages',
      providerToolName: 'open-science-notebook.manage_packages',
      status: 'in_progress',
      rawInput: { language: 'python', packages: ['numpy'] }
    })

    await renderActivity(
      activity,
      [],
      vi.fn(() => undefined)
    )

    const progress = container.querySelector<HTMLElement>('.install-progress-indeterminate')!
    const packageRow = container.querySelector<HTMLElement>(
      '[data-testid="manage-packages-package-row"]'
    )!
    expect(progress.closest('[data-annotation-surface]')).toBeNull()
    expect(packageRow.closest('[data-annotation-surface]')).toBeNull()
  })

  it('opens a terminal package related-changes section for matching repeat reveal requests', async () => {
    const activity = createActivity({
      id: 'manage-packages-reveal',
      title: 'open-science-notebook.manage_packages',
      providerToolName: 'open-science-notebook.manage_packages',
      rawInput: { language: 'python', packages: ['numpy'] },
      rawOutput: {
        structuredContent: {
          ok: true,
          method: 'conda',
          packageChanges: [
            {
              name: 'S7',
              relationship: 'unattributed',
              change: 'updated',
              beforeVersion: '0.1.0',
              afterVersion: '0.2.0'
            }
          ]
        }
      }
    })
    const addedAnnotations: TextAnnotation[] = []
    const onAdd = vi.fn((annotation: TextAnnotation) => {
      addedAnnotations.push(annotation)
      return undefined
    })

    await renderActivity(activity, [], onAdd)
    const relatedName = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="manage-packages-related-row"] span')
    ).find((element) => element.textContent === 'S7')!
    await selectAndAnnotate(relatedName)
    const annotation = addedAnnotations[0]!
    const annotationSectionId =
      annotation.source.kind === 'session-item' ? annotation.source.sectionId : undefined
    expect(annotationSectionId).toMatch(/^related-package:/u)

    await renderActivity(activity, [annotation], onAdd)
    const related = container.querySelector<HTMLDetailsElement>('details')!
    related.open = false
    expect(related.open).toBe(false)

    await renderActivity(activity, [annotation], onAdd, {
      requestId: 1,
      itemId: 'another-activity',
      sectionId: annotationSectionId
    })
    expect(related.open).toBe(false)

    await renderActivity(activity, [annotation], onAdd, {
      requestId: 2,
      itemId: activity.id,
      sectionId: annotationSectionId
    })
    expect(related.open).toBe(true)

    await act(async () => related.querySelector('summary')?.click())
    expect(related.open).toBe(false)

    await renderActivity(activity, [annotation], onAdd, {
      requestId: 3,
      itemId: activity.id,
      sectionId: annotationSectionId
    })
    expect(related.open).toBe(true)
  })
})
