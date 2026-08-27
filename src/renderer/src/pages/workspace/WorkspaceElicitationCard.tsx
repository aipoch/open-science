/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Minus,
  Pencil
} from 'lucide-react'

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

const valueForTextInput = (
  field: ElicitationField,
  value: ElicitationValue | undefined
): string => {
  if (typeof value !== 'string' || field.format !== 'date-time') {
    return typeof value === 'string' ? value : ''
  }
  if (normalizeLocalDateTime(value) || !isValidElicitationValue(field, value)) return value

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (part: number, width = 2): string => String(part).padStart(width, '0')
  const milliseconds = date.getMilliseconds()
  const fraction = milliseconds === 0 ? '' : `.${pad(milliseconds, 3)}`
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${fraction}`
}

const hasValidValue = (field: ElicitationField, value: ElicitationValue | undefined): boolean => {
  if (value === undefined) return !field.required
  if (field.required && typeof value === 'string' && value.trim().length === 0) return false
  if (field.required && Array.isArray(value) && value.length === 0) return false
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
  // Accordion review: indexes of the questions whose original content is expanded in place.
  const [expandedQuestions, setExpandedQuestions] = useState<ReadonlySet<number>>(new Set())
  const customAnswerRef = useRef<HTMLTextAreaElement>(null)

  const canSubmit = useMemo(
    () =>
      Boolean(request && request.fields.every((field) => hasValidValue(field, values[field.id]))),
    [request, values]
  )
  const choiceQuestion = choiceQuestions?.[activeChoiceIndex]
  const answers = elicitation.answers ?? []
  const fieldsById = new Map(elicitation.fields.map((field) => [field.id, field]))
  // Review selections come straight from the recorded answers — form state stays untouched.
  const reviewValues = useMemo(
    () => initialValues(request?.fields ?? [], elicitation.answers ?? []),
    [request, elicitation.answers]
  )
  const terminalLabel =
    elicitation.state === 'declined'
      ? t('Skipped')
      : elicitation.state === 'cancelled'
        ? t('Cancelled')
        : undefined
  const currentChoiceAnswer = choiceQuestion
    ? answerForChoiceQuestion(choiceQuestion, values)
    : undefined
  const completedChoiceAnswers = choiceQuestions ? choiceAnswers(choiceQuestions, values) : []
  // The footer tally sits under the current question's options, so it counts only what is
  // selected there — a multi-select answer is an array, other answers count as one.
  const selectedChoiceCount =
    currentChoiceAnswer === undefined
      ? 0
      : Array.isArray(currentChoiceAnswer.value)
        ? currentChoiceAnswer.value.length
        : 1
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
  const canReviewAnswer = Boolean(elicitation.state === 'answered' && choiceQuestions)
  const isPendingPlaceholder = variant === 'pending-placeholder' && elicitation.state === 'pending'
  const choiceTitle =
    choiceQuestion && (elicitation.state === 'pending' || choiceQuestions?.length === 1)
      ? choiceQuestion.choiceField.description || choiceQuestion.choiceField.label
      : undefined
  const showChoiceProgress = Boolean(
    choiceQuestions &&
    choiceQuestions.length > 1 &&
    !isPendingPlaceholder &&
    elicitation.state === 'pending'
  )
  const isAnsweredSummary = elicitation.state === 'answered' && answers.length > 0
  // Terminal choice cards render their own summary-style header, so the top title hides too.
  const isTerminalChoiceSummary = Boolean(terminalLabel && choiceQuestions)
  // The summary is titled by the first question itself — the agent's generic prompt message
  // carries no information. Multi-question cards append a count suffix in the header.
  const summaryTitle = choiceQuestions?.length
    ? choiceQuestions[0].choiceField.description || choiceQuestions[0].choiceField.label
    : elicitation.message

  const toggleQuestionReview = (questionIndex: number): void => {
    setExpandedQuestions((current) => {
      const next = new Set(current)
      if (next.has(questionIndex)) next.delete(questionIndex)
      else next.add(questionIndex)
      return next
    })
  }

  // Terminal cards put their status (skipped/cancelled) on the title line, right after the icon.
  const summaryHeader = (statusPrefix?: string): React.JSX.Element => (
    <div className="flex items-center gap-2">
      <span className="grid size-[22px] shrink-0 place-items-center text-primary">
        <CircleHelp className="size-3.5" strokeWidth={2} aria-hidden="true" />
      </span>
      <h3 className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm font-semibold leading-5">
        {statusPrefix ? (
          <span className="text-xs font-normal text-text-300">{`${statusPrefix} · `}</span>
        ) : null}
        {summaryTitle}
        {choiceQuestions && choiceQuestions.length > 1 ? (
          <span className="font-normal text-text-300">
            {' · '}
            {t('{{count}} questions', {
              count: choiceQuestions.length,
              defaultValue_one: '{{count}} question'
            })}
          </span>
        ) : null}
      </h3>
    </div>
  )

  // Read-only rendering of one question's original content — shared by answered rows and
  // skipped/cancelled cards so every question stays reviewable. Selections come from the
  // recorded answers via reviewValues (empty for terminal cards, so nothing reads as selected).
  const renderQuestionReview = (question: AgentUserChoiceQuestion): React.JSX.Element => {
    const questionAnswer = answerForChoiceQuestion(question, reviewValues)
    const questionAgentDecides = Boolean(
      questionAnswer?.fieldId === question.customField.id &&
      questionAnswer?.value === 'Let the agent decide'
    )
    const questionCustomSelected = Boolean(
      questionAnswer?.fieldId === question.customField.id && !questionAgentDecides
    )
    return (
      // Translucent white panel: a different material from the gray summary rows,
      // scaled to the summary rows (size-5 badges, 13px text).
      <div className="mb-1.5 mt-1 rounded-[10px] bg-bg-000/60 p-2">
        <p className="whitespace-pre-wrap break-words text-[13px] font-semibold leading-[18px]">
          {question.choiceField.description || question.choiceField.label}
        </p>
        <div className="mt-1" data-testid="elicitation-choice-review">
          {question.choiceField.options?.map((option, index) => {
            const selected = isChoiceOptionSelected(question, reviewValues, option.value)
            return (
              <div
                key={option.value}
                data-testid={`elicitation-option-${option.value}`}
                data-selected={selected ? 'true' : 'false'}
                className={cn(
                  'flex w-full items-start gap-2 px-1 py-1.5 text-left',
                  selected && 'bg-bg-200'
                )}
              >
                <span
                  className={cn(
                    'mt-px grid size-5 shrink-0 place-items-center rounded-md text-xs font-medium shadow-sm',
                    selected ? 'bg-primary text-primary-foreground' : 'bg-bg-200 text-text-100'
                  )}
                >
                  {selected ? (
                    <Check className="size-3" strokeWidth={2} aria-label={t('Selected')} />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[13px] font-medium leading-[18px]">
                    {option.label}
                  </span>
                  {option.description ? (
                    <span className="mt-px block whitespace-pre-wrap break-words text-xs leading-4 text-text-100">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </div>
            )
          })}
          <div
            data-selected={questionAgentDecides ? 'true' : 'false'}
            className={cn(
              'flex w-full items-start gap-2 px-1 py-1.5 text-left text-[13px] font-medium',
              questionAgentDecides && 'bg-bg-200'
            )}
          >
            <span
              className={cn(
                'mt-px grid size-5 shrink-0 place-items-center rounded-md',
                questionAgentDecides
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-bg-200 text-text-100'
              )}
            >
              {questionAgentDecides ? (
                <Check className="size-3" strokeWidth={2} aria-label={t('Selected')} />
              ) : (
                <Bot className="size-3" strokeWidth={1.75} aria-hidden="true" />
              )}
            </span>
            <span className="min-w-0 flex-1">{t('Let the agent decide')}</span>
          </div>
          {questionCustomSelected ? (
            <div
              data-testid="elicitation-custom-answer-review"
              data-selected="true"
              aria-label={t('Custom answer')}
              className="flex items-start gap-2 bg-bg-200 px-1 py-1.5 text-[13px]"
            >
              <span className="mt-px grid size-5 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
                <Check className="size-3" strokeWidth={2} aria-label={t('Selected')} />
              </span>
              <span className="min-h-4 min-w-0 flex-1 whitespace-pre-wrap break-words">
                {displayValue(
                  questionAnswer?.value ?? '',
                  fieldsById.get(question.customField.id),
                  t
                )}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    )
  }

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
        'rounded-2xl p-3 text-text-000 sm:p-4',
        // Answered and terminal cards read as activity records: match the tool-group surface
        // (gray, no chrome).
        elicitation.state !== 'pending' ? 'bg-bg-200/70' : 'bg-bg-000',
        !embedded && elicitation.state === 'pending' && 'border border-border-200 shadow-sm'
      )}
    >
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

      {isAnsweredSummary || isTerminalChoiceSummary ? null : (
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
      )}

      {isPendingPlaceholder ? (
        <p
          data-testid="elicitation-pending-placeholder"
          className="mt-2 text-sm italic leading-5 text-text-300"
        >
          {t('Awaiting your answer…')}
        </p>
      ) : elicitation.state === 'pending' && request && choiceQuestion ? (
        <form className="mt-2" data-testid="elicitation-choice-mode" onSubmit={handleChoiceSubmit}>
          <div className="space-y-0.5">
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
                    'relative flex w-full cursor-pointer items-start gap-2 rounded-xl bg-bg-000 px-2 py-1.5 text-left hover:bg-bg-200 active:bg-bg-200 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
                    selected && 'bg-primary/10 hover:bg-primary/15'
                  )}
                  onClick={() =>
                    selectChoice({ fieldId: choiceQuestion.choiceField.id, value: option.value })
                  }
                >
                  <span
                    className={cn(
                      'mt-px grid size-6 shrink-0 place-items-center rounded-md text-[13px] font-medium shadow-sm',
                      selected ? 'bg-primary text-primary-foreground' : 'bg-bg-200 text-text-100'
                    )}
                  >
                    {selected ? (
                      <Check className="size-3.5" strokeWidth={2} aria-label={t('Selected')} />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-[13px] font-medium leading-[18px]">
                      {option.label}
                    </span>
                    {option.description ? (
                      <span
                        data-testid="elicitation-option-description"
                        className="mt-px whitespace-pre-wrap break-words text-xs leading-4 text-text-100"
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
                'relative flex w-full cursor-pointer items-center gap-2 rounded-xl bg-bg-000 px-2 py-1.5 text-left text-[13px] font-medium hover:bg-bg-200 active:bg-bg-200 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
                agentDecidesSelected && 'bg-primary/10 hover:bg-primary/15'
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
                  'grid size-6 shrink-0 place-items-center rounded-md',
                  agentDecidesSelected
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-bg-100 text-text-100'
                )}
              >
                {agentDecidesSelected ? (
                  <Check className="size-3.5" strokeWidth={2} aria-label={t('Selected')} />
                ) : (
                  <Bot className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                )}
              </span>
              <span className="min-w-0 flex-1">{t('Let the agent decide')}</span>
            </button>
          </div>

          <div className="mt-1.5 flex items-start gap-2 px-2 py-1.5">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-bg-100 text-text-100">
              <Pencil className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
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
              className="max-h-40 min-h-7 min-w-0 flex-1 resize-none overflow-y-auto rounded-none border-0 border-b border-border-200 bg-transparent px-0 pb-0.5 pt-1.5 shadow-none focus-visible:ring-0"
              onChange={(event) => {
                const value = event.currentTarget.value
                setValues((current) => ({
                  ...current,
                  [choiceQuestion.choiceField.id]: undefined,
                  [choiceQuestion.customField.id]: value
                }))
              }}
            />
          </div>

          {choiceQuestions ? (
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="truncate text-sm text-text-300">
                {t('{{count}} selected', { count: selectedChoiceCount })}
              </span>
              <div className="flex shrink-0 items-center justify-end gap-2">
                {activeChoiceIndex > 0 ? (
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label={t('Previous question')}
                    disabled={isSubmitting}
                    className="px-3"
                    onClick={() => setActiveChoiceIndex((index) => Math.max(index - 1, 0))}
                  >
                    <ChevronLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
                    {t('Back')}
                  </Button>
                ) : null}
                {isFinalChoiceQuestion ? (
                  canFinishChoiceSet ? (
                    <Button className="px-3" type="submit" disabled={isSubmitting}>
                      {t('Finish')}
                    </Button>
                  ) : null
                ) : currentChoiceAnswer ? (
                  <Button
                    className="px-3"
                    type="submit"
                    aria-label={t('Next question')}
                    disabled={isSubmitting}
                  >
                    {t('Next')}
                    <ChevronRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  </Button>
                ) : null}
                {/* Skipping declines the whole request, so multi-question cards say "Skip all". */}
                <Button
                  className="px-3 bg-status-warning-surface text-status-warning-foreground hover:bg-status-warning-surface/70 dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground dark:hover:bg-status-warning-dark-surface/70"
                  type="button"
                  disabled={isSubmitting}
                  onClick={() =>
                    void respond({
                      requestId: request.requestId,
                      action: 'decline'
                    })
                  }
                >
                  {choiceQuestions.length > 1 ? t('Skip all') : t('Skip')}
                </Button>
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
                value: valueForTextInput(field, value),
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
        <div data-testid="elicitation-answer-summary">
          {summaryHeader()}
          <div className="mt-1.5 flex flex-col">
            {answers.map((answer) => {
              const field = fieldsById.get(answer.fieldId)
              const questionIndex =
                choiceQuestions?.findIndex(
                  (candidate) =>
                    candidate.choiceField.id === answer.fieldId ||
                    candidate.customField.id === answer.fieldId
                ) ?? -1
              const expandable = canReviewAnswer && questionIndex >= 0
              const expanded = expandable && expandedQuestions.has(questionIndex)
              const question = expandable ? choiceQuestions?.[questionIndex] : undefined
              return (
                <div key={answer.fieldId}>
                  <button
                    type="button"
                    data-testid="elicitation-answer-row"
                    aria-expanded={expandable ? expanded : undefined}
                    disabled={!expandable}
                    className={cn(
                      'group flex w-full items-start gap-2 rounded-lg px-1 py-1.5 text-left',
                      expandable
                        ? 'transition-colors duration-200 hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none'
                        : 'cursor-default'
                    )}
                    onClick={() => {
                      if (expandable) toggleQuestionReview(questionIndex)
                    }}
                  >
                    <span className="mt-px grid size-5 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
                      <Check className="size-3" strokeWidth={3} aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      {answers.length > 1 ? (
                        <span className="block text-xs leading-4 text-text-100">
                          {/* Custom/agent-decide answers live on the `question_N_custom` field
                              labeled "Other" — surface the owning question's label instead. */}
                          {choiceQuestions?.[questionIndex]?.choiceField.label ??
                            field?.label ??
                            answer.fieldId}
                        </span>
                      ) : null}
                      <span className="block whitespace-pre-wrap break-words text-[13px] font-medium leading-[18px]">
                        {displayValue(answer.value, field, t)}
                      </span>
                    </span>
                    {expandable ? (
                      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md text-text-300 transition-colors duration-150 group-hover:text-text-100">
                        {expanded ? (
                          <ChevronUp className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                        ) : (
                          <ChevronDown className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                        )}
                      </span>
                    ) : null}
                  </button>

                  {expanded && question ? renderQuestionReview(question) : null}
                </div>
              )
            })}
          </div>
        </div>
      ) : terminalLabel ? (
        choiceQuestions ? (
          // Terminal choice cards share the summary surface: same header, one expandable row
          // per question so the original prompt stays reviewable.
          <div data-testid="elicitation-answer-summary">
            {summaryHeader(terminalLabel)}
            <div className="mt-1.5 flex flex-col">
              {choiceQuestions.map((question, questionIndex) => {
                const expanded = expandedQuestions.has(questionIndex)
                return (
                  <div key={question.choiceField.id}>
                    <button
                      type="button"
                      data-testid="elicitation-answer-row"
                      aria-expanded={expanded}
                      className="group flex w-full items-start gap-2 rounded-lg px-1 py-1.5 text-left transition-colors duration-200 hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none"
                      onClick={() => toggleQuestionReview(questionIndex)}
                    >
                      <span className="mt-px grid size-5 shrink-0 place-items-center rounded-md bg-bg-200 text-text-300">
                        <Minus className="size-3" strokeWidth={2.5} aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs leading-4 text-text-100">
                          {question.choiceField.label}
                        </span>
                        <span className="block whitespace-pre-wrap break-words text-[13px] font-medium leading-[18px]">
                          {question.choiceField.description || question.choiceField.label}
                        </span>
                      </span>
                      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md text-text-300 transition-colors duration-150 group-hover:text-text-100">
                        {expanded ? (
                          <ChevronUp className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                        ) : (
                          <ChevronDown className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                        )}
                      </span>
                    </button>
                    {expanded ? renderQuestionReview(question) : null}
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="mt-2 text-sm text-text-300">{terminalLabel}</div>
        )
      ) : (
        <div className="mt-2 text-sm text-text-300">{t('Waiting for a response…')}</div>
      )}
    </div>
  )
}

export { WorkspaceElicitationCard }
