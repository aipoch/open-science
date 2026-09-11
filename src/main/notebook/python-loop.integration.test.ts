import { describe, it, expect } from 'vitest'
import { notebookExecutionContextSchema } from '../../shared/notebook-execution-context'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  existsSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { framePythonNamespaceRequest } from './kernel-protocol'
import {
  reportedPythonCallbackPlot,
  reportedPythonCallbackPrelude
} from './reported-python-callback.fixture'
import { startWorkingFileObservation } from './working-file-observer'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import withVolcanoCells from './reported-with-volcano.fixture.json'
import mixedVennCells from './reported-mixed-venn.fixture.json'
import vennCounterCells from './reported-mixed-venn-counter.fixture.json'
import { sealArtifactProvenanceGraph } from '../artifacts/artifact-provenance-graph'
import { notebookPromptInputPath } from './prompt-input-materialization'
import { reportedPathInput, reportedPathPlots } from './reported-python-path-plot.fixture'
import { reportedSubplotsInput, reportedSubplots } from './reported-python-subplots.fixture'
import {
  reportedCountsSource,
  reportedFailedPlot,
  reportedBarRetry,
  reportedPlotSetup
} from './reported-python-failed-plot.fixture'

// Run with: RUN_KERNEL=1 OPEN_SCIENCE_TEST_PY_ENV=/path/to/env/bin/python \
//   npx vitest run src/main/notebook/python-loop.integration.test.ts
const pyBin = process.env.OPEN_SCIENCE_TEST_PY_ENV
const gate = process.env.RUN_KERNEL && pyBin ? describe : describe.skip

const LOOP = join(__dirname, '../../../resources/notebook/python_loop.py')

// One wire response from python_loop.py, mirroring kernel-protocol's KernelLoopResponse but with
// the raw snake_case field names as they appear on the wire.
type LoopResponse = {
  req_id: string
  stdout: string
  stderr: string
  error: string | null
  result: string | null
  cwd: string
  figures: { mime: string; path: string }[]
  environment: {
    execution_context?: unknown
    runtime_version: string
    packages: Array<{ name: string; version_status: string; loaded_state: string }>
  }
  namespace?: {
    variable_count: number
    variables_truncated: boolean
    variables: Array<{
      name: string
      type: string
      size_bytes?: number
      shape?: string
      preview: string
      preview_truncated?: boolean
      is_private?: boolean
    }>
  }
}

// Minimal one-shot client over the loop's stdio protocol for the test.
const startLoop = (
  python: string,
  env: NodeJS.ProcessEnv
): {
  child: ChildProcessWithoutNullStreams
  send: (code: string, pythonRandomState?: unknown) => Promise<LoopResponse>
  inspect: (includePrivate?: boolean) => Promise<LoopResponse>
} => {
  const child = spawn(python, [LOOP], { env: { ...process.env, ...env } })
  const rl = createInterface({ input: child.stdout })
  const waiters = new Map<string, (v: LoopResponse) => void>()
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line) as LoopResponse
      const w = waiters.get(msg.req_id)
      if (w) {
        waiters.delete(msg.req_id)
        w(msg)
      }
    } catch {
      /* non-JSON loop noise ignored in the test */
    }
  })
  const send = (code: string, pythonRandomState?: unknown): Promise<LoopResponse> =>
    new Promise((resolve) => {
      const reqId = randomUUID()
      waiters.set(reqId, resolve)
      child.stdin.write(
        `${JSON.stringify({ req_id: reqId, code, python_random_state: pythonRandomState })}\n`
      )
    })
  const inspect = (includePrivate = false): Promise<LoopResponse> =>
    new Promise((resolve) => {
      const reqId = randomUUID()
      waiters.set(reqId, resolve)
      child.stdin.write(framePythonNamespaceRequest(reqId, includePrivate))
    })
  return { child, send, inspect }
}

