import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { ElicitationResponse } from '../../../../shared/acp'
import type {
  DelegatedQuestionAnswer,
  DelegatedQuestionRequest
} from '../../../../shared/session-persistence'

// Answer values travel to the agent and are compared against on read-back, so they stay English no
// matter the UI language. Only the buttons' visible labels are translated.
const AGENT_DECIDES_ANSWER = 'Let the agent decide'
const SKIPPED_ANSWER = 'Skipped'
const DRAFT_DEBOUNCE_MS = 300

type Props = Readonly<{
  projectId: string
  sessionId: string
  request: DelegatedQuestionRequest
  onRespond(response: ElicitationResponse): Promise<void>
}>

const WorkspaceDelegatedQuestionCard = ({
  projectId,
  sessionId,
  request,
  onRespond
}: Props): React.JSX.Element => {
  const { t } = useTranslation()
  const [answers, setAnswers] = useState<DelegatedQuestionAnswer[]>(() => [...request.draftAnswers])
  const [questionIndex, setQuestionIndex] = useState(request.draftQuestionIndex)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  const draftInFlight = useRef(false)
  const pendingDraft = useRef<ElicitationResponse | undefined>(undefined)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const question = request.questions[questionIndex]
  const currentAnswer = answers.find((answer) => answer.questionIndex === questionIndex)?.value

  const cancelScheduledDraft = (): void => {
    if (draftTimer.current === undefined) return
    clearTimeout(draftTimer.current)
    draftTimer.current = undefined
  }

  useEffect(
    () => () => {
      cancelScheduledDraft()
      pendingDraft.current = undefined
    },
    []
  )

  const responseError = (caught: unknown): void => {
    setError(caught instanceof Error ? caught.message : t('Could not save the response.'))
  }

  const drainDrafts = (): void => {
    const response = pendingDraft.current
    if (draftInFlight.current || !response) return
    pendingDraft.current = undefined
    draftInFlight.current = true
    setError(undefined)
    void Promise.resolve()
      .then(() => onRespond(response))
      .catch(responseError)
      .finally(() => {
        draftInFlight.current = false
        drainDrafts()
      })
  }

  const send = async (
    action: 'draft' | 'confirm',
    nextAnswers: readonly DelegatedQuestionAnswer[],
    nextQuestionIndex = questionIndex
  ): Promise<void> => {
    setError(undefined)
    const response: ElicitationResponse = {
      requestId: request.requestId,
      action: 'accept',
      delegatedQuestion: {
        projectId,
        sessionId,
        action,
        answers: nextAnswers,
        ...(action === 'draft' ? { questionIndex: nextQuestionIndex } : {})
      }
    }
    if (action === 'draft') {
      pendingDraft.current = response
      drainDrafts()
      return
    }
    pendingDraft.current = undefined
    try {
      await onRespond(response)
    } catch (caught) {
      responseError(caught)
      throw caught
    }
  }

  const choose = (value: string, debounce = false): void => {
    const next = [
      ...answers.filter((answer) => answer.questionIndex !== questionIndex),
      ...(value.trim() ? [{ questionIndex, value }] : [])
    ].sort((left, right) => left.questionIndex - right.questionIndex)
    setAnswers(next)
    cancelScheduledDraft()
    if (debounce) {
      draftTimer.current = setTimeout(() => {
        draftTimer.current = undefined
        void send('draft', next).catch(() => undefined)
      }, DRAFT_DEBOUNCE_MS)
      return
    }
    void send('draft', next).catch(() => undefined)
  }

  const move = (nextIndex: number): void => {
    cancelScheduledDraft()
    setQuestionIndex(nextIndex)
    void send('draft', answers, nextIndex).catch(() => undefined)
  }

  const confirm = async (): Promise<void> => {
    if (submitting || answers.length !== request.questions.length) return
    setSubmitting(true)
    cancelScheduledDraft()
    try {
      await send('confirm', answers)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section
      data-testid="delegated-question-card"
      className="relative z-10 mb-2 rounded-2xl border border-border-200 bg-bg-000 p-4 text-text-000 shadow-card"
      aria-label={t('Question from {{name}}', { name: request.sourceName })}
    >
      <p className="mb-1 text-xs font-medium text-text-100">
        {t('Asked by {{name}}', { name: request.sourceName })}
      </p>
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 flex-1 whitespace-pre-wrap text-base font-semibold">
          {question.question}
        </h3>
        <span className="shrink-0 text-xs text-text-300">
          {t('{{current}} of {{total}}', {
            current: questionIndex + 1,
            total: request.questions.length
          })}
        </span>
      </div>
      <div className="mt-3">
        {question.options.map((option, index) => {
          const selected = currentAnswer === option.label
          return (
            <button
              key={option.label}
              type="button"
              aria-label={option.label}
              aria-pressed={selected}
              className={cn(
                'flex w-full items-start gap-3 border-b border-border-200 px-3 py-3 text-left hover:bg-bg-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40',
                selected && 'bg-bg-200'
              )}
              onClick={() => choose(option.label)}
            >
              <span
                className={cn(
                  'grid size-7 shrink-0 place-items-center rounded-lg text-sm shadow-sm',
                  selected ? 'bg-primary text-primary-foreground' : 'bg-bg-000 text-text-100'
                )}
              >
                {selected ? <Check className="size-4" aria-label={t('Selected')} /> : index + 1}
              </span>
              <span>
                <span className="block text-sm font-medium">{option.label}</span>
                {option.description ? (
                  <span className="mt-0.5 block text-sm text-text-100">{option.description}</span>
                ) : null}
              </span>
            </button>
          )
        })}
        <button
          type="button"
          className="w-full border-b border-border-200 px-3 py-3 text-left text-sm font-medium hover:bg-bg-200"
          onClick={() => choose(AGENT_DECIDES_ANSWER)}
        >
          {t('Let the agent decide')}
        </button>
        <div className="flex items-start gap-2 border-b border-border-200 px-3 py-2">
          <Textarea
            aria-label={t('Type your own answer')}
            placeholder={t('Or type your own answer…')}
            rows={1}
            maxLength={4_000}
            value={
              currentAnswer &&
              currentAnswer !== AGENT_DECIDES_ANSWER &&
              currentAnswer !== SKIPPED_ANSWER &&
              !question.options.some((option) => option.label === currentAnswer)
                ? currentAnswer
                : ''
            }
            className="min-h-9 flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            onChange={(event) => choose(event.currentTarget.value, true)}
            onBlur={(event) => choose(event.currentTarget.value)}
          />
          <Button type="button" variant="ghost" onClick={() => choose(SKIPPED_ANSWER)}>
            {t('Skip')}
          </Button>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {questionIndex > 0 ? (
          <Button type="button" variant="ghost" onClick={() => move(questionIndex - 1)}>
            <ChevronLeft className="size-4" aria-hidden="true" />
            {t('Back')}
          </Button>
        ) : null}
        {currentAnswer ? (
          <Button
            type="button"
            disabled={submitting}
            onClick={() => {
              if (questionIndex === request.questions.length - 1) void confirm()
              else move(questionIndex + 1)
            }}
          >
            {questionIndex === request.questions.length - 1 ? t('Finish') : t('Next')}
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

export { WorkspaceDelegatedQuestionCard }
