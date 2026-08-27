// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'
import { installCssHighlightsMock, type TestHighlightRegistry } from '@/test-utils/css-highlights'
import type { TextAnnotation } from '../../../../shared/annotations'
import { WorkspacePlanActivityRecord } from './WorkspacePlanActivityRecord'

vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: PropsWithChildren) => <div>{children}</div>
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const createActivity = (
  rawInput: unknown,
  overrides: Partial<ToolActivity> = {}
): ToolActivity => ({
  id: 'plan/activity:1',
  kind: 'tool',
  title: 'generate_plan',
  providerToolName: 'generate_plan',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  rawInput,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const planArguments = {
  task_summary: 'Polish the example paragraph',
  phases: [
    {
      name: 'Work',
      delegations: [
        {
          name: 'Writing',
          steps: [
            { title: 'Inspect wording', description: 'Find unclear phrases.' },
            { title: 'Polish prose', description: 'Rewrite the paragraph.' }
          ]
        }
      ]
    }
  ],
  desired_outputs: [],
  feasibility: { confidence: 'high', rationale: 'The paragraph is available.' }
}

const createPreviewPlanArguments = (
  stepCount: number,
  taskSummary: string
): typeof planArguments => ({
  ...planArguments,
  task_summary: taskSummary,
  phases: [
    {
      name: 'Work',
      delegations: [
        {
          name: 'Writing',
          steps: Array.from({ length: stepCount }, (_, index) => ({
            title:
              index === 0
                ? 'Step 1 with a deliberately long title that must remain fully wrapped without clamping'
                : `Step ${index + 1}`,
            description: `Description ${index + 1}`
          }))
        }
      ]
    }
  ]
})

// jsdom does not synthesize a native button's click default action from keyboard events. Dispatch
// the browser event at the correct phase, then perform that default action only when it was not
// cancelled. Product code remains on native button semantics with no redundant key handler.
const activateNativeButtonWithKeyboard = (button: HTMLButtonElement, key: 'Enter' | ' '): void => {
  button.focus()
  const event = new KeyboardEvent(key === 'Enter' ? 'keydown' : 'keyup', {
    key,
    bubbles: true,
    cancelable: true
  })
  if (button.dispatchEvent(event)) button.click()
}

const getStepButtons = (container: ParentNode): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-controls^="plan-step-"]'))

let highlights: TestHighlightRegistry

const selectText = (element: HTMLElement): void => {
  const range = document.createRange()
  range.selectNodeContents(element)
  Object.defineProperty(range, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({
        left: 10,
        right: 120,
        top: 20,
        bottom: 40,
        width: 110,
        height: 20,
        x: 10,
        y: 20,
        toJSON: () => ({})
      }) as DOMRect
  })
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
}

