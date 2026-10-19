import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from '../../src/index'
import { rThemePlots } from '../../src/reported-r-theme-plots.fixture'
const dataMaskPipelineSource = `
library(dplyr)
library(ggplot2)
df <- read.csv("inputs/counts.csv")
counts <- count(df, group)
factor <- 2
counts <- mutate(counts, across(where(is.numeric), ~ .x / factor))
p <- ggplot(counts, aes(group, n)) + geom_col(data = ~ .x) +
  geom_errorbar(aes(ymin = n - 0.1, ymax = n + 0.1), width = 0.2)
write.csv(counts, "counts.csv", row.names = FALSE)
ggsave("counts.png", p, width = 6, height = 4, dpi = 100)
`

it.each([
  {
    name: 'dplyr and ggplot2 pipeline',
    code: dataMaskPipelineSource,
    inputName: 'counts.csv',
    outputNames: ['counts.csv', 'counts.png']
  },
  {
    name: 'reported theme dimensions and two plots',
    code: rThemePlots,
    inputName: 'sample-groups-666666666666.csv',
    outputNames: ['synthetic_groups_bar_ggplot.png', 'synthetic_groups_pie_ggplot.png']
  },
  {
    name: 'theme variants, grid units, legends and transparent colours',
    code: rThemePlots
      .replace('p_pie <-', 'cols <- scales::alpha(cols, 0.8)\np_pie <-')
      .replaceAll('theme_minimal', 'theme_dark')
      .replaceAll('margin(10, 10, 10, 10)', 'margin_auto(10)')
      .replaceAll(
        'legend.position = "right"',
        'legend.position = "right", legend.key.size = grid::unit(5, "mm")'
      )
      .replaceAll(
        'scale_fill_manual(values = cols)',
        'scale_fill_manual(values = cols, guide = guide_legend(nrow = 2))'
      ),
    inputName: 'sample-groups-666666666666.csv',
    outputNames: ['synthetic_groups_bar_ggplot.png', 'synthetic_groups_pie_ggplot.png']
  }
])(
  'captures and replays the real $name',
  async ({ code, inputName, outputNames }) => {
    const root = await mkdtemp(join(tmpdir(), 'r-evaluation-pipeline-'))
    try {
      const content = `group\n${Array(33).fill('Ctrl\nIRI\n').join('')}`
      const run = async (directory: string): Promise<string[]> => {
        const dataRoot = join(directory, 'data')
        await mkdir(join(dataRoot, 'inputs'), { recursive: true })
        await writeFile(join(dataRoot, 'inputs', inputName), content)
        const analysis = await analyzeNotebookSourceFileAccess('r', code)
        expect(analysis).toMatchObject({ readState: 'complete', writeState: 'complete' })
        expect(analysis.reads).toEqual([`inputs/${inputName}`])
        expect(analysis.writes.slice().sort()).toEqual(outputNames.slice().sort())
        const scriptPath = join(directory, 'analysis.R')
        await writeFile(scriptPath, code)
        const execution = spawnSync(
          process.env.OPEN_SCIENCE_TEST_R_COMMAND!,
          ['--vanilla', scriptPath],
          {
            cwd: dataRoot,
            encoding: 'utf8',
            timeout: 30000
          }
        )
        expect(execution.error).toBeUndefined()
        expect(execution.status, execution.stderr).toBe(0)
        return Promise.all(
          outputNames.map(async (file) =>
            createHash('sha256')
              .update(await readFile(join(dataRoot, file)))
              .digest('hex')
          )
        )
      }
      const original = await run(join(root, 'original'))
      expect(await run(join(root, 'replay'))).toEqual(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60000
)
