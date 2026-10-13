// Inspired by PR #2151's pristine-cache restore acceptance test. Exercise our actual
// reproduction runtime for both languages, using a local archive mirror so the test
// never relies on public repositories or on the developer's existing package cache.
// Opt in with OPEN_SCIENCE_TEST_MICROMAMBA, OPEN_SCIENCE_TEST_CONDA_ARCHIVES and
// OPEN_SCIENCE_TEST_RESTORE_PY_ENV / OPEN_SCIENCE_TEST_R_ENV (read-only environment prefixes).
// OPEN_SCIENCE_TEST_SCIENTIFIC_RESTORE=1 requires numpy/pandas/matplotlib and ggplot2.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'

import type {
  NotebookEnvironmentLock,
  NotebookEnvironmentPackage
} from '@aipoch/environment/contracts'
import {
  EnvironmentStateTracker,
  parseCondaPackageNames,
  removeEnvironmentSnapshot,
  verifyEnvironmentSnapshot
} from '@aipoch/environment'
import { verifySnapshotRuntime } from './package-process-sandbox'
import { NotebookKernelExecutor } from './kernel-executor'
import { createNotebookDependencyAnalyzer } from './dependency-analysis-adapter'
import { sealArtifactProvenanceGraph } from '../artifacts/artifact-provenance-graph'
import { reproductionRecipes } from '../artifacts/reproducibility-host'
import type { NotebookRunRecord } from '../../shared/notebook'
import type { NotebookProcessSandbox } from './process-sandbox'
import { micromambaSpawnEnv, normalizeExplicitLock } from '@aipoch/environment'
import {
  createNotebookReproductionRuntime,
  executeArtifactReproducibility,
  type NotebookReproductionStep
} from './reproduction-runtime'
import { pythonBin, rScriptBin } from '@aipoch/environment'

