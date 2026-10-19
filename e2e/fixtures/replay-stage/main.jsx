import { OverlayLayerProvider } from '../../../src/renderer/src/components/ui/overlay-layer'
import { SessionDiscussionDialog } from '../../../src/renderer/src/pages/workspace/SessionDiscussionDialog'
import { Profiler, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SessionReplayEvidence } from '../../../src/renderer/src/pages/workspace/SessionReplayEvidence'
import { ReplayPanel } from '../../../src/renderer/src/pages/workspace/replay/ReplayPanel'
import { ReplayStage } from '../../../src/renderer/src/pages/workspace/replay/ReplayStage'
import { createReplayPresentation } from '../../../src/renderer/src/pages/workspace/replay/replay-presentation'
import { freezeReplaySvg } from '../../../src/renderer/src/pages/workspace/replay/replay-svg'
import { buildReplayDocument } from '../../../src/renderer/src/lib/replay/timeline'
import { createLinearConversationGraph } from '../../../src/shared/conversation-graph'
import { projectReplayScene } from '../../../src/renderer/src/lib/replay/scene'
import { initI18n, prepareI18nLocale } from '../../../src/renderer/src/i18n'
import '../../../src/renderer/src/assets/main.css'

const params = new URLSearchParams(location.search)
const locale = ['de', 'fr'].includes(params.get('locale')) ? params.get('locale') : 'en'
await prepareI18nLocale(locale)
initI18n(locale)
export const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="560" height="300" viewBox="0 0 560 300"><rect width="560" height="300" fill="white"/><path d="M50 30V250H530" stroke="#666" fill="none"/><path d="M60 220L170 190L280 110L390 140L500 55" stroke="#167f85" stroke-width="5" fill="none"/><circle cx="500" cy="55" r="8" fill="#167f85"/><text x="50" y="22" font-family="Arial" font-size="16" fill="#222">Recorded observations</text><animate attributeName="opacity" from="0" to="1" dur="1s" repeatCount="indefinite"/></svg>'
const run = {
  runId: 'run-1',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'python',
  status: 'completed',
  startedAt: 1700000000000,
  endedAt: 1700000002000,
  script:
    'observations = [2.0, 3.1, 5.5, 4.7, 7.2]\nmean = sum(observations) / len(observations)\nprint(f"Mean: {mean:.2f}")',
  outputs: [{ type: 'stream', name: 'stdout', text: 'Mean: 4.50\n5 archived observations' }],
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  workingFiles: []
}
const evidence = (kind, id, extra = {}) => ({
  kind,
  id,
  projectId: 'fixture-project',
  sessionId: 'fixture-session',
  branchId: 'main',
  ...extra
})
const step = (id, kind, startMs, durationMs, fields) => ({
  id,
  kind,
  branchId: 'main',
  startMs,
  durationMs,
  endMs: startMs + durationMs,
  recordedAt: 1700000000000,
  activities: [],
  runs: [],
  resourceIds: [],
  evidence: [],
  issues: [],
  ...fields
})
const document = {
  generatorVersion: 3,
  presentationVersion: 2,
  source: {
    projectId: 'fixture-project',
    sessionId: 'fixture-session',
    fingerprint: 'fixture-records',
    title: 'A reproducible observation study'
  },
  defaultBranchId: 'main',
  branches: [
    {
      id: 'main',
      kind: 'conversation',
      label: 'Main branch',
      durationMs: 9000,
      steps: [
        step('question', 'message', 0, 2000, {
          message: {
            id: 'question',
            role: 'user',
            status: 'complete',
            eventIds: [],
            createdAt: 1700000000000,
            content:
              'Compare the recorded observations and show the analysis with its archived figure.'
          },
          evidence: [evidence('message', 'question')]
        }),
        step('analysis', 'notebook', 2000, 5000, {
          title: 'Analyze the saved observations',
          runs: [
            {
              runId: run.runId,
              cellId: run.cellId,
              source: run.source,
              kernelKind: run.kernelKind,
              status: run.status,
              startedAt: run.startedAt,
              endedAt: run.endedAt
            }
          ],
          resourceIds: ['plot-v1'],
          evidence: [
            evidence('notebook-run', 'run-1'),
            evidence('artifact-version', 'plot-v1', { artifactId: 'plot', versionId: 'version-1' })
          ]
        }),
        step('answer', 'message', 7000, 2000, {
          message: {
            id: 'answer',
            role: 'agent',
            status: 'complete',
            eventIds: [],
            createdAt: 1700000002000,
            content:
              'The mean of the five recorded observations is **4.50**. The saved figure preserves the exact output of this run.'
          },
          evidence: [evidence('message', 'answer')]
        })
      ]
    }
  ],
  resources: [
    {
      id: 'plot-v1',
      name: 'observations.svg',
      projectId: 'fixture-project',
      sessionId: 'fixture-session',
      artifactId: 'plot',
      versionId: 'version-1',
      versionNumber: 1,
      availability: 'recorded',
      mimeType: 'image/svg+xml',
      locator: 'artifact-version://version-1'
    }
  ],
  issues: []
}
if (params.has('transitions')) {
  const analysis = document.branches[0].steps[1]
  analysis.activities = [
    {
      id: 'analysis-tool',
      kind: 'tool',
      title: 'Notebook run',
      status: 'completed',
      sortIndex: 0,
      eventIds: [],
      createdAt: run.startedAt,
      updatedAt: run.endedAt,
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      rawInput: { code: run.script, kernelKind: run.kernelKind },
      rawOutput: { runId: run.runId, status: 'completed' },
      toolContent: []
    }
  ]
  document.branches[0].steps[2].message.content =
    'Recorded result with **uncertainty**.\n\n'.repeat(70)
}
if (params.has('artifacts')) {
  document.resources.push({
    ...document.resources[0],
    id: 'plot-v2',
    versionId: 'version-2',
    versionNumber: 2,
    locator: 'artifact-version://version-2'
  })
  document.branches[0].steps.push(
    step('file-v1', 'artifact', 9000, 1000, {
      title: 'observations.svg',
      resourceIds: ['plot-v1']
    }),
    step('file-v2', 'artifact', 10000, 1000, {
      title: 'observations.svg',
      resourceIds: ['plot-v2']
    })
  )
  document.branches[0].durationMs = 11000
}
if (params.has('history')) {
  document.branches[0].steps = Array.from({ length: 30 }, (_, index) =>
    step(`history-${index}`, 'message', index * 1000, 1000, {
      message: {
        id: `history-${index}`,
        role: index === 0 ? 'user' : 'agent',
        status: 'complete',
        eventIds: [],
        createdAt: 1700000000000,
        content:
          `Recorded observation ${index}. ` + 'Inspect the archived measurements. '.repeat(12)
      },
      runs:
        index % 3 === 0
          ? [
              {
                runId: `run-${index}`,
                cellId: `cell-${index}`,
                source: run.source,
                kernelKind: run.kernelKind,
                status: run.status,
                startedAt: run.startedAt,
                endedAt: run.endedAt
              }
            ]
          : []
    })
  )
  document.branches[0].durationMs = 30000
}
if (params.has('large')) {
  const longText = 'Archived observation **with uncertainty**.\n\n'.repeat(24000)
  const activities = (index) => [
    {
      id: `tool-${index}`,
      kind: 'tool',
      title: `Inspect observation ${index}`,
      status: 'completed',
      rawInput: { query: longText },
      terminalOutput: longText,
      rawOutput: { rows: longText },
      toolContent: [{ type: 'text', text: longText }],
      terminalExitCode: 0,
      sortIndex: index,
      eventIds: [],
      createdAt: 1700000000000,
      updatedAt: 1700000001000
    }
  ]
  document.branches[0].steps = Array.from({ length: 2000 }, (_, index) =>
    step(`message-${index}`, 'message', index * 1000, 1000, {
      message: {
        id: `message-${index}`,
        role: 'agent',
        status: 'complete',
        eventIds: [],
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        content: longText
      },
      activities: activities(index),
      evidence: [evidence('message', `message-${index}`), evidence('activity', `tool-${index}`)]
    })
  )
  document.resources = Array.from({ length: 3000 }, (_, index) => ({
    ...document.resources[0],
    id: `plot-${index}`,
    name: `observations-${index}.svg`,
    versionId: `version-${index}`,
    versionNumber: index + 1,
    locator: `artifact-version://version-${index}`
  }))
  run.script = 'print("archived")\n'.repeat(60000)
  run.outputs = Array.from({ length: 30 }, () => ({
    type: 'stream',
    name: 'stdout',
    text: longText
  }))
  document.branches[0].steps.push(
    step('large-results', 'notebook', 2000000, 1000, {
      runs: [
        {
          runId: run.runId,
          cellId: run.cellId,
          source: run.source,
          kernelKind: run.kernelKind,
          status: run.status,
          startedAt: run.startedAt,
          endedAt: run.endedAt
        }
      ],
      resourceIds: document.resources.map((resource) => resource.id),
      evidence: [
        evidence('notebook-run', run.runId),
        ...document.resources.map((resource) =>
          evidence('artifact-version', resource.versionId, { versionId: resource.versionId })
        )
      ]
    })
  )
  document.branches[0].durationMs = 2001000
  window.replayFixtureSize = { steps: 2001, versions: 3000, outputCharacters: longText.length * 30 }
}
if (params.has('followNotebook')) {
  run.script = Array.from({ length: 60 }, (_, index) => `observation_${index} = ${index}`).join(
    '\n'
  )
  run.text.stdout = Array.from({ length: 40 }, (_, index) => `Recorded output ${index}`).join('\n')
  run.outputs = [{ type: 'stream', name: 'stdout', text: run.text.stdout }]
}
if (params.has('longOutput')) {
  run.outputs = [
    {
      type: 'stream',
      name: 'stdout',
      text: Array.from(
        { length: 80 },
        (_, index) => `│ ${index} │ ${'archived table column '.repeat(12)} │`
      ).join('\n')
    }
  ]
}
if (params.has('longName')) {
  document.resources = document.resources.map((resource) => ({
    ...resource,
    name: 'sin_plot_with_a_very_long_research_observation_filename_and_additional_details.png',
    mimeType: 'image/png'
  }))
}
if (params.has('previewRegressions')) {
  document.resources.push({
    ...document.resources[0],
    id: 'plot-v3',
    versionId: 'version-3',
    versionNumber: 3,
    size: 425000,
    name: 'LDHA_TF_screening_report_with_additional_details.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    locator: 'artifact-version://version-3'
  })
  document.branches[0].steps.push(
    step('file-v3', 'artifact', 11000, 1000, { resourceIds: ['plot-v3'] })
  )
  document.branches[0].durationMs = 12000
  run.script = `plot_title = "${'long recorded plot label '.repeat(40)}"\nprint(plot_title)`
}
const pendingResources = new Map()
if (params.has('delayedArtifacts')) {
  window.releaseReplayResource = (id) => {
    pendingResources.get(id)?.()
    pendingResources.delete(id)
  }
}
if (params.has('detailIssue')) {
  document.branches[0].steps.slice(0, 2).forEach((step) => {
    step.issues = [{ code: 'incomplete-history' }]
  })
}
if (params.has('branchesReview')) {
  const message = (id, role, content, createdAt, extra = {}) => ({
    id,
    role,
    content,
    createdAt,
    updatedAt: createdAt,
    status: 'complete',
    eventIds: [],
    ...extra
  })
  const messages = [
    message('question', 'user', 'Compare Python and R analysis.', 1),
    message('answer', 'agent', 'The chosen R analysis used three samples.', 4, {
      responseToMessageId: 'question'
    }),
    message('correction', 'user', 'Explain the sample-size limitation.', 6, {
      attribution: {
        kind: 'application',
        feature: 'reviewer',
        purpose: 'correction',
        causeReviewId: 'review-original'
      }
    }),
    message('corrected', 'agent', 'Three samples cannot support a general conclusion.', 7, {
      responseToMessageId: 'correction'
    })
  ]
  const graph = createLinearConversationGraph({
    sessionId: 'fixture-session',
    messages,
    createdAt: 1,
    updatedAt: 8
  })
  const main = graph.branches[0].id
  graph.messages.push({
    ...message('alternative', 'agent', 'Alternative branch uses Python.', 4, {
      responseToMessageId: 'question'
    }),
    agentFrameId: graph.rootFrameId,
    introducedOnBranchId: 'alternative-branch',
    parentMessageId: 'question'
  })
  graph.branches.push({
    id: 'alternative-branch',
    forkActivityId: 'ask-method',
    agentFrameId: graph.rootFrameId,
    parentBranchId: main,
    forkMessageId: 'question',
    headMessageId: 'alternative',
    createdAt: 4,
    updatedAt: 4
  })
  const elicitation = {
    message: 'Choose the analysis method',
    fields: [
      {
        id: 'question_0',
        kind: 'single-select',
        label: 'Method',
        options: [
          { value: 'r', label: 'R analysis' },
          { value: 'python', label: 'Python analysis' }
        ]
      },
      { id: 'question_0_custom', kind: 'text', label: 'Other' }
    ],
    state: 'answered',
    answers: [{ fieldId: 'question_0', value: 'r' }]
  }
  const activity = {
    id: 'ask-method',
    kind: 'tool',
    title: 'ask_user',
    status: 'completed',
    createdAt: 2,
    updatedAt: 3,
    sortIndex: 2,
    eventIds: [],
    promptMessageId: 'question',
    agentFrameId: graph.rootFrameId,
    messageBranchId: main,
    elicitation
  }
  graph.activities.push({ ...activity, runtimeSegmentId: 'recorded-segment' })
  const review = {
    id: 'review-original',
    projectId: 'fixture-project',
    sessionId: 'fixture-session',
    turnMessageId: 'question',
    scope: {
      turnMessageId: 'question',
      agentFrameId: graph.rootFrameId,
      messageBranchId: main,
      blocks: [
        {
          id: 'answer-block',
          kind: 'message',
          sourceId: 'answer',
          blockIndex: 0,
          contentHash: 'hash'
        }
      ],
      artifactVersionIds: []
    },
    lifecycle: 'complete',
    outcome: 'flagged',
    model: 'archived-reviewer',
    reviewerLog: [],
    createdAt: 5,
    updatedAt: 5,
    checks: [
      {
        id: 'sample-size',
        reviewId: 'review-original',
        status: 'warn',
        claim: 'Sample size is limited',
        evidence: 'Only three samples were recorded.',
        resolution: 'open',
        sortIndex: 0,
        reflagCount: 0
      }
    ]
  }
  Object.assign(
    document,
    buildReplayDocument({
      session: {
        id: 'fixture-session',
        projectId: 'fixture-project',
        title: 'Branch and recorded decision study',
        cwd: '',
        status: 'idle',
        messages,
        activities: [activity],
        conversationGraph: graph,
        createdAt: 1,
        updatedAt: 8
      },
      reviews: [review],
      runs: [],
      resources: [],
      issues: []
    })
  )
}
const presentation = createReplayPresentation('en')
if (new URLSearchParams(location.search).has('font')) {
  const font = new FontFace(
    'ReplayFixtureFont',
    'url(/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2)'
  )
  globalThis.document.fonts.add(font)
  void font.load()
  presentation.fontFamily = 'ReplayFixtureFont, serif'
}
function Fixture() {
  const [position, setPosition] = useState(6000)
  const [preparationId, setPreparationId] = useState(0)
  const [mode, setMode] = useState('inline')
  const [timeoutMs, setTimeoutMs] = useState(params.has('fontTimeout') ? 150 : 5000)
  const resource = {
    status: 'ready',
    kind: 'image',
    mimeType: 'image/svg+xml',
    truncated: false,
    content: mode === 'inline' ? freezeReplaySvg(svg) : '/replay-delayed.svg'
  }
  useLayoutEffect(() => {
    window.replayFixture = {
      seek: setPosition,
      prepare: (nextMode, timeout) => {
        setMode(nextMode)
        setTimeoutMs(timeout)
        setPreparationId((value) => value + 1)
      },
      reprepare: () => setPreparationId((value) => value + 1)
    }
    return () => {
      delete window.replayFixture
    }
  }, [])
  return (
    <ReplayStage
      document={document}
      scene={projectReplayScene(document, 'main', position)}
      resources={{ 'plot-v1': resource }}
      runDetails={{ 'run-1': { status: 'ready', run, bytes: 1000 } }}
      presentation={presentation}
      preparationId={preparationId}
      readinessTimeoutMs={timeoutMs}
      onReady={(readiness) => {
        window.replayReadiness = readiness
      }}
    />
  )
}
if (params.has('evidencePage')) {
  window.api = {
    artifacts: {
      readPreview: async () => ({ content: btoa(svg), encoding: 'base64', truncated: false })
    },
    notebook: {
      getReference: async () => ({ notebookSessionRoot: '/archive' }),
      state: async () => ({ runs: [run] })
    }
  }
}
function PanelFixture() {
  const [expanded, setExpanded] = useState(false)
  const [question, setQuestion] = useState()
  const [evidence, setEvidence] = useState('')
  const [evidenceStep, setEvidenceStep] = useState()
  const source = {
    ...document.source,
    packageOrigin: {
      importId: 'import',
      sourceProjectId: 'original-project',
      sourceSessionId: 'original-session',
      importedAt: 1700000000000,
      manifestChecksum: 'a'.repeat(64),
      excludedFiles: [
        { filename: 'large-original.csv', storageKey: 'excluded', sizeBytes: 8000000 }
      ]
    }
  }
  return (
    <main
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 420px)',
        height: '100vh'
      }}
    >
      <section style={{ padding: 24 }}>
        <h1>Research discussion</h1>
        <textarea
          id="discussion"
          aria-label="Discussion question"
          style={{ width: '100%', minHeight: 120 }}
        />
        <output data-selected-evidence={evidence}>{evidence}</output>
      </section>
      <OverlayLayerProvider value={expanded ? 60 : 40}>
        {question ? (
          <SessionDiscussionDialog context={question} onClose={() => setQuestion(undefined)} />
        ) : null}
        <section
          data-replay-container="true"
          className="flex flex-col"
          style={
            expanded
              ? {
                  position: 'fixed',
                  inset: '5vh 5vw',
                  zIndex: 56,
                  background: 'white',
                  boxShadow: '0 0 0 100vmax #0005'
                }
              : {
                  minWidth: 0,
                  minHeight: 0,
                  borderLeft: '1px solid #ddd'
                }
          }
        >
          <div className={evidenceStep ? 'hidden' : 'min-h-0 flex-1'}>
            <ReplayPanel
              presentationMode={params.has('research') ? 'research' : undefined}
              document={{ ...document, source }}
              expanded={expanded}
              onToggleExpanded={() => setExpanded((value) => !value)}
              onAskStep={(context) => {
                window.discussionCapture = context
                if (params.has('modalLayers')) {
                  setQuestion(context)
                  return
                }
                setExpanded(false)
                queueMicrotask(() => globalThis.document.getElementById('discussion').focus())
              }}
              active={!evidenceStep}
              onOpenEvidence={(resource, step) => {
                setEvidence(resource?.versionId ?? step.id)
                if (params.has('evidencePage')) setEvidenceStep(step)
              }}
              readResource={async (resource) => {
                if (params.has('delayedArtifacts'))
                  await new Promise((resolve) => pendingResources.set(resource.id, resolve))
                if (resource.id === 'plot-v3') return { status: 'unsupported' }
                return {
                  status: 'ready',
                  kind: 'image',
                  mimeType: 'image/svg+xml',
                  truncated: false,
                  content: freezeReplaySvg(svg)
                }
              }}
              readNotebookRun={async (_source, index) => ({
                status: 'ready',
                run: params.has('history')
                  ? { ...run, runId: index.runId, cellId: index.cellId }
                  : run,
                bytes: 1000
              })}
            />
          </div>
          {evidenceStep ? (
            <SessionReplayEvidence
              source={source}
              step={evidenceStep}
              resources={document.resources}
              onBack={() => setEvidenceStep(undefined)}
              onOpenResource={(resource) => setEvidence(resource.versionId)}
            />
          ) : null}
        </section>
      </OverlayLayerProvider>
    </main>
  )
}
window.replayProfile = []
createRoot(globalThis.document.getElementById('root')).render(
  <Profiler
    id="replay"
    onRender={(_id, phase, actualDuration) => {
      if (params.has('profile')) window.replayProfile.push({ phase, actualDuration })
    }}
  >
    {params.has('panel') ? <PanelFixture /> : <Fixture />}
  </Profiler>
)
