import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

import additionalWorkflows from './omics-workflows.fixture.json'

const workflows = [
  ...additionalWorkflows.map((workflow) => ({ ...workflow, language: 'python' as const })),
  {
    name: 'microbial abundance and diversity',
    consumed: ['community'],
    states: [
      ['partial', 'partial', 'partial'],
      ['partial', 'complete', 'complete'],
      ['partial', 'complete', 'complete']
    ],
    language: 'r' as const,
    cells: [
      `library(phyloseq)
library(ggplot2)
counts <- read.csv("inputs/asv-counts.csv", row.names = 1, check.names = FALSE)
taxonomy <- read.csv("inputs/taxonomy.csv", row.names = 1, check.names = FALSE)
metadata <- read.csv("inputs/sample-metadata.csv", row.names = 1)
shared_samples <- intersect(colnames(counts), rownames(metadata))
counts <- as.matrix(counts[, shared_samples, drop = FALSE])
taxonomy <- as.matrix(taxonomy[rownames(counts), , drop = FALSE])
metadata <- metadata[shared_samples, , drop = FALSE]
community <- phyloseq(otu_table(counts, taxa_are_rows = TRUE),
                      tax_table(taxonomy), sample_data(metadata))`,
      `diversity <- estimate_richness(community, measures = c("Observed", "Shannon"))
filtered <- prune_taxa(taxa_sums(community) > 5, community)
relative <- transform_sample_counts(filtered, function(values) values / sum(values))
ordination <- ordinate(relative, method = "PCoA", distance = "bray")
plot <- plot_ordination(relative, ordination, color = "group") + geom_point(size = 3)
write.csv(diversity, "outputs/alpha-diversity.csv")
saveRDS(relative, "outputs/relative-abundance.rds")
ggsave("outputs/beta-diversity.png", plot, width = 7, height = 5)`,
      `relative_copy <- readRDS("outputs/relative-abundance.rds")
abundance <- as.data.frame(otu_table(relative_copy))
write.csv(abundance, "outputs/abundance-matrix.csv")`
    ],
    reads: [
      ['inputs/asv-counts.csv', 'inputs/sample-metadata.csv', 'inputs/taxonomy.csv'],
      [],
      ['outputs/relative-abundance.rds']
    ],
    writes: [
      [],
      [
        'outputs/alpha-diversity.csv',
        'outputs/beta-diversity.png',
        'outputs/relative-abundance.rds'
      ],
      ['outputs/abundance-matrix.csv']
    ]
  },
  {
    name: 'mass spectrometry peak detection and grouping',
    consumed: ['peaks', 'sample_groups'],
    states: [
      ['partial', 'partial', 'partial'],
      ['partial', 'partial', 'partial'],
      ['complete', 'complete', 'complete']
    ],
    language: 'r' as const,
    cells: [
      `library(MSnbase)
library(xcms)
raw_files <- c("inputs/control-a.mzML", "inputs/control-b.mzML", "inputs/treated-a.mzML", "inputs/treated-b.mzML")
sample_groups <- c("control", "control", "treated", "treated")
raw <- readMSData(files = raw_files, mode = "onDisk")
ms1 <- filterMsLevel(raw, msLevel = 1L)
window <- filterRt(ms1, rt = c(60, 600))
parameters <- CentWaveParam(ppm = 15, peakwidth = c(5, 30), snthresh = 10)
peaks <- findChromPeaks(window, param = parameters)`,
      `aligned <- adjustRtime(peaks, param = ObiwarpParam(binSize = 1))
grouping <- PeakDensityParam(sampleGroups = sample_groups, minFraction = 0.5, bw = 5)
grouped <- groupChromPeaks(aligned, param = grouping)
filled <- fillChromPeaks(grouped)
intensity <- featureValues(filled, value = "into")
features <- featureDefinitions(filled)
write.csv(intensity, "outputs/feature-intensities.csv")
write.csv(as.data.frame(features), "outputs/feature-definitions.csv")
saveRDS(filled, "outputs/processed-spectra.rds")`,
      `matrix <- read.csv("outputs/feature-intensities.csv", row.names = 1)
keep <- rowSums(is.na(matrix)) <= 1
complete <- matrix[keep, , drop = FALSE]
write.csv(complete, "outputs/filtered-intensities.csv")`
    ],
    reads: [
      [
        'inputs/control-a.mzML',
        'inputs/control-b.mzML',
        'inputs/treated-a.mzML',
        'inputs/treated-b.mzML'
      ],
      [],
      ['outputs/feature-intensities.csv']
    ],
    writes: [
      [],
      [
        'outputs/feature-definitions.csv',
        'outputs/feature-intensities.csv',
        'outputs/processed-spectra.rds'
      ],
      ['outputs/filtered-intensities.csv']
    ]
  },
  {
    name: 'clinical cohort harmonization and stratified summary',
    consumed: ['cohort'],
    states: [
      ['complete', 'complete', 'complete'],
      ['complete', 'complete', 'complete'],
      ['complete', 'complete', 'complete']
    ],
    language: 'python' as const,
    cells: [
      `from pathlib import Path
import pyreadstat as prs
import pandas as pd
source = Path("inputs") / "cohort.sav"
raw, metadata = prs.read_sav(filename_path=source, output_format="pandas")
cohort = pd.DataFrame(raw)
followup = pd.read_csv("inputs/followup.csv")
cohort = cohort.merge(followup, on="participant_id", how="inner")
cohort = cohort.loc[cohort["age"] >= 18].copy()
cohort["event"] = cohort["event"].fillna(0)`,
      `summary = cohort.groupby("treatment").agg(participants=("participant_id", "count"), mean_age=("age", "mean"), events=("event", "sum"))
summary.to_csv("outputs/stratified-summary.csv")
prs.write_sav(cohort, dst_path="outputs/analysis-cohort.sav")`,
      `exported, export_metadata = prs.read_sav(filename_path="outputs/analysis-cohort.sav")
analysis = pd.DataFrame(exported)
analysis.to_csv("outputs/analysis-cohort.csv", index=False)`
    ],
    reads: [
      [join('inputs', 'cohort.sav'), 'inputs/followup.csv'].sort(),
      [],
      ['outputs/analysis-cohort.sav']
    ],
    writes: [
      [],
      ['outputs/analysis-cohort.sav', 'outputs/stratified-summary.csv'],
      ['outputs/analysis-cohort.csv']
    ]
  }
]