const execute = promisify(execFile)
const mm = process.env.OPEN_SCIENCE_TEST_MICROMAMBA
const archives = process.env.OPEN_SCIENCE_TEST_CONDA_ARCHIVES
const scientific = process.env.OPEN_SCIENCE_TEST_SCIENTIFIC_RESTORE === '1'
const hash = (content: string): string => createHash('sha256').update(content).digest('hex')
// This suite certifies restoration and the real kernel protocol. OS policy enforcement has
// its own certification suite; these known fixture scripts run only under a temporary root.
const passThroughSandbox: NotebookProcessSandbox = {
  wrap: async ({ executable, args, env }) => ({
    executable,
    args,
    env,
    annotateStderr: (stderr) => stderr,
    cleanup: async (_reason, outcome) => ({
      processesTerminated: outcome.processesTerminated,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
  })
}

for (const language of ['python', 'r'] as const) {
  it.skipIf(!mm)(
    `rejects a corrupted ${language} archive before verifying or starting a runtime`,
    { timeout: 30_000 },
    async ({ signal }) => {
      const root = await mkdtemp(join(tmpdir(), 'reproduction-corrupt-archive-'))
      const server = createServer((_request, response) => response.end('corrupted package bytes'))
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', resolve)
        })
        const address = server.address()
        if (!address || typeof address === 'string')
          throw new Error('Missing archive server address')
        const serialized = JSON.stringify({
          schemaVersion: 1,
          format: 'environment-lock-bundle',
          kernelKind: language,
          environmentName: `default-${language}`,
          components: [
            {
              ecosystem: 'conda',
              format: 'conda-explicit-md5',
              resolution: 'locked',
              explicitLock: `@EXPLICIT\nhttp://127.0.0.1:${address.port}/noarch/fixture-1.0-0.tar.bz2#${'0'.repeat(32)}\n`,
              packages: [language === 'python' ? 'python' : 'r-base']
            }
          ]
        })
        const lockChecksum = hash(serialized)
        const lockPath = join(
          root,
          'runtime',
          'provenance',
          'environment-locks',
          `${lockChecksum}.json`
        )
        await mkdir(dirname(lockPath), { recursive: true })
        await writeFile(lockPath, serialized)
        const verifyExecutable = vi.fn()
        const createExecutor = vi.fn()
        await expect(
          createNotebookReproductionRuntime(
            {
              requirements: [
                {
                  requirementId: `environment-lock:${lockChecksum}`,
                  kernelKind: language,
                  lockChecksum,
                  lockState: 'available'
                }
              ],
              storageRoot: root,
              attemptRoot: join(root, 'attempt'),
              projectId: 'corrupted-archive-test',
              sessionId: language,
              signal,
              processSandbox: { wrap: vi.fn() }
            },
            { micromamba: mm, verifyExecutable, createExecutor }
          )
        ).rejects.toThrow(/md5|checksum|validation/iu)
        expect(verifyExecutable).not.toHaveBeenCalled()
        expect(createExecutor).not.toHaveBeenCalled()
      } finally {
        server.closeAllConnections()
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  const source =
    process.env[
      language === 'python' ? 'OPEN_SCIENCE_TEST_RESTORE_PY_ENV' : 'OPEN_SCIENCE_TEST_R_ENV'
    ] ?? (language === 'python' ? process.env.OPEN_SCIENCE_TEST_PY_ENV : undefined)
  it.skipIf(!mm || !archives || !source)(
    `restores ${language}${scientific ? ' scientific packages' : ''} from an empty cache, preserves its exact lock and output, then reuses the cache without a server`,
    { timeout: 300_000 },
    async ({ signal }) => {
      const root = await mkdtemp(join(tmpdir(), 'reproduction-cold-cache-'))
      const requests: string[] = []
      const available = new Set(await readdir(archives!))
      const server = createServer((request, response) => {
        const file = basename(request.url ?? '')
        if (!available.has(file) || !/\.(?:conda|tar\.bz2)$/u.test(file)) {
          response.writeHead(404).end()
          return
        }
        requests.push(file)
        const stream = createReadStream(join(archives!, file))
        stream.on('error', () => response.destroy())
        stream.pipe(response)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', resolve)
        })
        const address = server.address()
        if (!address || typeof address === 'string')
          throw new Error('Missing archive server address')
        const { stdout: rawLock } = await execute(mm!, [
          '--no-rc',
          'list',
          '-p',
          source!,
          '--explicit',
          '--md5'
        ])
        const { stdout: inventory } = await execute(mm!, [
          '--no-rc',
          'list',
          '-p',
          source!,
          '--json'
        ])
        const pinned = normalizeExplicitLock(rawLock).trim().split('\n').slice(1)
        const files = pinned.map((line) => basename(new URL(line).pathname))
        expect(files.length).toBeGreaterThan(0)
        for (const file of files)
          expect(available.has(file), `Fixture archive missing: ${file}`).toBe(true)
        const explicitLock =
          '@EXPLICIT\n' +
          pinned
            .map((line) => {
              const url = new URL(line)
              // Retain the platform directory: micromamba uses it to select relocation/signing
              // behavior (notably osx-arm64). The mirror resolves only the archive basename.
              return `http://127.0.0.1:${address.port}${url.pathname}${url.hash}`
            })
            .join('\n') +
          '\n'
        const lock: NotebookEnvironmentLock = {
          schemaVersion: 1,
          format: 'environment-lock-bundle',
          kernelKind: language,
          environmentName: `default-${language}`,
          platform: process.platform,
          architecture: process.arch,
          components: [
            {
              ecosystem: 'conda',
              format: 'conda-explicit-md5',
              resolution: 'locked',
              explicitLock,
              packages: parseCondaPackageNames(inventory)
            }
          ]
        }
        const serialized = JSON.stringify(lock)
        const lockChecksum = hash(serialized)
        const storageRoot = join(root, 'storage')
        const lockPath = join(
          storageRoot,
          'runtime',
          'provenance',
          'environment-locks',
          `${lockChecksum}.json`
        )
        await mkdir(dirname(lockPath), { recursive: true })
        await writeFile(lockPath, serialized)
        const cache = join(storageRoot, 'runtime', 'pkgs')
        expect(await readdir(cache).catch(() => [])).toEqual([])
        const baseCode =
          language === 'python'
            ? 'import math\nfrom pathlib import Path\nvalues = [float(x) for x in Path("inputs/values.txt").read_text().split()]\nPath("values.txt").write_text(",".join(format(math.sin(x), ".8f") for x in values))\nPath("count.txt").write_text(str(len(values)))\nprint("replayed 4 values")'
            : 'values <- scan("inputs/values.txt", quiet=TRUE)\nwriteLines(paste(sprintf("%.8f", sin(values)), collapse=","), "values.txt")\nwriteLines(as.character(length(values)), "count.txt")\ncat("replayed 4 values\\n")'
        const plottingCode =
          language === 'python'
            ? `
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
df = pd.read_csv("inputs/groups.csv")
counts = df["group"].value_counts().sort_index()
counts.to_csv("counts.csv", header=True)
fig, axes = plt.subplots(1, 2, figsize=(8, 3))
x = np.linspace(0, 2 * np.pi, 100)
axes[0].plot(x, np.sin(x))
axes[1].bar(counts.index, counts.values)
fig.tight_layout()
fig.savefig("plots.png", dpi=100)
plt.close(fig)
`
            : `
suppressPackageStartupMessages(library(ggplot2))
df <- read.csv("inputs/groups.csv")
counts <- as.data.frame(table(df$group))
names(counts) <- c("group", "n")
write.csv(counts, "counts.csv", row.names=FALSE)
p <- ggplot(counts, aes(x=group, y=n, fill=group)) + geom_col() + theme_minimal()
ggsave("plots.png", p, width=6, height=4, dpi=100, device="png", type="cairo")
`
        const code = baseCode + (scientific ? plottingCode : '')
        const args = language === 'python' ? ['-I', '-c', code] : ['--vanilla', '-e', code]
        const command = language === 'python' ? pythonBin : rScriptBin
        const originalCwd = join(root, 'original-output')
        await mkdir(join(originalCwd, 'inputs'), { recursive: true })
        await writeFile(join(originalCwd, 'inputs', 'values.txt'), '0 1 2 3\n')
        const groups = 'group\n' + 'Ctrl\n'.repeat(33) + 'IRI\n'.repeat(33)
        await writeFile(join(originalCwd, 'inputs', 'groups.csv'), groups)
        await execute(command(source!), args, { cwd: originalCwd })
        const expected = await readFile(join(originalCwd, 'values.txt'), 'utf8')
        const expectedCount = await readFile(join(originalCwd, 'count.txt'), 'utf8')
        const expectedScientific = scientific
          ? await Promise.all(
              ['counts.csv', 'plots.png'].map((file) => readFile(join(originalCwd, file)))
            )
          : []

        for (const attempt of ['cold', 'warm']) {
          const attemptRoot = join(root, attempt)
          const runtime = await createNotebookReproductionRuntime(
            {
              requirements: [
                {
                  requirementId: `environment-lock:${lockChecksum}`,
                  kernelKind: language,
                  environmentName: lock.environmentName,
                  lockChecksum,
                  lockState: 'available'
                }
              ],
              storageRoot,
              attemptRoot,
              projectId: 'cold-cache-test',
              sessionId: attempt,
              signal,
              processSandbox: passThroughSandbox,
              onEnvironmentProgress: ({ stage }) =>
                console.log(`[restore ${language}/${attempt}] ${stage}`)
            },
            { micromamba: mm }
          )
          try {
            const prefix = join(attemptRoot, 'environments', lockChecksum)
            const { stdout: restored } = await execute(
              mm!,
              ['--no-rc', 'list', '-p', prefix, '--explicit', '--md5'],
              {
                env: micromambaSpawnEnv(join(storageRoot, 'runtime'))
              }
            )
            expect(normalizeExplicitLock(restored)).toBe(explicitLock)
            const sessionRoot = join(attemptRoot, 'session')
            const dataRoot = join(sessionRoot, 'data')
            await mkdir(join(dataRoot, 'inputs'), { recursive: true })
            await writeFile(join(dataRoot, 'inputs', 'values.txt'), '0 1 2 3\n')
            await writeFile(join(dataRoot, 'inputs', 'groups.csv'), groups)
            const step: NotebookReproductionStep = {
              kind: 'notebook-run',
              stepId: 'step-1',
              activityId: 'run-1',
              sequence: 0,
              runId: 'run-1',
              runIndex: 0,
              kernelKind: language,
              sourceChecksum: hash(code),
              environmentRequirementId: `environment-lock:${lockChecksum}`,
              inputEntityIds: [],
              outputEntityIds: []
            }
            const failedSource =
              language === 'python'
                ? 'raise RuntimeError("expected fixture failure")'
                : 'stop("expected fixture failure")'
            const failed = await runtime.execute({
              step: { ...step, sourceChecksum: hash(failedSource) },
              source: failedSource,
              sessionRoot,
              signal,
              kernelEpochId: 'fixture-epoch'
            })
            expect(failed.status).toBe('failed')
            expect(failed.traceback + failed.stderr).toContain('expected fixture failure')
            const result = await runtime.execute({
              step: {
                ...step,
                runId: 'run-2',
                runIndex: 1,
                stepId: 'step-2',
                activityId: 'run-2',
                sequence: 1
              },
              source: code,
              sessionRoot,
              signal,
              kernelEpochId: 'fixture-epoch'
            })
            expect(result.status, result.traceback || result.stderr).toBe('completed')
            expect(result.stdout).toContain('replayed 4 values')
            expect(await readFile(join(dataRoot, 'values.txt'), 'utf8')).toBe(expected)
            expect(await readFile(join(dataRoot, 'count.txt'), 'utf8')).toBe(expectedCount)
            if (scientific) {
              for (const [index, file] of ['counts.csv', 'plots.png'].entries()) {
                expect(await readFile(join(dataRoot, file)), `${attempt}/${file}`).toEqual(
                  expectedScientific[index]
                )
              }
            }
          } finally {
            expect(await runtime.shutdown()).toEqual({ reaped: true })
          }
          if (attempt === 'cold') {
            expect(new Set(requests)).toEqual(new Set(files))
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
          }
        }
      } finally {
        server.closeAllConnections()
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    }
  )
}

// Supply a read-only mixed Conda prefix. Use a short TMPDIR when its binary prefix allocation
// is short. No packages are installed and the workflow runs only in the restored environment.
const snapshotSource = process.env.OPEN_SCIENCE_TEST_SNAPSHOT_PREFIX
it.skipIf(!snapshotSource)(
  'captures a mixed environment and replays a JSON mapping workflow with complete file lineage',
  { timeout: 300_000 },
  async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), 'e-'))
    const storageRoot = join(root, 'storage')
    let runtime: Awaited<ReturnType<typeof createNotebookReproductionRuntime>> | undefined
    try {
      const observed = JSON.parse(
        (
          await execute(
            pythonBin(snapshotSource!),
            [
              '-I',
              '-B',
              '-c',
              'import json, sys; print(json.dumps({"runtimeVersion": ".".join(map(str, sys.version_info[:3])), "packages": []}))'
            ],
            { signal, timeout: 30_000 }
          )
        ).stdout
      )
      const captured = await new EnvironmentStateTracker({
        dataRoot: storageRoot,
        verifySnapshotRuntime: (prefix, argv) =>
          verifySnapshotRuntime(passThroughSandbox, prefix, argv, signal)
      }).captureCompletedRun(
        {
          language: 'python',
          environmentName: 'default-python',
          runtimeSource: 'managed',
          command: pythonBin(snapshotSource!),
          condaPrefix: snapshotSource
        },
        observed
      )
      expect(
        captured.environmentLock,
        JSON.stringify({ lock: captured.environmentLock, warnings: captured.manifest.warnings })
      ).toMatchObject({ state: 'available' })
      if (captured.environmentLock.state !== 'available')
        throw new Error('Snapshot is not available')
      const lockChecksum = captured.environmentLock.lockChecksum
      const requirementId = `environment-lock:${lockChecksum}`
      runtime = await createNotebookReproductionRuntime(
        {
          requirements: [
            {
              requirementId,
              kernelKind: 'python',
              environmentName: 'default-python',
              lockChecksum,
              lockState: 'available'
            }
          ],
          storageRoot,
          attemptRoot: join(root, 'attempt'),
          projectId: 'snapshot-test',
          sessionId: 'replay',
          processSandbox: passThroughSandbox,
          signal
        },
        {
          createExecutor: (options) => {
            const executor = new NotebookKernelExecutor(options)
            const execute = executor.execute.bind(executor)
            // Capture uses the same kernel observer as a normal run, with a fresh activity ID.
            executor.execute = (request) =>
              execute({ ...request, runId: 'scores', fileEvidenceStorageRoot: storageRoot })
            return executor
          }
        }
      )
      const sessionRoot = join(root, 'session'),
        dataRoot = join(sessionRoot, 'data')
      await mkdir(dataRoot, { recursive: true })
      await writeFile(
        join(dataRoot, 'input.json'),
        JSON.stringify({ a: { values: [1, 2] }, b: { values: [2, 3] } })
      )
      const source = `import json
import numpy as np
with open("input.json") as handle:
    records = json.load(handle)
scores = {}
for name, record in records.items():
    scores[name] = float(np.sum(record.get("values", [])))
with open("scores.json", "w") as handle:
    json.dump(scores, handle, sort_keys=True)
`
      const step: NotebookReproductionStep = {
        kind: 'notebook-run',
        stepId: 'scores',
        activityId: 'scores',
        sequence: 0,
        runId: 'scores',
        runIndex: 0,
        kernelKind: 'python',
        sourceChecksum: hash(source),
        environmentRequirementId: requirementId,
        inputEntityIds: [],
        outputEntityIds: []
      }
      const execution = await runtime.execute({
        step,
        source,
        sessionRoot,
        signal,
        kernelEpochId: 'snapshot-epoch'
      })
      const files = execution
      expect(execution.status, execution.traceback).toBe('completed')
      if (!files.workingFiles || !files.fileEvidence)
        throw new Error('Missing kernel file evidence')
      expect(JSON.parse(await readFile(join(dataRoot, 'scores.json'), 'utf8'))).toEqual({
        a: 3,
        b: 5
      })
      expect(files.fileEvidence).toMatchObject({
        state: 'available',
        fileReads: 'complete',
        writerAttribution: 'complete',
        reasonCodes: []
      })
      const run: NotebookRunRecord = {
        runId: 'scores',
        cellId: 'scores',
        source: 'agent',
        kernelKind: 'python',
        kernelEpochId: 'snapshot-epoch',
        environment: 'default-python',
        environmentLock: captured.environmentLock,
        kernelDispatched: true,
        script: source,
        status: 'completed',
        startedAt: 1,
        endedAt: 2,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        workingFiles: files.workingFiles,
        inputFiles: [],
        fileEvidence: files.fileEvidence
      }
      const projection = await createNotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => [run] }
      }).project({ projectId: 'snapshot-test', sessionId: 'replay' })
      expect(projection.stalenessByRunId.scores).toEqual({ state: 'clear' })
      const output = files.workingFiles.find((file) => file.relativePath === 'data/scores.json')!
      const graph = sealArtifactProvenanceGraph({
        target: {
          versionId: 'version',
          filename: 'scores.json',
          checksum: output.checksum!,
          sizeBytes: output.size!,
          producerRunId: 'scores',
          sourceGenerationId: output.generationId
        },
        notebookActivities: [
          {
            run,
            runIndex: 0,
            evidenceJson: await readFile(join(storageRoot, files.fileEvidence.storageKey!), 'utf8')
          }
        ],
        computeActivities: [],
        notebookDependencies: projection
      })
      expect(graph.completeness).toBe('complete')
      const recipeInput: Parameters<
        typeof reproductionRecipes.sealArtifactReproducibilityRecipe
      >[0] = {
        provenanceGraph: graph,
        inputFiles: [],
        runs: [
          {
            runId: run.runId,
            runIndex: 0,
            agentFrameId: 'frame',
            messageBranchId: 'branch',
            runtimeSegmentId: 'segment',
            promptMessageId: 'prompt',
            kernelEpochId: run.kernelEpochId,
            kernelDispatched: true,
            kernelKind: 'python',
            environmentName: run.environment,
            environmentLock: captured.environmentLock,
            script: source,
            status: 'completed',
            startedAt: new Date(1).toISOString(),
            completedAt: new Date(2).toISOString(),
            outputs: [],
            inputFileVersionKeys: []
          }
        ]
      }
      const recipe = reproductionRecipes.sealArtifactReproducibilityRecipe(recipeInput)
      expect(recipe.capture).toEqual({ state: 'sealed', reasonCodes: [] })
      expect(recipe.environmentRequirements).toEqual([
        {
          requirementId,
          kernelKind: 'python',
          environmentName: 'default-python',
          lockChecksum,
          lockState: 'available'
        }
      ])
      // Exercise the generated Python verifier, including packages without __version__
      // and legacy distributions without RECORD. Only the disposable restored prefix changes.
      const [restored] = await readdir(join(storageRoot, '.e'))
      const prefix = join(storageRoot, '.e', restored!, 'e')
      const sitePackages = (
        await execute(
          pythonBin(prefix),
          ['-I', '-B', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'],
          { signal }
        )
      ).stdout.trim()
      const fixtures = ['snapshot_release', 'snapshot_record', 'snapshot_legacy']
      for (const name of fixtures) {
        await writeFile(
          join(sitePackages, `${name}.py`),
          name === 'snapshot_release' ? '__version__ = "1.0.0"' : 'value = 1'
        )
        const metadata = join(sitePackages, `${name}-1.0.dist-info`)
        await mkdir(metadata)
        await writeFile(
          join(metadata, 'METADATA'),
          `Metadata-Version: 2.1\nName: ${name}\nVersion: 1.0\n`
        )
        await writeFile(join(metadata, 'top_level.txt'), `${name}\n`)
        if (name !== 'snapshot_legacy') await writeFile(join(metadata, 'RECORD'), `${name}.py,,\n`)
      }
      const snapshot = {
        schemaVersion: 1 as const,
        sourcePrefix: prefix,
        entries: [],
        observation: {
          runtimeVersion: observed.runtimeVersion,
          packages: [
            ...captured.manifest.packages,
            ...fixtures.map((name): NotebookEnvironmentPackage => ({
              name,
              version: '1.0',
              versionStatus: 'known' as const,
              ecosystem: 'python' as const,
              loadedState: 'loaded' as const,
              evidenceSources: ['python-importlib-metadata', 'python-kernel-modules']
            }))
          ]
        }
      }
      const verify = (): Promise<void> =>
        verifyEnvironmentSnapshot(snapshot, prefix, ([command, ...args]) =>
          execute(command!, args, { signal, timeout: 30_000 }).then((result) => result.stdout)
        )
      await verify()
      await writeFile(join(sitePackages, 'snapshot_release.py'), '__version__ = "1.1"')
      await expect(verify()).rejects.toThrow('loaded module version changed')
      await writeFile(join(sitePackages, 'snapshot_release.py'), '__version__ = "1.0.0"')
      const omitted = snapshot.observation.packages.pop()!
      await expect(verify()).rejects.toThrow('inventory changed')
      snapshot.observation.packages.push(omitted)
      snapshot.observation.packages.push({
        name: 'snapshot_missing',
        version: '1.0',
        versionStatus: 'known',
        ecosystem: 'python',
        evidenceSources: ['python-importlib-metadata']
      })
      await expect(verify()).rejects.toThrow('inventory changed')
      expect((await runtime.shutdown()).reaped).toBe(true)
      runtime = undefined
      const comparison = await executeArtifactReproducibility({
        execution: { ...recipeInput, reproducibilityRecipe: recipe },
        frontierId: 'original-inputs',
        storageRoot,
        processSandbox: passThroughSandbox,
        signal
      })
      expect(comparison).toMatchObject({ matched: true, completedStepIds: ['step:scores'] })
      expect(await readdir(join(storageRoot, '.e'))).toEqual([])
    } finally {
      const reaped = runtime ? (await runtime.shutdown()).reaped : true
      if (reaped) await removeEnvironmentSnapshot(root)
    }
  }
)
