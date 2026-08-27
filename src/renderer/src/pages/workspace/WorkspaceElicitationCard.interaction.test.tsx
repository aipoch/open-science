// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceElicitationCard } from './WorkspaceElicitationCard'

import type { ToolActivity } from '@/stores/session-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const setTextControlValue = (
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string
): void => {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  setter?.call(control, value)
  control.dispatchEvent(new Event('input', { bubbles: true }))
}

const fields = [
  {
    id: 'question_0',
    label: 'Skill type',
    kind: 'single-select' as const,
    options: [
      {
        value: 'multi-omics',
        label: 'Multi-omics integration',
        description:
          'Combine transcriptomics, proteomics, and genomics across platforms with differential analysis, enrichment, interaction networks, quality control, and publication-ready visualization.'
      },
      { value: 'clinical', label: 'Clinical statistics' },
      { value: 'screening', label: 'High-throughput screening' },
      { value: 'single-cell', label: 'Single-cell omics' }
    ]
  },
  {
    id: 'question_0_custom',
    label: 'Other',
    description: 'Type your own answer instead of choosing an option above (optional).',
    kind: 'text' as const
  }
]

const activity: ToolActivity = {
  id: 'tool-ask-1',
  kind: 'tool',
  title: 'AskUserQuestion',
  status: 'in_progress',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1,
  updatedAt: 1,
  elicitation: {
    message: 'What kind of skill are you trying to create?',
    fields,
    state: 'pending'
  }
}

const request = {
  requestId: 'elicitation-1',
  sessionId: 'session-1',
  toolCallId: activity.id,
  message: activity.elicitation?.message ?? '',
  fields
}

const multiQuestionFields = [
  {
    ...fields[0],
    label: 'Skill scope',
    description: 'What should this skill primarily cover?'
  },
  fields[1],
  {
    id: 'question_1',
    label: 'Language',
    description: 'Which language should the skill use?',
    kind: 'single-select' as const,
    options: [
      { value: 'chinese', label: 'Chinese' },
      { value: 'english', label: 'English' }
    ]
  },
  {
    id: 'question_1_custom',
    label: 'Other',
    kind: 'text' as const
  }
]

const multiQuestionRequest = {
  ...request,
  fields: multiQuestionFields,
  message: 'Please answer the following questions.'
}

const maximumQuestionFields = Array.from({ length: 8 }, (_, index) => [
  {
    ...fields[0],
    id: `question_${index}`,
    label: `Question ${index + 1}`,
    description: `Prompt ${index + 1}`
  },
  {
    ...fields[1],
    id: `question_${index}_custom`
  }
]).flat()

