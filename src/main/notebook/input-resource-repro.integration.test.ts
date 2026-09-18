import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import type { NotebookRunInputFile } from '../../shared/notebook'
import { notebookPromptInputPath } from './prompt-input-materialization'
import { startWorkingFileObservation } from './working-file-observer'

const python = process.env.OPEN_SCIENCE_TEST_PYTHON
const r =
  process.env.OPEN_SCIENCE_TEST_R_ENV && join(process.env.OPEN_SCIENCE_TEST_R_ENV, 'bin/Rscript')
const execute = promisify(execFile)
const checksum = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

for (const [language, workflow] of [
  ['python', 'compressed'],
  ['r', 'compressed'],
  ['python', 'plot'],
  ['r', 'plot']
] as const) {
  const command = language === 'python' ? python : r
  it.skipIf(!process.env.RUN_KERNEL || !command)(
    `freezes and replays the ${language} ${workflow} input without unrelated files`,
    async () => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'input-resource-repro-'))
      const sessionRoot = join(storageRoot, 'notebook')
      const dataRoot = join(sessionRoot, 'data')
      try {
        await mkdir(join(dataRoot, 'inputs'), { recursive: true })
        const filename =
          workflow === 'plot' ? 'table.csv' : language === 'python' ? 'table.zip' : 'table.csv.gz'
        let content: Buffer
        if (workflow === 'plot') {
          content = Buffer.from('group,value\nA,1\nA,1\nB,2\n')
        } else if (language === 'python') {
          const archive = join(storageRoot, 'fixture.zip')
          await execute(command!, [
            '-I',
            '-c',
            'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as archive:\n archive.writestr("table.csv", "x\\n1\\n2\\n3\\n")',
            archive
          ])
          content = await readFile(archive)
        } else content = gzipSync('x\n1\n2\n3\n')
        const input: NotebookRunInputFile = {
          sourceKind: 'upload-version',
          sourceFileId: 'input',
          inputFileVersionId: 'input-v1',
          sourceProjectId: 'project',
          sourceSessionId: 'session',
          filename,
          checksum: checksum(content),
          sizeBytes: content.length,
          storageKey: 'uploads/input',
          association: 'turn-attached'
        }
        const path = notebookPromptInputPath(filename, input.checksum)
        await writeFile(join(dataRoot, path), content)
        await writeFile(join(dataRoot, 'inputs/unrelated.csv'), 'x\n999\n')
        const script =
          workflow === 'plot'
            ? language === 'python'
              ? `import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
df = pd.read_csv("${path}").drop_duplicates()
counts = df["group"].value_counts().sort_index()
percent = (counts / counts.sum() * 100).round(1)
result = percent.to_frame(name="percent")
result.to_csv("result.csv")
fig, ax = plt.subplots()
bars = ax.barh(result.index, result["percent"])
ax.bar_label(bars, fmt="%.1f%%")
ax.tick_params(axis="y", labelsize=12)
fig.savefig("plot.png")`
              : `library(ggplot2)
df <- read.csv("${path}")
df <- droplevels(df[complete.cases(df), , drop=FALSE])
counts <- table(df$group)
result <- as.data.frame(prop.table(counts) * 100)
names(result) <- c("group", "percent")
write.csv(result, "result.csv", row.names=FALSE)
p <- ggplot(result, aes(group, percent)) + geom_col() +
  scale_x_discrete(labels=c(A="Alpha", B="Beta")) +
  scale_y_sqrt(breaks=waiver(), expand=expansion(mult=c(0, .1)))
ggsave("plot.png", p, width=6, height=4, dpi=100)`
            : language === 'python'
              ? `from pathlib import Path as P
from zipfile import ZipFile
import pandas as pd
paths = {"selected": P("${path}"), "unused": P("inputs/unrelated.csv")}
with ZipFile(paths["selected"]) as archive:
    with archive.open("table.csv") as stream:
        frame = pd.read_csv(stream)
frame.to_csv("result.csv", index=False)`
              : `connection <- gzcon(file("${path}", "rb"), text=TRUE)
frame <- read.csv(connection)
close(connection)
write.csv(frame, "result.csv", row.names=FALSE)`
        const args = language === 'python' ? ['-I', '-c', script] : ['--vanilla', '-e', script]
        const observation = await startWorkingFileObservation({
          dataRoot,
          notebookSessionRoot: sessionRoot,
          cwd: dataRoot,
          language,
          code: script,
          runId: 'run',
          registeredInputFiles: [input]
        })
        try {
          await execute(command!, args, { cwd: dataRoot, timeout: 30_000 })
        } catch (error) {
          await observation.finish()
          throw error
        }
        const result = await observation.finish()
        expect(result.fileEvidence).toMatchObject({ state: 'available', fileReads: 'complete' })
        expect(result.confirmedReadPaths).toEqual([`data/${path}`])
        const evidence: {
          relations: Array<{
            relativePath: string
            registeredInput?: { inputFileVersionId: string }
            generation: { contentStorageKey: string }
          }>
        } = JSON.parse(await readFile(join(storageRoot, result.fileEvidence.storageKey!), 'utf8'))
        const captured = evidence.relations.filter((relation) => relation.registeredInput)
        expect(captured).toHaveLength(1)
        expect(captured[0]!.registeredInput?.inputFileVersionId).toBe('input-v1')
        expect(
          evidence.relations.some((relation) => relation.relativePath.includes('unrelated'))
        ).toBe(false)
        const replay = join(storageRoot, 'replay')
        const replayInput = join(replay, path)
        await mkdir(dirname(replayInput), { recursive: true })
        await writeFile(
          replayInput,
          await readFile(join(storageRoot, captured[0]!.generation.contentStorageKey))
        )
        await execute(command!, args, { cwd: replay, timeout: 30_000 })
        expect(await readFile(join(replay, 'result.csv'), 'utf8')).toBe(
          await readFile(join(dataRoot, 'result.csv'), 'utf8')
        )
        if (workflow === 'plot') {
          expect(evidence.relations.map((relation) => relation.relativePath)).toEqual(
            expect.arrayContaining(['data/result.csv', 'data/plot.png'])
          )
          expect(checksum(await readFile(join(replay, 'plot.png')))).toBe(
            checksum(await readFile(join(dataRoot, 'plot.png')))
          )
        }
      } finally {
        await rm(storageRoot, { recursive: true, force: true })
      }
    },
    60_000
  )
}
