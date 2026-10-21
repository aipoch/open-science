import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { WorkspaceElicitationCard } from '@/pages/workspace/WorkspaceElicitationCard'
import { WorkspaceDelegatedQuestionCard } from '@/pages/workspace/WorkspaceDelegatedQuestionCard'
import type { AgentUserChoicePrompt, ElicitationField } from '../../../src/shared/elicitation'
import type { ElicitationResponse } from '../../../src/shared/acp'

const search = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', search.has('dark'))
const kind = search.has('single') ? 'single-select' : 'multi-select'
const options = Array.from({ length: 16 }, (_, index) => ({
  label: `Option ${index + 1}`,
  description: `Research category ${index + 1}`
}))
const questions: AgentUserChoicePrompt[] = [
  { question: 'Which outputs?', kind, options },
  ...(search.has('mixed') || search.has('review')
    ? [
        {
          question: 'Which approach should we use for the next phase of this research project?',
          kind: 'single-select' as const,
          options: options.slice(0, 2)
        }
      ]
    : []),
  ...(search.has('review')
    ? [
        {
          question: 'Which resources are available?',
          kind: 'single-select' as const,
          options: options.slice(0, 2)
        }
      ]
    : [])
]
const fields: ElicitationField[] = questions.flatMap((question, index) => [
  {
    id: `question_${index}`,
    label: question.question,
    kind: question.kind ?? 'single-select',
    options: question.options.map((option) => ({ ...option, value: option.label }))
  },
  { id: `question_${index}_custom`, label: 'Other', kind: 'text' }
])
export const Fixture = (): React.JSX.Element => {
  const [response, setResponse] = useState<ElicitationResponse | undefined>(() =>
    search.has('review')
      ? {
          requestId: 'question-1',
          action: 'accept',
          answers: [
            { fieldId: 'question_0', value: ['Option 1', 'Option 3'] },
            { fieldId: 'question_1', value: 'Option 2' },
            { fieldId: 'question_2', value: 'Option 1' }
          ]
        }
      : undefined
  )
  const onRespond = async (value: ElicitationResponse): Promise<void> => {
    setResponse(value)
  }
  return (
    <main className="mx-auto max-w-2xl p-4">
      {search.has('delegate') ? (
        <WorkspaceDelegatedQuestionCard
          projectId="project-1"
          sessionId="session-1"
          request={{
            requestId: 'question-1',
            canonicalDigest: 'a'.repeat(64),
            sourceFrameId: 'child',
            sourceAttemptId: 'attempt',
            sourceRuntimeSegmentId: 'runtime',
            sourceMessageBranchId: 'child-branch',
            rootOriginMessageId: 'prompt',
            rootBranchId: 'root-branch',
            sourceName: 'Researcher',
            questions,
            askedAt: 1,
            status: 'pending',
            draftAnswers: [],
            draftQuestionIndex: 0
          }}
          onRespond={onRespond}
        />
      ) : (
        <WorkspaceElicitationCard
          // Historical surfaces retain the projection after the pending request is gone.
          request={
            response?.action === 'accept'
              ? undefined
              : {
                  requestId: 'question-1',
                  sessionId: 'session-1',
                  toolCallId: 'tool-1',
                  message: 'Which outputs?',
                  fields
                }
          }
          elicitation={{
            message: 'Which outputs?',
            fields,
            state: response?.action === 'accept' ? 'answered' : 'pending',
            answers: response?.answers
          }}
          onRespond={onRespond}
        />
      )}
      <pre
        className="mt-4 whitespace-pre-wrap break-words text-xs text-text-300"
        data-testid="submitted-answer"
      >
        {response && JSON.stringify(response)}
      </pre>
    </main>
  )
}
const locale =
  search.get('locale') === 'zh-Hans' ? 'zh-Hans' : search.get('locale') === 'ru' ? 'ru' : 'en'
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