const mixedChoiceFields = [
  { ...multiQuestionFields[0], kind: 'multi-select' as const },
  ...multiQuestionFields.slice(1)
]

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('WorkspaceElicitationCard choice question', () => {
  it('presents a provider-native multi-select question as one step instead of a whole form', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const mixedRequest = { ...multiQuestionRequest, fields: mixedChoiceFields }

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: mixedRequest.message,
            fields: mixedChoiceFields,
            state: 'pending'
          }}
          request={mixedRequest}
          onRespond={onRespond}
        />
      )
    })

    expect(container.querySelector('[data-testid="elicitation-choice-mode"]')).not.toBeNull()
    expect(container.querySelector('h3')?.textContent).toBe(
      'What should this skill primarily cover?'
    )
    expect(
      container.querySelector('[data-testid="elicitation-question-progress"]')?.textContent
    ).toBe('1 of 2')
    expect(
      container
        .querySelector('[data-testid="elicitation-question-progress"]')
        ?.getAttribute('aria-label')
    ).toBe('Question 1 of 2')
    expect(
      container
        .querySelector('[data-testid="elicitation-question-progress"]')
        ?.parentElement?.classList.contains('sticky')
    ).toBe(true)
    expect(
      container
        .querySelector('[data-testid="elicitation-question-progress"]')
        ?.parentElement?.classList.contains('top-3')
    ).toBe(true)
    expect(container.querySelector('h3')?.classList.contains('pr-36')).toBe(true)
    expect(
      Array.from(
        container.querySelectorAll('[data-testid="elicitation-question-progress-segment"]')
      ).map((segment) => segment.getAttribute('data-state'))
    ).toEqual(['current', 'upcoming'])
    expect(container.textContent).not.toContain('Which language should the skill use?')

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="elicitation-option-multi-omics"]')
        ?.click()
    })
    expect(container.querySelector('h3')?.textContent).toBe(
      'What should this skill primarily cover?'
    )

    const nextButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Next'
    )
    expect(nextButton?.disabled).toBe(false)
    expect(nextButton?.querySelector('svg.lucide-chevron-right')).not.toBeNull()
    await act(async () => nextButton?.click())

    expect(container.querySelector('h3')?.textContent).toBe('Which language should the skill use?')
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('counts each checked option of a multi-select question in the selected tally', async () => {
    const mixedRequest = { ...multiQuestionRequest, fields: mixedChoiceFields }

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: mixedRequest.message,
            fields: mixedChoiceFields,
            state: 'pending'
          }}
          request={mixedRequest}
        />
      )
    })

    expect(container.textContent).toContain('0 selected')

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="elicitation-option-multi-omics"]')
        ?.click()
    })
    expect(container.textContent).toContain('1 selected')

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="elicitation-option-clinical"]')
        ?.click()
    })
    expect(container.textContent).toContain('2 selected')

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="elicitation-option-clinical"]')
        ?.click()
    })
    expect(container.textContent).toContain('1 selected')
  })

  it('counts only the current question selection in the footer tally', async () => {
    const onDraftChange = vi.fn()

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: multiQuestionRequest.message,
            fields: multiQuestionFields,
            state: 'pending'
          }}
          request={multiQuestionRequest}
          onDraftChange={onDraftChange}
        />
      )
    })

    expect(container.textContent).toContain('0 selected')

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="elicitation-option-multi-omics"]')
        ?.click()
    })
    expect(container.textContent).toContain('1 selected')

    const next = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Next'
    )
    await act(async () => next?.click())

    // The first question's answer must not leak into the second question's tally.
    expect(container.querySelector('h3')?.textContent).toBe('Which language should the skill use?')
    expect(container.textContent).toContain('0 selected')

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="elicitation-option-chinese"]')
        ?.click()
    })
    expect(container.textContent).toContain('1 selected')
  })

  it('presents multiple choice questions one at a time and finishes only after the last answer', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const onDraftChange = vi.fn()

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: multiQuestionRequest.message,
            fields: multiQuestionFields,
            state: 'pending'
          }}
          request={multiQuestionRequest}
          onRespond={onRespond}
          onDraftChange={onDraftChange}
        />
      )
    })

    expect(container.querySelector('h3')?.textContent).toBe(
      'What should this skill primarily cover?'
    )
    expect(
      container.querySelector('[data-testid="elicitation-question-progress"]')?.textContent
    ).toBe('1 of 2')
    expect(container.textContent).not.toContain('Which language should the skill use?')

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="elicitation-option-multi-omics"]')
        ?.click()
    })

    expect(onRespond).not.toHaveBeenCalled()
    expect(onDraftChange).not.toHaveBeenCalled()
    expect(container.querySelector('h3')?.textContent).toBe(
      'What should this skill primarily cover?'
    )

    const advance = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Next'
    )
    expect(advance?.disabled).toBe(false)
    expect(advance?.querySelector('svg.lucide-chevron-right')).not.toBeNull()
    await act(async () => advance?.click())

    expect(onDraftChange).toHaveBeenCalledOnce()
    expect(onDraftChange).toHaveBeenLastCalledWith([
      { fieldId: 'question_0', value: 'multi-omics' }
    ])
    expect(container.querySelector('h3')?.textContent).toBe('Which language should the skill use?')
    expect(
      container.querySelector('[data-testid="elicitation-question-progress"]')?.textContent
    ).toBe('2 of 2')
    expect(
      container
        .querySelector('[data-testid="elicitation-question-progress"]')
        ?.getAttribute('aria-label')
    ).toBe('Question 2 of 2')
    expect(
      Array.from(
        container.querySelectorAll('[data-testid="elicitation-question-progress-segment"]')
      ).map((segment) => segment.getAttribute('data-state'))
    ).toEqual(['upcoming', 'current'])
    expect(container.textContent).not.toContain('Finish')

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="elicitation-option-chinese"]')
        ?.click()
    })

    expect(onRespond).not.toHaveBeenCalled()
    expect(onDraftChange).toHaveBeenCalledOnce()
    expect(onDraftChange).toHaveBeenLastCalledWith([
      { fieldId: 'question_0', value: 'multi-omics' }
    ])
    const finish = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Finish'
    )
    expect(finish?.disabled).toBe(false)

    const back = container.querySelector<HTMLButtonElement>('[aria-label="Previous question"]')
    expect(back?.textContent).toContain('Back')
    expect(back?.querySelector('svg.lucide-chevron-left')).not.toBeNull()
    expect(back?.parentElement).toBe(finish?.parentElement)
    await act(async () => {
      back?.click()
    })
    expect(
      container.querySelector('[data-testid="elicitation-question-progress"]')?.textContent
    ).toBe('1 of 2')
    expect(
      container
        .querySelector('[data-testid="elicitation-option-multi-omics"]')
        ?.getAttribute('data-selected')
    ).toBe('true')

    const next = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Next'
    )
    expect(next?.querySelector('svg.lucide-chevron-right')).not.toBeNull()
    await act(async () => next?.click())
    expect(onDraftChange).toHaveBeenCalledTimes(2)
    expect(onDraftChange).toHaveBeenLastCalledWith([
      { fieldId: 'question_0', value: 'multi-omics' }
    ])
    expect(
      container.querySelector('[data-testid="elicitation-question-progress"]')?.textContent
    ).toBe('2 of 2')

    const restoredFinish = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Finish'
    )
    await act(async () => restoredFinish?.click())

    expect(onRespond).toHaveBeenCalledWith({
      requestId: request.requestId,
      action: 'accept',
      answers: [
        { fieldId: 'question_0', value: 'multi-omics' },
        { fieldId: 'question_1', value: 'chinese' }
      ]
    })
  })

  it('keeps progress segments width-bounded at the maximum accepted question count', async () => {
    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: multiQuestionRequest.message,
            fields: maximumQuestionFields,
            state: 'pending'
          }}
          request={{ ...multiQuestionRequest, fields: maximumQuestionFields }}
        />
      )
    })

    const segments = Array.from(
      container.querySelectorAll('[data-testid="elicitation-question-progress-segment"]')
    )
    expect(segments).toHaveLength(8)
    expect(segments[0]?.parentElement?.classList.contains('w-16')).toBe(true)
    expect(segments.every((segment) => segment.classList.contains('flex-1'))).toBe(true)
    expect(
      container.querySelector('[data-testid="elicitation-question-progress"]')?.textContent
    ).toBe('1 of 8')
  })

  it('resumes a pending multi-question choice at the first unanswered step', async () => {
    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: multiQuestionRequest.message,
            fields: multiQuestionFields,
            state: 'pending',
            draftAnswers: [{ fieldId: 'question_0', value: 'clinical' }]
          }}
          request={multiQuestionRequest}
        />
      )
    })

    expect(container.querySelector('h3')?.textContent).toBe('Which language should the skill use?')
    expect(
      container.querySelector('[data-testid="elicitation-question-progress"]')?.textContent
    ).toBe('2 of 2')
    // The tally reflects the question on screen, not the restored draft of the previous one.
    expect(container.textContent).toContain('0 selected')
  })

  it('expands each answered question accordion-style to reveal its original content', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const durableRequest = {
      ...multiQuestionRequest,
      durable: {
        kind: 'agent-user-choice' as const,
        requestId: multiQuestionRequest.requestId,
        promptMessageId: 'prompt-1'
      }
    }

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: multiQuestionRequest.message,
            fields: multiQuestionFields,
            state: 'answered',
            durable: durableRequest.durable,
            answers: [
              { fieldId: 'question_0', value: 'multi-omics' },
              { fieldId: 'question_1', value: 'chinese' }
            ]
          }}
          request={durableRequest}
          onRespond={onRespond}
        />
      )
    })

    const rows = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="elicitation-answer-row"]')
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute('aria-expanded')).toBe('false')
    expect(rows[1]?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-testid="elicitation-choice-review"]')).toBeNull()

    // Expanding the first question reveals only its own original content in place.
    await act(async () => rows[0]?.click())
    expect(rows[0]?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('[data-testid="elicitation-choice-review"]')).toHaveLength(1)
    // The expanded content sits on a translucent white panel — a different material from the
    // gray summary rows so the two read apart at a glance.
    const reviewWrap = container.querySelector(
      '[data-testid="elicitation-choice-review"]'
    )?.parentElement
    expect(reviewWrap?.className).toContain('bg-bg-000/60')
    expect(reviewWrap?.className).toContain('rounded-')
    expect(reviewWrap?.className).not.toContain('border-l-2')
    // Expanded rows match the compact scale of the summary list rows above — no separators.
    const expandedOption = container.querySelector('[data-testid="elicitation-option-multi-omics"]')
    const expandedBadge = expandedOption?.querySelector('span')
    expect(expandedBadge?.className).toContain('size-5')
    expect(expandedOption?.classList.contains('border-b')).toBe(false)
    expect(expandedOption?.getAttribute('data-selected')).toBe('true')
    // The second question stays a collapsed list row — its options are not rendered.
    expect(container.querySelector('[data-testid="elicitation-option-chinese"]')).toBeNull()
    expect(container.textContent).toContain('What should this skill primarily cover?')
    expect(container.textContent).not.toContain('Which language should the skill use?')
    // The custom-input row only appears when the recorded answer was a custom input.
    expect(container.querySelector('[data-testid="elicitation-custom-answer-review"]')).toBeNull()
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).not.toContain('Skip')
    expect(container.textContent).not.toContain('Submit')
    expect(onRespond).not.toHaveBeenCalled()

    // Expanding the second question stacks below the first, accordion-style.
    await act(async () => rows[1]?.click())
    expect(rows[1]?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('[data-testid="elicitation-choice-review"]')).toHaveLength(2)
    expect(container.textContent).toContain('Which language should the skill use?')
    expect(
      container
        .querySelector('[data-testid="elicitation-option-chinese"]')
        ?.getAttribute('data-selected')
    ).toBe('true')

    // Collapsing the first question leaves the second one open.
    await act(async () => rows[0]?.click())
    expect(rows[0]?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-testid="elicitation-choice-review"]')).toHaveLength(1)
    expect(container.querySelector('[data-testid="elicitation-option-multi-omics"]')).toBeNull()
    expect(container.querySelector('[data-testid="elicitation-option-chinese"]')).not.toBeNull()
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('styles skipped choice cards like the summary and expands each question for review', async () => {
    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: multiQuestionRequest.message,
            fields: multiQuestionFields,
            state: 'declined'
          }}
          request={multiQuestionRequest}
        />
      )
    })

    const card = container.querySelector('[data-testid="elicitation-card"]')
    expect(card?.className).toContain('bg-bg-200')
    expect(card?.className).not.toContain('border-border-200')

    const summary = container.querySelector('[data-testid="elicitation-answer-summary"]')
    expect(summary?.querySelector('svg.lucide-circle-question-mark')).not.toBeNull()
    expect(summary?.textContent).toContain('What should this skill primarily cover?')
    expect(summary?.textContent).toContain('2 questions')
    // The status sits on the title line itself, right after the icon, ahead of the title.
    const headerText = summary?.querySelector('h3')?.textContent ?? ''
    expect(headerText).toContain('Skipped')
    expect(headerText.indexOf('Skipped')).toBeLessThan(
      headerText.indexOf('What should this skill primarily cover?')
    )
    expect(summary?.querySelector('p')).toBeNull()

    const rows = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="elicitation-answer-row"]')
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute('aria-expanded')).toBe('false')
    expect(rows[0]?.textContent).toContain('Skill scope')
    expect(container.querySelector('[data-testid="elicitation-choice-review"]')).toBeNull()

    // Clicking a row reveals that question's original content with nothing selected.
    await act(async () => rows[0]?.click())
    expect(rows[0]?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-testid="elicitation-choice-review"]')).not.toBeNull()
    expect(
      container
        .querySelector('[data-testid="elicitation-option-multi-omics"]')
        ?.getAttribute('data-selected')
    ).toBe('false')
    expect(container.querySelector('[data-testid="elicitation-custom-answer-review"]')).toBeNull()

    await act(async () => rows[0]?.click())
    expect(container.querySelector('[data-testid="elicitation-choice-review"]')).toBeNull()
  })

  it('places a warning-colored Skip all button last in the footer row for multi-question cards', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: multiQuestionRequest.message,
            fields: multiQuestionFields,
            state: 'pending'
          }}
          request={multiQuestionRequest}
          onRespond={onRespond}
        />
      )
    })

    const skip = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Skip all'
    )
    expect(skip).toBeDefined()
    expect(skip?.className).toContain('status-warning')
    // Footer buttons match the compact card scale.
    expect(skip?.className).not.toContain('h-11')
    // Advance to the second question so Back renders, then check it shares the same pill
    // geometry as the solid buttons (no borderless ghost).
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="elicitation-option-multi-omics"]')
        ?.click()
    })
    const next = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Next'
    )
    await act(async () => next?.click())
    const back = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Back'
    )
    expect(back?.getAttribute('data-variant')).toBe('secondary')
    expect(back?.className).toContain('px-3')
    // Same row as the footer tally, last button in the action group.
    const skipAfter = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Skip all'
    )
    expect(skipAfter?.parentElement?.lastElementChild).toBe(skipAfter)
    expect(skipAfter?.parentElement?.parentElement?.textContent).toContain('selected')
    // The full-width separator is gone; the input carries its own underline instead.
    const customRow = container.querySelector('textarea')?.closest('div')
    expect(customRow?.textContent).not.toContain('Skip')
    expect(customRow?.classList.contains('border-t')).toBe(false)
    expect(customRow?.classList.contains('border-b')).toBe(false)
    expect(container.querySelector('textarea')?.className).toContain('border-b')

    await act(async () => skip?.click())
    expect(onRespond).toHaveBeenCalledWith({
      requestId: multiQuestionRequest.requestId,
      action: 'decline'
    })
  })

  it('renders the answered summary as a compact checklist with a question-type icon', async () => {
    const mixedRequest = { ...multiQuestionRequest, fields: mixedChoiceFields }

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: mixedRequest.message,
            fields: mixedChoiceFields,
            state: 'answered',
            answers: [
              { fieldId: 'question_0', value: ['multi-omics', 'clinical'] },
              { fieldId: 'question_1', value: 'chinese' }
            ]
          }}
          request={mixedRequest}
        />
      )
    })

    const card = container.querySelector('[data-testid="elicitation-card"]')
    expect(card?.className).toContain('bg-bg-200')
    expect(card?.className).not.toContain('border-border-200')

    // Header: question-type icon (bare — no tile background or shadow); the title is the
    // first question's text plus a question count.
    const summary = container.querySelector('[data-testid="elicitation-answer-summary"]')
    expect(summary?.querySelector('svg.lucide-circle-question-mark')).not.toBeNull()
    const iconWrap = summary?.querySelector('span')
    expect(iconWrap?.className).not.toContain('bg-bg-000')
    expect(iconWrap?.className).not.toContain('shadow-sm')
    expect(summary?.textContent).toContain('What should this skill primarily cover?')
    expect(summary?.textContent).toContain('2 questions')
    expect(summary?.textContent).not.toContain('Please answer the following questions.')
    // No separator lines between summary rows.
    expect(summary?.children[1]?.className).not.toContain('divide-y')

    const rows = Array.from(container.querySelectorAll('[data-testid="elicitation-answer-row"]'))
    expect(rows).toHaveLength(2)
    expect(rows[0]?.querySelector('svg.lucide-chevron-down')).not.toBeNull()
    expect(rows[0]?.querySelector('svg.lucide-check')).not.toBeNull()
    expect(rows[0]?.textContent).toContain('Skill scope')
    expect(rows[0]?.textContent).toContain('Multi-omics integration, Clinical statistics')
    expect(rows[1]?.textContent).toContain('Chinese')
  })

  it('keeps answered free-text answers as plain text on the summary', async () => {
    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: activity.elicitation?.message ?? '',
            fields,
            state: 'answered',
            answers: [{ fieldId: 'question_0_custom', value: 'A literature review skill' }]
          }}
          request={request}
        />
      )
    })

    expect(container.querySelector('[data-testid="elicitation-answer-row"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="elicitation-answer-summary"]')?.textContent
    ).toContain('A literature review skill')
  })

  it('labels custom and agent-decide answer rows with the question label instead of Other', async () => {
    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: multiQuestionRequest.message,
            fields: multiQuestionFields,
            state: 'answered',
            answers: [
              { fieldId: 'question_0_custom', value: 'Use our private sources' },
              { fieldId: 'question_1_custom', value: 'Let the agent decide' }
            ]
          }}
          request={multiQuestionRequest}
        />
      )
    })

    const rows = Array.from(container.querySelectorAll('[data-testid="elicitation-answer-row"]'))
    expect(rows).toHaveLength(2)
    // Custom answers live on the `question_N_custom` field whose label is "Other" — the row
    // must surface the owning question's label instead.
    expect(rows[0]?.textContent).toContain('Skill scope')
    expect(rows[0]?.textContent).not.toContain('Other')
    expect(rows[0]?.textContent).toContain('Use our private sources')
    expect(rows[1]?.textContent).toContain('Language')
    expect(rows[1]?.textContent).not.toContain('Other')
  })

  it('marks a preset choice as selected before enabling Finish', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={activity.elicitation!}
          request={request}
          onRespond={onRespond}
        />
      )
    })

    const firstChoice = container.querySelector<HTMLButtonElement>(
      '[data-testid="elicitation-option-multi-omics"]'
    )
    expect(firstChoice?.className).toContain('hover:bg-bg-200')
    expect(firstChoice?.className).toContain('cursor-pointer')
    expect(firstChoice?.getAttribute('aria-pressed')).toBe('false')
    expect(container.textContent).not.toContain('Finish')

    await act(async () => firstChoice?.click())

    expect(firstChoice?.getAttribute('aria-pressed')).toBe('true')
    expect(firstChoice?.getAttribute('data-selected')).toBe('true')
    expect(firstChoice?.className).toContain('bg-bg-200')
    expect(firstChoice?.querySelector('svg.lucide-check')).not.toBeNull()
    expect(onRespond).not.toHaveBeenCalled()

    const finish = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Finish'
    )
    expect(finish).toBeDefined()
    await act(async () => finish?.click())

    expect(onRespond).toHaveBeenCalledWith({
      requestId: request.requestId,
      action: 'accept',
      answers: [{ fieldId: 'question_0', value: 'multi-omics' }]
    })
  })

  it('renders a compact decision list without truncating option details', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={activity.elicitation!}
          request={request}
          onRespond={onRespond}
        />
      )
    })

    expect(container.querySelector('[data-testid="elicitation-choice-mode"]')).not.toBeNull()
    const card = container.querySelector('[data-testid="elicitation-card"]')
    expect(card?.className).toContain('shadow-sm')
    expect(card?.className).not.toContain('shadow-card-opaque')
    expect(card?.className).toContain('border-border-200')
    expect(card?.className).toContain('p-3')
    expect(card?.className).toContain('sm:p-4')
    expect(card?.querySelector('h3')?.className).toContain('min-w-0')
    expect(container.querySelector('textarea[aria-label="Type your own answer"]')).not.toBeNull()
    const longDescription = container.querySelector(
      '[data-testid="elicitation-option-description"]'
    )
    expect(container.querySelector('h3')?.className).toContain('break-words')
    expect(longDescription?.className).toContain('whitespace-pre-wrap')
    expect(longDescription?.className).not.toContain('line-clamp-2')
    expect(container.textContent).not.toContain('Continue')

    const firstChoice = container.querySelector<HTMLButtonElement>(
      '[data-testid="elicitation-option-multi-omics"]'
    )
    expect(firstChoice).not.toBeNull()
    expect(firstChoice?.className).toContain('focus-visible:ring-2')
    // Compact option rows: size-6 badges, 13px text, tight padding.
    expect(firstChoice?.className).toContain('py-1.5')
    expect(firstChoice?.className).not.toContain('py-3')
    expect(firstChoice?.querySelector('span')?.className).toContain('size-6')
    expect(firstChoice?.textContent).toContain('Multi-omics integration')
    const optionLabel = firstChoice?.querySelectorAll('span')[1]?.firstElementChild
    expect(optionLabel?.className).toContain('text-[13px]')
    await act(async () => firstChoice?.click())

    expect(firstChoice?.getAttribute('data-selected')).toBe('true')
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('renders choice options as rounded items instead of square-edged separators', async () => {
    await act(async () => {
      root.render(
        <WorkspaceElicitationCard elicitation={activity.elicitation!} request={request} />
      )
    })

    const options = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-elicitation-option-row="true"]')
    )
    expect(options.length).toBeGreaterThan(0)
    for (const option of options) {
      expect(option.className).toContain('rounded-xl')
      expect(option.classList.contains('border')).toBe(false)
      expect(option.classList.contains('border-b')).toBe(false)
      // Unselected options sit directly on the card; only the badge marks them.
      expect(option.className).toContain('bg-bg-000')
      // Hover swaps the background instead of raising a shadow.
      expect(option.className).toContain('hover:bg-bg-200')
      expect(option.className).not.toContain('hover:shadow-card')
    }
    // The "Let the agent decide" row is an option too and must share the rounded look.
    const agentDecides = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
    ).find((button) => !button.hasAttribute('data-elicitation-option-row'))
    expect(agentDecides?.className).toContain('rounded-xl')
    expect(agentDecides?.classList.contains('border')).toBe(false)
    expect(agentDecides?.className).toContain('bg-bg-000')
    expect(agentDecides?.className).toContain('hover:bg-bg-200')
    expect(agentDecides?.className).not.toContain('hover:shadow-card')

    await act(async () => options[0]?.click())
    // Selected items carry only the brand tint — no outline; hover deepens the tint.
    expect(options[0]?.className).toContain('bg-primary/10')
    expect(options[0]?.className).toContain('hover:bg-primary/15')
    expect(options[0]?.classList.contains('border')).toBe(false)
    expect(options[0]?.className).not.toContain('bg-bg-000')
  })

  it('lets the bottom composer own the single card shadow', async () => {
    await act(async () => {
      root.render(
        <WorkspaceElicitationCard elicitation={activity.elicitation!} request={request} embedded />
      )
    })

    expect(container.querySelector('[data-testid="elicitation-card"]')?.className).not.toContain(
      'shadow-sm'
    )
  })

  it('accepts a compact custom answer or lets the agent decide', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={activity.elicitation!}
          request={request}
          onRespond={onRespond}
        />
      )
    })

    const customInput = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Type your own answer"]'
    )
    expect(customInput).not.toBeNull()
    if (customInput) {
      Object.defineProperty(customInput, 'scrollHeight', { configurable: true, value: 96 })
    }
    await act(async () => {
      if (!customInput) return
      setTextControlValue(customInput, 'A literature review skill')
    })
    expect(customInput?.style.height).toBe('96px')
    expect(customInput?.className).toContain('focus-visible:ring-0')
    // Tighter gap between the input text and its underline.
    expect(customInput?.className).toContain('pb-0.5')
    expect(customInput?.className).not.toContain('py-1.5')
    // The 36px min-height padded the gap below a single line — keep the box snug.
    expect(customInput?.className).toContain('min-h-7')
    expect(customInput?.closest('div')?.className).toContain('items-start')
    expect(customInput?.closest('div')?.className).toContain('gap-2')
    expect(customInput?.closest('div')?.firstElementChild?.className).toContain('mt-0.5')
    expect(container.querySelector('svg.lucide-bot')).not.toBeNull()
    const finishCustomAnswer = Array.from(
      customInput?.closest('form')?.querySelectorAll('button') ?? []
    ).find((button) => button.textContent?.trim() === 'Finish')
    expect(finishCustomAnswer).toBeDefined()
    await act(async () => finishCustomAnswer?.click())

    expect(onRespond).toHaveBeenCalledWith({
      requestId: request.requestId,
      action: 'accept',
      answers: [{ fieldId: 'question_0_custom', value: 'A literature review skill' }]
    })

    onRespond.mockClear()
    const agentDecides = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Let the agent decide'
    )
    expect(agentDecides?.className).toContain('hover:bg-bg-200')
    expect(agentDecides?.className).toContain('cursor-pointer')
    // Single-line row: icon and label center-aligned, not top-aligned.
    expect(agentDecides?.className).toContain('items-center')
    expect(agentDecides?.firstElementChild?.className).not.toContain('mt-px')
    // The label column stretches like the option rows' flex-1 content column.
    expect(agentDecides?.lastElementChild?.className).toContain('flex-1')
    await act(async () => agentDecides?.click())
    expect(agentDecides?.getAttribute('aria-pressed')).toBe('true')
    expect(onRespond).not.toHaveBeenCalled()
    const finishAgentDecision = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Finish'
    )
    await act(async () => finishAgentDecision?.click())
    expect(onRespond).toHaveBeenCalledWith({
      requestId: request.requestId,
      action: 'accept',
      answers: [{ fieldId: 'question_0_custom', value: 'Let the agent decide' }]
    })

    onRespond.mockClear()
    const skip = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Skip'
    )
    await act(async () => skip?.click())
    expect(onRespond).toHaveBeenCalledWith({
      requestId: request.requestId,
      action: 'decline'
    })
  })

  it('retains the compact choice UI when submitting fails', async () => {
    const onRespond = vi.fn().mockRejectedValue(new Error('Bridge unavailable'))

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={activity.elicitation!}
          request={request}
          onRespond={onRespond}
        />
      )
    })

    const firstChoice = container.querySelector<HTMLButtonElement>(
      '[data-testid="elicitation-option-multi-omics"]'
    )
    await act(async () => firstChoice?.click())
    const finish = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Finish'
    )
    await act(async () => finish?.click())

    expect(container.querySelector('[data-testid="elicitation-choice-mode"]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Bridge unavailable')
  })

  it('opens an answered choice as a read-only review', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const durableRequest = {
      ...request,
      durable: {
        kind: 'agent-user-choice' as const,
        requestId: request.requestId,
        promptMessageId: 'prompt-1'
      }
    }

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            ...activity.elicitation!,
            state: 'answered',
            durable: durableRequest.durable,
            answers: [{ fieldId: 'question_0', value: 'multi-omics' }]
          }}
          request={durableRequest}
          onRespond={onRespond}
        />
      )
    })

    expect(container.querySelector('[data-testid="elicitation-choice-mode"]')).toBeNull()
    const summary = container.querySelector('[data-testid="elicitation-answer-summary"]')
    // Single-question cards use the question itself as the summary title.
    expect(summary?.textContent).toContain('Skill type')
    expect(summary?.querySelector('svg.lucide-circle-question-mark')).not.toBeNull()
    const row = container.querySelector<HTMLButtonElement>('[data-testid="elicitation-answer-row"]')
    expect(row?.getAttribute('aria-expanded')).toBe('false')
    expect(row?.querySelector('svg.lucide-chevron-down')).not.toBeNull()
    await act(async () => row?.click())

    expect(container.querySelector('[data-testid="elicitation-choice-review"]')).not.toBeNull()
    expect(row?.getAttribute('aria-expanded')).toBe('true')
    expect(row?.querySelector('svg.lucide-chevron-up')).not.toBeNull()
    expect(
      container
        .querySelector('[data-testid="elicitation-option-multi-omics"]')
        ?.getAttribute('data-selected')
    ).toBe('true')
    expect(container.querySelector('svg.lucide-check')).not.toBeNull()
    expect(container.querySelector('svg.lucide-bot')).not.toBeNull()
    // The recorded answer is a preset option, so the custom-input row stays hidden.
    expect(container.querySelector('[data-testid="elicitation-custom-answer-review"]')).toBeNull()
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).not.toContain('Skip')
    expect(container.textContent).not.toContain('Submit')
    expect(container.textContent).not.toContain('Finish')
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('shows the submitted custom answer in its stable review row', async () => {
    const durableRequest = {
      ...request,
      durable: {
        kind: 'agent-user-choice' as const,
        requestId: request.requestId,
        promptMessageId: 'prompt-1'
      }
    }

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            ...activity.elicitation!,
            state: 'answered',
            durable: durableRequest.durable,
            answers: [{ fieldId: 'question_0_custom', value: 'Use our private sources' }]
          }}
          request={durableRequest}
        />
      )
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="elicitation-answer-row"]')?.click()
    })

    const customAnswer = container.querySelector('[data-testid="elicitation-custom-answer-review"]')
    expect(customAnswer?.getAttribute('data-selected')).toBe('true')
    expect(customAnswer?.textContent).toContain('Use our private sources')
  })

  it('uses the validated generic form for constrained indexed fields', async () => {
    const constrainedFields = [
      { ...fields[0], required: true },
      { ...fields[1], maxLength: 3 }
    ]

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: activity.elicitation?.message ?? '',
            fields: constrainedFields,
            state: 'pending'
          }}
          request={{ ...request, fields: constrainedFields }}
          onRespond={vi.fn().mockResolvedValue(undefined)}
        />
      )
    })

    expect(container.querySelector('[data-testid="elicitation-choice-mode"]')).toBeNull()
    expect(container.querySelector('textarea')).not.toBeNull()
    const continueButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Continue'
    )
    expect(continueButton?.disabled).toBe(true)
  })
})

