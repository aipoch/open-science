import { describe, it, expect } from 'vitest'
import { notebookExecutionContextSchema } from '../../shared/notebook-execution-context'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
  send: (code: string) => Promise<LoopResponse>
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
  const send = (code: string): Promise<LoopResponse> =>
    new Promise((resolve) => {
      const reqId = randomUUID()
      waiters.set(reqId, resolve)
      child.stdin.write(`${JSON.stringify({ req_id: reqId, code })}\n`)
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
      expect(files.workingFiles.some((file) => file.relativePath === 'data/synthetic_groups_bar.png')).toBe(
        true
      )
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
        "x = 41; label = '活跃变量'; _private = 'hidden'; sys = 1; json = 'user json'; " +
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
        "globals()['x' * 2_000_000] = 1; globals().update({f'变量{i}': '汉' * 1000 for i in range(500)})"
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
