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
    expect(container.textContent).toContain('1 selected')
  })

  it('reviews completed multi-question choices without exposing mutation controls', async () => {
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

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="elicitation-answer-summary"]')
        ?.click()
    })
    expect(
      container.querySelector('[data-testid="elicitation-question-progress"]')?.textContent
    ).toBe('1 of 2')
    expect(
      container
        .querySelector('[data-testid="elicitation-option-multi-omics"]')
        ?.getAttribute('data-selected')
    ).toBe('true')
    const emptyCustomAnswer = container.querySelector(
      '[data-testid="elicitation-custom-answer-review"]'
    )
    expect(emptyCustomAnswer).not.toBeNull()
    expect(emptyCustomAnswer?.getAttribute('data-selected')).toBe('false')
    expect(emptyCustomAnswer?.textContent).toBe('')
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).not.toContain('Skip')
    expect(container.textContent).not.toContain('Submit')
    expect(onRespond).not.toHaveBeenCalled()

    const nextQuestion = container.querySelector<HTMLButtonElement>('[aria-label="Next question"]')
    expect(nextQuestion?.querySelector('svg.lucide-chevron-right')).not.toBeNull()
    expect(nextQuestion?.parentElement).toBe(
      container.querySelector<HTMLButtonElement>('[aria-label="Previous question"]')?.parentElement
    )
    await act(async () => {
      nextQuestion?.click()
    })
    expect(
      container.querySelector('[data-testid="elicitation-question-progress"]')?.textContent
    ).toBe('2 of 2')
    expect(
      container
        .querySelector('[data-testid="elicitation-option-chinese"]')
        ?.getAttribute('data-selected')
    ).toBe('true')

    const previousQuestion = container.querySelector<HTMLButtonElement>(
      '[aria-label="Previous question"]'
    )
    expect(previousQuestion?.querySelector('svg.lucide-chevron-left')).not.toBeNull()
    await act(async () => previousQuestion?.click())
    expect(
      container.querySelector('[data-testid="elicitation-question-progress"]')?.textContent
    ).toBe('1 of 2')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Close answer review"]')?.click()
    })
    expect(container.querySelector('[data-testid="elicitation-choice-review"]')).toBeNull()
    expect(container.querySelector('[data-testid="elicitation-answer-summary"]')).not.toBeNull()
    expect(onRespond).not.toHaveBeenCalled()
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
    expect(firstChoice?.className).toContain('hover:shadow-card')
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
    await act(async () => firstChoice?.click())

    expect(firstChoice?.getAttribute('data-selected')).toBe('true')
    expect(onRespond).not.toHaveBeenCalled()
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
    expect(customInput?.closest('div')?.className).toContain('items-start')
    expect(customInput?.closest('div')?.className).toContain('gap-3')
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
    expect(agentDecides?.className).toContain('hover:shadow-card')
    expect(agentDecides?.className).toContain('cursor-pointer')
    expect(agentDecides?.firstElementChild?.className).toContain('mt-0.5')
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
    const reviewAffordance = container.querySelector(
      '[data-testid="elicitation-answer-review-affordance"]'
    )
    expect(reviewAffordance?.className).toContain('opacity-0')
    expect(reviewAffordance?.className).toContain('group-hover:opacity-100')
    expect(reviewAffordance?.querySelector('svg.lucide-eye')).not.toBeNull()
    expect(container.querySelector('svg.lucide-chevron-down')).toBeNull()
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="elicitation-answer-summary"]')
        ?.click()
    })

    expect(container.querySelector('[data-testid="elicitation-choice-review"]')).not.toBeNull()
    expect(
      container
        .querySelector('[data-testid="elicitation-option-multi-omics"]')
        ?.getAttribute('data-selected')
    ).toBe('true')
    expect(container.querySelector('svg.lucide-check')).not.toBeNull()
    expect(container.querySelector('svg.lucide-bot')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="elicitation-custom-answer-review"]')
    ).not.toBeNull()
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
      container
        .querySelector<HTMLButtonElement>('[data-testid="elicitation-answer-summary"]')
        ?.click()
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
      defaultValue: '2026-08-02T12:00:00Z'
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
      answers: [{ fieldId: 'scheduled-at', value: '2026-08-02T12:00:00Z' }]
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
