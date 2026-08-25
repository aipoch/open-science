/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Check, ChevronLeft, ChevronRight, Eye, Pencil, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  MAX_ELICITATION_MESSAGE_CHARS,
  isValidElicitationValue,
  resolveAgentUserChoiceQuestions,
  type AgentUserChoiceQuestion,
  type ElicitationAnswer,
  type ElicitationField,
  type ElicitationProjection,
  type ElicitationResponse,
  type ElicitationValue,
  type PendingElicitationRequest
} from '../../../../shared/acp'

const displayValue = (
  value: ElicitationValue,
  field?: ElicitationField,
  t?: (key: string) => string
): string => {
  const optionLabel = (candidate: string): string =>
    field?.options?.find((option) => option.value === candidate)?.label ?? candidate
  if (Array.isArray(value)) return value.map(optionLabel).join(', ')
  if (typeof value === 'boolean') return value ? (t?.('Yes') ?? 'Yes') : (t?.('No') ?? 'No')
  if (typeof value === 'string') return optionLabel(value)
  return String(value)
}

const initialValues = (
  fields: ElicitationField[],
  answers: ElicitationAnswer[] = []
): Record<string, ElicitationValue | undefined> => {
  const values = Object.fromEntries(
    fields.map((field) => [
      field.id,
      field.defaultValue ??
        (field.required && field.kind === 'boolean'
          ? false
          : field.required && field.kind === 'multi-select'
            ? []
            : undefined)
    ])
  )
  const fieldIds = new Set(fields.map((field) => field.id))
  for (const answer of answers) {
    if (fieldIds.has(answer.fieldId)) values[answer.fieldId] = answer.value
  }
  return values
}

const normalizeLocalDateTime = (value: string): string | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6] ?? 0)
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'))
  const date = new Date(year, month - 1, day, hour, minute, second, millisecond)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return undefined
  }
  return date.toISOString()
}

const valueForSubmission = (field: ElicitationField, value: ElicitationValue): ElicitationValue =>
  field.format === 'date-time' && typeof value === 'string'
    ? (normalizeLocalDateTime(value) ?? value)
    : value

const hasValidValue = (field: ElicitationField, value: ElicitationValue | undefined): boolean => {
  if (value === undefined) return !field.required
  if (field.required && typeof value === 'string' && value.trim().length === 0) return false
  if (field.required && Array.isArray(value) && value.length === 0) return false
  if (field.format === 'date-time' && typeof value === 'string' && !normalizeLocalDateTime(value)) {
    return false
  }
  return isValidElicitationValue(field, valueForSubmission(field, value))
}

const submittedAnswers = (
  fields: ElicitationField[],
  values: Record<string, ElicitationValue | undefined>
): ElicitationAnswer[] =>
  fields.flatMap((field) => {
    const value = values[field.id]
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
      return []
    return [{ fieldId: field.id, value: valueForSubmission(field, value) }]
  })

type WorkspaceElicitationCardProps = {
  elicitation: ElicitationProjection
  request?: PendingElicitationRequest
  variant?: 'default' | 'pending-placeholder'
  embedded?: boolean
  onRespond?: (response: ElicitationResponse) => Promise<void>
  onDraftChange?: (answers: ElicitationAnswer[]) => void
}

const answerForChoiceQuestion = (
  question: AgentUserChoiceQuestion,
  values: Record<string, ElicitationValue | undefined>
): ElicitationAnswer | undefined => {
  const customValue = values[question.customField.id]
  if (typeof customValue === 'string' && customValue.trim()) {
    return { fieldId: question.customField.id, value: customValue.trim() }
  }
  const selectedValue = values[question.choiceField.id]
  return selectedValue === undefined || (Array.isArray(selectedValue) && selectedValue.length === 0)
    ? undefined
    : { fieldId: question.choiceField.id, value: selectedValue }
}

const choiceAnswers = (
  questions: AgentUserChoiceQuestion[],
  values: Record<string, ElicitationValue | undefined>
): ElicitationAnswer[] =>
  questions.flatMap((question) => {
    const answer = answerForChoiceQuestion(question, values)
    return answer ? [answer] : []
  })

