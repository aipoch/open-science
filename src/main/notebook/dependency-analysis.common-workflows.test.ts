import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { analyzePythonSources } from './dependency-analysis-python'

const commonAnalysisScripts = [
  [
    'r',
    'indexed percentage labels',
    'counts <- c(33, 33)\nfor (i in seq_along(counts)) { pct <- counts[i] / sum(counts) * 100; label <- sprintf("%.1f%%", pct); print(label) }'
  ],
  [
    'r',
    'table row labels',
    'counts <- data.frame(group=c("Ctrl", "IRI"), n=c(33, 33))\nfor (i in seq_len(nrow(counts))) { pct <- counts$n[i] / sum(counts$n) * 100; print(sprintf("%.1f%%", pct)) }'
  ],
  [
    'r',
    'named group labels',
    'counts <- c(Ctrl=33, IRI=33)\nfor (group in names(counts)) { pct <- counts[group] / sum(counts) * 100; print(sprintf("%s %.1f%%", group, pct)) }'
  ],
  [
    'python',
    'percentage table chain',
    'import pandas as pd\ncounts = pd.Series([1, 1, 2]).value_counts()\nresult = (counts / counts.sum() * 100).round(1).to_frame(name="percent")\nprint(result.head())'
  ],
  [
    'python',
    'percentage arithmetic chain',
    'import pandas as pd\ncounts = pd.Series([1, 1, 2]).value_counts()\npercent = (counts / counts.sum() * 100).round(1)\nprint(percent.to_dict())'
  ],
  [
    'python',
    'Series rounding',
    'import pandas as pd\ncounts = pd.Series([1.25, 2.55]).round(1)\nprint(counts.to_dict())'
  ],
  [
    'python',
    'DataFrame deduplication',
    'import pandas as pd\ndf = pd.DataFrame({"g": [1, 1, 2]}).drop_duplicates()\nprint(df.head())'
  ],
  [
    'python',
    'Series to frame',
    'import pandas as pd\ncounts = pd.Series([1, 2]).to_frame(name="n")\nprint(counts.head())'
  ],
  [
    'python',
    'missing data mask',
    'import pandas as pd\ndf = pd.DataFrame({"g": [1, None]})\nmask = df["g"].notna()\nprint(mask.sum())'
  ],
  [
    'python',
    'horizontal bar labels',
    'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nbars = ax.barh(["A", "B"], [1, 2])\nax.bar_label(bars, fmt="%.0f")\nax.tick_params(axis="y", labelsize=12)\nfig.savefig("plot.png")'
  ],
  [
    'python',
    'histogram styling',
    'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.hist([1, 2, 2, 3], bins=3)\nax.set_aspect("auto")\nfig.savefig("plot.png")'
  ],
  [
    'r',
    'table proportions',
    'counts <- table(c("A", "A", "B"))\npercent <- round(prop.table(counts) * 100, 1)\nprint(percent)'
  ],
  [
    'r',
    'missing data filtering',
    'df <- data.frame(x=c(1, NA, 2))\nkeep <- complete.cases(df)\nprint(df[keep, , drop=FALSE])'
  ],
  [
    'r',
    'levels after filtering',
    'df <- data.frame(g=factor(c("A", "B")))\nfiltered <- droplevels(df[1, , drop=FALSE])\nprint(filtered)'
  ],
  [
    'r',
    'discrete axis labels',
    'library(ggplot2)\np <- ggplot(data.frame(g=c("A", "B"), n=c(1, 2)), aes(g, n)) + geom_col() + scale_x_discrete(labels=c(A="Alpha", B="Beta"))\nggsave("plot.png", p)'
  ],
  [
    'r',
    'log axis',
    'library(ggplot2)\np <- ggplot(data.frame(x=1:3, y=c(1, 10, 100)), aes(x, y)) + geom_point() + scale_y_log10()\nggsave("plot.png", p)'
  ],
  [
    'r',
    'explicit scale default',
    'library(ggplot2)\np <- scale_x_continuous(breaks=waiver(), expand=expansion(mult=c(0, .1)))'
  ]
] as const

it('visits a reduction inside arithmetic once', async () => {
  const [facts] = await analyzePythonSources([
    'import pandas as pd\ncounts = pd.Series([1, 2])\npercent = (counts / counts.sum() * 100).round(1)'
  ])
  expect(
    facts.receiverCalls?.filter((call) => call.receiver === 'counts' && call.member === 'sum')
  ).toHaveLength(1)
})

it.each([
  'scale_x_discrete',
  'scale_y_discrete',
  'scale_y_log10',
  'scale_x_reverse',
  'scale_y_sqrt'
])('keeps deferred callbacks opaque for %s', async (scale) => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      `library(ggplot2); p <- ${scale}(labels=function(x) custom_reader())`
    )
  ).toMatchObject({ readState: 'partial' })
})

it.each([
  'scale_x_discrete(NULL, NULL, NULL, custom_labels)',
  'scale_y_log10(labels=custom_labels)'
])('keeps unresolved scale callbacks opaque: %s', async (script) => {
  expect(
    await analyzeNotebookSourceFileAccess('r', `library(ggplot2); p <- ${script}`)
  ).toMatchObject({
    readState: 'partial'
  })
})

it.each(commonAnalysisScripts)('resolves common %s %s', async (language, _name, script) => {
  const root = await mkdtemp(join(tmpdir(), 'common-analysis-'))
  try {
    const run: NotebookRunRecord = {
      runId: 'run',
      cellId: 'cell',
      source: 'agent',
      kernelKind: language,
      kernelEpochId: 'epoch',
      environment: `default-${language}`,
      script,
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: []
    }
    const projection = await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => [run] }
    }).project({ projectId: 'project', sessionId: 'session', completedRun: run })
    expect(projection.stalenessByRunId.run).toEqual({ state: 'clear' })
    expect(await analyzeNotebookSourceFileAccess(language, script)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
