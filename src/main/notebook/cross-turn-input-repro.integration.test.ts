import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import type { NotebookRunInputFile, NotebookRunRecord } from '../../shared/notebook'
import { sealArtifactProvenanceGraph } from '../artifacts/artifact-provenance-graph'
import {
  resolveArtifactReproducibilityExecutionPlan,
  sealArtifactReproducibilityRecipe
} from '../artifacts/artifact-reproducibility-recipe'
import { createRootNotebookLane } from './lane-identity'
import { analyzePythonFileAccesses } from './dependency-analysis-python'
import { notebookPromptInputPath } from './prompt-input-materialization'
import { NotebookRunRepository } from './repository'
import { NotebookRunTerminalizationOwner } from './run-terminalization'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { startWorkingFileObservation } from './working-file-observer'
import { reportedPythonPlots } from './reported-python-plots.fixture'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { reportedSubplots, reportedSubplotsInput } from './reported-python-subplots.fixture'
import { rBasePlots } from './reported-r-base-plots.fixture'

const python = process.env.OPEN_SCIENCE_TEST_PYTHON
const hash = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex')

it.skipIf(!process.env.RUN_KERNEL || !python)(
  'matches input path evaluation by the Python interpreter',
  async () => {
    const expressions = [
      'Path("inputs", "groups.csv")',
      'Path("inputs") / "/data/groups.csv"',
      'Path("inputs").joinpath("/data", "groups.csv")',
      'Path("inputs/groups.csv.bak").with_suffix("")',
      'Path("inputs/.groups").with_suffix(".csv")',
      'Path("inputs/link") / "../groups.csv"',
      'os.path.join("inputs", "/data", "groups.csv")',
      'posixpath.join("inputs", "../groups.csv")',
      String.raw`ntpath.join("C:\\inputs", "\\data", "groups.csv")`,
      String.raw`ntpath.join("C:\\inputs", "D:groups.csv")`,
      String.raw`ntpath.join("C:\\inputs", "c:groups.csv")`,
      String.raw`ntpath.join("\\\\server\\share", "groups.csv")`
    ]
    const imports = 'from pathlib import Path\nimport os, posixpath, ntpath, json'
    const { stdout } = await promisify(execFile)(python!, [
      '-I',
      '-c',
      `${imports}\nprint(json.dumps([str(value) for value in [${expressions.join(',')}]]))`
    ])
    const expected: string[] = JSON.parse(stdout)
    for (const [index, expression] of expressions.entries()) {
      const [result] = await analyzePythonFileAccesses([`${imports}\nopen(${expression})`])
      expect(result?.reads, expression).toEqual([expected[index]])
    }
  }
)