gate('python_loop.py', () => {
  it('replays the reported pycirclize workflow from its necessary upstream cell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pycirclize-replay-'))
    const scripts = readFileSync(join(__dirname, 'reported-pycirclize.fixture.py'), 'utf8').split(
      '\n# %%\n'
    )
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    let selected = new Set(['0', '1', '2'])
    try {
      for (const phase of ['original', 'replay']) {
        const sessionRoot = join(root, phase)
        const dataRoot = join(sessionRoot, 'data')
        mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
        execFileSync(pyBin!, [
          '-c',
          `from openpyxl import Workbook
import sys
w = Workbook()
s = w.active
s.append(["from", "to", "value"])
for i in range(1, 7):
    for j in range(1, 11):
        s.append([f"Gene{i}", f"S{j}", i + j / 2])
w.save(sys.argv[1])`,
          join(dataRoot, 'inputs/edge-weights-222222222222.xlsx')
        ])
        const loop = startLoop(pyBin!, { MPLBACKEND: 'Agg' })
        try {
          expect(
            (await loop.send(`import os\nos.chdir(${JSON.stringify(dataRoot)})`)).error
          ).toBeNull()
          for (const [index, script] of scripts.entries()) {
            if (!selected.has(String(index))) continue
            const context =
              phase === 'original'
                ? await analyzer.sourceFileAccessContext({
                    projectId: 'p',
                    sessionId: phase,
                    currentRunId: String(index),
                    language: 'python',
                    environment: 'python',
                    kernelEpochId: phase
                  })
                : undefined
            const observation =
              phase === 'original'
                ? await startWorkingFileObservation({
                    dataRoot,
                    notebookSessionRoot: sessionRoot,
                    cwd: dataRoot,
                    language: 'python',
                    code: script,
                    runId: String(index),
                    sourceFileAccessContext: context
                  })
                : undefined
            const response = await loop.send(script)
            const evidence = await observation?.finish()
            expect(response.error, response.stderr).toBeNull()
            if (phase === 'original') {
              expect(evidence!.fileEvidence).toMatchObject({
                state: 'available',
                fileReads: 'complete',
                writerAttribution: 'complete',
                reasonCodes: []
              })
              if (index < 2)
                expect(evidence!.confirmedReadPaths).toContain(
                  'data/inputs/edge-weights-222222222222.xlsx'
                )
              runs.push({
                runId: String(index),
                cellId: String(index),
                source: 'agent',
                kernelKind: 'python',
                kernelEpochId: phase,
                environment: 'python',
                script,
                status: 'completed',
                kernelDispatched: true,
                startedAt: index,
                endedAt: index + 1,
                text: {
                  stdout: response.stdout,
                  stderr: response.stderr,
                  traceback: '',
                  plain: []
                },
                outputs: [],
                ...evidence!
              })
            }
          }
          if (phase === 'original') {
            const projection = await analyzer.project({
              projectId: 'p',
              sessionId: phase,
              completedRun: runs[2]!
            })
            expect(projection.stalenessByRunId['2']).toEqual({ state: 'clear' })
            selected = new Set(['2'])
            for (const id of selected)
              for (const upstream of projection.dependenciesByRunId?.[id] ?? [])
                selected.add(upstream)
            expect([...selected].sort()).toEqual(['1', '2'])
          }
          expect(readFileSync(join(dataRoot, 'chord_diagram.pdf')).subarray(0, 5).toString()).toBe(
            '%PDF-'
          )
        } finally {
          loop.child.kill()
        }
      }
      expect(readFileSync(join(root, 'replay/data/chord_diagram.png'))).toEqual(
        readFileSync(join(root, 'original/data/chord_diagram.png'))
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('captures serialized intermediates and replays them across fresh Python kernels', async () => {
    const root = mkdtempSync(join(tmpdir(), 'serialized-python-native-'))
    const outputs: string[] = []
    const scripts = [
      'import pandas as pd\nd=pd.read_csv("inputs/source.csv")\nd.to_pickle("middle.pkl")',
      'import pickle\nimport numpy as np\nwith open("middle.pkl","rb") as f:\n    d=pickle.load(f)\nvalues=d["x"].to_numpy()\nnp.save("middle",values)',
      'import numpy as np\nvalues=np.load("middle.npy")\nnp.savetxt("out.csv",values*2,delimiter=",")'
    ]
    try {
      for (const sessionId of ['original', 'replay']) {
        const sessionRoot = join(root, sessionId),
          dataRoot = join(sessionRoot, 'data')
        mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
        writeFileSync(join(dataRoot, 'inputs/source.csv'), 'x\n1\n2\n3\n')
        const runs: NotebookRunRecord[] = []
        const analyzer = new NotebookDependencyAnalyzer({
          storageRoot: root,
          repository: { readSessionRuns: async () => runs }
        })
        for (const [index, script] of scripts.entries()) {
          const runId = `${sessionId}-${index}`
          const loop = startLoop(pyBin!, { PYTHONDONTWRITEBYTECODE: '1', MPLBACKEND: 'Agg' })
          try {
            expect(
              (await loop.send(`import os\nos.chdir(${JSON.stringify(dataRoot)})`)).error
            ).toBeNull()
            const context = await analyzer.sourceFileAccessContext({
              projectId: 'p',
              sessionId,
              currentRunId: runId,
              language: 'python',
              environment: 'python',
              kernelEpochId: runId
            })
            const observation = await startWorkingFileObservation({
              dataRoot,
              notebookSessionRoot: sessionRoot,
              cwd: dataRoot,
              language: 'python',
              code: script,
              runId,
              sourceFileAccessContext: context
            })
            const result = await loop.send(script)
            expect(result.error).toBeNull()
            const evidence = await observation.finish()
            expect(evidence.fileEvidence, `${sessionId} step ${index}`).toMatchObject({
              state: 'available',
              fileReads: 'complete',
              writerAttribution: 'complete',
              reasonCodes: []
            })
            expect(evidence.confirmedReadPaths).toEqual([
              `data/${['inputs/source.csv', 'middle.pkl', 'middle.npy'][index]}`
            ])
            runs.push({
              runId,
              cellId: runId,
              kernelKind: 'python',
              kernelEpochId: runId,
              environment: 'python',
              source: 'agent',
              status: 'completed',
              kernelDispatched: true,
              startedAt: index,
              endedAt: index + 1,
              script,
              text: { stdout: '', stderr: '', traceback: '', plain: [] },
              outputs: [],
              workingFiles: evidence.workingFiles,
              fileEvidence: evidence.fileEvidence
            })
            const projection = await analyzer.project({
              projectId: 'p',
              sessionId,
              throughRunId: runId
            })
            expect(projection.stalenessByRunId[runId]).toEqual({ state: 'clear' })
          } finally {
            loop.child.kill()
          }
        }
        outputs.push(readFileSync(join(dataRoot, 'out.csv'), 'utf8'))
      }
      expect(outputs[1]).toBe(outputs[0])
      expect(outputs[0]).toContain('6.000000000000000000e+00')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120000)

  it('captures comparison reductions and streaming CSV counts in the reported inspection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'comparison-inspection-'))
    const sessionRoot = join(root, 'session')
    const dataRoot = join(sessionRoot, 'data')
    mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
    const loop = startLoop(pyBin!, { PYTHONDONTWRITEBYTECODE: '1', MPLBACKEND: 'Agg' })
    try {
      const setup = await loop.send(
        `import os\nos.chdir(${JSON.stringify(dataRoot)})\nimport pandas as pd\npd.DataFrame({'id':['A','B','C'],'log2FoldChange':[-1,0,1],'pvalue':[0,.5,.01]}).to_excel('inputs/differential-results-333333333333.xlsx',index=False,sheet_name='Sheet 1')\nwith open('inputs/expression-matrix-444444444444.csv','w') as f:\n    f.write('id,value\\nA,1\\nB,2\\nC,3\\n')`
      )
      expect(setup.error).toBeNull()
      const observer = await startWorkingFileObservation({
        dataRoot,
        notebookSessionRoot: sessionRoot,
        cwd: dataRoot,
        language: 'python',
        code: withVolcanoCells[4].script,
        runId: 'inspect'
      })
      const result = await loop.send(withVolcanoCells[4].script)
      expect(result.error).toBeNull()
      expect(result.stdout).toContain('Zero p-value count: 1')
      expect(result.stdout).toContain('CSV data rows: 3')
      const evidence = await observer.finish()
      expect(evidence.fileEvidence).toMatchObject({
        state: 'available',
        fileReads: 'complete',
        writerAttribution: 'complete',
        reasonCodes: []
      })
      expect(evidence.confirmedReadPaths?.sort()).toEqual(
        [
          'data/inputs/expression-matrix-444444444444.csv',
          'data/inputs/differential-results-333333333333.xlsx'
        ].sort()
      )
    } finally {
      loop.child.kill()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it.each([
    {
      label: 'cleaned IDs',
      cells: mixedVennCells,
      expectedText: 'Total distinct IDs: 7',
      canonical: false
    },
    {
      label: 'set Counter regions',
      cells: [
        vennCounterCells[0],
        'import pandas as pd\ndf=pd.read_excel("inputs/set-membership-111111111111.xlsx",sheet_name="5 groups")\n' +
          vennCounterCells[1] +
          '\nimport json\nprint("REGIONS:"+json.dumps(dict(reg),sort_keys=True))'
      ],
      expectedText: 'union 7',
      canonical: true
    }
  ])(
    'captures mixed Venn workbook inspection and replays $label in a fresh kernel',
    async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'mixed-venn-python-'))
      const results: string[] = []
      try {
        for (const name of ['original', 'replay']) {
          const dataRoot = join(root, name, 'data')
          mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
          execFileSync(
            pyBin!,
            [
              '-c',
              'import pandas as pd\npd.DataFrame({"A":[" a ",None,"b"],"B":["b","c",None],"C":["a","d",None],"D":["d"," e ",None],"E":["e","f","g"]}).to_excel("inputs/set-membership-111111111111.xlsx",sheet_name="5 groups",index=False)'
            ],
            { cwd: dataRoot, timeout: 20000 }
          )
          const loop = startLoop(pyBin!, { PYTHONDONTWRITEBYTECODE: '1' })
          const runs: NotebookRunRecord[] = []
          const analyzer = new NotebookDependencyAnalyzer({
            storageRoot: root,
            repository: { readSessionRuns: async () => runs }
          })
          try {
            expect(
              (await loop.send(`import os\nos.chdir(${JSON.stringify(dataRoot)})`)).error
            ).toBeNull()
            for (const index of name === 'original' ? [0, 1] : [1]) {
              const script = scenario.cells[index],
                runId = `${name}-${index}`
              const observer = await startWorkingFileObservation({
                dataRoot,
                notebookSessionRoot: join(root, name),
                cwd: dataRoot,
                language: 'python',
                code: script,
                runId,
                sourceFileAccessContext: await analyzer.sourceFileAccessContext({
                  projectId: 'p',
                  sessionId: name,
                  currentRunId: runId,
                  language: 'python',
                  environment: 'python',
                  kernelEpochId: name
                })
              })
              const response = await loop.send(script)
              expect(response.error).toBeNull()
              const evidence = await observer.finish()
              expect(evidence.confirmedReadPaths).toEqual([
                'data/inputs/set-membership-111111111111.xlsx'
              ])
              expect(evidence.fileEvidence).toMatchObject({
                state: 'available',
                fileReads: 'complete',
                writerAttribution: 'complete',
                reasonCodes: []
              })
              runs.push({
                runId,
                cellId: runId,
                script,
                kernelKind: 'python',
                kernelEpochId: name,
                environment: 'python',
                source: 'agent',
                status: 'completed',
                kernelDispatched: true,
                startedAt: index,
                endedAt: index + 1,
                text: {
                  stdout: response.stdout,
                  stderr: response.stderr,
                  traceback: '',
                  plain: []
                },
                outputs: [],
                ...evidence
              })
              if (index === 1) {
                expect(response.stdout).toContain(scenario.expectedText)
                results.push(
                  scenario.canonical
                    ? response.stdout.split('\n').find((line) => line.startsWith('REGIONS:'))!
                    : response.stdout
                )
              }
            }
            const result = await analyzer.project({
              projectId: 'p',
              sessionId: name,
              completedRun: runs.at(-1)!
            })
            for (const run of runs)
              expect(result.stalenessByRunId[run.runId]).toEqual({ state: 'clear' })
            expect(result.dependenciesByRunId?.[`${name}-1`]).toEqual([])
          } finally {
            loop.child.kill()
          }
        }
        expect(results[0]).toBeTruthy()
        expect(results[1]).toBe(results[0])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    60000
  )

  it('captures workbook reads across ExcelFile cells and replays the table output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'excel-cells-native-'))
    const outputs: Buffer[] = []
    try {
      for (const name of ['original', 'replay']) {
        const sessionRoot = join(root, name)
        const dataRoot = join(sessionRoot, 'data')
        mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
        const loop = startLoop(pyBin!, { PYTHONDONTWRITEBYTECODE: '1', MPLBACKEND: 'Agg' })
        try {
          const setup = await loop.send(
            `import os\nos.chdir(${JSON.stringify(dataRoot)})\nimport pandas as pd\npd.DataFrame({"gene":["A","B"],"value":[1,2]}).to_excel("inputs/book.xlsx",index=False)`
          )
          expect(setup.error).toBeNull()
          const scripts = [
            'import pandas as pd\nxl=pd.ExcelFile("inputs/book.xlsx")',
            'df=xl.parse(sheet_name=0)\nprint(df.head())',
            'df=xl.parse(sheet_name=0)\ndf.to_csv("result.csv",index=False)\nxl.close()'
          ]
          const runs: NotebookRunRecord[] = []
          const analyzer = new NotebookDependencyAnalyzer({
            storageRoot: root,
            repository: { readSessionRuns: async () => runs }
          })
          for (const [index, script] of (name === 'original'
            ? scripts
            : [scripts.join('\n')]
          ).entries()) {
            const runId = `${name}-${index}`
            const observer = await startWorkingFileObservation({
              dataRoot,
              notebookSessionRoot: sessionRoot,
              cwd: dataRoot,
              language: 'python',
              code: script,
              runId,
              sourceFileAccessContext: await analyzer.sourceFileAccessContext({
                projectId: 'p',
                sessionId: name,
                currentRunId: runId,
                language: 'python',
                environment: 'python',
                kernelEpochId: name
              })
            })
            const response = await loop.send(script)
            expect(response.error).toBeNull()
            const evidence = await observer.finish()
            expect(evidence.fileEvidence).toMatchObject({
              state: 'available',
              fileReads: 'complete',
              writerAttribution: 'complete',
              reasonCodes: []
            })
            expect(evidence.confirmedReadPaths).toEqual(['data/inputs/book.xlsx'])
            runs.push({
              runId,
              cellId: runId,
              script,
              kernelKind: 'python',
              environment: 'python',
              kernelEpochId: name,
              source: 'agent',
              status: 'completed',
              kernelDispatched: true,
              startedAt: index,
              endedAt: index + 1,
              text: { stdout: response.stdout, stderr: response.stderr, traceback: '', plain: [] },
              outputs: [],
              ...evidence
            })
          }
          const projection = await analyzer.project({
            projectId: 'p',
            sessionId: name,
            completedRun: runs.at(-1)!
          })
          expect(projection.stalenessByRunId[runs.at(-1)!.runId]).toEqual({ state: 'clear' })
          outputs.push(readFileSync(join(dataRoot, 'result.csv')))
        } finally {
          loop.child.kill()
        }
      }
      expect(outputs[0].toString()).toBe('gene,value\nA,1\nB,2\n')
      expect(outputs[1]).toEqual(outputs[0])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('replays the selected plotting configuration cells and reproduces identical PNG bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'python-style-replay-'))
    const original = startLoop(pyBin!, { MPLBACKEND: 'Agg' })
    const replay = startLoop(pyBin!, { MPLBACKEND: 'Agg' })
    const scripts = [
      'import matplotlib.pyplot as plt',
      'plt.style.use("ggplot")',
      'unrelated = 42',
      'plt.rcParams["font.size"] = 17',
      'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([1, 2], [3, 4])\nax.set_title("Configuration replay")\nfig.savefig("plot.png")\nplt.close(fig)'
    ]
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: String(index),
      cellId: String(index),
      source: 'agent',
      kernelKind: 'python',
      kernelEpochId: 'epoch',
      script,
      status: 'completed',
      startedAt: index,
      endedAt: index + 1,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }))
    try {
      for (const [loop, name] of [
        [original, 'original'],
        [replay, 'replay']
      ] as const) {
        const dir = join(root, name)
        mkdirSync(dir)
        expect((await loop.send(`import os\nos.chdir(${JSON.stringify(dir)})`)).error).toBeNull()
      }
      for (const source of scripts) expect((await original.send(source)).error).toBeNull()
      const projection = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      }).project({ projectId: 'p', sessionId: 's', completedRun: runs[4]! })
      const selected = new Set<string>(['4'])
      expect(projection.stalenessByRunId['4']).toEqual({ state: 'clear' })
      for (const id of selected)
        for (const upstream of projection.dependenciesByRunId?.[id] ?? []) selected.add(upstream)
      expect([...selected].sort()).toEqual(['0', '1', '3', '4'])
      for (const run of runs.filter((run) => selected.has(run.runId)))
        expect((await replay.send(run.script)).error).toBeNull()
      expect(readFileSync(join(root, 'replay', 'plot.png'))).toEqual(
        readFileSync(join(root, 'original', 'plot.png'))
      )
    } finally {
      original.child.kill()
      replay.child.kill()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
  it.each([false, true])(
    'replays unseeded and cached Gaussian sequences (cached: %s)',
    async (cached) => {
      const original = startLoop(pyBin!, {})
      const replay = startLoop(pyBin!, {})
      try {
        if (cached)
          await original.send(
            'import random\nimport numpy as np\nrandom.seed(17)\nnp.random.seed(29)\nrandom.gauss(0, 1)\nnp.random.normal()'
          )
        const source =
          'from __future__ import annotations\nimport random\nimport numpy as np\nprint([random.random(), random.gauss(0, 1), random.gauss(0, 1)])\nprint(np.random.normal(size=7).tolist())'
        const first = await original.send(source)
        const state = notebookExecutionContextSchema.parse(first.environment.execution_context)
          .before.pythonRandomState
        if (cached && state?.state === 'available') {
          expect(state.standard.gaussian).not.toBeNull()
          expect(state.numpy?.hasGaussian).toBe(1)
        }
        await replay.send(
          'import random\nimport numpy as np\nrandom.random()\nnp.random.normal(size=13)'
        )
        const restored = await replay.send(source, state)
        expect(first.error).toBeNull()
        expect(restored.error).toBeNull()
        expect(restored.stdout).toBe(first.stdout)
        expect(
          notebookExecutionContextSchema.parse(restored.environment.execution_context).before
            .pythonRandomState
        ).toEqual(state)
        const failed = await replay.send('x = 1\nraise ValueError("original line")', state)
        expect(failed.error).toContain('line 2')
      } finally {
        original.child.kill()
        replay.child.kill()
      }
    },
    60_000
  )

  it('rejects malformed state before executing source and never invokes a patched RNG hook', async () => {
    const loop = startLoop(pyBin!, {})
    try {
      const before = await loop.send('import random\nimport numpy as np')
      const state = notebookExecutionContextSchema.parse(before.environment.execution_context).after
        .pythonRandomState
      if (state?.state !== 'available') throw new Error('Expected native RNG state')
      const rejected = await loop.send('print("must not execute")', {
        ...state,
        numpy: { ...state.numpy, words: [0] }
      })
      expect(rejected.error).toContain('Invalid NumPy')
      expect(rejected.stdout).not.toContain('must not execute')
      const unchanged = await loop.send('pass')
      expect(
        notebookExecutionContextSchema.parse(unchanged.environment.execution_context).before
          .pythonRandomState
      ).toEqual(state)
      const patched = await loop.send(
        'def hook():\n    print("must not call hook")\n    raise RuntimeError()\nrandom.getstate = hook'
      )
      expect(patched.stdout).not.toContain('must not call hook')
      expect(
        notebookExecutionContextSchema.parse(patched.environment.execution_context).after
          .pythonRandomState
      ).toEqual({ state: 'unavailable', reason: 'modified-rng' })
      expect((await loop.send('pass', state)).error).toContain('modified Python RNG')
    } finally {
      loop.child.kill()
    }
  }, 60_000)
  it('captures Python and NumPy random sequences including Gaussian caches', async () => {
    const { child, send } = startLoop(pyBin!, {})
    try {
      const first = await send(
        'import random\nimport numpy as np\nrandom.gauss(0,1)\nnp.random.normal()'
      )
      const context = notebookExecutionContextSchema.parse(first.environment.execution_context)
      expect(context.before).toHaveProperty('pythonRandomState.state', 'available')
      expect(context.before).toHaveProperty('pythonRandomState.numpy.words')
      expect(context.after).not.toEqual(context.before)
    } finally {
      child.kill()
    }
  })

  it('captures execution context before and after a cell without copying credentials', async () => {
    const { child, send } = startLoop(pyBin!, {
      OMP_NUM_THREADS: '2',
      OPEN_SCIENCE_TEST_SECRET: 'private-value'
    })
    try {
      const result = await send('import os\nos.environ["OMP_NUM_THREADS"] = "3"')
      expect(result.error).toBeNull()
      const context = notebookExecutionContextSchema.parse(result.environment.execution_context)
      expect(context.before.threadLimits.OMP_NUM_THREADS).toBe('2')
      expect(context.after.threadLimits.OMP_NUM_THREADS).toBe('3')
      expect(JSON.stringify(context)).not.toContain('private-value')
    } finally {
      child.kill()
    }
  }, 60_000)
  it.each(['Path input and two plots', 'nested subplots'] as const)(
    'captures and replays the reported %s across runs',
    async (scenario) => {
      const subplots = scenario === 'nested subplots'
      const filenames = subplots
        ? ['synthetic_groups_group_plots.png']
        : ['synthetic_groups_pie.png', 'synthetic_groups_bar.png']
      const root = mkdtempSync(join(tmpdir(), 'python-path-plot-repro-'))
      const notebookSessionRoot = join(root, 'notebook')
      const dataRoot = join(notebookSessionRoot, 'data')
      const content =
        'sample,group\n' +
        Array.from({ length: 66 }, (_, i) => `sample-${i},${i % 2 ? 'IRI' : 'Ctrl'}\n`).join('')
      const checksum = createHash('sha256').update(content).digest('hex')
      const inputPath = notebookPromptInputPath('sample-groups.csv', checksum)
      const scripts = [
        (subplots ? reportedSubplotsInput : reportedPathInput).replace(
          'inputs/sample-groups-666666666666.csv',
          inputPath
        ),
        (subplots ? reportedSubplots : reportedPathPlots).replace(
          'inputs/sample-groups-666666666666.csv',
          inputPath
        )
      ]
      mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
      writeFileSync(join(dataRoot, inputPath), content)
      const environment = {
        MPLBACKEND: 'Agg',
        MPLCONFIGDIR: join(root, 'mpl'),
        PYTHONDONTWRITEBYTECODE: '1',
        OPEN_SCIENCE_KERNEL_FIGURES_DIR: join(root, 'figures')
      }
      const original = startLoop(pyBin!, environment)
      let replay: ReturnType<typeof startLoop> | undefined
      const runs: NotebookRunRecord[] = []
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      try {
        expect(
          (await original.send(`import os; os.chdir(${JSON.stringify(dataRoot)})`)).error
        ).toBeNull()
        for (const [index, script] of scripts.entries()) {
          const runId = `run-${index}`
          const observer = await startWorkingFileObservation({
            dataRoot,
            notebookSessionRoot,
            cwd: dataRoot,
            language: 'python',
            code: script,
            runId,
            sourceFileAccessContext: await analyzer.sourceFileAccessContext({
              projectId: 'project',
              sessionId: 'session',
              currentRunId: runId,
              language: 'python',
              environment: 'default-python',
              kernelEpochId: 'epoch'
            }),
            registeredInputFiles: [
              {
                sourceKind: 'upload-version',
                sourceFileId: 'groups',
                inputFileVersionId: 'groups-v1',
                sourceProjectId: 'project',
                sourceSessionId: 'session',
                filename: 'sample-groups.csv',
                checksum,
                sizeBytes: Buffer.byteLength(content),
                storageKey: 'uploads/groups.csv',
                association: index === 0 ? 'turn-attached' : 'resolver-accessed'
              }
            ]
          })
          const response = await original.send(script)
          const files = await observer.finish()
          expect(response.error).toBeNull()
          expect(files.fileEvidence).toMatchObject({
            state: 'available',
            fileReads: 'complete',
            writerAttribution: 'complete',
            reasonCodes: []
          })
          expect(files.confirmedReadPaths ?? []).toEqual(
            index === 0 || subplots ? [`data/${inputPath}`] : []
          )
          runs.push({
            runId,
            cellId: runId,
            source: 'agent',
            kernelKind: 'python',
            kernelEpochId: 'epoch',
            kernelDispatched: true,
            environment: 'default-python',
            script,
            status: 'completed',
            startedAt: index,
            endedAt: index,
            text: { stdout: response.stdout, stderr: response.stderr, traceback: '', plain: [] },
            outputs: [],
            artifacts: [],
            inputFiles: [],
            ...files
          })
          const projection = await analyzer.project({
            projectId: 'project',
            sessionId: 'session',
            completedRun: runs[index]
          })
          expect(projection.stalenessByRunId[runId]).toEqual({ state: 'clear' })
          expect(projection.dependenciesByRunId?.[runId]).toEqual(
            index === 0 || subplots ? [] : ['run-0']
          )
        }
        for (const filename of filenames) {
          const output = runs[1].workingFiles.find(
            (file) => file.relativePath === `data/${filename}`
          )!
          expect(output.checksum).toBeDefined()
          const graph = sealArtifactProvenanceGraph({
            target: {
              versionId: 'version',
              filename,
              checksum: output.checksum!,
              sizeBytes: output.size!,
              producerRunId: 'run-1',
              sourceGenerationId: output.generationId
            },
            notebookActivities: runs.map((run, runIndex) => ({
              run,
              runIndex,
              evidenceJson: readFileSync(join(root, run.fileEvidence!.storageKey!), 'utf8')
            })),
            computeActivities: []
          })
          expect(graph.completeness).toBe('complete')
        }
        const replayRoot = join(root, 'replay')
        mkdirSync(join(replayRoot, 'inputs'), { recursive: true })
        writeFileSync(join(replayRoot, inputPath), content)
        replay = startLoop(pyBin!, {
          ...environment,
          OPEN_SCIENCE_KERNEL_FIGURES_DIR: join(root, 'replay-figures')
        })
        expect(
          (await replay.send(`import os; os.chdir(${JSON.stringify(replayRoot)})`)).error
        ).toBeNull()
        for (const script of scripts) expect((await replay.send(script)).error).toBeNull()
        for (const filename of filenames) {
          expect(readFileSync(join(replayRoot, filename))).toEqual(
            readFileSync(join(dataRoot, filename))
          )
        }
      } finally {
        original.child.kill()
        replay?.child.kill()
        rmSync(root, { recursive: true, force: true })
      }
    },
    60_000
  )

  it('recovers the reported failed plot and replays the self-contained repair with captured files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'python-failed-plot-repro-'))
    const notebookSessionRoot = join(root, 'notebook')
    const dataRoot = join(notebookSessionRoot, 'data')
    const content = 'group\n' + 'Ctrl\n'.repeat(33) + 'IRI\n'.repeat(33)
    const checksum = createHash('sha256').update(content).digest('hex')
    const inputPath = notebookPromptInputPath('groups.csv', checksum)
    const countsSource = reportedCountsSource.replace(
      'inputs/sample-groups-666666666666.csv',
      inputPath
    )
    const repaired = [countsSource, reportedPlotSetup, reportedBarRetry].join('\n')
    mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
    writeFileSync(join(dataRoot, inputPath), content)
    const environment = {
      MPLBACKEND: 'Agg',
      MPLCONFIGDIR: join(root, 'mpl'),
      PYTHONDONTWRITEBYTECODE: '1',
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: join(root, 'figures')
    }
    const original = startLoop(pyBin!, environment)
    let replay: ReturnType<typeof startLoop> | undefined
    try {
      expect(
        (await original.send(`import os; os.chdir(${JSON.stringify(dataRoot)})`)).error
      ).toBeNull()
      expect((await original.send(countsSource)).error).toBeNull()
      const failed = await original.send(reportedFailedPlot)
      expect(failed.error).toContain('suptitle')
      expect(failed.stdout).toContain('pie saved')
      expect(existsSync(join(dataRoot, 'synthetic_groups_pie.png'))).toBe(true)
      expect(existsSync(join(dataRoot, 'synthetic_groups_bar.png'))).toBe(false)
      expect((await original.send(reportedBarRetry)).error).toBeNull()
      const observer = await startWorkingFileObservation({
        dataRoot,
        notebookSessionRoot,
        cwd: dataRoot,
        language: 'python',
        code: repaired,
        runId: 'repair',
        registeredInputFiles: [
          {
            sourceKind: 'upload-version',
            sourceFileId: 'groups',
            inputFileVersionId: 'groups-v1',
            sourceProjectId: 'project',
            sourceSessionId: 'session',
            filename: 'groups.csv',
            checksum,
            sizeBytes: Buffer.byteLength(content),
            storageKey: 'uploads/groups.csv',
            association: 'turn-attached'
          }
        ]
      })
      const repairedResponse = await original.send(repaired)
      const files = await observer.finish()
      expect(repairedResponse.error).toBeNull()
      expect(files.fileEvidence).toMatchObject({
        state: 'available',
        fileReads: 'complete',
        writerAttribution: 'complete',
        reasonCodes: []
      })
      expect(files.confirmedReadPaths).toEqual([`data/${inputPath}`])
      expect(
        files.workingFiles.some((file) => file.relativePath === 'data/synthetic_groups_bar.png')
      ).toBe(true)
      const replayRoot = join(root, 'replay')
      mkdirSync(join(replayRoot, 'inputs'), { recursive: true })
      writeFileSync(join(replayRoot, inputPath), content)
      replay = startLoop(pyBin!, environment)
      expect(
        (await replay.send(`import os; os.chdir(${JSON.stringify(replayRoot)})`)).error
      ).toBeNull()
      expect((await replay.send(repaired)).error).toBeNull()
      expect(readFileSync(join(replayRoot, 'synthetic_groups_bar.png'))).toEqual(
        readFileSync(join(dataRoot, 'synthetic_groups_bar.png'))
      )
    } finally {
      original.child.kill()
      replay?.child.kill()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures and replays the reported callback plot with complete file and dependency evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'python-callback-repro-'))
    const notebookSessionRoot = join(root, 'notebook')
    const dataRoot = join(notebookSessionRoot, 'data')
    mkdirSync(dataRoot, { recursive: true })
    const environment = {
      MPLBACKEND: 'Agg',
      MPLCONFIGDIR: join(root, 'mpl'),
      PYTHONDONTWRITEBYTECODE: '1',
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: join(root, 'figures')
    }
    const original = startLoop(pyBin!, environment)
    let replay: ReturnType<typeof startLoop> | undefined
    try {
      expect(
        (await original.send(`import os; os.chdir(${JSON.stringify(dataRoot)})`)).error
      ).toBeNull()
      expect((await original.send(reportedPythonCallbackPrelude)).error).toBeNull()
      const observer = await startWorkingFileObservation({
        dataRoot,
        notebookSessionRoot,
        cwd: dataRoot,
        language: 'python',
        code: reportedPythonCallbackPlot,
        runId: 'plot',
        registeredInputFiles: []
      })
      const response = await original.send(reportedPythonCallbackPlot)
      const files = await observer.finish()
      expect(response.error).toBeNull()
      expect(response.stdout).toContain('saved')
      // plt.close() leaves no live display figure; the saved PNG is captured below.
      expect(response.figures).toHaveLength(0)
      expect(files.fileEvidence).toMatchObject({
        state: 'available',
        fileReads: 'complete',
        externalPaths: 'complete',
        writerAttribution: 'complete',
        reasonCodes: []
      })
      expect(files.confirmedReadPaths ?? []).toEqual([])
      const output = files.workingFiles.find(
        (file) => file.relativePath === 'data/group_pie_r.png'
      )!
      expect(output.checksum).toBeDefined()
      const run: NotebookRunRecord = {
        runId: 'plot',
        cellId: 'plot',
        source: 'agent',
        kernelKind: 'python',
        kernelEpochId: 'epoch',
        kernelDispatched: true,
        environment: 'default-python',
        script: reportedPythonCallbackPlot,
        status: 'completed',
        startedAt: 1,
        endedAt: 2,
        text: { stdout: response.stdout, stderr: response.stderr, traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        inputFiles: [],
        ...files
      }
      const projection = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => [run] }
      }).project({ projectId: 'project', sessionId: 'session', completedRun: run })
      expect(projection.stalenessByRunId.plot).toEqual({ state: 'clear' })
      expect(projection.dependenciesByRunId?.plot).toEqual([])
      const graph = sealArtifactProvenanceGraph({
        target: {
          versionId: 'version',
          filename: 'group_pie_r.png',
          checksum: output.checksum!,
          sizeBytes: output.size!,
          producerRunId: run.runId,
          sourceGenerationId: output.generationId
        },
        notebookActivities: [
          {
            run,
            runIndex: 0,
            evidenceJson: readFileSync(join(root, files.fileEvidence.storageKey!), 'utf8')
          }
        ],
        computeActivities: []
      })
      expect(graph.completeness).toBe('complete')
      const replayRoot = join(root, 'replay')
      mkdirSync(replayRoot)
      replay = startLoop(pyBin!, environment)
      expect(
        (await replay.send(`import os; os.chdir(${JSON.stringify(replayRoot)})`)).error
      ).toBeNull()
      expect((await replay.send(reportedPythonCallbackPlot)).error).toBeNull()
      expect(readFileSync(join(replayRoot, 'group_pie_r.png'))).toEqual(
        readFileSync(join(dataRoot, 'group_pie_r.png'))
      )
    } finally {
      original.child.kill()
      replay?.child.kill()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.each(['extra_import', 'extra_distribution'])(
    'keeps the loaded %s distribution identity after its original search path is removed',
    async (importName) => {
      const root = mkdtempSync(join(tmpdir(), 'python-library-shadow-'))
      const libraries = ['1.0', '99.0'].map((version) => {
        const library = join(root, version)
        const distribution = join(library, `extra_distribution-${version}.dist-info`)
        mkdirSync(distribution, { recursive: true })
        writeFileSync(
          join(distribution, 'METADATA'),
          `Name: extra-distribution\nVersion: ${version}\n`
        )
        writeFileSync(join(distribution, 'top_level.txt'), `${importName}\n`)
        writeFileSync(join(distribution, 'RECORD'), `${importName}.py,,\n`)
        writeFileSync(join(library, `${importName}.py`), `__version__ = "${version}"\n`)
        return library
      })
      const { child, send } = startLoop(pyBin as string, { PYTHONDONTWRITEBYTECODE: '1' })
      try {
        const loaded = await send(
          `import sys; sys.path.insert(0, ${JSON.stringify(libraries[0])}); import ${importName}`
        )
        expect(loaded.error).toBeNull()
        const switched = await send(
          `sys.path.remove(${JSON.stringify(libraries[0])}); sys.path.insert(0, ${JSON.stringify(libraries[1])}); assert ${importName}.__version__ == "1.0"`
        )
        expect(switched.error).toBeNull()
        const packages = switched.environment.packages.filter(
          (pkg) => pkg.name.replace(/_/gu, '-') === 'extra-distribution'
        )
        expect(packages.filter((pkg) => pkg.loaded_state === 'loaded')).toEqual([
          expect.objectContaining({ version: '1.0' })
        ])
        expect(packages).toContainEqual(
          expect.objectContaining({ version: '99.0', loaded_state: 'installed-only' })
        )
      } finally {
        child.kill()
        rmSync(root, { recursive: true, force: true })
      }
    },
    60_000
  )

  it.each(['extra_import', '_extra_import'])(
    'distinguishes unused distributions from dynamically imported %s aliases',
    async (importName) => {
      const root = mkdtempSync(join(tmpdir(), 'python-package-usage-'))
      const distribution = join(root, 'extra_distribution-1.0.dist-info')
      mkdirSync(distribution)
      writeFileSync(join(distribution, 'METADATA'), 'Name: extra-distribution\nVersion: 1.0\n')
      writeFileSync(join(distribution, 'top_level.txt'), `${importName}\n`)
      writeFileSync(join(root, `${importName}.py`), '__version__ = "1.0"\n')
      const { child, send } = startLoop(pyBin as string, { PYTHONDONTWRITEBYTECODE: '1' })
      try {
        const unused = await send(`import sys; sys.path.insert(0, ${JSON.stringify(root)})`)
        expect(unused.error).toBeNull()
        expect(unused.environment.packages).toContainEqual(
          expect.objectContaining({
            name: 'extra-distribution',
            loaded_state: 'installed-only'
          })
        )
        const childUse = await send(
          'import subprocess; subprocess.run([sys.executable, "-c", "pass"], check=True)'
        )
        expect(childUse.error).toBeNull()
        expect(childUse.environment.packages).toContainEqual(
          expect.objectContaining({
            name: 'extra-distribution',
            loaded_state: 'unknown'
          })
        )
        const used = await send(
          `import importlib; extra = importlib.import_module("${importName}")`
        )
        expect(used.error).toBeNull()
        expect(used.environment.packages).toContainEqual(
          expect.objectContaining({
            name: 'extra-distribution',
            loaded_state: 'loaded'
          })
        )
      } finally {
        child.kill()
        rmSync(root, { recursive: true, force: true })
      }
    },
    60_000
  )

  it('tracks shared namespace distributions independently and preserves unknown ownership', async () => {
    const root = mkdtempSync(join(tmpdir(), 'python-namespace-usage-'))
    mkdirSync(join(root, 'shared_namespace'))
    for (const name of ['used', 'unused', 'unknown']) {
      const distribution = join(root, `namespace_${name}-1.0.dist-info`)
      mkdirSync(distribution)
      writeFileSync(join(distribution, 'METADATA'), `Name: namespace-${name}\nVersion: 1.0\n`)
      writeFileSync(join(distribution, 'top_level.txt'), 'shared_namespace\n')
      writeFileSync(join(root, 'shared_namespace', name + '.py'), 'value = 1\n')
      if (name !== 'unknown')
        writeFileSync(join(distribution, 'RECORD'), `shared_namespace/${name}.py,,\n`)
    }
    const { child, send } = startLoop(pyBin as string, { PYTHONDONTWRITEBYTECODE: '1' })
    try {
      const response = await send(
        `import sys; sys.path.insert(0, ${JSON.stringify(root)}); import shared_namespace.used`
      )
      expect(response.error).toBeNull()
      const states = Object.fromEntries(
        response.environment.packages
          .filter((pkg) => pkg.name.startsWith('namespace-'))
          .map((pkg) => [pkg.name, pkg.loaded_state])
      )
      expect(states).toEqual({
        'namespace-used': 'loaded',
        'namespace-unused': 'installed-only',
        'namespace-unknown': 'unknown'
      })
    } finally {
      child.kill()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('returns fresh bounded user variables while filtering bootstrap and private names', async () => {
    const { child, send, inspect } = startLoop(pyBin as string, {})
    try {
      await send(
        "x = 41; label = 'active value'; _private = 'hidden'; sys = 1; json = 'user json'; " +
          "items = list(range(10000)); blob = b'x' * 2000000; " +
          "Explosive = type('Explosive', (), {'__repr__': lambda self: (_ for _ in ()).throw(RuntimeError('no repr'))}); explosive = Explosive(); mixed = [explosive]; globals()[0] = 'non-string key'"
      )
      const first = await inspect()
      expect(first.namespace?.variables.map(({ name }) => name)).toEqual([
        'Explosive',
        'blob',
        'explosive',
        'items',
        'json',
        'label',
        'mixed',
        'sys',
        'x'
      ])
      expect(first.namespace?.variables.find(({ name }) => name === 'blob')).toMatchObject({
        size_bytes: 2_000_033,
        preview: expect.stringMatching(/^b'/)
      })
      expect(first.namespace?.variables.find(({ name }) => name === 'sys')?.preview).toBe('1')
      expect(first.namespace?.variables.find(({ name }) => name === 'json')?.preview).toBe(
        "'user json'"
      )
      expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(256 * 1024)

      await send("x = 42; del label; added = {'ok': True}")
      const refreshed = await inspect(true)
      expect(refreshed.namespace?.variables.map(({ name }) => name)).toEqual([
        'Explosive',
        '_private',
        'added',
        'blob',
        'explosive',
        'items',
        'json',
        'mixed',
        'sys',
        'x'
      ])
      expect(refreshed.namespace?.variables.find(({ name }) => name === 'mixed')?.preview).toBe(
        'list [1]'
      )
      expect(refreshed.namespace?.variables.find(({ name }) => name === 'x')?.preview).toBe('42')
      expect(refreshed.namespace?.variables.find(({ name }) => name === '_private')).toMatchObject({
        is_private: true
      })
    } finally {
      child.kill()
    }
  }, 60_000)

  it('keeps the final JSON response within budget for non-ASCII names and previews', async () => {
    const { child, send, inspect } = startLoop(pyBin as string, {})
    try {
      await send(
        "globals()['x' * 2_000_000] = 1; globals().update({f'€€{i}': '€' * 1000 for i in range(500)})"
      )
      const response = await inspect()

      expect(response.namespace?.variables_truncated).toBe(true)
      expect(response.namespace?.variables.some(({ name }) => name.endsWith('…'))).toBe(true)
      expect(
        response.namespace?.variables.every(({ name }) => Buffer.byteLength(name, 'utf8') <= 1024)
      ).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThan(256 * 1024)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('does not dereference spoofed scientific object properties', async () => {
    const { child, send, inspect } = startLoop(pyBin as string, {})
    try {
      await send(
        "shape_reads = []; Spoof = type('ndarray', (), {'__module__': 'numpy', 'shape': property(lambda self: shape_reads.append('read') or (1, 2))}); spoof = Spoof()"
      )

      const response = await inspect()
      expect(response.namespace?.variables.find(({ name }) => name === 'spoof')).toMatchObject({
        type: 'numpy.ndarray',
        preview: '<numpy.ndarray>'
      })
      expect((await send('len(shape_reads)')).result).toBe('0')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('executes non-ASCII source sent over the stdin protocol', async () => {
    const { child, send } = startLoop(pyBin as string, {})
    try {
      const response = await send('\n# Select 8–10 representative candidate factors\nprint(1)')

      expect(response.error).toBeNull()
      expect(response.stdout).toBe('1\n')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('keeps state across requests, echoes trailing expr, captures stdout, reports errors', async () => {
    const { child, send } = startLoop(pyBin as string, {})
    try {
      const a = await send('x = 41')
      expect(a.error).toBeNull()
      expect(a.environment.runtime_version).toMatch(/^3\./)
      expect(a.environment.packages).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'sys', loaded_state: 'loaded' })])
      )

      // State survives across requests; a trailing bare expression echoes as a repr result.
      const b = await send('x + 1')
      expect(b.error).toBeNull()
      expect(b.result).toBe('42')

      // stdout is captured per-request.
      const c = await send('print("hi")')
      expect(c.stdout).toContain('hi')

      // Errors come back as a traceback string, not a thrown exception.
      const d = await send('raise ValueError("boom")')
      expect(d.error).toContain('ValueError: boom')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('captures a saved matplotlib figure exactly once as a content-addressed PNG', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-'))
    const savedPath = join(figuresDir, 'saved.png')
    const { child, send } = startLoop(pyBin as string, {
      MPLBACKEND: 'Agg',
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        'import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt; ' +
          `plt.plot([1,2,3]); plt.savefig(${JSON.stringify(savedPath)})`
      )
      expect(r.error).toBeNull()
      expect(existsSync(savedPath)).toBe(true)
      expect(r.figures).toHaveLength(1)
      const fig = r.figures[0]
      expect(existsSync(fig.path)).toBe(true)
      const bytes = readFileSync(fig.path)
      // PNG magic bytes.
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('\x89PNG'.slice(0, 4))
      expect(bytes[0]).toBe(0x89)
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('allows reading pyvenv.cfg metadata but still blocks writing it', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'os-python-runtime-guard-'))
    const workspace = mkdtempSync(join(tmpdir(), 'os-python-pyvenv-read-'))
    const configPath = join(workspace, 'pyvenv.cfg')
    writeFileSync(configPath, 'home = /usr/bin\n')
    const { child, send } = startLoop(pyBin as string, {
      OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot
    })
    try {
      const read = await send(
        `print(open(${JSON.stringify(configPath)}, 'r', encoding='utf-8').read(), end='')`
      )
      expect(read.error).toBeNull()
      expect(read.stdout).toBe('home = /usr/bin\n')

      const write = await send(`open(${JSON.stringify(configPath)}, 'w').write('changed')`)
      expect(write.error).toMatch(/manage_packages/)
      expect(readFileSync(configPath, 'utf8')).toBe('home = /usr/bin\n')
    } finally {
      child.kill()
      rmSync(runtimeRoot, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 60_000)

  it('allows libraries to create workload caches without opening the managed runtime', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'os-python-runtime-cache-'))
    const cacheRoot = join(runtimeRoot, 'cache', 'notebook')
    const matplotlibCache = join(cacheRoot, 'matplotlib')
    mkdirSync(cacheRoot, { recursive: true })
    const { child, send } = startLoop(pyBin as string, {
      OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot,
      OPEN_SCIENCE_NOTEBOOK_CACHE_DIR: cacheRoot,
      MPLCONFIGDIR: matplotlibCache,
      MPLBACKEND: 'Agg'
    })
    try {
      const imported = await send('import matplotlib; print(matplotlib.get_configdir())')

      expect(imported.error).toBeNull()
      expect(imported.stderr).not.toContain('Package/environment mutation is not allowed')
      expect(imported.stdout.trim()).toBe(realpathSync.native(matplotlibCache))

      const blocked = await send(
        `import os; os.makedirs(${JSON.stringify(join(runtimeRoot, 'blocked'))})`
      )
      expect(blocked.error).toMatch(/manage_packages/)
    } finally {
      child.kill()
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it.skipIf(process.platform === 'win32')(
    'uses subprocess write targets so copy-out and workspace writes remain allowed',
    async () => {
      const runtimeRoot = mkdtempSync(join(tmpdir(), 'os-python-child-runtime-'))
      const workspace = mkdtempSync(join(tmpdir(), 'os-python-child-output-'))
      const source = join(runtimeRoot, 'source.txt')
      const copied = join(workspace, 'copied.txt')
      const outputDir = join(workspace, 'created')
      writeFileSync(source, 'runtime input')
      const { child, send } = startLoop(pyBin as string, {
        OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot
      })
      try {
        const copyOut = await send(
          `import subprocess; subprocess.run(["cp", ${JSON.stringify(source)}, ${JSON.stringify(copied)}], check=True)`
        )
        expect(copyOut.error).toBeNull()
        expect(readFileSync(copied, 'utf8')).toBe('runtime input')

        const workspaceWrite = await send(
          `subprocess.run(["sh", "-c", ` +
            `${JSON.stringify(`printf '%s' "$OPEN_SCIENCE_RUNTIME_DIR" >/dev/null; mkdir ${JSON.stringify(outputDir)}`)}], check=True)`
        )
        expect(workspaceWrite.error).toBeNull()
        expect(existsSync(outputDir)).toBe(true)

        const blocked = await send(
          `subprocess.run(["cp", ${JSON.stringify(copied)}, ` +
            `${JSON.stringify(join(runtimeRoot, 'blocked.txt'))}], check=True)`
        )
        expect(blocked.error).toMatch(/manage_packages/)
      } finally {
        child.kill()
        rmSync(runtimeRoot, { recursive: true, force: true })
        rmSync(workspace, { recursive: true, force: true })
      }
    },
    60_000
  )
})

gate('python_loop.py data-kernel isolation', () => {
  it('exposes no host symbol even when the connector RPC env is present', async () => {
    // The data kernel must have NO outbound connector access: host.mcp lives only in the control-plane
    // repl kernel. Even with the RPC endpoint/token set in the environment, the python namespace must
    // not expose a `host` symbol, and referencing it must raise NameError.
    const { child, send } = startLoop(pyBin as string, {
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: 'http://127.0.0.1:9/x',
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok'
    })
    try {
      const a = await send("print('host' in dir())")
      expect(a.error).toBeNull()
      expect(a.stdout.trim()).toBe('False')

      const b = await send("print('host' in globals())")
      expect(b.error).toBeNull()
      expect(b.stdout.trim()).toBe('False')

      // Actually touching host is a hard NameError, not a silent no-op.
      const c = await send('host.mcp("x", "y")')
      expect(c.error).toContain("name 'host' is not defined")
    } finally {
      child.kill()
    }
  }, 60_000)
})