describe('WorkspaceElicitationCard generic ACP form', () => {
  it.each([
    [
      'a wrong-kind preset',
      {
        id: 'attempts',
        label: 'Attempts',
        kind: 'integer' as const,
        required: true,
        defaultValue: '2'
      }
    ],
    [
      'an out-of-enum preset',
      {
        id: 'approach',
        label: 'Approach',
        kind: 'single-select' as const,
        required: true,
        options: [
          { value: 'minimal', label: 'Minimal' },
          { value: 'expanded', label: 'Expanded' }
        ],
        defaultValue: 'unsupported'
      }
    ],
    [
      'an invalid formatted preset',
      {
        id: 'contact',
        label: 'Contact',
        kind: 'text' as const,
        required: true,
        format: 'email' as const,
        defaultValue: 'not-an-email'
      }
    ]
  ])('keeps Continue disabled for %s', async (_label, field) => {
    const onRespond = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{ message: 'Provide a value', fields: [field], state: 'pending' }}
          request={{
            requestId: 'generic-invalid-default',
            sessionId: 'session-1',
            toolCallId: 'tool-generic-invalid-default',
            message: 'Provide a value',
            fields: [field]
          }}
          onRespond={onRespond}
        />
      )
    })

    const continueButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Continue'
    )
    expect(continueButton?.disabled).toBe(true)
    await act(async () => continueButton?.click())
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('submits an RFC3339 date-time default accepted by Main', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const field = {
      id: 'scheduled-at',
      label: 'Scheduled at',
      kind: 'text' as const,
      required: true,
      format: 'date-time' as const,
      defaultValue: '2026-08-02T12:00:00.123456Z'
    }

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{ message: 'Choose a time', fields: [field], state: 'pending' }}
          request={{
            requestId: 'generic-date-time-default',
            sessionId: 'session-1',
            toolCallId: 'tool-generic-date-time-default',
            message: 'Choose a time',
            fields: [field]
          }}
          onRespond={onRespond}
        />
      )
    })

    const continueButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Continue'
    )
    expect(continueButton?.disabled).toBe(false)
    await act(async () => continueButton?.click())
    expect(onRespond).toHaveBeenCalledWith({
      requestId: 'generic-date-time-default',
      action: 'accept',
      answers: [{ fieldId: 'scheduled-at', value: '2026-08-02T12:00:00.123456Z' }]
    })
  })

  it('keeps non-question form fields on the generic submit path', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const genericFields = [
      {
        id: 'rationale',
        label: 'Rationale',
        kind: 'text' as const,
        required: true
      }
    ]

    await act(async () => {
      root.render(
        <WorkspaceElicitationCard
          elicitation={{
            message: 'Explain the release decision',
            fields: genericFields,
            state: 'pending'
          }}
          request={{
            requestId: 'generic-1',
            sessionId: 'session-1',
            toolCallId: 'tool-generic-1',
            message: 'Explain the release decision',
            fields: genericFields
          }}
          onRespond={onRespond}
        />
      )
    })

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')
    expect(textarea).not.toBeNull()
    await act(async () => {
      if (!textarea) return
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'The checks passed')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const continueButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Continue'
    )
    await act(async () => continueButton?.click())

    expect(onRespond).toHaveBeenCalledWith({
      requestId: 'generic-1',
      action: 'accept',
      answers: [{ fieldId: 'rationale', value: 'The checks passed' }]
    })
  })
})