for (const [language, reportedPlots] of [
  ['python', false],
  ['r', false],
  ['r', 'base-plots'],
  ['python', true],
  ['python', 'nested-subplots']
] as const) {
  const command =
    language === 'python'
      ? python
      : process.env.OPEN_SCIENCE_TEST_R_ENV
        ? join(process.env.OPEN_SCIENCE_TEST_R_ENV, 'bin/Rscript')
        : undefined
  const args = (script: string): string[] =>
    language === 'r' ? ['--vanilla', '-e', script] : ['-I', '-c', script]
  it.skipIf(!process.env.RUN_KERNEL || !command)(
    `replays the third ${language} plot${reportedPlots === 'base-plots' ? ' with base graphics annotations' : reportedPlots === 'nested-subplots' ? ' with nested subplots' : reportedPlots ? ' with reported sorting and labels' : ''} using an earlier upload without reattaching it, including after reopening the repository`,
    async () => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'cross-turn-plot-'))
      const execute = promisify(execFile)
      const session = {
        projectId: 'project',
        sessionId: 'session',
        lane: createRootNotebookLane('project', 'session', 'root')
      }
      const repository = new NotebookRunRepository(storageRoot)
      try {
        const document = await repository.loadOrCreate({ ...session, workspaceCwd: storageRoot })
        const content = 'group\n' + 'Ctrl\n'.repeat(33) + 'IRI\n'.repeat(33)
        const input: NotebookRunInputFile = {
          sourceKind: 'upload-version',
          sourceFileId: 'groups',
          inputFileVersionId: 'groups-v1',
          sourceProjectId: 'project',
          sourceSessionId: 'session',
          filename: 'groups.csv',
          checksum: hash(content),
          sizeBytes: Buffer.byteLength(content),
          storageKey: 'uploads/groups.csv',
          association: 'turn-attached'
        }
        const inputPath = notebookPromptInputPath(input.filename, input.checksum)
        const scripts =
          reportedPlots === 'nested-subplots'
            ? [
                'print("ready")',
                reportedSubplotsInput.replace('inputs/sample-groups-666666666666.csv', inputPath),
                reportedSubplots
                  .replace('inputs/sample-groups-666666666666.csv', inputPath)
                  .replaceAll('synthetic_groups_group_plots.png', 'group_bar.png')
              ]
            : reportedPlots === 'base-plots'
              ? [
                  'print("ready")',
                  `df <- read.csv("${inputPath}"); print(table(df$group))`,
                  rBasePlots
                    .replace('inputs/sample-groups-666666666666.csv', inputPath)
                    .replaceAll('synthetic_groups_group1_bar_r.png', 'group_bar.png')
                ]
              : reportedPlots
                ? reportedPythonPlots(inputPath)
                : language === 'r'
                  ? [
                      'library(ggplot2)\nx <- seq(0, 2*pi, length.out=400)\np <- ggplot(data.frame(x=x, y=sin(x)), aes(x=x, y=y)) + geom_line()\nggsave("sin_wave.png", p, width=7, height=4.5, dpi=150)',
                      `library(ggplot2)
df <- read.csv("${inputPath}")
counts <- as.data.frame(table(df$group))
names(counts) <- c("group", "n")
p <- ggplot(counts, aes(x="", y=n, fill=group)) +
  geom_col(width=1) + coord_polar(theta="y") + theme_void()
ggsave("group_pie.png", p, width=5.5, height=5.5, dpi=150)`,
                      `library(ggplot2)
files <- list(groups = "${inputPath}", unused = "inputs/unrelated.csv")
path <- files[["groups"]]
df <- read.csv(path)
counts <- as.data.frame(table(df$group))
names(counts) <- c("group", "n")
p <- ggplot(counts, aes(x=group, y=n, fill=group)) +
  geom_col(width=0.6, color="white") +
  geom_text(aes(label=n), vjust=-0.5) +
  scale_fill_manual(values=c(Ctrl="#4C72B0", IRI="#DD8452")) +
  labs(title="Sample count per group (SYNTHETIC_GROUPS)", x="Group", y="Number of samples") +
  ylim(0, max(counts$n) * 1.2) + theme_minimal()
ggsave("group_bar.png", p, width=6, height=4.5, dpi=150)
cat("saved group_bar.png\\n")`
                    ]
                  : [
                      'import numpy as np\nimport matplotlib.pyplot as plt\nx = np.linspace(0, 2*np.pi, 400)\nfig, ax = plt.subplots()\nax.plot(x, np.sin(x))\nfig.savefig("sin_wave.png")',
                      `import pandas as pd\nimport matplotlib.pyplot as plt\ndf = pd.read_csv("${inputPath}")\ncounts = df["group"].value_counts()\nfig, ax = plt.subplots()\nax.pie(counts.values, labels=counts.index)\nfig.savefig("group_pie.png")`,
                      `import pandas as pd
import matplotlib.pyplot as plt
from pathlib import Path
df = pd.read_csv(Path("inputs", "${inputPath.slice('inputs/'.length)}"))
counts = df["group"].value_counts()
fig, ax = plt.subplots(figsize=(6, 4.5))
colors = ["#4C72B0", "#DD8452"]
bars = ax.bar(counts.index, counts.values, color=colors, edgecolor="white", linewidth=1.5)
for bar, value in zip(bars, counts.values):
    ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.5,
            str(int(value)), ha="center", va="bottom", fontsize=12)
ax.set_title("Sample count per group (SYNTHETIC_GROUPS)")
ax.set_xlabel("Group")
ax.set_ylabel("Number of samples")
ax.set_ylim(0, max(counts.values) * 1.2)
ax.grid(axis="y", alpha=0.3)
ax.set_axisbelow(True)
fig.tight_layout()
fig.savefig("group_bar.png", dpi=150)
print("saved group_bar.png")`
                    ]
        const activities: Array<{
          run: NotebookRunRecord
          runIndex: number
          evidenceJson: string
        }> = []
        for (const [index, script] of scripts.entries()) {
          expect(await analyzeNotebookSourceFileAccess(language, script)).toMatchObject({
            readState: 'complete',
            writeState: 'complete',
            externalState: 'complete',
            reads: index === 0 ? [] : [inputPath],
            reasonCodes: []
          })
          if (index === 1) {
            for (const path of [
              join(document.dataRoot, inputPath),
              join(storageRoot, input.storageKey)
            ]) {
              await mkdir(dirname(path), { recursive: true })
              await writeFile(path, content)
            }
            await writeFile(join(document.dataRoot, 'inputs/unrelated.csv'), 'unused\n')
          }
          const running: NotebookRunRecord = {
            runId: 'run-' + index,
            cellId: 'cell-' + index,
            kernelKind: language,
            kernelEpochId: 'epoch',
            kernelDispatched: true,
            source: 'agent',
            script,
            status: 'running',
            startedAt: index,
            cwdBefore: document.dataRoot,
            messageBranchId: 'branch',
            promptMessageId: 'prompt-' + index,
            text: { stdout: '', stderr: '', traceback: '', plain: [] },
            outputs: [],
            workingFiles: [],
            inputFiles: index === 1 ? [input] : []
          }
          const owner = new NotebookRunTerminalizationOwner({
            // A new repository instance on every turn exercises durable history, not registry memory.
            repository: new NotebookRunRepository(storageRoot),
            notifyChanged: () => undefined
          })
          const { run } = await owner.run({
            session,
            runningRun: running,
            invoke: async () => {
              const observer = await startWorkingFileObservation({
                dataRoot: document.dataRoot,
                notebookSessionRoot: document.notebookSessionRoot,
                cwd: document.dataRoot,
                code: script,
                language,
                runId: running.runId,
                registeredInputFiles: running.inputFiles
              })
              const execution = await execute(command!, args(script), {
                cwd: document.dataRoot,
                timeout: 30_000,
                env: { ...process.env, MPLBACKEND: 'Agg', MPLCONFIGDIR: join(storageRoot, 'mpl') }
              })
              return {
                status: 'completed',
                stdout: execution.stdout,
                stderr: execution.stderr,
                traceback: '',
                cwdAfter: document.dataRoot,
                outputs: [],
                ...(await observer.finish())
              }
            }
          })
          activities.push({
            run,
            runIndex: index,
            evidenceJson: await readFile(
              join(dirname(document.notebookSessionRoot), run.fileEvidence!.storageKey!),
              'utf8'
            )
          })
        }
        const producer = activities[2]!.run
        if (reportedPlots) {
          const projection = await new NotebookDependencyAnalyzer({
            storageRoot,
            repository: { readSessionRuns: async () => activities.map(({ run }) => run) }
          }).project({
            projectId: session.projectId,
            sessionId: session.sessionId,
            completedRun: producer,
            interpreter: { command: command! }
          })
          expect(projection.stalenessByRunId).toEqual({
            'run-0': { state: 'clear' },
            'run-1': { state: 'clear' },
            'run-2': { state: 'clear' }
          })
          expect(projection.dependenciesByRunId).toEqual({ 'run-0': [], 'run-1': [], 'run-2': [] })
        }
        expect(producer.inputFiles).toEqual([
          expect.objectContaining({
            inputFileVersionId: input.inputFileVersionId,
            accessEvidence: 'file-evidence'
          })
        ])
        const output = producer.workingFiles.find(
          (file) => file.relativePath === 'data/group_bar.png'
        )!
        const graph = sealArtifactProvenanceGraph({
          target: {
            versionId: 'version-bar',
            filename: 'group_bar.png',
            checksum: output.checksum!,
            sizeBytes: output.size!,
            producerRunId: producer.runId,
            sourceGenerationId: output.generationId
          },
          notebookActivities: activities,
          computeActivities: []
        })
        expect(graph.completeness).toBe('complete')
        expect(graph.edges).toContainEqual(
          expect.objectContaining({
            kind: 'used',
            activityId: producer.runId,
            authority: 'authoritative'
          })
        )
        const recipe = sealArtifactReproducibilityRecipe({
          provenanceGraph: graph,
          inputFiles: producer.inputFiles ?? [],
          runs: activities.map(({ run, runIndex }) => ({
            runId: run.runId,
            runIndex,
            agentFrameId: 'agent',
            messageBranchId: 'branch',
            runtimeSegmentId: 'runtime',
            promptMessageId: 'prompt-' + runIndex,
            kernelEpochId: 'epoch',
            kernelKind: language,
            environmentName: `default-${language}`,
            // This regression isolates file lineage; native lock capture/restoration has separate tests.
            environmentLock: {
              state: 'available',
              format: 'environment-lock-bundle',
              lockChecksum: 'a'.repeat(64)
            },
            script: run.script,
            status: 'completed',
            startedAt: '2026-09-05T00:00:00.000Z',
            completedAt: '2026-09-05T00:00:01.000Z',
            outputs: [],
            inputFileVersionKeys: []
          }))
        })
        const plan = resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')
        expect(recipe.capture).toEqual({ state: 'sealed', reasonCodes: [] })
        expect(plan?.steps.map((step) => step.activityId)).toEqual([producer.runId])
        expect(plan?.frontier.crossingFiles).toHaveLength(1)
        const replay = join(storageRoot, 'replay')
        for (const file of plan!.frontier.crossingFiles) {
          const destination = join(replay, file.materializationPath)
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, await readFile(join(storageRoot, file.contentStorageKey)))
        }
        await execute(command!, args(scripts[2]!), {
          cwd: replay,
          timeout: 30_000,
          env: { ...process.env, MPLBACKEND: 'Agg', MPLCONFIGDIR: join(storageRoot, 'mpl') }
        })
        expect(hash(await readFile(join(replay, 'group_bar.png')))).toBe(output.checksum)
        // A historical registration must not certify bytes changed in the working input copy.
        await writeFile(join(document.dataRoot, inputPath), content + 'Ctrl\n')
        const changed: NotebookRunRecord = {
          ...producer,
          runId: 'run-changed',
          startedAt: 3,
          status: 'running',
          inputFiles: [],
          fileEvidence: undefined,
          workingFiles: []
        }
        const checked = await new NotebookRunTerminalizationOwner({
          repository: new NotebookRunRepository(storageRoot),
          notifyChanged: () => undefined
        }).run({
          session,
          runningRun: changed,
          invoke: async () => {
            const observer = await startWorkingFileObservation({
              dataRoot: document.dataRoot,
              notebookSessionRoot: document.notebookSessionRoot,
              cwd: document.dataRoot,
              code: changed.script,
              language,
              runId: changed.runId,
              registeredInputFiles: changed.inputFiles
            })
            const execution = await execute(command!, args(changed.script), {
              cwd: document.dataRoot,
              timeout: 30_000,
              env: { ...process.env, MPLBACKEND: 'Agg', MPLCONFIGDIR: join(storageRoot, 'mpl') }
            })
            return {
              status: 'completed',
              stdout: execution.stdout,
              stderr: execution.stderr,
              traceback: '',
              outputs: [],
              ...(await observer.finish())
            }
          }
        })
        expect(checked.run.inputFiles).toEqual([])
        expect(checked.run.fileEvidence?.state).not.toBe('available')
      } finally {
        await rm(storageRoot, { recursive: true, force: true })
      }
    },
    60_000
  )
}