it.each(workflows)('tracks input, output and cell dependencies: $name', async (workflow) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'omics-lineage-'))
  const runs: NotebookRunRecord[] = workflow.cells.map((script, index) => ({
    runId: String(index),
    cellId: String(index),
    script,
    kernelKind: workflow.language,
    kernelEpochId: 'epoch',
    environment: workflow.language,
    source: 'agent',
    status: 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }))
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: async () => runs }
    })
    const projection = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '2' })
    if (workflow.name === 'clinical cohort harmonization and stratified summary')
      expect(projection.dependenciesByRunId?.['1']).toContain('0')
    else {
      // Opaque package calls and unmodeled values currently prevent a reliable graph.
      expect(projection.stalenessByRunId['1']?.state).toBe('unknown')
      expect(projection.stalenessByRunId['1']).toMatchObject({
        reasons: expect.arrayContaining(['opaque-call'])
      })
    }
    const analyze = workflow.language === 'r' ? analyzeRNotebookSource : analyzePythonNotebookSource
    const { facts } = await analyze(workflow.cells[1]!)
    expect(facts.usedNames).toEqual(expect.arrayContaining(workflow.consumed))
    for (const [index, run] of runs.entries()) {
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: run.runId,
        language: workflow.language,
        environment: workflow.language,
        kernelEpochId: 'epoch'
      })
      const access = await analyzeNotebookSourceFileAccess(workflow.language, run.script, context)
      expect(access.reads).toEqual(workflow.reads[index])
      expect(access.writes).toEqual(workflow.writes[index])
      expect([access.readState, access.writeState, access.externalState]).toEqual(
        workflow.states[index]
      )
    }
  } finally {
    await rm(storageRoot, { recursive: true, force: true })
  }
})