describe('WorkspacePlanActivityRecord', () => {
  let container: HTMLDivElement
  let root: Root
  let notifyResize: (() => void) | undefined
  const originalResizeObserver = globalThis.ResizeObserver

  beforeEach(() => {
    highlights = installCssHighlightsMock()
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(): void {
        notifyResize = () => this.callback([], this as unknown as ResizeObserver)
      }
      disconnect(): void {
        notifyResize = undefined
      }
      unobserve(): void {
        notifyResize = undefined
      }
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    notifyResize = undefined
    window.getSelection()?.removeAllRanges()
    vi.unstubAllGlobals()
    if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver
    else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
  })

  it('shows task, count, and feasibility while descriptions start collapsed', () => {
    act(() => root.render(<WorkspacePlanActivityRecord activity={createActivity(planArguments)} />))

    expect(container.textContent).toContain('Created execution Plan')
    expect(container.textContent).toContain('2 steps')
    expect(container.textContent).toContain('Polish the example paragraph')
    expect(container.textContent).toContain('high confidence')
    expect(container.textContent).toContain('The paragraph is available.')
    expect(container.textContent).not.toContain('Find unclear phrases.')

    const buttons = getStepButtons(container)
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Inspect wording',
      'Polish prose'
    ])
    expect(buttons.every((button) => button.getAttribute('aria-expanded') === 'false')).toBe(true)
    expect(buttons.every((button) => Boolean(button.getAttribute('aria-controls')))).toBe(true)
  })

  it('creates and restores a task-summary annotation with the stable Plan source', () => {
    const activity = createActivity(planArguments)
    const onAdd = vi.fn<(annotation: TextAnnotation) => undefined>(() => undefined)
    const renderWith = (activeAnnotations: readonly TextAnnotation[]): void => {
      act(() =>
        root.render(
          <WorkspacePlanActivityRecord
            activity={activity}
            annotationPort={{
              sessionId: 'session-1',
              activeAnnotations,
              onAdd,
              onError: vi.fn()
            }}
          />
        )
      )
    }

    renderWith([])
    const summary = container.querySelector<HTMLElement>('[data-testid="plan-task-summary"]')!
    act(() => selectText(summary))
    const trigger = document.querySelector<HTMLButtonElement>('[data-annotation-trigger]')
    expect(trigger).not.toBeNull()
    act(() => trigger?.click())
    const confirm = Array.from(document.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Annotate')
      .at(-1)
    act(() => confirm?.click())

    const added = onAdd.mock.calls[0]?.[0]
    expect(added?.source).toEqual({
      kind: 'session-item',
      sessionId: 'session-1',
      itemId: activity.id,
      itemType: 'plan',
      sectionId: 'task-summary'
    })

    renderWith(added ? [added] : [])
    expect(
      Array.from(highlights.get('agent-annotation-draft') ?? []).map((range) => range.toString())
    ).toContain('Polish the example paragraph')
  })

  it('does not expand a step from the click following a text drag, but keeps ordinary click', () => {
    const onAdd = vi.fn<(annotation: TextAnnotation) => undefined>(() => undefined)
    act(() =>
      root.render(
        <WorkspacePlanActivityRecord
          activity={createActivity(planArguments)}
          annotationPort={{
            sessionId: 'session-1',
            activeAnnotations: [],
            onAdd,
            onError: vi.fn()
          }}
        />
      )
    )
    const first = getStepButtons(container)[0]
    const title = first.querySelector<HTMLElement>('span')!

    act(() => {
      selectText(title)
      first.click()
    })
    expect(first.getAttribute('aria-expanded')).toBe('false')

    window.getSelection()?.removeAllRanges()
    act(() => first.click())
    expect(first.getAttribute('aria-expanded')).toBe('true')
  })

  it('expands step descriptions independently with native button controls', () => {
    act(() => root.render(<WorkspacePlanActivityRecord activity={createActivity(planArguments)} />))
    const [first, second] = getStepButtons(container)

    expect(first.tagName).toBe('BUTTON')
    act(() => first.click())
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Find unclear phrases.')
    expect(container.textContent).not.toContain('Rewrite the paragraph.')
    expect(first.querySelector('span')?.className).toContain('text-[12px] text-text-000')
    expect(document.getElementById(first.getAttribute('aria-controls') ?? '')?.className).toContain(
      'text-[10.5px] leading-[1.5] text-text-300'
    )

    act(() => second.click())
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(second.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Find unclear phrases.')
    expect(container.textContent).toContain('Rewrite the paragraph.')
  })

  it.each([
    ['Enter', 'Enter'],
    ['Space', ' ']
  ] as const)('expands a step through native %s activation', (_label, key) => {
    act(() => root.render(<WorkspacePlanActivityRecord activity={createActivity(planArguments)} />))
    const first = getStepButtons(container)[0]
    expect(first?.getAttribute('aria-expanded')).toBe('false')

    act(() => {
      if (first) activateNativeButtonWithKeyboard(first, key)
    })

    expect(first?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Find unclear phrases.')
  })

  it('renders compact decisions and an explicit unavailable fallback', () => {
    act(() =>
      root.render(
        <div>
          <WorkspacePlanActivityRecord activity={createActivity({ decision: 'approved' })} />
          <WorkspacePlanActivityRecord
            activity={createActivity({ arguments: { decision: 'rejected' } }, { id: 'dismiss' })}
          />
          <WorkspacePlanActivityRecord activity={createActivity(undefined, { id: 'missing' })} />
        </div>
      )
    )

    expect(container.textContent).toContain('Approved execution Plan')
    expect(container.textContent).toContain('Dismissed execution Plan')
    expect(container.textContent).toContain('Plan details unavailable')
  })

  it('annotates failed Plan details and reveals them by the Plan activity', () => {
    const activity = createActivity(planArguments, {
      status: 'failed',
      rawOutput: { error: 'Plan service unavailable' }
    })
    const onAdd = vi.fn<(annotation: TextAnnotation) => undefined>(() => undefined)
    const renderWith = (
      activeAnnotations: readonly TextAnnotation[],
      revealRequest?: Readonly<{ requestId: number; itemId: string; sectionId?: string }>
    ): void => {
      act(() =>
        root.render(
          <WorkspacePlanActivityRecord
            activity={activity}
            annotationPort={{
              sessionId: 'session-1',
              activeAnnotations,
              onAdd,
              onError: vi.fn()
            }}
            revealRequest={revealRequest}
          />
        )
      )
    }

    renderWith([])

    expect(container.textContent).toContain('Failed to create execution Plan')
    const detailsButton = container.querySelector<HTMLButtonElement>('button')
    expect(detailsButton?.getAttribute('aria-expanded')).toBe('false')

    act(() => detailsButton?.click())
    expect(detailsButton?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Plan service unavailable')

    const errorDetails = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="tool-code-block"]')
    ).find((element) => element.textContent?.includes('Plan service unavailable'))
    expect(errorDetails).toBeDefined()
    act(() => selectText(errorDetails!))
    const trigger = document.querySelector<HTMLButtonElement>('[data-annotation-trigger]')
    expect(trigger).not.toBeNull()
    act(() => trigger?.click())
    const confirm = Array.from(document.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Annotate')
      .at(-1)
    act(() => confirm?.click())

    const added = onAdd.mock.calls[0]?.[0]
    expect(added?.source).toEqual({
      kind: 'session-item',
      sessionId: 'session-1',
      itemId: activity.id,
      itemType: 'plan',
      sectionId: 'output'
    })

    act(() => detailsButton?.click())
    expect(detailsButton?.getAttribute('aria-expanded')).toBe('false')
    renderWith(added ? [added] : [], {
      requestId: 1,
      itemId: activity.id,
      sectionId: 'output'
    })

    expect(detailsButton?.getAttribute('aria-expanded')).toBe('true')
    expect(
      Array.from(highlights.get('agent-annotation-draft') ?? []).map((range) => range.toString())
    ).toContain(errorDetails?.textContent)
  })

  it('offers an independent three-line task preview only when the summary overflows', () => {
    act(() => root.render(<WorkspacePlanActivityRecord activity={createActivity(planArguments)} />))
    expect(container.querySelector('[data-testid="plan-task-summary-toggle"]')).toBeNull()

    const longPlan = createPreviewPlanArguments(
      2,
      'Prepare and polish a long task summary while preserving meaning, terminology, tone, evidence, and every required output.'
    )
    act(() => root.render(<WorkspacePlanActivityRecord activity={createActivity(longPlan)} />))
    const summary = container.querySelector<HTMLElement>('[data-testid="plan-task-summary"]')
    Object.defineProperties(summary, {
      clientHeight: { configurable: true, value: 60 },
      scrollHeight: { configurable: true, value: 120 }
    })
    act(() => notifyResize?.())

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="plan-task-summary-toggle"]'
    )
    expect(summary?.className).toContain('line-clamp-3')
    expect(toggle?.textContent).toContain('Show full task')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')

    act(() => toggle?.click())
    expect(summary?.className).not.toContain('line-clamp-3')
    expect(toggle?.textContent).toContain('Show less')
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-testid="plan-expand-all"]')?.textContent).toContain(
      'Expand all'
    )
    expect(container.textContent).not.toContain('Find unclear phrases.')
  })

  it('shows five unclamped step titles and a dynamic compact remainder', () => {
    const previewPlan = createPreviewPlanArguments(8, 'Prepare the report')
    act(() => root.render(<WorkspacePlanActivityRecord activity={createActivity(previewPlan)} />))

    const stepButtons = getStepButtons(container)
    expect(stepButtons).toHaveLength(5)
    expect(container.textContent).toContain('+ 3 more steps')
    expect(container.textContent).not.toContain('Step 6')
    expect(stepButtons[0].textContent).toContain(
      'Step 1 with a deliberately long title that must remain fully wrapped without clamping'
    )
    expect(stepButtons[0].querySelector('span')?.className).not.toMatch(/truncate|line-clamp/u)

    act(() =>
      root.render(
        <WorkspacePlanActivityRecord
          activity={createActivity(createPreviewPlanArguments(6, 'Prepare the report'))}
        />
      )
    )
    expect(container.textContent).toContain('+ 1 more step')
  })

  it('expands and collapses the whole card from compact or partially expanded state', () => {
    const previewPlan = createPreviewPlanArguments(
      8,
      'Prepare and polish a long task summary while preserving meaning, terminology, tone, evidence, and every required output.'
    )
    act(() => root.render(<WorkspacePlanActivityRecord activity={createActivity(previewPlan)} />))
    const summary = container.querySelector<HTMLElement>('[data-testid="plan-task-summary"]')
    Object.defineProperties(summary, {
      clientHeight: { configurable: true, value: 60 },
      scrollHeight: { configurable: true, value: 120 }
    })
    act(() => notifyResize?.())

    const firstStep = getStepButtons(container)[0]
    const expandAll = container.querySelector<HTMLButtonElement>('[data-testid="plan-expand-all"]')
    act(() => firstStep?.click())
    expect(container.textContent).toContain('Description 1')
    expect(expandAll?.textContent).toContain('Expand all')

    act(() => expandAll?.click())
    const allStepButtons = getStepButtons(container)
    expect(allStepButtons).toHaveLength(8)
    expect(allStepButtons.every((button) => button.getAttribute('aria-expanded') === 'true')).toBe(
      true
    )
    expect(container.textContent).toContain('Description 8')
    expect(container.textContent).not.toContain('+ 3 more steps')
    expect(container.textContent).toContain('Show less')
    expect(expandAll?.textContent).toContain('Collapse all')
    expect(expandAll?.getAttribute('aria-expanded')).toBe('true')

    act(() => expandAll?.click())
    expect(getStepButtons(container)).toHaveLength(5)
    expect(container.textContent).not.toContain('Description 1')
    expect(container.textContent).toContain('+ 3 more steps')
    expect(container.textContent).toContain('Show full task')
    expect(expandAll?.textContent).toContain('Expand all')
    expect(expandAll?.getAttribute('aria-expanded')).toBe('false')
  })
})