const firstUnansweredQuestionIndex = (
  questions: AgentUserChoiceQuestion[],
  values: Record<string, ElicitationValue | undefined>
): number => {
  const index = questions.findIndex((question) => !answerForChoiceQuestion(question, values))
  return index === -1 ? Math.max(questions.length - 1, 0) : index
}

const isChoiceOptionSelected = (
  question: AgentUserChoiceQuestion,
  values: Record<string, ElicitationValue | undefined>,
  optionValue: string
): boolean => {
  const value = values[question.choiceField.id]
  return Array.isArray(value) ? value.includes(optionValue) : value === optionValue
}

const WorkspaceElicitationCard = ({
  elicitation,
  request,
  variant = 'default',
  embedded = false,
  onRespond,
  onDraftChange
}: WorkspaceElicitationCardProps): React.JSX.Element => {
  const { t } = useTranslation()
  const choiceQuestions = request ? resolveAgentUserChoiceQuestions(request.fields) : undefined
  const restoredValues = initialValues(
    request?.fields ?? [],
    elicitation.state === 'pending' ? (elicitation.draftAnswers ?? []) : []
  )
  const [values, setValues] = useState<Record<string, ElicitationValue | undefined>>(
    () => restoredValues
  )
  const [confirmedValues, setConfirmedValues] = useState(() => restoredValues)
  const [activeChoiceIndex, setActiveChoiceIndex] = useState(() =>
    choiceQuestions ? firstUnansweredQuestionIndex(choiceQuestions, restoredValues) : 0
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  const [isReviewingAnswer, setIsReviewingAnswer] = useState(false)
  const customAnswerRef = useRef<HTMLTextAreaElement>(null)

  const canSubmit = useMemo(
    () =>
      Boolean(request && request.fields.every((field) => hasValidValue(field, values[field.id]))),
    [request, values]
  )
  const choiceQuestion = choiceQuestions?.[activeChoiceIndex]
  const answers = elicitation.answers ?? []
  const fieldsById = new Map(elicitation.fields.map((field) => [field.id, field]))
  const terminalLabel =
    elicitation.state === 'declined'
      ? t('Skipped')
      : elicitation.state === 'cancelled'
        ? t('Cancelled')
        : undefined
  const isReviewingChoice =
    isReviewingAnswer && elicitation.state === 'answered' && Boolean(choiceQuestions)
  const currentChoiceAnswer = choiceQuestion
    ? answerForChoiceQuestion(choiceQuestion, values)
    : undefined
  const completedChoiceAnswers = choiceQuestions ? choiceAnswers(choiceQuestions, values) : []
  const isFinalChoiceQuestion = Boolean(
    choiceQuestions && activeChoiceIndex === choiceQuestions.length - 1
  )
  const canFinishChoiceSet = Boolean(
    choiceQuestions && completedChoiceAnswers.length === choiceQuestions.length
  )
  const customChoiceValue = choiceQuestion ? values[choiceQuestion.customField.id] : undefined
  const agentDecidesSelected = Boolean(
    currentChoiceAnswer?.fieldId === choiceQuestion?.customField.id &&
    currentChoiceAnswer?.value === 'Let the agent decide'
  )
  const customAnswerSelected = Boolean(
    currentChoiceAnswer?.fieldId === choiceQuestion?.customField.id && !agentDecidesSelected
  )
  const canReviewAnswer = Boolean(elicitation.state === 'answered' && choiceQuestions)
  const isPendingPlaceholder = variant === 'pending-placeholder' && elicitation.state === 'pending'
  const choiceTitle =
    choiceQuestion &&
    (elicitation.state === 'pending' || isReviewingChoice || choiceQuestions?.length === 1)
      ? choiceQuestion.choiceField.description || choiceQuestion.choiceField.label
      : undefined
  const showChoiceProgress = Boolean(
    choiceQuestions &&
    choiceQuestions.length > 1 &&
    !isPendingPlaceholder &&
    (elicitation.state === 'pending' || isReviewingChoice)
  )

  const respond = async (response: ElicitationResponse): Promise<boolean> => {
    if (!onRespond || isSubmitting) return false
    setError(undefined)
    setIsSubmitting(true)
    try {
      await onRespond({
        ...response,
        ...(request?.durable ? { request } : {})
      })
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not submit the response.')
      return false
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!request || !canSubmit) return
    void respond({
      requestId: request.requestId,
      action: 'accept',
      answers: submittedAnswers(request.fields, values)
    })
  }

  const handleChoiceSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!request || !choiceQuestions || !choiceQuestion || !currentChoiceAnswer) return

    if (!isFinalChoiceQuestion) {
      const nextConfirmedValues = {
        ...confirmedValues,
        [choiceQuestion.choiceField.id]: values[choiceQuestion.choiceField.id],
        [choiceQuestion.customField.id]: values[choiceQuestion.customField.id]
      }
      setConfirmedValues(nextConfirmedValues)
      onDraftChange?.(choiceAnswers(choiceQuestions, nextConfirmedValues))
      setActiveChoiceIndex((index) => index + 1)
      setError(undefined)
      return
    }
    if (!canFinishChoiceSet) return

    void respond({
      requestId: request.requestId,
      action: 'accept',
      answers: completedChoiceAnswers
    })
  }

  useEffect(() => {
    const textarea = customAnswerRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`
  }, [activeChoiceIndex, customChoiceValue])

  const selectChoice = (answer: ElicitationAnswer): void => {
    if (!request || !choiceQuestions || !choiceQuestion) return

    if (
      choiceQuestion.choiceField.kind === 'multi-select' &&
      answer.fieldId === choiceQuestion.choiceField.id &&
      typeof answer.value === 'string'
    ) {
      const currentValue = values[choiceQuestion.choiceField.id]
      const selectedValues = Array.isArray(currentValue) ? currentValue : []
      const nextSelectedValues = selectedValues.includes(answer.value)
        ? selectedValues.filter((value) => value !== answer.value)
        : [...selectedValues, answer.value]
      const nextValues = {
        ...values,
        [choiceQuestion.choiceField.id]: nextSelectedValues,
        [choiceQuestion.customField.id]: undefined
      }
      setValues(nextValues)
      setError(undefined)
      return
    }

    const nextValues = {
      ...values,
      [choiceQuestion.choiceField.id]: undefined,
      [choiceQuestion.customField.id]: undefined,
      [answer.fieldId]: answer.value
    }
    setValues(nextValues)
    setError(undefined)
  }

  return (
    <div
      data-testid="elicitation-card"
      className={cn(
        'rounded-2xl bg-bg-000 p-3 text-text-000 sm:p-4',
        !embedded && 'border border-border-200 shadow-sm'
      )}
    >
      {isReviewingChoice ? (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            aria-label={t('Close answer review')}
            className="grid size-11 shrink-0 place-items-center rounded-lg text-text-100 hover:bg-bg-100 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() => {
              setIsReviewingAnswer(false)
              setActiveChoiceIndex(0)
              setError(undefined)
            }}
          >
            <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {showChoiceProgress && choiceQuestions ? (
        <div className="pointer-events-none sticky top-3 z-10 -mb-5 flex h-5 justify-end sm:top-4">
          <span
            data-testid="elicitation-question-progress"
            role="status"
            aria-label={t('Question {{current}} of {{total}}', {
              current: activeChoiceIndex + 1,
              total: choiceQuestions.length
            })}
            className="inline-flex shrink-0 items-center gap-3 bg-bg-000 pl-3 text-xs leading-5 text-text-300 tabular-nums"
          >
            <span aria-hidden="true" className="flex w-16 items-center gap-0.5">
              {choiceQuestions.map((question, index) => (
                <span
                  key={question.choiceField.id}
                  data-testid="elicitation-question-progress-segment"
                  data-state={index === activeChoiceIndex ? 'current' : 'upcoming'}
                  className={cn(
                    'h-1 min-w-0 flex-1 rounded-full',
                    index === activeChoiceIndex ? 'bg-text-000' : 'bg-bg-400'
                  )}
                />
              ))}
            </span>
            <span aria-hidden="true">
              {t('{{current}} of {{total}}', {
                current: activeChoiceIndex + 1,
                total: choiceQuestions.length
              })}
            </span>
          </span>
        </div>
      ) : null}

      <div className="flex items-start">
        <h3
          className={cn(
            'min-w-0 flex-1 whitespace-pre-wrap break-words text-base font-semibold leading-6',
            showChoiceProgress && 'pr-36'
          )}
        >
          {choiceTitle ?? elicitation.message}
        </h3>
      </div>

      {isPendingPlaceholder ? (
        <p
          data-testid="elicitation-pending-placeholder"
          className="mt-2 text-sm italic leading-5 text-text-300"
        >
          {t('Awaiting your answer…')}
        </p>
      ) : isReviewingChoice && choiceQuestion ? (
        <div className="mt-3" data-testid="elicitation-choice-review">
          <div>
            {choiceQuestion.choiceField.options?.map((option, index) => {
              const selected = isChoiceOptionSelected(choiceQuestion, values, option.value)
              return (
                <div
                  key={option.value}
                  data-testid={`elicitation-option-${option.value}`}
                  data-selected={selected ? 'true' : 'false'}
                  className={cn(
                    'flex w-full items-start gap-3 border-b border-border-200 px-3 py-3 text-left',
                    selected && 'bg-bg-200'
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg text-sm font-medium shadow-sm',
                      selected ? 'bg-primary text-primary-foreground' : 'bg-bg-000 text-text-100'
                    )}
                  >
                    {selected ? (
                      <Check className="size-4" strokeWidth={2} aria-label={t('Selected')} />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium leading-5">
                      {option.label}
                    </span>
                    {option.description ? (
                      <span className="mt-0.5 block whitespace-pre-wrap break-words text-sm leading-5 text-text-100">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </div>
              )
            })}
            <div
              data-selected={agentDecidesSelected ? 'true' : 'false'}
              className={cn(
                'flex w-full items-start gap-3 border-b border-border-200 px-3 py-3 text-left text-sm font-medium',
                agentDecidesSelected && 'bg-bg-200'
              )}
            >
              <span
                className={cn(
                  'mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg',
                  agentDecidesSelected
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-bg-100 text-text-100'
                )}
              >
                {agentDecidesSelected ? (
                  <Check className="size-4" strokeWidth={2} aria-label={t('Selected')} />
                ) : (
                  <Bot className="size-4" strokeWidth={1.75} aria-hidden="true" />
                )}
              </span>
              <span>{t('Let the agent decide')}</span>
            </div>
            <div
              data-testid="elicitation-custom-answer-review"
              data-selected={customAnswerSelected ? 'true' : 'false'}
              aria-label={t('Custom answer')}
              className={cn(
                'flex items-start gap-3 border-b border-border-200 px-3 py-3 text-sm',
                customAnswerSelected && 'bg-bg-200'
              )}
            >
              <span
                className={cn(
                  'mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg',
                  customAnswerSelected
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-bg-100 text-text-100'
                )}
              >
                {customAnswerSelected ? (
                  <Check className="size-4" strokeWidth={2} aria-label={t('Selected')} />
                ) : (
                  <Pencil className="size-4" strokeWidth={1.75} aria-hidden="true" />
                )}
              </span>
              <span className="min-h-5 min-w-0 flex-1 whitespace-pre-wrap break-words">
                {customAnswerSelected
                  ? displayValue(
                      currentChoiceAnswer?.value ?? '',
                      fieldsById.get(choiceQuestion.customField.id),
                      t
                    )
                  : null}
              </span>
            </div>
          </div>

          {choiceQuestions && choiceQuestions.length > 1 ? (
            <div className="mt-3 flex items-center justify-end gap-2 border-t border-border-200 pt-3">
              <button
                type="button"
                aria-label={t('Previous question')}
                disabled={activeChoiceIndex === 0}
                className="grid size-11 place-items-center rounded-xl border border-border-200 bg-bg-000 text-text-100 hover:bg-bg-100 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => setActiveChoiceIndex((index) => Math.max(index - 1, 0))}
              >
                <ChevronLeft className="size-5" strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={t('Next question')}
                disabled={activeChoiceIndex === choiceQuestions.length - 1}
                className="grid size-11 place-items-center rounded-xl border border-border-200 bg-bg-000 text-text-100 hover:bg-bg-100 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() =>
                  setActiveChoiceIndex((index) => Math.min(index + 1, choiceQuestions.length - 1))
                }
              >
                <ChevronRight className="size-5" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
      ) : elicitation.state === 'pending' && request && choiceQuestion ? (
        <form className="mt-3" data-testid="elicitation-choice-mode" onSubmit={handleChoiceSubmit}>
          <div>
            {choiceQuestion.choiceField.options?.map((option, index) => {
              const selected = isChoiceOptionSelected(choiceQuestion, values, option.value)
              return (
                <button
                  key={option.value}
                  type="button"
                  data-elicitation-option-row="true"
                  data-testid={`elicitation-option-${option.value}`}
                  data-selected={selected ? 'true' : 'false'}
                  aria-pressed={selected}
                  disabled={isSubmitting}
                  className={cn(
                    'relative flex w-full cursor-pointer items-start gap-3 border-b border-border-200 px-3 py-3 text-left hover:z-10 hover:shadow-card active:bg-bg-200 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
                    selected && 'bg-bg-200'
                  )}
                  onClick={() =>
                    selectChoice({ fieldId: choiceQuestion.choiceField.id, value: option.value })
                  }
                >
                  <span
                    className={cn(
                      'mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg text-sm font-medium shadow-sm',
                      selected ? 'bg-primary text-primary-foreground' : 'bg-bg-000 text-text-100'
                    )}
                  >
                    {selected ? (
                      <Check className="size-4" strokeWidth={2} aria-label={t('Selected')} />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium leading-5">
                      {option.label}
                    </span>
                    {option.description ? (
                      <span
                        data-testid="elicitation-option-description"
                        className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-5 text-text-100"
                        title={option.description}
                      >
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              data-selected={agentDecidesSelected ? 'true' : 'false'}
              aria-pressed={agentDecidesSelected}
              disabled={isSubmitting}
              className={cn(
                'relative flex w-full cursor-pointer items-start gap-3 border-b border-border-200 px-3 py-3 text-left text-sm font-medium hover:z-10 hover:shadow-card active:bg-bg-200 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
                agentDecidesSelected && 'bg-bg-200'
              )}
              onClick={() =>
                selectChoice({
                  fieldId: choiceQuestion.customField.id,
                  value: 'Let the agent decide'
                })
              }
            >
              <span
                className={cn(
                  'mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg',
                  agentDecidesSelected
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-bg-100 text-text-100'
                )}
              >
                {agentDecidesSelected ? (
                  <Check className="size-4" strokeWidth={2} aria-label={t('Selected')} />
                ) : (
                  <Bot className="size-4" strokeWidth={1.75} aria-hidden="true" />
                )}
              </span>
              <span>{t('Let the agent decide')}</span>
            </button>
          </div>

          <div className="flex items-start gap-3 border-b border-border-200 px-3 py-2">
            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-bg-100 text-text-100">
              <Pencil className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </span>
            <Textarea
              ref={customAnswerRef}
              aria-label={t('Type your own answer')}
              placeholder={t('Or type your own answer…')}
              rows={1}
              value={typeof customChoiceValue === 'string' ? customChoiceValue : ''}
              disabled={isSubmitting}
              maxLength={Math.min(
                choiceQuestion.customField.maxLength ?? MAX_ELICITATION_MESSAGE_CHARS,
                MAX_ELICITATION_MESSAGE_CHARS
              )}
              className="max-h-40 min-h-9 min-w-0 flex-1 resize-none overflow-y-auto rounded-none border-0 bg-transparent px-0 py-1.5 shadow-none focus-visible:border-transparent focus-visible:ring-0"
              onChange={(event) => {
                const value = event.currentTarget.value
                setValues((current) => ({
                  ...current,
                  [choiceQuestion.choiceField.id]: undefined,
                  [choiceQuestion.customField.id]: value
                }))
              }}
            />
            <Button
              className="mt-0.5"
              type="button"
              variant="ghost"
              disabled={isSubmitting}
              onClick={() =>
                void respond({
                  requestId: request.requestId,
                  action: 'decline'
                })
              }
            >
              {t('Skip')}
            </Button>
          </div>

          {choiceQuestions ? (
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="truncate text-sm text-text-300">
                {t('{{count}} selected', { count: completedChoiceAnswers.length })}
              </span>
              <div className="flex shrink-0 items-center justify-end gap-2">
                {activeChoiceIndex > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={t('Previous question')}
                    disabled={isSubmitting}
                    className="h-11 px-3"
                    onClick={() => setActiveChoiceIndex((index) => Math.max(index - 1, 0))}
                  >
                    <ChevronLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
                    {t('Back')}
                  </Button>
                ) : null}
                {isFinalChoiceQuestion ? (
                  canFinishChoiceSet ? (
                    <Button className="h-11 px-3" type="submit" disabled={isSubmitting}>
                      {t('Finish')}
                    </Button>
                  ) : null
                ) : currentChoiceAnswer ? (
                  <Button className="h-11 px-3" type="submit" disabled={isSubmitting}>
                    {t('Next')}
                    <ChevronRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          <p className="sr-only" aria-live="polite">
            {isSubmitting ? t('Submitting response') : error ? t('Response submission failed') : ''}
          </p>

          {error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {t(error)}
            </p>
          ) : null}
        </form>
      ) : elicitation.state === 'pending' && request ? (
        <form className="mt-3 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-4">
            {request.fields.map((field) => {
              const value = values[field.id]
              const setValue = (next: ElicitationValue): void =>
                setValues((current) => ({ ...current, [field.id]: next }))

              if (field.kind === 'single-select') {
                return (
                  <fieldset key={field.id} className="space-y-2">
                    <legend className="text-sm font-medium">{field.label}</legend>
                    {field.description ? (
                      <p className="text-sm leading-5 text-text-100">{field.description}</p>
                    ) : null}
                    <div className="space-y-2">
                      {field.options?.map((option) => {
                        const selected = value === option.value
                        return (
                          <label
                            key={option.value}
                            className={cn(
                              'block cursor-pointer rounded-xl border border-border-200 bg-bg-000 p-3 text-left transition-colors duration-200 ease-out hover:bg-bg-200 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 motion-reduce:transition-none',
                              isSubmitting && 'pointer-events-none opacity-50',
                              selected && 'border-ring ring-1 ring-ring/30'
                            )}
                          >
                            <input
                              className="sr-only"
                              type="radio"
                              name={`${request.requestId}-${field.id}`}
                              value={option.value}
                              checked={selected}
                              disabled={isSubmitting}
                              onChange={() => setValue(option.value)}
                            />
                            <span className="block text-sm font-medium">{option.label}</span>
                            {option.description ? (
                              <span className="mt-1 block text-sm leading-5 text-text-100">
                                {option.description}
                              </span>
                            ) : null}
                          </label>
                        )
                      })}
                    </div>
                  </fieldset>
                )
              }

              if (field.kind === 'multi-select') {
                const selectedValues = Array.isArray(value) ? value : []
                return (
                  <fieldset key={field.id} className="space-y-2">
                    <legend className="text-sm font-medium">{field.label}</legend>
                    {field.description ? (
                      <p className="text-sm leading-5 text-text-100">{field.description}</p>
                    ) : null}
                    {field.options?.map((option) => {
                      const selected = selectedValues.includes(option.value)
                      return (
                        <label
                          key={option.value}
                          className={cn(
                            'block cursor-pointer rounded-xl border border-border-200 bg-bg-000 p-3 text-left transition-colors duration-200 ease-out hover:bg-bg-200 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 motion-reduce:transition-none',
                            isSubmitting && 'pointer-events-none opacity-50',
                            selected && 'border-ring ring-1 ring-ring/30'
                          )}
                        >
                          <input
                            className="sr-only"
                            type="checkbox"
                            value={option.value}
                            checked={selected}
                            disabled={isSubmitting}
                            onChange={() =>
                              setValue(
                                selected
                                  ? selectedValues.filter((item) => item !== option.value)
                                  : [...selectedValues, option.value]
                              )
                            }
                          />
                          <span className="block text-sm font-medium">{option.label}</span>
                          {option.description ? (
                            <span className="mt-1 block text-sm leading-5 text-text-100">
                              {option.description}
                            </span>
                          ) : null}
                        </label>
                      )
                    })}
                  </fieldset>
                )
              }

              if (field.kind === 'boolean') {
                return (
                  <label key={field.id} className="flex items-center justify-between gap-3 text-sm">
                    <span>
                      <span className="block font-medium">{field.label}</span>
                      {field.description ? (
                        <span className="mt-1 block leading-5 text-text-100">
                          {field.description}
                        </span>
                      ) : null}
                    </span>
                    <Switch
                      checked={value === true}
                      disabled={isSubmitting}
                      onCheckedChange={(checked) => setValue(checked)}
                    />
                  </label>
                )
              }

              if (field.kind === 'number' || field.kind === 'integer') {
                return (
                  <label key={field.id} className="block space-y-2 text-sm">
                    <span className="font-medium">{field.label}</span>
                    {field.description ? (
                      <span className="block leading-5 text-text-100">{field.description}</span>
                    ) : null}
                    <Input
                      type="number"
                      step={field.kind === 'integer' ? 1 : 'any'}
                      min={field.minimum}
                      max={field.maximum}
                      value={typeof value === 'number' ? value : ''}
                      disabled={isSubmitting}
                      required={field.required}
                      onChange={(event) => {
                        const next = event.currentTarget.valueAsNumber
                        setValues((current) => ({
                          ...current,
                          [field.id]: Number.isFinite(next) ? next : undefined
                        }))
                      }}
                    />
                  </label>
                )
              }

              const inputType =
                field.format === 'email'
                  ? 'email'
                  : field.format === 'uri'
                    ? 'url'
                    : field.format === 'date'
                      ? 'date'
                      : field.format === 'date-time'
                        ? 'datetime-local'
                        : undefined
              const textProps = {
                value: typeof value === 'string' ? value : '',
                disabled: isSubmitting,
                required: field.required,
                minLength: field.minLength,
                maxLength: Math.min(
                  field.maxLength ?? MAX_ELICITATION_MESSAGE_CHARS,
                  MAX_ELICITATION_MESSAGE_CHARS
                ),
                onChange: (
                  event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
                ): void => setValue(event.currentTarget.value)
              }

              return (
                <label key={field.id} className="block space-y-2 text-sm">
                  <span className="font-medium">{field.label}</span>
                  {field.description ? (
                    <span className="block leading-5 text-text-100">{field.description}</span>
                  ) : null}
                  {inputType ? (
                    <Input type={inputType} {...textProps} />
                  ) : (
                    <Textarea {...textProps} />
                  )}
                </label>
              )
            })}
          </div>

          <p className="sr-only" aria-live="polite">
            {isSubmitting ? t('Submitting response') : error ? t('Response submission failed') : ''}
          </p>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {t(error)}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={isSubmitting}
              onClick={() => void respond({ requestId: request.requestId, action: 'decline' })}
            >
              {t('Skip')}
            </Button>
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              {t('Continue')}
            </Button>
          </div>
        </form>
      ) : answers.length > 0 ? (
        <button
          type="button"
          data-testid="elicitation-answer-summary"
          aria-expanded={isReviewingAnswer}
          disabled={!canReviewAnswer}
          className={cn(
            'group mt-2 flex w-full items-start justify-between gap-3 rounded-xl py-1 text-left text-sm leading-5',
            canReviewAnswer &&
              'transition-colors duration-200 hover:bg-bg-100 active:bg-bg-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none'
          )}
          onClick={() => {
            if (!canReviewAnswer) return
            setValues(initialValues(request?.fields ?? [], answers))
            setActiveChoiceIndex(0)
            setError(undefined)
            setIsReviewingAnswer(true)
          }}
        >
          <span className="min-w-0 flex-1 space-y-2">
            {answers.map((answer) => (
              <span className="block" key={answer.fieldId}>
                {answers.length > 1 ? (
                  <span className="block font-medium text-text-100">
                    {fieldsById.get(answer.fieldId)?.label ?? answer.fieldId}
                  </span>
                ) : null}
                <span className="block whitespace-pre-wrap break-words">
                  {displayValue(answer.value, fieldsById.get(answer.fieldId), t)}
                </span>
              </span>
            ))}
          </span>
          {canReviewAnswer ? (
            <span
              data-testid="elicitation-answer-review-affordance"
              className="grid size-7 shrink-0 place-items-center rounded-lg bg-bg-100 text-text-100 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
            >
              <Eye className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </span>
          ) : null}
        </button>
      ) : terminalLabel ? (
        <div className="mt-2 text-sm text-text-300">{terminalLabel}</div>
      ) : (
        <div className="mt-2 text-sm text-text-300">{t('Waiting for a response…')}</div>
      )}
    </div>
  )
}

export { WorkspaceElicitationCard }
