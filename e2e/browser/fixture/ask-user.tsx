import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { WorkspaceElicitationCard } from '@/pages/workspace/WorkspaceElicitationCard'
import { WorkspaceDelegatedQuestionCard } from '@/pages/workspace/WorkspaceDelegatedQuestionCard'
import type { AgentUserChoicePrompt, ElicitationField } from '../../../src/shared/elicitation'
import type { ElicitationResponse } from '../../../src/shared/acp'

const search = new URLSearchParams(location.search)
const kind = search.has('single') ? 'single-select' : 'multi-select'
const options = Array.from({ length: 16 }, (_, index) => ({
  label: `Option ${index + 1}`,
  description: `Research category ${index + 1}`
}))
const questions: AgentUserChoicePrompt[] = [
  { question: 'Which outputs?', kind, options },
  ...(search.has('mixed')
    ? [
        {
          question: 'Which approach should we use for the next phase of this research project?',
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
  const [response, setResponse] = useState<ElicitationResponse>()
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
          request={{
            requestId: 'question-1',
            sessionId: 'session-1',
            toolCallId: 'tool-1',
            message: 'Which outputs?',
            fields
          }}
          elicitation={{
            message: 'Which outputs?',
            fields,
            state: response?.action === 'accept' ? 'answered' : 'pending',
            answers: response?.answers
          }}
          onRespond={onRespond}
        />
      )}
      <pre data-testid="submitted-answer">{response && JSON.stringify(response)}</pre>
    </main>
  )
}
const locale = search.get('locale') === 'ru' ? 'ru' : 'en'
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
