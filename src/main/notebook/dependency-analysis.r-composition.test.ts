import { describe, expect, it } from 'vitest'
import { analyzeRSources } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

import { combinedPlot } from './reported-r-composition.fixture'

describe('reported R plot composition', () => {
  it.each([
    'has_package <- requireNamespace("cowplot", quietly = TRUE)',
    'value <- patchwork::plot_annotation(title = "Combined")',
    'value <- patchwork::plot_layout(guides = "collect")',
    'pkg <- "patchwork"; has_package <- base::requireNamespace(quietly = TRUE, package = pkg)',
    'has_package <- requireNamespace(quietly = TRUE, "gridExtra")',
    'has_package <- requireNamespace("ggplot2", TRUE)',
    'pie_plot <- ggplot2::ggplot(); bar_plot <- ggplot2::ggplot(); third_plot <- ggplot2::ggplot(); combined <- (pie_plot | bar_plot) / third_plot & ggplot2::theme(legend.position = "bottom")',
    combinedPlot
  ])('captures dependency and file evidence: %s', async (script) => {
    const facts = (await analyzeRSources([script]))[0]
    expect(facts?.state === 'unknown' ? facts.reasons : []).toEqual(
      script === combinedPlot ? ['external-state'] : []
    )
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reasonCodes: []
    })
  })

  it('captures the CSV and the combined PNG', async () => {
    expect(await analyzeNotebookSourceFileAccess('r', combinedPlot)).toMatchObject({
      reads: ['inputs/sample-groups-666666666666.csv'],
      writes: ['synthetic_groups_group_combined.png'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it.each([
    'requireNamespace(package_name, quietly = TRUE)',
    'requireNamespace("unknownExtension", quietly = TRUE)',
    'requireNamespace("ggplot2", lib.loc = "custom-library")',
    'requireNamespace <- custom_probe; requireNamespace("ggplot2")',
    'custom::requireNamespace("ggplot2")',
    'plot_layout <- custom_layout; plot_layout(ncol = 2)',
    'custom::plot_annotation(title = "Combined")',
    'patchwork::plot_annotation(title = custom_title())',
    'patchwork::plot_layout(widths = function() read.csv("hidden.csv"))'
  ])('keeps unresolved namespaces and constructor effects conservative: %s', async (script) => {
    expect((await analyzeNotebookSourceFileAccess('r', script)).readState).toBe('partial')
  })

  it('continues traversing file reads inside layout arguments', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'patchwork::plot_annotation(title = readLines("title.txt"))'
      )
    ).toMatchObject({
      reads: ['title.txt']
    })
  })

  it('keeps all plot operands as dependencies of nested composition', async () => {
    const [facts] = await analyzeRSources([
      'combined <- (pie_plot | bar_plot) / third_plot & ggplot2::theme(legend.position = "bottom")'
    ])
    expect(facts).toMatchObject({ state: 'available' })
    expect(facts?.priorUsedNames).toEqual(
      expect.arrayContaining(['pie_plot', 'bar_plot', 'third_plot'])
    )
  })
})
