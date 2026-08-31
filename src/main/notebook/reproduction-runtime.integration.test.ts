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

import type { NotebookEnvironmentLock } from '../../shared/notebook'
import { parseCondaPackageNames } from './environment-lock'
import type { NotebookProcessSandbox } from './process-sandbox'
import { micromambaSpawnEnv, normalizeExplicitLock } from './micromamba'
import {
  createNotebookReproductionRuntime,
  type NotebookReproductionStep
} from './reproduction-runtime'
import { pythonBin, rScriptBin } from './runtime-paths'

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
    cleanup: () => undefined
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
