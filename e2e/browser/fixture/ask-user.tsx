import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { WorkspaceElicitationCard } from '@/pages/workspace/WorkspaceElicitationCard'
import { WorkspaceDelegatedQuestionCard } from '@/pages/workspace/WorkspaceDelegatedQuestionCard'
import type { ElicitationField } from '../../../src/shared/elicitation'
import type { ElicitationResponse } from '../../../src/shared/acp'

initI18n('en')
const options = Array.from({ length: 16 }, (_, index) => ({
  label: `Option ${index + 1}`,
  description: `Research category ${index + 1}`
}))
const fields: ElicitationField[] = [
  {
    id: 'question_0',
    label: 'Which outputs?',
    kind: 'multi-select',
    options: options.map((option) => ({ ...option, value: option.label }))
  },
  { id: 'question_0_custom', label: 'Other', kind: 'text' }
]
export const Fixture = (): React.JSX.Element => {
  const [response, setResponse] = useState<ElicitationResponse>()
  const onRespond = async (value: ElicitationResponse): Promise<void> => {
    setResponse(value)
  }
  return (
    <main className="mx-auto max-w-2xl p-4">
      {new URLSearchParams(location.search).has('delegate') ? (
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
            questions: [{ question: 'Which outputs?', kind: 'multi-select', options }],
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
          elicitation={{ message: 'Which outputs?', fields, state: 'pending' }}
          onRespond={onRespond}
        />
      )}
      <pre data-testid="submitted-answer">{response && JSON.stringify(response)}</pre>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