it.each(['pandas', 'polars', 'dict'])(
  'does not assign a DataFrame type to a pyreadstat tuple (%s)',
  async (format) => {
    const { facts } = await analyzePythonNotebookSource(`import pyreadstat
result = pyreadstat.read_sav(filename_path="inputs/cohort.sav", output_format="${format}")`)
    expect(facts.typeBindings?.find((binding) => binding.target === 'result')?.typeName).not.toBe(
      'pandas.DataFrame'
    )
  }
)

it('keeps uncertainty after mutation of an opaque multiomics object', async () => {
  const source = `import muon as mu
import torch
import pandas as pd
mdata = mu.read_10x_h5("inputs/multiome.h5")
labels = pd.read_csv("inputs/cell_labels.csv")
mdata.obs = mdata.obs.join(labels.set_index("cell_id"))
torch.save(mdata.obs["label"].to_numpy(), "outputs/labels.pt")
mdata.write("outputs/multiome.h5mu")`
  const access = await analyzeNotebookSourceFileAccess('python', source)
  expect(access).toMatchObject({
    reads: ['inputs/cell_labels.csv', 'inputs/multiome.h5'],
    writes: ['outputs/labels.pt'],
    externalState: 'partial'
  })
  // The opaque property setter invalidates the receiver namespace. The checkpoint
  // remains uncaptured; external uncertainty must prevent a complete-capture claim.
  expect(access.writes).not.toContain('outputs/multiome.h5mu')
})

it.each([
  ['muon.read_10x_h5("inputs/multiome.h5")', ['inputs/multiome.h5']],
  ['muon.read_10x_h5("inputs/multiome.h5", extended=enabled)', ['inputs/multiome.h5']],
  ['muon.read_10x_mtx("inputs/matrix")', []]
])('keeps unresolved multiomics companions visible: %s', async (expression, reads) => {
  expect(
    await analyzeNotebookSourceFileAccess('python', `import muon\nvalue = ${expression}`)
  ).toMatchObject({
    reads,
    readState: 'partial',
    externalState: 'partial'
  })
})

it.each(['r', 'rb', 'w', 'wb', 'wz'])('respects the variant file mode %s', async (mode) => {
  const reading = mode.startsWith('r')
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      `import pysam
handle = pysam.VariantFile("data/variants.bcf", mode="${mode}", index_filename="data/variants.csi", header=header)`
    )
  ).toMatchObject({
    reads: reading ? ['data/variants.bcf', 'data/variants.csi'] : [],
    writes: reading ? [] : ['data/variants.bcf'],
    externalState: 'partial'
  })
})

it('keeps a dynamic variant mode unresolved', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      `from pysam import VariantFile
handle = VariantFile("data/variants.bcf", mode=mode)`
    )
  ).toMatchObject({
    reads: [],
    writes: [],
    readState: 'partial',
    writeState: 'partial'
  })
})

it('does not invent partition files for deferred parquet output', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      `import dask.dataframe as dd
frame = dd.read_parquet("inputs/partitions")
job = frame.to_parquet("outputs/partitions", compute=False)`
    )
  ).toMatchObject({
    reads: ['inputs/partitions'],
    writes: [],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('retains uncertainty about FASTA indexes and mutable access', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      `from pyfaidx import Fasta
reference = Fasta("inputs/reference.fa", mutable=True)`
    )
  ).toMatchObject({
    reads: ['inputs/reference.fa'],
    writes: [],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('does not borrow a clinical reader from an unrelated namespace', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      `import custom
result = custom.read_sav("inputs/cohort.sav")`
    )
  ).toMatchObject({ reads: [], externalState: 'partial' })
})
