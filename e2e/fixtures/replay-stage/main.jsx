import { useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ReplayPanel } from '../../../src/renderer/src/pages/workspace/replay/ReplayPanel'
import { ReplayStage } from '../../../src/renderer/src/pages/workspace/replay/ReplayStage'
import { createReplayPresentation } from '../../../src/renderer/src/pages/workspace/replay/replay-presentation'
import { freezeReplaySvg } from '../../../src/renderer/src/pages/workspace/replay/replay-svg'
import { projectReplayScene } from '../../../src/renderer/src/lib/replay/scene'
import { initI18n, prepareI18nLocale } from '../../../src/renderer/src/i18n'
import '../../../src/renderer/src/assets/main.css'

const params = new URLSearchParams(location.search)
const locale = params.get('locale') === 'de' ? 'de' : 'en'
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
  generatorVersion: 2,
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
function PanelFixture() {
  const [expanded, setExpanded] = useState(false)
  const [evidence, setEvidence] = useState('')
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
      <section
        data-replay-container="true"
        style={
          expanded
            ? {
                position: 'fixed',
                inset: '5vh 5vw',
                zIndex: 10,
                background: 'white',
                boxShadow: '0 0 0 100vmax #0005'
              }
            : { minWidth: 0, borderLeft: '1px solid #ddd' }
        }
      >
        <ReplayPanel
          document={{ ...document, source }}
          expanded={expanded}
          onToggleExpanded={() => setExpanded((value) => !value)}
          onAskStep={(context) => {
            window.replayQuestion = context
            setExpanded(false)
            queueMicrotask(() => globalThis.document.getElementById('discussion').focus())
          }}
          onOpenEvidence={(resource, step) => setEvidence(resource?.versionId ?? step.id)}
          readResource={async () => ({
            status: 'ready',
            kind: 'image',
            mimeType: 'image/svg+xml',
            truncated: false,
            content: freezeReplaySvg(svg)
          })}
          readNotebookRun={async () => ({ status: 'ready', run, bytes: 1000 })}
        />
      </section>
    </main>
  )
}
createRoot(globalThis.document.getElementById('root')).render(
  params.has('panel') ? <PanelFixture /> : <Fixture />
)
