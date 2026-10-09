import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import {
  NotebookDependencyAnalyzer,
  type NotebookDependencyInterpreter
} from './dependency-analysis'
import { analyzePythonNotebookSource, analyzePythonSources } from './dependency-analysis-python'
import { analyzeRNotebookSource, analyzeRSources } from './dependency-analysis-r'
import { projectNotebookDependencies } from './dependency-projection'
import { projectNotebookFileContext, type FileContextEntry } from './dependency-file-context'
import { normalizeNotebookSourceFileAccess } from './source-file-access-analysis'
import type {
  NotebookDependencyTypeSummary,
  NotebookRunDependencyFacts
} from './dependency-analysis-types'

const unusedInterpreter = (kernelKind: 'python' | 'r'): NotebookDependencyInterpreter => ({
  command: kernelKind === 'python' ? 'unused-python' : 'unused-rscript'
})

const temporaryRoots: string[] = []

// Insert only at the outer function body; nested bodies must stay unchanged.
const prependFunctionBody = (source: string, statements: string): string => {
  const opening = source.indexOf('{')
  if (opening < 0) throw new Error('Expected a function body in the regression source')
  return source.slice(0, opening + 1) + '\n' + statements + source.slice(opening + 1)
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })))
})

const completedRun = (
  runId: string,
  cellId: string,
  kernelKind: 'python' | 'r',
  script: string
): NotebookRunRecord => ({
  runId,
  cellId,
  source: 'agent',
  inputKind: 'cell',
  kernelKind,
  kernelEpochId: 'epoch-1',
  environment: kernelKind === 'python' ? 'default-python' : 'default-r',
  script,
  status: 'completed',
  startedAt: 1,
  endedAt: 1,
  executionCount: 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  inputFiles: []
})

const projectScripts = async (
  kernelKind: 'python' | 'r',
  scripts: string[],
  storagePrefix: string
): Promise<Awaited<ReturnType<NotebookDependencyAnalyzer['project']>>> => {
  const storageRoot = await mkdtemp(join(tmpdir(), storagePrefix))
  temporaryRoots.push(storageRoot)
  const runs: NotebookRunRecord[] = []
  const analyzer = new NotebookDependencyAnalyzer({
    storageRoot,
    repository: { readSessionRuns: vi.fn(async () => runs) }
  })
  let projection: Awaited<ReturnType<NotebookDependencyAnalyzer['project']>> | undefined
  for (const [index, script] of scripts.entries()) {
    const run = {
      ...completedRun(`run-${index + 1}`, `cell-${index + 1}`, kernelKind, script),
      startedAt: index + 1,
      endedAt: index + 1,
      executionCount: index + 1
    }
    runs.push(run)
    projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun: run,
      interpreter: unusedInterpreter(kernelKind)
    })
  }
  if (!projection) throw new Error('projectScripts requires at least one script')
  return projection
}

it('links a local fsspec input into a downstream scientific cell', async () => {
  const projection = await projectScripts(
    'python',
    [
      "import fsspec\nwith fsspec.open('inputs/measurements.csv', 'rt') as handle:\n    text = handle.read()",
      "import pandas as pd\nframe = pd.DataFrame({'text': [text]})\nframe.to_parquet('outputs/measurements.parquet')"
    ],
    'notebook-fsspec-lineage-'
  )

  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
})

it('propagates a Seurat object across multi-cell analysis steps', async () => {
  const scripts = [
    'counts <- Seurat::Read10X_h5("inputs/pbmc.h5")\nobj <- Seurat::CreateSeuratObject(counts)',
    'obj <- Seurat::NormalizeData(obj, normalization.method = "LogNormalize")',
    'obj <- Seurat::FindVariableFeatures(obj, nfeatures = 2000)',
    'obj <- Seurat::RunPCA(obj, npcs = 30)',
    'obj <- Seurat::FindNeighbors(obj, dims = 1:20)',
    'obj <- Seurat::FindClusters(obj, resolution = 0.5)',
    'SeuratDisk::SaveH5Seurat(obj, filename = "outputs/pbmc.h5seurat")'
  ]
  const projection = await projectScripts('r', scripts, 'notebook-seurat-lineage-')
  const first = await analyzeRNotebookSource(scripts[0])
  const pca = await analyzeRNotebookSource(`${scripts[0]}\n${scripts[3]}`)

  expect(first.facts.typeBindings).toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'obj', typeName: 'Seurat' })])
  )
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projection.dependenciesByRunId?.['run-4']).toContain('run-3')
  expect(projection.dependenciesByRunId?.['run-6']).toContain('run-5')
  expect(projection.dependenciesByRunId?.['run-7']).toContain('run-6')
  expect(pca.facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
})

it('keeps Seurat integration anchors and marker tables distinct from the object', async () => {
  const scripts = [
    'obj <- Seurat::CreateSeuratObject(counts)',
    'anchors <- Seurat::FindIntegrationAnchors(object.list = list(obj, obj), dims = 1:20)',
    'integrated <- Seurat::IntegrateData(anchors)',
    'markers <- Seurat::FindAllMarkers(integrated, only.pos = TRUE)'
  ]
  const projection = await projectScripts('r', scripts, 'notebook-seurat-integration-lineage-')
  const entry = await analyzeRNotebookSource(scripts.join('\n'))
  const bindings = entry.facts.typeBindings

  expect(bindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'anchors', typeName: 'SeuratIntegrationAnchorSet' }),
      expect.objectContaining({ target: 'integrated', typeName: 'Seurat' }),
      expect.objectContaining({ target: 'markers', typeName: 'data.frame' })
    ])
  )
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projection.dependenciesByRunId?.['run-3']).toContain('run-2')
  expect(projection.dependenciesByRunId?.['run-4']).toContain('run-3')
})

it('retains phyloseq conversion reads without certifying an unproved cross-cell input', async () => {
  const scripts = [
    'counts <- matrix(c(1, 2, 3, 4), nrow = 2)\nps <- phyloseq::phyloseq(phyloseq::otu_table(counts, taxa_are_rows = TRUE))',
    'dds <- phyloseq::phyloseq_to_deseq2(ps, ~ treatment + batch)',
    'dds <- DESeq2::DESeq(dds)\nres <- DESeq2::results(dds)'
  ]
  const projection = await projectScripts('r', scripts, 'notebook-phyloseq-deseq2-lineage-')
  const entry = await analyzeRNotebookSource(scripts.join('\n'))

  expect(entry.facts.typeBindings).toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'dds', typeName: 'DESeqDataSet' })])
  )
  const consumer = await analyzeRNotebookSource(scripts[1])
  expect(consumer.facts.usedNames).toContain('ps')
  expect(projection.dependenciesByRunId?.['run-2']).toBeUndefined()
  expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
})

it('requires a phyloseq input before certifying DESeq2 conversion', async () => {
  for (const setup of ['', 'ps <- Seurat::CreateSeuratObject(counts)']) {
    const { facts } = await analyzeRNotebookSource(
      `${setup}\ndds <- phyloseq::phyloseq_to_deseq2(ps, ~ treatment + batch)`
    )
    expect(facts.typeBindings?.find((binding) => binding.target === 'dds')).toBeUndefined()
    expect(facts.safeCallNames ?? []).not.toContain('phyloseq::phyloseq_to_deseq2')
  }
  const { facts } = await analyzeRNotebookSource(
    'ps <- phyloseq::phyloseq(phyloseq::otu_table(counts, taxa_are_rows = TRUE))\nps <- phyloseq::phyloseq_to_deseq2(ps, ~ treatment + batch)'
  )
  expect(facts.typeBindings).toContainEqual(
    expect.objectContaining({ target: 'ps', typeName: 'DESeqDataSet' })
  )
  expect(facts.safeCallNames).toContain('phyloseq::phyloseq_to_deseq2')
})

it('keeps DESeq2 result and count outputs typed across R cells', async () => {
  const scripts = [
    'counts <- read.csv("inputs/counts.csv")\nmetadata <- read.csv("inputs/metadata.csv")\ndds <- DESeq2::DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = ~ condition)',
    'dds <- DESeq2::DESeq(dds)',
    'res <- DESeq2::results(dds)\ncount_matrix <- DESeq2::counts(dds)'
  ]
  const projection = await projectScripts('r', scripts, 'notebook-deseq2-output-types-')
  const entry = await analyzeRNotebookSource(scripts.join('\n'))

  expect(entry.facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'res', typeName: 'data.frame' }),
      expect.objectContaining({ target: 'count_matrix', typeName: 'matrix' })
    ])
  )
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projection.dependenciesByRunId?.['run-3']).toContain('run-2')
})

it('tracks Visium spatial input and VCF output contracts across R cells', async () => {
  const scripts = [
    'spe <- SpatialExperiment::read10xVisium(samples = "inputs/visium")',
    'coords <- SpatialExperiment::spatialCoords(spe)',
    'vcf <- VariantAnnotation::readVcf("inputs/cohort.vcf.gz", genome = "hg38")',
    'VariantAnnotation::writeVcf(vcf, "outputs/cohort.filtered.vcf.gz")'
  ]
  const projection = await projectScripts('r', scripts, 'notebook-spatial-vcf-lineage-')
  const entry = await analyzeRNotebookSource(scripts.join('\n'))
  const outputFacts = await analyzeRNotebookSource(scripts[3]!)

  expect(entry.facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'spe', typeName: 'SpatialExperiment' })
    ])
  )
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(outputFacts.facts.usedNames).toContain('VariantAnnotation::writeVcf')
})

it('preserves MultiAssayExperiment assay and sample-map lineage across R cells', async () => {
  const scripts = [
    'rna <- SummarizedExperiment::SummarizedExperiment(assays = list(counts = matrix(1:4, nrow = 2)))\natac <- SummarizedExperiment::SummarizedExperiment(assays = list(counts = matrix(5:8, nrow = 2)))\nmae <- MultiAssayExperiment::MultiAssayExperiment(experiments = list(rna = rna, atac = atac))',
    'rna_assay <- MultiAssayExperiment::experiments(mae)[["rna"]]',
    'mapping <- MultiAssayExperiment::sampleMap(mae)\nprint(mapping)'
  ]
  const projection = await projectScripts('r', scripts, 'notebook-multi-assay-experiment-lineage-')
  const entry = await analyzeRNotebookSource(scripts.join('\n'))

  expect(entry.facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'mae', typeName: 'MultiAssayExperiment' }),
      expect.objectContaining({ target: 'mapping', typeName: 'S4Vectors.DataFrame' })
    ])
  )
  expect(entry.facts.aliases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        target: 'rna_assay',
        source: 'mae',
        access: 'subscript',
        member: 'rna'
      })
    ])
  )
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projection.dependenciesByRunId?.['run-3']).toContain('run-1')

  const dynamic = await analyzeRNotebookSource(
    `${scripts[0]}\nassay_name <- get_assay_name()\nrna_assay <- MultiAssayExperiment::experiments(mae)[[assay_name]]`
  )
  expect(dynamic.facts.aliases ?? []).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'rna_assay', source: 'mae', member: 'rna' })
    ])
  )

  const unknownReceiver = await analyzeRNotebookSource(
    'mae <- external_container\nmapping <- MultiAssayExperiment::sampleMap(mae)'
  )
  expect(unknownReceiver.facts.typeBindings ?? []).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'mapping', typeName: 'S4Vectors.DataFrame' })
    ])
  )
  const otherPackage = await analyzeRNotebookSource(
    `${scripts[0]}\nmapping <- custom::sampleMap(mae)`
  )
  expect(otherPackage.facts.typeBindings ?? []).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'mapping', typeName: 'S4Vectors.DataFrame' })
    ])
  )
})

it('resolves unqualified Seurat transforms after the package is loaded', async () => {
  const scripts = [
    'library(Seurat)',
    'obj <- CreateSeuratObject(counts)',
    'obj <- NormalizeData(obj)',
    'obj <- RunPCA(obj, npcs = 10)'
  ]
  const projection = await projectScripts('r', scripts, 'notebook-seurat-unqualified-lineage-')
  const entry = await analyzeRNotebookSource(scripts.join('\n'))

  expect(entry.facts.typeBindings).toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'obj', typeName: 'Seurat' })])
  )
  expect(entry.facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
  expect(projection.dependenciesByRunId?.['run-3']).toContain('run-2')
  expect(projection.dependenciesByRunId?.['run-4']).toContain('run-3')
})

describe('loaded scientific package call identities', () => {
  it.each([
    ['Seurat', 'NormalizeData', 'Seurat::CreateSeuratObject(counts)', 'Seurat'],
    [
      'MultiAssayExperiment',
      'sampleMap',
      'MultiAssayExperiment::MultiAssayExperiment()',
      'S4Vectors.DataFrame'
    ]
  ])('preserves binding barriers for loaded %s::%s', async (pkg, name, constructor, type) => {
    const shadow = `${name} <- function(x) readLines("secret.txt")`
    const producer = await analyzeRNotebookSource(shadow)
    expect(producer.fileAccess).toBeDefined()
    const context = projectNotebookFileContext('r', [
      { facts: producer.facts, fileContext: producer.fileAccess!.context }
    ])
    for (const binding of ['local', 'incoming', 'dynamic']) {
      for (const qualified of [false, true]) {
        const call = qualified ? `${pkg}::${name}` : name
        const source = [
          `library(${pkg})`,
          `obj <- ${constructor}`,
          ...(binding === 'incoming' ? [] : [binding === 'local' ? shadow : 'source("setup.R")']),
          `result <- ${call}(obj)`
        ].join('\n')
        const { facts } = await analyzeRNotebookSource(
          source,
          binding === 'incoming' ? context : undefined
        )
        const resultType = facts.typeBindings?.find((binding) => binding.target === 'result')
        if (qualified) {
          expect(resultType?.typeName).toBe(type)
          expect(facts.safeCallNames).toContain(`${pkg}::${name}`)
        } else {
          expect(resultType).toBeUndefined()
          expect(facts.safeCallNames ?? []).not.toContain(`${pkg}::${name}`)
        }
      }
    }
  })
})

it.each([
  ['Pipeline', 'from sklearn.pipeline import Pipeline\nmodel = Pipeline(steps)'],
  [
    'ColumnTransformer',
    'from sklearn.compose import ColumnTransformer\nmodel = ColumnTransformer(steps)'
  ]
])('keeps unproved delegated %s operations opaque', async (_name, setup) => {
  const [facts] = await analyzePythonSources([`${setup}\nresult = model.transform(values)`])
  expect(facts.typeBindings ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'result' })])
  )
  const projection = await projectScripts(
    'python',
    ['steps = []\nvalues = [1]', setup, 'result = model.transform(values)'],
    'notebook-delegated-estimator-'
  )
  expect(projection.stalenessByRunId['run-3'].state).toBe('unknown')
  expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
})

describe('Python lexical callback helper bindings', () => {
  const prelude =
    'import numpy as np\nfrom scipy.ndimage import generic_filter\nvalues = np.array([1., 2., 3.])\nPENALTY_PATH = "penalty-a.txt"\nFROZEN_SCALE = 1.0'
  const globalHelper = 'def penalty_helper(value):\n    return float(open(PENALTY_PATH).read())'

  it.each([
    'penalty_helper = lambda: 1.0\n        value = penalty_helper()',
    'def penalty_helper():\n            return 1.0\n        value = penalty_helper()',
    'penalty_helper = 1.0\n        penalty_helper += 1.0\n        value = penalty_helper'
  ])('excludes a class helper bound before its read: %s', async (body) => {
    const projection = await projectScripts(
      'python',
      [
        prelude,
        `${globalHelper}\ndef callback(window):\n    class Inner:\n        ${body}\n    return FROZEN_SCALE`,
        'result = generic_filter(values, function=callback, size=3)',
        'PENALTY_PATH = "penalty-b.txt"',
        'FROZEN_SCALE = 2.0'
      ],
      'notebook-class-local-helper-'
    )
    expect(
      projection.invalidatedByRunId['run-4']?.find((item) => item.runId === 'run-3')?.names ?? []
    ).not.toContain('PENALTY_PATH')
    expect(projection.invalidatedByRunId['run-5']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-3', names: expect.arrayContaining(['FROZEN_SCALE']) })
      ])
    )
    expect(projection.stalenessByRunId['run-3'].state).toBe('unknown')
  })

  it.each([
    'penalty_helper = penalty_helper(1.0)',
    'penalty_helper = 1.0\n        del penalty_helper\n        value = penalty_helper(1.0)',
    'if flag:\n            penalty_helper = 1.0\n        value = penalty_helper(1.0)',
    'penalty_helper = 1.0\n        if flag:\n            del penalty_helper\n        value = penalty_helper(1.0)',
    'penalty_helper = 1.0\n        mutate_namespace()\n        value = penalty_helper(1.0)',
    'penalty_helper = 1.0\n        class Nested:\n            value = penalty_helper(1.0)',
    'global penalty_helper\n        penalty_helper = replacement\n        value = penalty_helper(1.0)'
  ])('retains uncertain class helper fallback: %s', async (body) => {
    const [facts] = await analyzePythonSources([
      `def callback(window):\n    class Inner:\n        ${body}\n    return window`
    ])
    expect(
      facts.typeSummaries?.find((item) => item.name === 'python-function:callback')?.methods[0]
        .usedNames
    ).toContain('penalty_helper')
  })

  it.each([
    ['local definition', '    def penalty_helper(value):\n        return value'],
    [
      'conditional definition',
      '    if True:\n        def penalty_helper(value):\n            return value'
    ],
    [
      'local alias',
      '    def penalty_helper(value):\n        return value\n    local_helper = penalty_helper'
    ]
  ])('excludes the unrelated global path for a lexical %s', async (label, local) => {
    const target = label === 'local alias' ? 'local_helper' : 'penalty_helper'
    const callback = `def callback(window):\n${local}\n    return ${target}(FROZEN_SCALE)`
    const [facts] = await analyzePythonSources([callback])
    const method = facts.typeSummaries?.find((item) => item.name === 'python-function:callback')
      ?.methods[0]
    expect(method?.usedNames).toContain('FROZEN_SCALE')
    expect(method?.usedNames ?? []).not.toContain('penalty_helper')
    expect(method?.effect).toBe('unknown')

    const projection = await projectScripts(
      'python',
      [
        prelude,
        `${globalHelper}\n${callback}`,
        'result = generic_filter(values, function=callback, size=3)',
        'PENALTY_PATH = "penalty-b.txt"',
        'FROZEN_SCALE = 2.0'
      ],
      'notebook-lexical-local-helper-'
    )
    const pathChange = projection.invalidatedByRunId['run-4']?.find(
      (item) => item.runId === 'run-3'
    )
    expect(pathChange?.names ?? []).not.toContain('PENALTY_PATH')
    expect(projection.invalidatedByRunId['run-5']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-3',
          state: 'unknown',
          names: expect.arrayContaining(['FROZEN_SCALE'])
        })
      ])
    )
    expect(projection.stalenessByRunId['run-3'].state).toBe('unknown')
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
  })

  it.each([
    ['ordinary global helper', ''],
    [
      'nested class method',
      '    class Inner:\n        def penalty_helper(self):\n            return 1.0\n'
    ],
    [
      'nested class async method',
      '    class Inner:\n        async def penalty_helper(self):\n            return 1.0\n'
    ],
    ['nested class attribute', '    class Inner:\n        penalty_helper = 1.0\n'],
    [
      'class load beside an enclosing local helper',
      '    def penalty_helper(value):\n        return value\n    class Inner:\n        penalty_helper = penalty_helper(1.0)\n'
    ]
  ])('retains the real global path beside a lexical %s', async (_, declaration) => {
    const projection = await projectScripts(
      'python',
      [
        prelude,
        `${globalHelper}\ndef callback(window):\n${declaration}    return penalty_helper(window)`,
        'result = generic_filter(values, function=callback, size=3)',
        'PENALTY_PATH = "penalty-b.txt"'
      ],
      'notebook-lexical-global-helper-'
    )
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-3',
          state: 'unknown',
          names: expect.arrayContaining(['PENALTY_PATH'])
        })
      ])
    )
    expect(projection.stalenessByRunId['run-3'].state).toBe('unknown')
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
  })
})

it('retains a kinetic model gain without capturing its shadowed global reader', async () => {
  const callback =
    'def model(x, Vm, K):\n    def substrate_fraction(x, k):\n        return x / (k + x)\n    return enzyme_gain * Vm * substrate_fraction(x, K)'
  const [facts] = await analyzePythonSources([callback])
  const method = facts.typeSummaries?.find((item) => item.name === 'python-function:model')
    ?.methods[0]
  expect(method?.usedNames).toContain('enzyme_gain')
  expect(method?.usedNames ?? []).not.toContain('substrate_fraction')

  const projection = await projectScripts(
    'python',
    [
      'import numpy as np\nfrom scipy.optimize import curve_fit\nx = np.array([0.1, 0.2, 1.])\ny = np.array([1., 2., 3.])\nenzyme_gain = 1.0\nUNRELATED_PATH = "unused-a.txt"',
      `def substrate_fraction(x, k):\n    return float(open(UNRELATED_PATH).read())\n${callback}`,
      'parameters, covariance = curve_fit(model, x, y)',
      'UNRELATED_PATH = "unused-b.txt"',
      'enzyme_gain = 2.0'
    ],
    'notebook-lexical-kinetic-model-'
  )
  const pathChange = projection.invalidatedByRunId['run-4']?.find((item) => item.runId === 'run-3')
  expect(pathChange?.names ?? []).not.toContain('UNRELATED_PATH')
  expect(projection.invalidatedByRunId['run-5']).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ runId: 'run-3', state: 'unknown', names: ['enzyme_gain'] })
    ])
  )
  expect(projection.stalenessByRunId['run-3']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining([
      'opaque-call',
      'scoped-opaque-call',
      'opaque-mutation',
      'external-state'
    ])
  })
  expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
})

it('keeps a robust loss local class separate from its calibration dependency', async () => {
  const callback = [
    'def custom_loss(z):',
    '    class LossMetadata:',
    '        def calibrate(self):',
    '            return 1.0',
    '    _ = LossMetadata',
    '    c = robust_scale * calibrate()',
    '    def normalize(value):',
    '        return value / (c * c)',
    '    t = 1.0 + normalize(z)',
    '    return np.array([2 * c * c * (np.sqrt(t) - 1), t ** -0.5, -0.5 / (c * c) * t ** -1.5])'
  ].join('\n')
  const [facts] = await analyzePythonSources([callback])
  const method = facts.typeSummaries?.find((item) => item.name === 'python-function:custom_loss')
    ?.methods[0]
  expect(method?.effect).toBe('unknown')
  expect(method?.usedNames).toEqual(['calibrate', 'np', 'robust_scale'])

  const projection = await projectScripts(
    'python',
    [
      'import numpy as np\nfrom scipy.optimize import least_squares\nx = np.array([1., 2.])\ny = np.array([2., 4.])\np0 = np.array([0.])\nrobust_scale = 0.25\nLossMetadata = 1.0\nCALIBRATION_PATH = "calibration-a.txt"\nUNRELATED_PATH = "unused-a.txt"',
      `def calibrate():\n    return float(open(CALIBRATION_PATH).read())\ndef normalize(value):\n    return float(open(UNRELATED_PATH).read())\ndef residuals(p):\n    return p[0] * x - y\n${callback}`,
      'fit = least_squares(residuals, p0, loss=custom_loss)',
      'LossMetadata = object',
      'UNRELATED_PATH = "unused-b.txt"',
      'CALIBRATION_PATH = "calibration-b.txt"',
      'robust_scale = 1.0'
    ],
    'notebook-lexical-robust-loss-'
  )
  for (const [runId, name] of [
    ['run-4', 'LossMetadata'],
    ['run-5', 'UNRELATED_PATH']
  ]) {
    const invalidation = projection.invalidatedByRunId[runId]?.find(
      (item) => item.runId === 'run-3'
    )
    expect(invalidation?.names ?? []).not.toContain(name)
  }
  for (const [runId, name] of [
    ['run-6', 'CALIBRATION_PATH'],
    ['run-7', 'robust_scale']
  ]) {
    expect(projection.invalidatedByRunId[runId]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-3',
          state: 'unknown',
          names: expect.arrayContaining([name])
        })
      ])
    )
  }
  expect(projection.stalenessByRunId['run-3']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['opaque-call', 'scoped-opaque-call', 'external-state'])
  })
  expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
})

it.each(['nested definition', 'lambda'])(
  'retains volcano roughness calibration from a callback local %s default',
  async (shape) => {
    const callback = [
      'def relief_callback(window):',
      '    class Metadata:',
      '        def calibrate(self):',
      '            return 1',
      ...(shape === 'lambda'
        ? ['    normalize = lambda value, scale=calibrate(): value * scale']
        : ['    def normalize(value, scale=calibrate()):', '        return value * scale']),
      '    w = np.asarray(window, dtype=np.float64)',
      '    mu = float(np.mean(w))',
      '    M = float(np.mean(np.abs(w - mu)))',
      '    return float(normalize(M) * GAIN)'
    ].join('\n')
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfrom scipy.ndimage import generic_filter\nterrain = np.array([[100., 101.], [99., 102.]])\nGAIN = 1.0\nCALIBRATION_PATH = "inputs/calibration-low.txt"\nUNRELATED_PATH = "inputs/unrelated.txt"\ncalibration_events = []',
        [
          'def calibrate():',
          '    with open(CALIBRATION_PATH, "r") as f:',
          '        cal_val = float(f.read().strip())',
          '    calibration_events.append((CALIBRATION_PATH, float(cal_val)))',
          '    return float(cal_val)',
          'def normalize(*values):',
          '    with open(UNRELATED_PATH, "r") as f:',
          '        _ = f.read()',
          '    return None',
          callback
        ].join('\n'),
        'roughness = generic_filter(terrain, function=relief_callback, size=3, mode="reflect", origin=0, output=np.float64)',
        'GAIN = 1.5',
        'CALIBRATION_PATH = "inputs/calibration-high.txt"',
        'UNRELATED_PATH = "inputs/another-unrelated.txt"'
      ],
      'notebook-volcano-default-calibration-'
    )

    const unrelatedChange = projection.invalidatedByRunId['run-6']?.find(
      (item) => item.runId === 'run-3'
    )
    expect(unrelatedChange?.names ?? []).not.toContain('UNRELATED_PATH')
    expect(projection.stalenessByRunId['run-3']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call', 'scoped-opaque-call', 'external-state'])
    })
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
    for (const [runId, name] of [
      ['run-4', 'GAIN'],
      ['run-5', 'CALIBRATION_PATH']
    ]) {
      expect(projection.invalidatedByRunId[runId]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: 'run-3',
            state: 'unknown',
            names: expect.arrayContaining([name])
          })
        ])
      )
    }
  }
)

it('propagates nonlinear least-squares parameters without certifying callback purity', async () => {
  const scripts = [
    'import numpy as np\nfrom scipy.optimize import least_squares\nx = np.array([1., 2., 3.])\ny = np.array([2., 4., 6.])\np0 = np.array([1.])\ndef residuals(p):\n    return p[0] * x - y',
    'fit = least_squares(residuals, p0, method="trf", x_scale="jac")',
    'parameters = fit.x\njacobian = fit.jac\nconverged = fit.success\nvalues = parameters.astype("float64")',
    'np.save("outputs/fitted-parameters.npy", values)'
  ]
  const [facts] = await analyzePythonSources([scripts.join('\n')])
  expect(facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'fit', typeName: 'scipy.optimize.OptimizeResult' }),
      expect.objectContaining({ target: 'parameters', typeName: 'numpy.ndarray' }),
      expect.objectContaining({ target: 'values', typeName: 'numpy.ndarray' }),
      expect.objectContaining({ target: 'converged', typeName: 'python.scalar' })
    ])
  )
  expect(facts.typeBindings).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'jacobian', typeName: 'numpy.ndarray' })
    ])
  )
  expect(facts.state).toBe('unknown')
  const projection = await projectScripts('python', scripts, 'notebook-least-squares-lineage-')
  // Result properties remain typed, but arbitrary callbacks mean the solver
  // and downstream consumers cannot be certified reproducible from source.
  expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
  expect(projection.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
})

it.each([
  'residuals, p0',
  'residuals, p0, jac=jacobian',
  'residuals, p0, loss=loss_function',
  'residuals, p0, callback=observer',
  'residuals, p0, workers=pool.map'
])('keeps least_squares callbacks conservative: %s', async (arguments_) => {
  const [facts] = await analyzePythonSources([
    `from scipy.optimize import least_squares\nfit = least_squares(${arguments_})`
  ])
  expect(facts.state).toBe('unknown')
  if (facts.state !== 'unknown') throw new Error('least_squares must remain conservative')
  expect(facts.reasons).toEqual(expect.arrayContaining(['external-state']))
  expect(facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'fit', typeName: 'scipy.optimize.OptimizeResult' })
    ])
  )
})

it.each([
  ['callback', 19],
  ['workers', 20],
  ['loss', 9]
] as const)('retains captures of a positional least_squares %s', async (_, position) => {
  const args = [
    'residuals',
    'p0',
    '"2-point"',
    '(-1, 1)',
    '"trf"',
    '1e-8',
    '1e-8',
    '1e-8',
    '1.0',
    '"linear"',
    '1.0',
    'None',
    'None',
    '{}',
    'None',
    'None',
    '0',
    '()',
    'None',
    'None',
    'None'
  ]
  args[position] = 'observer'
  const projection = await projectScripts(
    'python',
    [
      'from scipy.optimize import least_squares\np0 = [0.]\ncallback_gain = 1.0',
      'def residuals(p):\n    return p\ndef observer(value):\n    return callback_gain',
      `fit = least_squares(${args.join(', ')})`,
      'callback_gain = 2.0'
    ],
    'notebook-positional-optimizer-'
  )
  expect(projection.invalidatedByRunId['run-4']).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        runId: 'run-3',
        state: 'unknown',
        names: expect.arrayContaining(['callback_gain'])
      })
    ])
  )
  expect(projection.stalenessByRunId['run-3'].state).toBe('unknown')
  expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
})

it.each([
  'import scipy.optimize as opt\nfit = opt.least_squares(residuals, p0)',
  'from scipy.optimize import least_squares as solve\nfit = solve(residuals, p0)'
])('resolves a least_squares import alias: %s', async (source) => {
  const [facts] = await analyzePythonSources([`${source}\nparameters = fit.x`])
  expect(facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'fit', typeName: 'scipy.optimize.OptimizeResult' }),
      expect.objectContaining({ target: 'parameters', typeName: 'numpy.ndarray' })
    ])
  )
})

it('does not reuse least_squares result semantics after rebinding', async () => {
  const [facts] = await analyzePythonSources([
    'from scipy.optimize import least_squares\nleast_squares = replacement\nfit = least_squares(residuals, p0)\nparameters = fit.x'
  ])
  expect(facts.typeBindings ?? []).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'fit', typeName: 'scipy.optimize.OptimizeResult' })
    ])
  )
})

it.each(['residuals, p0', 'fun=residuals, x0=p0'])(
  'retains known captures of an opaque optimizer callback: %s',
  async (arguments_) => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfrom scipy.optimize import least_squares\nx = np.array([1., 2., 3.])\ny = np.array([2., 4., 6.])\np0 = np.array([1.])',
        'def residuals(p):\n    return model(p, x) - y',
        `fit = least_squares(${arguments_})`,
        'parameters = fit.x',
        'x = np.array([4., 5., 6.])'
      ],
      'notebook-opaque-optimizer-captures-'
    )

    expect(projection.invalidatedByRunId['run-5']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-3', state: 'unknown', names: ['x'] })
      ])
    )
    expect(projection.stalenessByRunId['run-3']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call', 'external-state'])
    })
    // Captures retain invalidation evidence, not a verified reproducibility edge.
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
    expect(projection.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
  }
)

it('does not retain captures from a replaced optimizer callback', async () => {
  const projection = await projectScripts(
    'python',
    [
      'import numpy as np\nfrom scipy.optimize import least_squares\nx = np.array([1.])\nz = np.array([2.])\np0 = np.array([1.])',
      'def residuals(p):\n    return model(p, x)',
      'def residuals(p):\n    return replacement_model(p, z)',
      'fit = least_squares(residuals, p0)',
      'x = np.array([3.])',
      'z = np.array([4.])'
    ],
    'notebook-replaced-optimizer-callback-'
  )

  expect(projection.invalidatedByRunId['run-5'] ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ runId: 'run-4', names: ['x'] })])
  )
  expect(projection.invalidatedByRunId['run-6']).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ runId: 'run-4', state: 'unknown', names: ['z'] })
    ])
  )
})

it('retains captures of every opaque optimizer callback', async () => {
  const projection = await projectScripts(
    'python',
    [
      'from scipy.optimize import least_squares\nx = [1.]\nscale = [2.]\np0 = [1.]',
      'def residuals(p):\n    return model(p, x)\ndef jacobian(p):\n    return custom_jacobian(p, scale)',
      'fit = least_squares(residuals, p0, jac=jacobian)',
      'x = [3.]',
      'scale = [4.]'
    ],
    'notebook-multiple-optimizer-callbacks-'
  )

  for (const [runId, name] of [
    ['run-4', 'x'],
    ['run-5', 'scale']
  ]) {
    expect(projection.invalidatedByRunId[runId]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-3', state: 'unknown', names: [name] })
      ])
    )
  }
  expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
})

it('retains captures of every opaque callback in an aggregation list', async () => {
  const projection = await projectScripts(
    'python',
    [
      'import pandas as pd\nframe = pd.DataFrame({"group": [1, 1], "value": [2., 3.]})\nfirst_scale = 2.\nsecond_scale = 3.',
      'def first(values):\n    return custom_aggregate(values, first_scale)\ndef second(values):\n    return other_aggregate(values, second_scale)',
      'result = frame.groupby("group").agg(func=[first, second])',
      'first_scale = 4.',
      'second_scale = 5.'
    ],
    'notebook-opaque-aggregation-callbacks-'
  )

  for (const [runId, name] of [
    ['run-4', 'first_scale'],
    ['run-5', 'second_scale']
  ]) {
    expect(projection.invalidatedByRunId[runId]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-3', state: 'unknown', names: [name] })
      ])
    )
  }
  expect(projection.stalenessByRunId['run-3']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['opaque-call'])
  })
  expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
})

it('retains captures of an unpatched opaque optimizer worker', async () => {
  const projection = await projectScripts(
    'python',
    [
      'from scipy.optimize import least_squares\nx = [1.]\np0 = [1.]',
      'class Worker:\n    def map(self, function, parameters):\n        return custom_map(function, parameters, x)\ndef residuals(p):\n    return p\npool = Worker()',
      'fit = least_squares(residuals, p0, workers=pool.map)',
      'x = [2.]'
    ],
    'notebook-opaque-optimizer-worker-'
  )

  expect(projection.invalidatedByRunId['run-4']).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ runId: 'run-3', state: 'unknown', names: ['x'] })
    ])
  )
})

it.each([
  ['pool.map = replacement', 'fit = least_squares(residuals, p0, workers=pool.map)'],
  ['', 'pool.map = replacement\nfit = least_squares(residuals, p0, workers=pool.map)']
])('does not reuse captures of a patched optimizer worker: %s', async (patch, solve) => {
  const projection = await projectScripts(
    'python',
    [
      'import numpy as np\nfrom scipy.optimize import least_squares\nx = np.array([1.])\np0 = np.array([1.])',
      'class Worker:\n    def map(self, function, parameters):\n        return custom_map(function, parameters, x)\ndef residuals(p):\n    return p\npool = Worker()',
      patch || 'untouched = 1',
      solve,
      'x = np.array([2.])'
    ],
    'notebook-patched-optimizer-worker-'
  )

  expect(projection.stalenessByRunId['run-4']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['opaque-call'])
  })
  expect(projection.invalidatedByRunId['run-5'] ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ runId: 'run-4', names: ['x'] })])
  )
})

it.each([
  '    x.append(p)\n    return model(p, x)',
  '    with open("inputs/calibration.csv") as handle:\n        return custom_residual(p, x, handle.read())'
])('retains captures without certifying mutation or I/O callbacks: %s', async (body) => {
  const projection = await projectScripts(
    'python',
    [
      'from scipy.optimize import least_squares\nx = [1., 2.]\np0 = [1.]',
      `def residuals(p):\n${body}`,
      'fit = least_squares(residuals, p0)',
      'x = [3., 4.]'
    ],
    'notebook-effectful-optimizer-callback-'
  )

  expect(projection.invalidatedByRunId['run-4']).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ runId: 'run-3', state: 'unknown', names: ['x'] })
    ])
  )
  expect(projection.stalenessByRunId['run-3']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['opaque-call', 'external-state'])
  })
  expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
})

it('propagates an xarray variable selection across Python cells', async () => {
  const scripts = [
    'import xarray as xr\nds = xr.open_dataset("inputs/climate.nc")',
    'temperature = ds["temperature"]',
    'mean_temperature = temperature.mean(dim="time")',
    'temperature.to_netcdf("outputs/temperature.nc")'
  ]
  const projection = await projectScripts('python', scripts, 'notebook-xarray-selection-lineage-')
  const [facts] = await analyzePythonSources([scripts.join('\n')])

  expect(facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'temperature', typeName: 'xarray.DataArray' }),
      expect.objectContaining({ target: 'mean_temperature', typeName: 'xarray.DataArray' })
    ])
  )
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projection.dependenciesByRunId?.['run-3']).toContain('run-2')
  expect(projection.dependenciesByRunId?.['run-4']).toContain('run-2')

  const [dynamicFacts] = await analyzePythonSources([
    'import xarray as xr\nds = xr.open_dataset("inputs/climate.nc")\nvariable_name = get_variable_name()\ntemperature = ds[variable_name]'
  ])
  expect(dynamicFacts.typeBindings ?? []).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'temperature', typeName: 'xarray.DataArray' })
    ])
  )
})

it('propagates a multi-page TIFF frame across Python cells', async () => {
  const scripts = [
    'import tifffile\ntif = tifffile.TiffFile("inputs/stack.tiff")',
    'page = tif.pages[0]',
    'frame = page.asarray()',
    'tifffile.imwrite("outputs/frame.tiff", frame)'
  ]
  const projection = await projectScripts('python', scripts, 'notebook-tiff-pages-lineage-')
  const [facts] = await analyzePythonSources([scripts.join('\n')])

  expect(facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'page', typeName: 'tifffile.TiffPage' }),
      expect.objectContaining({ target: 'frame', typeName: 'numpy.ndarray' })
    ])
  )
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projection.dependenciesByRunId?.['run-3']).toContain('run-2')
})

it('propagates AnnData matrix annotations across Python cells', async () => {
  const scripts = [
    'import anndata as ad\nadata = ad.read_h5ad("inputs/cells.h5ad")',
    'metadata = adata.obs\nembedding = adata.obsm["X_pca"]\ncounts = adata.layers["counts"]',
    'clusters = metadata["cluster"].value_counts()',
    'adata.write_h5ad("outputs/annotated.h5ad", convert_strings_to_categoricals = False)'
  ]
  const projection = await projectScripts('python', scripts, 'notebook-anndata-attributes-lineage-')
  const [facts] = await analyzePythonSources([scripts.join('\n')])

  expect(facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'metadata', typeName: 'pandas.DataFrame' }),
      expect.objectContaining({ target: 'embedding', typeName: 'anndata.ArrayLike' }),
      expect.objectContaining({ target: 'counts', typeName: 'anndata.ArrayLike' }),
      expect.objectContaining({ target: 'clusters', typeName: 'pandas.Series' })
    ])
  )
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projection.dependenciesByRunId?.['run-3']).toContain('run-2')
  expect(projection.dependenciesByRunId?.['run-4']).toContain('run-1')
})

it('propagates Scanpy copy-mode preprocessing as a new AnnData object', async () => {
  const scripts = [
    'import scanpy as sc\nadata = sc.read_h5ad("inputs/cells.h5ad")',
    'normalized = sc.pp.normalize_total(adata, copy = True)',
    'clusters = normalized.obs["cluster"].value_counts()'
  ]
  const projection = await projectScripts('python', scripts, 'notebook-scanpy-copy-lineage-')
  const [facts] = await analyzePythonSources([scripts.join('\n')])

  expect(facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'normalized', typeName: 'anndata.AnnData' }),
      expect.objectContaining({ target: 'clusters', typeName: 'pandas.Series' })
    ])
  )
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projection.dependenciesByRunId?.['run-3']).toContain('run-2')
})

it('does not claim Scanpy copy-mode returns AnnData for array inputs', async () => {
  const [facts] = await analyzePythonSources([
    'import numpy as np\nimport scanpy as sc\nvalues = np.ones((2, 2))\nnormalized = sc.pp.log1p(values, copy = True)'
  ])

  expect(facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'values', typeName: 'numpy.ndarray' })
    ])
  )
  expect(facts.typeBindings).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'normalized', typeName: 'anndata.AnnData' })
    ])
  )
})

it('keeps backed AnnData matrix lineage conservative', async () => {
  const [facts] = await analyzePythonSources([
    'import anndata as ad\nadata = ad.read_h5ad("inputs/cells.h5ad", backed = "r")\nmatrix = adata.X\nembedding = adata.obsm["X_pca"]'
  ])

  expect(facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'adata', typeName: 'anndata.AnnDataBacked' }),
      expect.objectContaining({ target: 'matrix', typeName: 'anndata.ArrayLike' }),
      expect.objectContaining({ target: 'embedding', typeName: 'anndata.ArrayLike' })
    ])
  )
  expect(facts.typeBindings).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'matrix', typeName: 'numpy.ndarray' }),
      expect.objectContaining({ target: 'embedding', typeName: 'numpy.ndarray' })
    ])
  )
})

it.each([
  ['', 'anndata.AnnData'],
  [', None', 'anndata.AnnData'],
  [', False', 'anndata.AnnData'],
  [', "r"', 'anndata.AnnDataBacked'],
  [', "r+"', 'anndata.AnnDataBacked'],
  [', **options', 'anndata.AnnDataBacked'],
  [', backed=None, **options', 'anndata.AnnDataBacked']
])('specializes AnnData read_h5ad backed arguments %s', async (arguments_, typeName) => {
  const [facts] = await analyzePythonSources([
    `import anndata as ad\nadata = ad.read_h5ad("inputs/cells.h5ad"${arguments_})`
  ])
  expect(facts.typeBindings).toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'adata', typeName })])
  )
})

it.each([
  ['', true],
  [', convert_strings_to_categoricals=True', true],
  [', convert_strings_to_categoricals=False', false]
])('tracks metadata mutation during AnnData write_zarr%s', async (options, mutates) => {
  const projection = await projectScripts(
    'python',
    [
      'import anndata as ad\nadata = ad.read_h5ad("inputs/cells.h5ad")',
      `adata.write_zarr("outputs/cells.zarr"${options})`,
      'metadata = adata.obs'
    ],
    'notebook-anndata-zarr-mutation-'
  )
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  if (mutates) expect(projection.dependenciesByRunId?.['run-3']).toContain('run-2')
  else expect(projection.dependenciesByRunId?.['run-3']).not.toContain('run-2')
})

it.each([
  ['MSnbase::filterMsLevel(input, msLevel = 1L)', 'xcms.XCMSnExp'],
  ['xcms::findChromPeaks(input, param = parameters)', 'xcms.XCMSnExp'],
  ['xcms::featureValues(input, value = "into")', 'data.frame']
])('requires a proved mass-spectrometry input for %s', async (call, expectedType) => {
  for (const setup of ['', 'input <- Seurat::CreateSeuratObject(counts)']) {
    const { facts } = await analyzeRNotebookSource(`${setup}\nresult <- ${call}`)
    expect(facts.typeBindings?.find((binding) => binding.target === 'result')).toBeUndefined()
    expect(facts.safeCallNames ?? []).not.toContain(call.split('(')[0])
  }
  const { facts } = await analyzeRNotebookSource(
    `raw <- MSnbase::readMSData(files = "input.mzML", mode = "onDisk")\ninput <- xcms::findChromPeaks(raw, param = parameters)\nresult <- ${call}`
  )
  expect(facts.typeBindings).toContainEqual(
    expect.objectContaining({ target: 'result', typeName: expectedType })
  )
  expect(facts.safeCallNames).toContain(call.split('(')[0])
})

it('propagates an MSnbase/xcms proteomics object across R cells', async () => {
  const scripts = [
    'raw_files <- c("inputs/control-a.mzML", "inputs/treated-a.mzML")\nsample_groups <- c("control", "treated")\nraw <- MSnbase::readMSData(files = raw_files, mode = "onDisk")\nms1 <- MSnbase::filterMsLevel(raw, msLevel = 1L)\nwindow <- MSnbase::filterRt(ms1, rt = c(60, 600))',
    'parameters <- xcms::CentWaveParam(ppm = 15, peakwidth = c(5, 30), snthresh = 10)\npeaks <- xcms::findChromPeaks(window, param = parameters)',
    'aligned <- xcms::adjustRtime(peaks, param = xcms::ObiwarpParam(binSize = 1))\ngrouping <- xcms::PeakDensityParam(sampleGroups = sample_groups, minFraction = 0.5, bw = 5)\ngrouped <- xcms::groupChromPeaks(aligned, param = grouping)\nfilled <- xcms::fillChromPeaks(grouped)\nintensity <- xcms::featureValues(filled, value = "into")\nfeatures <- xcms::featureDefinitions(filled)\nwrite.csv(intensity, "outputs/feature-intensities.csv")\nsaveRDS(filled, "outputs/processed-spectra.rds")',
    'matrix <- read.csv("outputs/feature-intensities.csv", row.names = 1)\nkeep <- rowSums(is.na(matrix)) <= 1\nwrite.csv(matrix[keep, , drop = FALSE], "outputs/filtered-intensities.csv")'
  ]
  const projection = await projectScripts('r', scripts, 'notebook-xcms-lineage-')
  const entry = await analyzeRNotebookSource(scripts.join('\n'))

  expect(entry.facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'raw', typeName: 'MSnbase.MSnExp' }),
      expect.objectContaining({ target: 'peaks', typeName: 'xcms.XCMSnExp' }),
      expect.objectContaining({ target: 'intensity', typeName: 'data.frame' })
    ])
  )
  expect(entry.facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['external-state'])
  })
  expect(entry.facts.usedNames).toEqual(
    expect.arrayContaining(['peaks', 'filled', 'xcms::adjustRtime', 'xcms::featureValues'])
  )
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
})

describe('scientific Notebook dependency corpus', { timeout: 60_000 }, () => {
  it('invalidates transcript counts after their sample file vector is replaced', async () => {
    const projection = await projectScripts(
      'r',
      [
        'files <- c(A="inputs/A/quant.sf", B="inputs/B/quant.sf")',
        'txi <- tximport::tximport(files, type="salmon", txOut=TRUE, dropInfReps=TRUE)',
        'write.csv(txi$counts, "counts.csv")',
        'files <- c(A="inputs/newA/quant.sf", B="inputs/B/quant.sf")'
      ],
      'open-science-transcript-inputs-'
    )
    expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
  })

  it('tracks the transcript-to-gene mapping as an object dependency', async () => {
    const projection = await projectScripts(
      'r',
      [
        'mapping <- read.csv("inputs/map.csv")\nfiles <- c("inputs/A/quant.sf")',
        'txi <- tximport::tximport(files, type="salmon", tx2gene=mapping, dropInfReps=TRUE)',
        'mapping <- read.csv("inputs/new-map.csv")'
      ],
      'open-science-transcript-mapping-'
    )
    expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('invalidates a spectrum reader when its input path changes', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from pyteomics import mgf\npath = "inputs/a.mgf"',
        'reader = mgf.MGF(path)',
        'path = "inputs/b.mgf"'
      ],
      'open-science-spectrum-inputs-'
    )
    expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('keeps a deterministic Matplotlib tuple loop clear when only its labels are static', async () => {
    const [facts] = await analyzePythonSources([
      [
        'import numpy as np, matplotlib',
        'matplotlib.use("Agg")',
        'import matplotlib.pyplot as plt',
        'x = np.linspace(0, 2 * np.pi, 400)',
        'for name, y, color in [("sin", np.sin(x), "tab:blue"), ("cos", np.cos(x), "tab:red")]:',
        '    fig, ax = plt.subplots(figsize=(6, 3.5), dpi=150)',
        '    ax.plot(x, y, color=color)',
        '    ax.set_title(f"y = {name}(x)"); ax.set_xlabel("x"); ax.set_ylabel(f"{name}(x)")',
        '    ax.axhline(0, color="gray", lw=0.5); ax.grid(alpha=0.3)',
        '    fig.tight_layout(); fig.savefig(f"{name}.png"); plt.close(fig)',
        'print("ok")'
      ].join('\n')
    ])

    expect(facts?.state).toBe('available')
  })

  it.each([
    ['zip', 'for name, y in zip(("sin", "cos"), (np.sin(x), np.cos(x))):'],
    ['enumerate', 'for index, y in enumerate((np.sin(x), np.cos(x)), start=1):']
  ])(
    'keeps a deterministic Matplotlib %s loop clear when only output labels are static',
    async (_name, loop) => {
      const [facts] = await analyzePythonSources([
        [
          'import numpy as np',
          'import matplotlib.pyplot as plt',
          'x = np.linspace(0, 2 * np.pi, 400)',
          loop,
          '    fig, ax = plt.subplots()',
          '    ax.plot(x, y)',
          '    fig.savefig("plot.png")',
          '    plt.close(fig)'
        ].join('\n')
      ])

      expect(facts?.state).toBe('available')
    }
  )

  it('keeps a deterministic Matplotlib dictionary loop clear when only keys are static', async () => {
    const [facts] = await analyzePythonSources([
      [
        'import numpy as np',
        'import matplotlib.pyplot as plt',
        'x = np.linspace(0, 2 * np.pi, 400)',
        'plots = {"sin": np.sin(x), "cos": np.cos(x)}',
        'for name, y in plots.items():',
        '    fig, ax = plt.subplots()',
        '    ax.plot(x, y)',
        '    fig.savefig(f"{name}.png")',
        '    plt.close(fig)'
      ].join('\n')
    ])

    expect(facts?.state).toBe('available')
  })

  it.each([
    [
      'named list values',
      [
        'x <- seq(0, 2 * pi, length.out = 400)',
        'plots <- list(sin = sin(x), cos = cos(x))',
        'for (name in names(plots)) {',
        '  png(sprintf("%s.png", name))',
        '  plot(x, plots[[name]], type = "l")',
        '  dev.off()',
        '}'
      ].join('\n')
    ],
    [
      'local computed assignments',
      [
        'x <- seq(0, 2 * pi, length.out = 400)',
        'for (name in c("sin", "cos")) {',
        '  y <- sin(x)',
        '  png(sprintf("%s.png", name))',
        '  plot(x, y, type = "l")',
        '  dev.off()',
        '}'
      ].join('\n')
    ]
  ])('keeps a deterministic R loop with %s clear', async (_name, source) => {
    const [facts] = await analyzeRSources([source])

    expect(facts?.state).toBe('available')
  })

  it('classifies a common base R read-clean-aggregate workflow as clear', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-base-analysis-'))
    temporaryRoots.push(storageRoot)
    const run = completedRun(
      'run-1',
      'r-base-analysis',
      'r',
      [
        'data <- read.csv("measurements.csv")',
        'clean <- na.omit(data)',
        'summary <- aggregate(value ~ group, data = clean, FUN = mean)',
        'summary <- summary[order(summary$value, decreasing = TRUE), ]',
        'write.csv(summary, "summary.csv", row.names = FALSE)',
        'print(summary)'
      ].join('\n')
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [run]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun: run,
      interpreter: unusedInterpreter('r')
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps directly imported NumPy function effects across runs', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-numpy-import-runs-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'from numpy import linspace, sin, pi',
      'x = linspace(-2 * pi, 2 * pi, 400)',
      'y = sin(x)\nprint(y.min(), y.max())'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const run = {
        ...completedRun(`run-${index + 1}`, `cell-${index + 1}`, 'python', script),
        startedAt: index + 1,
        endedAt: index + 1,
        executionCount: index + 1
      }
      runs.push(run)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun: run,
        interpreter: unusedInterpreter('python')
      })
    }

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' }
    })
  })

  it('freezes a direct-import call effect before a same-run rebind', async () => {
    const projection = await projectScripts(
      'python',
      ['from numpy import sin\nx = [0.0]\ny = sin(x)\nsin = abs\nprint(y)'],
      'open-science-python-import-rebind-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies direct imports of common NumPy functions as clear', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-numpy-imports-'))
    temporaryRoots.push(storageRoot)
    const run = completedRun(
      'run-1',
      'numpy-direct-imports',
      'python',
      [
        'from numpy import linspace, sin, pi',
        'x = linspace(-2 * pi, 2 * pi, 400)',
        'y = sin(x)',
        'print(x.min(), x.max(), y.min(), y.max())'
      ].join('\n')
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [run]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun: run,
      interpreter: unusedInterpreter('python')
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a common pandas cleaning and grouped-summary chain as clear', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-pandas-chain-'))
    temporaryRoots.push(storageRoot)
    const run = completedRun(
      'run-1',
      'pandas-summary',
      'python',
      [
        'import pandas as pd',
        'df = pd.read_csv("measurements.csv")',
        'summary = (',
        '    df.dropna(subset=["group", "value"])',
        '      .groupby("group", as_index=False)["value"]',
        '      .mean()',
        '      .sort_values("value", ascending=False)',
        ')',
        'print(summary.head())'
      ].join('\n')
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [run]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun: run,
      interpreter: unusedInterpreter('python')
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a common NumPy and Matplotlib plotting workflow as clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import numpy as np',
          'import matplotlib.pyplot as plt',
          'x = np.linspace(-2 * np.pi, 2 * np.pi, 400)',
          'y = np.sin(x)',
          'fig, ax = plt.subplots(figsize=(8, 4.5))',
          'ax.plot(x, y, color="#2b6cb0", linewidth=2, label=r"$\\sin(x)$")',
          'for k in range(-2, 3):',
          '    ax.axvline(k * np.pi, color="gray", linestyle=":", alpha=0.4)',
          'ax.set_xlabel("x")',
          'ax.set_ylabel("sin(x)")',
          'ax.set_title("Sine function")',
          'ax.axhline(0, color="black", linewidth=0.8)',
          'ax.set_xticks([-2*np.pi, -np.pi, 0, np.pi, 2*np.pi])',
          'ax.set_xticklabels([r"$-2\\pi$", r"$-\\pi$", r"$0$", r"$\\pi$", r"$2\\pi$"])',
          'ax.set_ylim(-1.2, 1.2)',
          'ax.grid(True, linestyle="--", alpha=0.5)',
          'ax.legend()',
          'plt.tight_layout()',
          'plt.savefig("sin_plot.png", dpi=120)',
          'print("Saved: sin_plot.png")'
        ].join('\n')
      ],
      'open-science-python-matplotlib-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps common pyplot and stdlib CSV plotting runs clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import numpy as np',
          'import matplotlib.pyplot as plt',
          'x = np.linspace(0, 2 * np.pi, 1000)',
          'y = np.sin(x)',
          'fig, ax = plt.subplots(figsize=(10, 6))',
          'ax.plot(x, y, label="sin(x)", color="blue", linewidth=2)',
          'ax.axhline(0, color="black", linewidth=0.5)',
          'ax.axvline(0, color="black", linewidth=0.5)',
          'ax.set_xlabel("x (radians)")',
          'ax.set_ylabel("sin(x)")',
          'ax.set_title("Sine Function")',
          'ax.legend()',
          'ax.grid(True, alpha=0.3)',
          'plt.tight_layout()',
          'plt.savefig("sine_plot.png", dpi=100)',
          'plt.show()',
          'print("Plot saved as sine_plot.png")'
        ].join('\n'),
        [
          'import csv',
          'import matplotlib.pyplot as plt',
          'from collections import Counter',
          'groups = []',
          'with open("groups.csv", "r") as f:',
          '    reader = csv.DictReader(f)',
          '    for row in reader:',
          '        groups.append(row["group"])',
          'counts = Counter(groups)',
          'labels = list(counts.keys())',
          'sizes = list(counts.values())',
          'fig, ax = plt.subplots(figsize=(8, 8))',
          'ax.pie(sizes, labels=labels, autopct="%1.1f%%")',
          'ax.axis("equal")',
          'plt.tight_layout()',
          'plt.savefig("group_pie_chart.png", dpi=100)',
          'plt.show()',
          'print(dict(counts))'
        ].join('\n')
      ],
      'open-science-python-common-plotting-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' }
    })
  })

  it('keeps a local collection loop scoped to that collection', async () => {
    const projection = await projectScripts(
      'python',
      ['groups = []\nfor row in rows:\n    groups.append(row["group"])\nprint(groups)'],
      'open-science-python-local-collection-loop-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies common csv and Counter construction as scoped reads', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import csv',
          'from collections import Counter',
          'with open("groups.csv", "r") as handle:',
          '    reader = csv.DictReader(handle)',
          'counts = Counter([])',
          'print(dict(counts))'
        ].join('\n')
      ],
      'open-science-python-csv-counter-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a standard-library compressed-file pipeline as clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import gzip',
          "with gzip.open('measurements.csv.gz', 'rt') as stream:",
          '    payload = stream.read()',
          "with gzip.open('summary.txt.gz', 'wt') as stream:",
          '    stream.write(payload)'
        ].join('\n')
      ],
      'open-science-python-gzip-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('tracks an Astropy FITS HDU handoff across cells', async () => {
    const projection = await projectScripts(
      'python',
      [
        "from astropy.io import fits\nhdul = fits.open('inputs/source.fits')",
        "hdul.writeto('outputs/result.fits', overwrite=True)"
      ],
      'open-science-python-astropy-fits-'
    )

    expect(projection.dependenciesByRunId?.['run-2']).toEqual(['run-1'])
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })

  it.each([
    [
      'temporary file',
      "import tempfile\nwith tempfile.NamedTemporaryFile() as stream:\n    stream.write(b'data')"
    ],
    [
      'SQLite connection',
      "import sqlite3\nconnection = sqlite3.connect('results.sqlite')\nconnection.execute('select 1')"
    ],
    [
      'DuckDB connection',
      "import duckdb\nconnection = duckdb.connect('results.duckdb')\nconnection.sql('select 1')"
    ]
  ])('keeps a Python %s conservative', async (_label, script) => {
    const [facts] = await analyzePythonSources([script])

    expect(facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it.each(['connection', 'cursor'])('keeps SQLite %s execution conservative', async (receiver) => {
    const statements = [
      'SELECT value FROM measurements',
      'UPDATE measurements SET value = 2',
      'INSERT INTO measurements VALUES (3)',
      'DELETE FROM measurements',
      'CREATE TABLE measurements (value INTEGER)'
    ]
    for (const statement of statements) {
      const [facts] = await analyzePythonSources([
        [
          'import sqlite3',
          'connection = sqlite3.connect("file:inputs/data.sqlite?mode=ro", uri=True)',
          'cursor = connection.cursor()',
          `${receiver}.execute(${JSON.stringify(statement)})`
        ].join('\n')
      ])
      expect(facts, statement).toMatchObject({
        state: 'unknown',
        reasons: expect.arrayContaining(['external-state'])
      })
      const [laterFacts] = await analyzePythonSources(
        [`${receiver}.execute(${JSON.stringify(statement)})`],
        {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          pythonBindings: [
            { name: 'connection', qualifiedName: 'sqlite3.Connection', kind: 'object' },
            { name: 'cursor', qualifiedName: 'sqlite3.Cursor', kind: 'object' }
          ],
          resolvedKernelNames: ['connection', 'cursor']
        }
      )
      expect(laterFacts, `later cell: ${statement}`).toMatchObject({
        state: 'unknown',
        reasons: expect.arrayContaining(['external-state']),
        usedNames: expect.arrayContaining([receiver]),
        receiverCalls: expect.arrayContaining([
          expect.objectContaining({ receiver, member: 'execute' })
        ])
      })
    }
  })

  it('keeps an R DBI connection conservative', async () => {
    const projection = await projectScripts(
      'r',
      [
        "connection <- DBI::dbConnect(RSQLite::SQLite(), 'results.sqlite')\nDBI::dbGetQuery(connection, 'select 1')"
      ],
      'open-science-r-dbi-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it('retains a readonly SQLite input through scientific cursor continuation and cache reload', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-sqlite-scientific-'))
    temporaryRoots.push(storageRoot)
    const scripts = [
      'reference <- utils::read.csv("inputs/observations.csv")',
      [
        'import sqlite3',
        'import pandas as pd',
        'conn = sqlite3.connect("file:inputs/observations.sqlite?mode=ro", uri=True)',
        'cur = conn.cursor()',
        'cur.execute("SELECT row_id, Plant, uptake FROM observations ORDER BY row_id")',
        'baseline_fetched = cur.fetchall()',
        'baseline = pd.DataFrame(baseline_fetched, columns=["row_id", "Plant", "uptake"])',
        'baseline.to_csv("outputs/baseline.csv", index=False)',
        'cur.execute("SELECT Plant, COUNT(*), SUM(uptake), AVG(uptake) FROM observations GROUP BY Plant ORDER BY Plant")',
        'baseline_summary = pd.DataFrame(cur.fetchall(), columns=["Plant", "n", "sum", "mean"])',
        'baseline_summary.to_csv("outputs/baseline-summary.csv", index=False)',
        'print("LIVE_IDS", id(conn), id(cur))',
        'print(sorted(baseline_summary["n"].unique().tolist()))'
      ].join('\n'),
      [
        'cur.execute("SELECT row_id, Plant, uptake FROM observations WHERE conc >= ? ORDER BY row_id", (500,))',
        'changed_fetched = cur.fetchall()',
        'changed = pd.DataFrame(changed_fetched, columns=["row_id", "Plant", "uptake"])',
        'changed.to_csv("outputs/changed.csv", index=False)',
        'cur.execute("SELECT Plant, COUNT(*), SUM(uptake), AVG(uptake) FROM observations WHERE conc >= ? GROUP BY Plant ORDER BY Plant", (500,))',
        'changed_summary = pd.DataFrame(cur.fetchall(), columns=["Plant", "n", "sum", "mean"])',
        'changed_summary.to_csv("outputs/changed-summary.csv", index=False)',
        'print("LIVE_IDS", id(conn), id(cur))',
        'print(sorted(changed_summary["n"].unique().tolist()))'
      ].join('\n')
    ]
    const runs = scripts.map((script, index) => ({
      ...completedRun(
        `run-${index + 1}`,
        `cell-${index + 1}`,
        index === 0 ? 'r' : 'python',
        script
      ),
      cwdBefore: storageRoot,
      cwdAfter: storageRoot,
      startedAt: index + 1,
      endedAt: index + 1,
      executionCount: index + 1
    }))
    const options = { storageRoot, repository: { readSessionRuns: async () => runs } }
    const request = { projectId: 'default-project', sessionId: 'session-1' }
    const analyzer = new NotebookDependencyAnalyzer(options)
    const projection = await analyzer.project(request)
    const contextRequest = {
      ...request,
      currentRunId: 'run-3',
      language: 'python' as const,
      environment: 'default-python',
      kernelEpochId: 'epoch-1'
    }
    const beforeReload = await analyzer.sourceFileAccessContext(contextRequest)
    const reloaded = new NotebookDependencyAnalyzer(options)
    const context = await reloaded.sourceFileAccessContext(contextRequest)
    const result = await analyzePythonNotebookSource(scripts[2]!, context)

    expect(projection.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(await reloaded.project(request)).toEqual(projection)
    expect(context).toEqual(beforeReload)
    expect(context?.pythonBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'conn',
          qualifiedName: 'sqlite3.Connection',
          filePath: 'inputs/observations.sqlite'
        }),
        expect.objectContaining({
          name: 'cur',
          qualifiedName: 'sqlite3.Cursor',
          filePath: 'inputs/observations.sqlite'
        })
      ])
    )
    expect(
      normalizeNotebookSourceFileAccess('python', result.facts, result.fileAccess, context)
    ).toMatchObject({
      reads: ['inputs/observations.sqlite'],
      writes: ['outputs/changed-summary.csv', 'outputs/changed.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect(result.facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  describe('SQLite scientific context boundaries', () => {
    const setup = [
      'import sqlite3',
      'conn = sqlite3.connect("file:inputs/observations.sqlite?mode=ro", uri=True)',
      'cur = conn.cursor()',
      'cur.execute("SELECT Plant, COUNT(*), SUM(uptake), AVG(uptake) FROM observations GROUP BY Plant ORDER BY Plant")',
      'baseline_rows = cur.fetchall()',
      'import pandas as pd',
      'summary = pd.DataFrame(baseline_rows, columns=["Plant", "n", "uptake_sum", "uptake_mean"])',
      'print(sorted(summary["n"].unique().tolist()))'
    ].join('\n')
    const select =
      'cur.execute("SELECT row_id, uptake FROM observations WHERE conc >= ? ORDER BY row_id", (500,))\nchanged_rows = cur.fetchall()'
    const owner = async (
      producer = setup
    ): Promise<{
      storageRoot: string
      runs: NotebookRunRecord[]
      options: ConstructorParameters<typeof NotebookDependencyAnalyzer>[0]
      contextRequest: Parameters<NotebookDependencyAnalyzer['sourceFileAccessContext']>[0]
      analyzer: NotebookDependencyAnalyzer
    }> => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-sqlite-context-boundary-'))
      temporaryRoots.push(storageRoot)
      const runs: NotebookRunRecord[] = [producer, select].map((script, index) => ({
        ...completedRun(`run-${index + 1}`, `cell-${index + 1}`, 'python', script),
        cwdBefore: storageRoot,
        cwdAfter: storageRoot,
        startedAt: index + 1,
        endedAt: index + 1,
        executionCount: index + 1
      }))
      const options = { storageRoot, repository: { readSessionRuns: async () => runs } }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const contextRequest = {
        ...request,
        currentRunId: 'run-2',
        language: 'python' as const,
        environment: 'default-python',
        kernelEpochId: 'epoch-1'
      }
      const analyzer = new NotebookDependencyAnalyzer(options)
      await analyzer.project(request)
      return { storageRoot, runs, options, contextRequest, analyzer }
    }

    it.each(['missing current run', 'missing current cwd', 'opaque snapshot helper'])(
      'discards the relative SQLite input after %s',
      async (barrier) => {
        const source =
          barrier === 'opaque snapshot helper'
            ? `${setup}\ndef snapshot():\n    return inspect_runtime()\nbaseline_state = snapshot()`
            : setup
        const { runs, options, contextRequest } = await owner(source)
        if (barrier === 'missing current run') runs.pop()
        if (barrier === 'missing current cwd') runs[1]!.cwdBefore = undefined
        const context = await new NotebookDependencyAnalyzer(options).sourceFileAccessContext(
          contextRequest
        )
        const result = await analyzePythonNotebookSource(select, context)

        expect(
          context?.pythonBindings?.some(({ filePath }) => filePath !== undefined) ?? false
        ).toBe(false)
        expect(
          normalizeNotebookSourceFileAccess('python', result.facts, result.fileAccess, context)
        ).toMatchObject({
          reads: [],
          readState: 'partial'
        })
      }
    )

    it.each(['malformed SQLite path', 'obsolete analyzer version'])(
      'rebuilds the scientific context after a cached %s',
      async (corruption) => {
        const { storageRoot, options, contextRequest, analyzer } = await owner()
        const expected = await analyzer.sourceFileAccessContext(contextRequest)
        const cachePath = join(
          storageRoot,
          'notebooks/default-project/session-1/cache/dependency-analysis.json'
        )
        const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
          analyzerVersion: number
          runs: Record<
            string,
            {
              fileContext: {
                staticStrings: Array<{ name: string; value: string }>
                pythonBindings: Array<{
                  name: string
                  qualifiedName: string
                  kind: string
                  filePath?: unknown
                }>
              }
            }
          >
        }
        const cachedContext = cache.runs['run-1'].fileContext
        // This otherwise valid marker exposes silent acceptance of the corrupted cache.
        cachedContext.staticStrings.push({ name: 'cache_only', value: 'poison.csv' })
        if (corruption === 'malformed SQLite path') {
          cachedContext.pythonBindings.push({
            name: 'cache_cursor',
            qualifiedName: 'sqlite3.Cursor',
            kind: 'object',
            filePath: []
          })
        } else {
          cache.analyzerVersion -= 1
        }
        await writeFile(cachePath, JSON.stringify(cache))

        const context = await new NotebookDependencyAnalyzer(options).sourceFileAccessContext(
          contextRequest
        )
        expect(context).toEqual(expected)
        const result = await analyzePythonNotebookSource(select, context)
        expect(
          normalizeNotebookSourceFileAccess('python', result.facts, result.fileAccess, context)
        ).toMatchObject({
          reads: ['inputs/observations.sqlite'],
          readState: 'partial',
          externalState: 'partial'
        })
      }
    )
  })

  it('classifies common pandas value-file readers as data frame reads', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import pandas as pd',
          'from pandas import read_sas',
          'table = pd.read_table("measurements.tsv")',
          'fixed = pd.read_fwf("measurements.txt")',
          'sas = pd.read_sas("measurements.sas7bdat")',
          'spss = pd.read_spss("measurements.sav")',
          'stata = pd.read_stata("measurements.dta")',
          'orc = pd.read_orc("measurements.orc")',
          'xml = pd.read_xml("measurements.xml")',
          'query = pd.read_sql_query("select * from measurements", connection)',
          'preview = pd.read_table("preview.tsv").head()',
          'direct = read_sas("preview.sas7bdat").head()',
          'print(table.head(), fixed.head(), sas.head(), spss.head())',
          'print(stata.head(), orc.head(), xml.head(), query.head(), preview, direct)'
        ].join('\n')
      ],
      'open-science-python-pandas-value-readers-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it.each([
    ['NumPy text', 'import numpy as np\ndata = np.loadtxt("matrix.tsv")'],
    [
      'NumPy missing-value text',
      'import numpy as np\ndata = np.genfromtxt("matrix.csv", delimiter=",")'
    ],
    ['NumPy binary', 'import numpy as np\ndata = np.fromfile("matrix.bin", dtype=np.float64)'],
    ['SciPy WAV', 'from scipy.io import wavfile\nsample_rate, data = wavfile.read("signal.wav")'],
    ['Matplotlib image', 'import matplotlib.image as mpimg\ndata = mpimg.imread("figure.png")'],
    ['imageio', 'import imageio.v3 as iio\ndata = iio.imread("figure.tiff")'],
    ['scikit-image', 'from skimage import io\ndata = io.imread("figure.jpg")'],
    ['tifffile', 'import tifffile\ndata = tifffile.imread("figure.tiff")'],
    [
      'tifffile handle',
      'import tifffile\nwith tifffile.TiffFile("figure.tiff") as tif:\n    data = tif.asarray()'
    ],
    ['OpenCV', 'import cv2\ndata = cv2.imread("figure.png")']
  ])('tracks a %s file reader as an ndarray producer', async (_label, setup) => {
    const projection = await projectScripts(
      'python',
      [setup, 'snapshot = data.mean()\nprint(snapshot)', 'data.fill(0)'],
      'open-science-python-ndarray-reader-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    ['Dataset', 'dataset = xr.open_dataset("climate.nc")'],
    ['multi-file Dataset', 'dataset = xr.open_mfdataset("climate-*.nc")'],
    ['DataArray', 'dataset = xr.open_dataarray("temperature.nc")'],
    ['Zarr Dataset', 'dataset = xr.open_zarr("climate.zarr")']
  ])('tracks an xarray %s reader and its loaded state', async (_label, read) => {
    const projection = await projectScripts(
      'python',
      [
        `import xarray as xr\n${read}`,
        'snapshot = dataset.mean()\nprint(snapshot)',
        'dataset.load()'
      ],
      'open-science-python-xarray-reader-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('carries a Python Arrow Dataset handle and later table reads across cells', async () => {
    const scripts = [
      'import pyarrow.dataset as ds\ndataset = ds.dataset("inputs/events")',
      'table = dataset.to_table()\nprint(table)',
      'rows = dataset.count_rows()\nprint(rows)'
    ]
    const facts = await analyzePythonSources(scripts)
    expect(facts[0]?.typeBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'dataset', typeName: 'pyarrow.dataset.Dataset' })
      ])
    )
    expect(facts[1]?.receiverCalls).toEqual(
      expect.arrayContaining([expect.objectContaining({ receiver: 'dataset', member: 'to_table' })])
    )
    expect(facts[2]?.receiverCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ receiver: 'dataset', member: 'count_rows' })
      ])
    )
  })

  it.each([
    [
      'Pillow image',
      'from PIL import Image\nitem = Image.open("figure.png")',
      'snapshot = item.getbbox()\nprint(snapshot)',
      'item.paste((0, 0, 0), (0, 0, 1, 1))'
    ],
    [
      'AnnData',
      'import anndata as ad\nitem = ad.read_h5ad("cells.h5ad")',
      'snapshot = item.n_obs\nprint(snapshot)',
      'item.obs_names_make_unique()'
    ],
    [
      'Scanpy AnnData',
      'import scanpy as sc\nitem = sc.read_10x_mtx("matrix")',
      'snapshot = item.n_obs\nprint(snapshot)',
      'item.var_names_make_unique()'
    ],
    [
      'Nibabel image',
      'import nibabel as nib\nitem = nib.load("brain.nii.gz")',
      'snapshot = item.shape\nprint(snapshot)',
      'item.update_header()'
    ]
  ])(
    'tracks a %s file reader and its domain-object mutation',
    async (_label, setup, consume, mutate) => {
      const projection = await projectScripts(
        'python',
        [setup, consume, mutate],
        'open-science-python-domain-reader-corpus-'
      )

      expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
      expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    }
  )

  it.each([
    ['pickle', 'import pickle\nitem = pickle.load(handle)'],
    ['joblib', 'import joblib\nitem = joblib.load("model.joblib")'],
    ['torch', 'import torch\nitem = torch.load("model.pt")'],
    ['dill', 'import dill\nitem = dill.load(handle)'],
    ['cloudpickle', 'import cloudpickle\nitem = cloudpickle.load(handle)']
  ])('keeps %s arbitrary-object deserialization namespace-unknown', async (_label, source) => {
    const projection = await projectScripts(
      'python',
      [source],
      'open-science-python-unsafe-deserializer-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call', 'dynamic-namespace'])
    })
  })

  it('treats a variable file argument as a possible consumed handle', async () => {
    const projection = await projectScripts(
      'python',
      [
        'handle = open("matrix.bin", "rb")',
        'snapshot = handle\nprint(snapshot)',
        'import numpy as np\ndata = np.fromfile(handle, dtype=np.float64)'
      ],
      'open-science-python-consumed-file-handle-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    ['keyword', 'import numpy as np\ndata = np.fromfile(file=handle, dtype=np.float64)'],
    ['direct import', 'from numpy import fromfile\ndata = fromfile(handle, dtype=np.float64)'],
    ['pandas keyword', 'import pandas as pd\ndata = pd.read_csv(filepath_or_buffer=handle)'],
    ['Pillow keyword', 'from PIL import Image\ndata = Image.open(fp=handle)'],
    ['xarray keyword', 'import xarray as xr\ndata = xr.open_dataset(filename_or_obj=handle)']
  ])('tracks a file handle passed through a NumPy %s call', async (_label, read) => {
    const projection = await projectScripts(
      'python',
      ['handle = open("matrix.bin", "rb")', 'snapshot = handle\nprint(snapshot)', read],
      'open-science-python-consumed-file-handle-variant-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    ['positional', 'frame = pd.read_sql_query("select * from samples", connection)'],
    ['named', 'frame = pd.read_sql_query("select * from samples", con=connection)']
  ])('treats a %s pandas SQL connection as possibly consumed', async (_label, read) => {
    const projection = await projectScripts(
      'python',
      [
        'connection = {"dsn": "memory"}',
        'snapshot = connection\nprint(snapshot)',
        `import pandas as pd\n${read}`
      ],
      'open-science-python-consumed-sql-connection-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps a copied SimpleITK array independent from its image', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import SimpleITK as sitk\nimage = sitk.ReadImage("ct.nii.gz")',
        'snapshot = image.GetSize()\nprint(snapshot)',
        'data = sitk.GetArrayFromImage(image)',
        'data.fill(0)'
      ],
      'open-science-simpleitk-array-copy-'
    )
    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })

  it.each(['GetArrayFromImage', 'GetArrayViewFromImage'])(
    'invalidates a dependent result after an image mutation through %s',
    async (method) => {
      const projection = await projectScripts(
        'python',
        [
          'import SimpleITK as sitk\nimage = sitk.ReadImage("ct.nii.gz")',
          `data = sitk.${method}(image)`,
          'snapshot = data.mean()\nprint(snapshot)',
          'image.SetPixel(0, 0, 1)'
        ],
        'open-science-simpleitk-array-input-'
      )
      expect(projection?.stalenessByRunId['run-3']).toMatchObject({
        state: expect.stringMatching(/^(stale|unknown)$/u)
      })
    }
  )

  it('keeps Nibabel cached data as a possible alias of the image', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import nibabel as nib\nimage = nib.load("brain.nii.gz")',
        'snapshot = image.shape\nprint(snapshot)',
        'data = image.get_fdata()',
        'data.fill(0)'
      ],
      'open-science-python-nibabel-cache-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('tracks a Nibabel image write as a file producer across cells', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import nibabel as nib\nimage = nib.load("inputs/brain.nii.gz")',
        'image.to_filename("work/normalized-brain.nii.gz")',
        'normalized = nib.load("work/normalized-brain.nii.gz")\nprint(normalized.shape)'
      ],
      'open-science-python-nibabel-file-lineage-'
    )

    expect(projection?.dependenciesByRunId?.['run-2']).toEqual(expect.arrayContaining(['run-1']))
    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks a pandas input through a grouped summary and later replacement', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\ndf = pd.read_csv("measurements.csv")',
        [
          'summary = (df.dropna(subset=["group", "value"])',
          '  .groupby("group")["value"]',
          '  .mean()',
          '  .sort_values(ascending=False))',
          'print(summary)'
        ].join('\n'),
        'df = pd.read_csv("updated-measurements.csv")'
      ],
      'open-science-python-pandas-lineage-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('classifies a common pandas value-count pie chart as clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import pandas as pd',
          'import matplotlib.pyplot as plt',
          'df = pd.read_csv("groups.csv")',
          'counts = df["group"].value_counts()',
          'print(counts.to_dict())',
          'plt.figure(figsize=(6, 6))',
          'plt.pie(counts.values, labels=counts.index, autopct="%1.1f%%")',
          'plt.title("Sample Group Distribution")',
          'plt.tight_layout()',
          'plt.savefig("group_pie.png", dpi=120)',
          'plt.show()'
        ].join('\n')
      ],
      'open-science-python-pandas-plot-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a common pandas join-reshape-export workflow as clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import pandas as pd',
          'samples = pd.read_csv("samples.csv")',
          'measurements = pd.read_csv("measurements.csv")',
          'merged = samples.merge(measurements, on="sample_id", how="left")',
          'report = (',
          '    merged.assign(ratio=merged["value"] / merged["total"])',
          '      .pivot_table(index="group", values="ratio", aggfunc="mean")',
          '      .reset_index()',
          '      .rename(columns={"ratio": "mean_ratio"})',
          '      .sort_values("mean_ratio", ascending=False)',
          ')',
          'report.to_csv("report.csv", index=False)',
          'print(report.head())'
        ].join('\n')
      ],
      'open-science-python-pandas-reshape-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('tracks both inputs of a pandas join across runs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nsamples = pd.read_csv("samples.csv")\nmeasurements = pd.read_csv("measurements.csv")',
        'report = samples.merge(measurements, on="sample_id", how="left")\nprint(report.head())',
        'measurements = pd.read_csv("updated-measurements.csv")'
      ],
      'open-science-python-pandas-join-lineage-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('does not treat pandas merge configuration as aliased data', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nleft = pd.DataFrame({"id": [1], "value": [1]})\nright = pd.DataFrame({"id": [1], "other": [2]})\nkey = "id"\nmode = "left"',
        'key_snapshot = key\nprint(key_snapshot)',
        'left_snapshot = len(left)\nprint(left_snapshot)',
        'combined = pd.merge(left, right, how=mode, on=key, copy=False)\ncombined["value"] = [9]'
      ],
      'open-science-python-pandas-merge-configuration-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it.each(['shallow = frame.copy(deep=False)', 'shallow = frame.copy(False)'])(
    'keeps pandas shallow-copy relationships conservative for %s',
    async (copyExpression) => {
      const projection = await projectScripts(
        'python',
        [
          'import pandas as pd\nframe = pd.DataFrame({"value": [1, 2, 3]})',
          'snapshot = len(frame)\nprint(snapshot)',
          `${copyExpression}\nshallow["value"] = [4, 5, 6]`
        ],
        'open-science-python-pandas-shallow-copy-corpus-'
      )

      expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
      expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    }
  )

  it('does not invent a pandas alias for the default deep-copy path', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nframe = pd.DataFrame({"value": [1, 2, 3]})',
        'snapshot = len(frame)\nprint(snapshot)',
        'copied = frame.copy()\ncopied["value"] = [4, 5, 6]'
      ],
      'open-science-python-pandas-default-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    'converted = frame.astype(float, copy=False)',
    'converted = frame.astype(float, False)'
  ])('keeps pandas no-copy conversions conservative for %s', async (copyExpression) => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nframe = pd.DataFrame({"value": [1, 2, 3]})',
        'snapshot = len(frame)\nprint(snapshot)',
        `${copyExpression}\nconverted["value"] = [4, 5, 6]`
      ],
      'open-science-python-pandas-astype-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    'combined = pd.concat([left, right], copy=False)',
    'combined = pd.merge(left=left, right=right, on="id", copy=False)',
    'combined = left.merge(right, on="id", copy=False)'
  ])('keeps pandas no-copy joins conservative for %s', async (mergeExpression) => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nleft = pd.DataFrame({"id": [1], "value": [1]})\nright = pd.DataFrame({"id": [1], "other": [2]})',
        'snapshot = left["value"].sum()\nprint(snapshot)',
        `${mergeExpression}\ncombined["value"] = [9]`
      ],
      'open-science-python-pandas-no-copy-join-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps dynamic pandas callbacks unknown while literal mappings remain analyzable', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nfrom transforms import rename_column\nframe = pd.DataFrame({"value": [1, 2, 3]})',
        'literal = frame.rename(columns={"value": "measurement"})\nprint(literal.head())',
        'dynamic = frame.rename(columns=rename_column)\nprint(dynamic.head())',
        'aggregated = frame.pivot_table(values="value", aggfunc=[rename_column])\nprint(aggregated)'
      ],
      'open-science-python-pandas-callback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
  })

  it('keeps a nested pandas callback conservative across runs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nfrom transforms import aggregate\nframe = pd.DataFrame({"value": [1, 2, 3]})',
        'result = frame.pivot_table(values="value", aggfunc=[aggregate])\nprint(result)'
      ],
      'open-science-python-pandas-nested-callback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('keeps a registered pure NumPy callback analyzable in pandas', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nimport pandas as pd\nframe = pd.DataFrame({"group": ["a", "a"], "value": [1, 2]})\nresult = frame.pivot_table(index="group", values="value", aggfunc=np.mean)\nprint(result)'
      ],
      'open-science-python-pandas-known-callback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps a registered pure callback analyzable through a module alias', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nimport pandas as pd\nn = np\nframe = pd.DataFrame({"group": ["a", "a"], "value": [1, 2]})\nresult = frame.pivot_table(index="group", values="value", aggfunc=n.mean)\nprint(result)'
      ],
      'open-science-python-pandas-aliased-callback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('does not treat values inside a pandas rename mapping as callbacks', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nnew_name = "measurement"\nmapping = {"value": new_name}\nframe = pd.DataFrame({"value": [1, 2, 3]})\nrenamed = frame.rename(columns=mapping)\nprint(renamed.head())'
      ],
      'open-science-python-pandas-mapping-value-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('does not treat a plain pandas assign value as a callback', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nlabel = "control"\nframe = pd.DataFrame({"value": [1, 2, 3]})\nassigned = frame.assign(group=label)\nprint(assigned.head())'
      ],
      'open-science-python-pandas-assign-value-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it.each([
    {
      setup: 'from custom import build_value\ncallback = build_value',
      callback: 'callback'
    },
    { setup: 'import custom', callback: 'custom.build_value' }
  ])('keeps imported pandas assign callbacks conservative for $callback', async (scenario) => {
    const projection = await projectScripts(
      'python',
      [
        `import pandas as pd\n${scenario.setup}\nframe = pd.DataFrame({"value": [1, 2, 3]})\nassigned = frame.assign(result=${scenario.callback})\nprint(assigned.head())`
      ],
      'open-science-python-pandas-imported-assign-callback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it.each([
    'summary = frame.groupby("group").sum()',
    'summary = frame.groupby("group")["value"].sum()',
    'reshaped = np.asarray(frame["value"]).reshape(1, -1)'
  ])('resolves common chained scientific return types for %s', async (expression) => {
    const projection = await projectScripts(
      'python',
      [
        `import numpy as np\nimport pandas as pd\nframe = pd.DataFrame({"group": ["a", "a"], "value": [1, 2]})\n${expression}\nprint(frame.head())`
      ],
      'open-science-python-scientific-chain-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps a chained NumPy view linked to its data input', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = [1, 2, 3]\nderived = np.asarray(values).reshape(-1)',
        'snapshot = len(values)\nprint(snapshot)',
        'derived.fill(0)'
      ],
      'open-science-python-numpy-chained-view-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks an inline chained NumPy mutation back to its data input', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = [1, 2, 3]',
        'snapshot = len(values)\nprint(snapshot)',
        'np.asarray(values).reshape(-1).fill(0)'
      ],
      'open-science-python-numpy-inline-chain-mutation-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each(['np.asarray(a=values).reshape(-1).fill(0)', 'values.astype(float, copy=False).fill(0)'])(
    'tracks conditional and keyword NumPy chain provenance for %s',
    async (expression) => {
      const projection = await projectScripts(
        'python',
        [
          'import numpy as np\nvalues = np.asarray([1, 2, 3])',
          'snapshot = values.sum()\nprint(snapshot)',
          expression
        ],
        'open-science-python-numpy-chain-arguments-corpus-'
      )

      expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
      expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    }
  )

  it.each(['values.copy().fill(0)', 'frame.copy().fillna(0, inplace=True)'])(
    'does not link a fresh chained copy back to its source for %s',
    async (expression) => {
      const projection = await projectScripts(
        'python',
        [
          'import numpy as np\nimport pandas as pd\nvalues = np.asarray([1, 2, 3])\nframe = pd.DataFrame({"value": [1, None]})',
          'values_snapshot = values.sum()\nframe_snapshot = len(frame)\nprint(values_snapshot, frame_snapshot)',
          expression
        ],
        'open-science-python-fresh-chain-copy-corpus-'
      )

      expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
      expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    }
  )

  it('resolves a direct-import scientific call chain', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from numpy import asarray\nvalues = [1, 2, 3]\nderived = asarray(values).reshape(-1)\nprint(derived)'
      ],
      'open-science-python-direct-import-chain-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps chained pandas no-copy inputs linked through instance methods', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nleft = pd.DataFrame({"id": [1], "value": [1]})\nright = pd.DataFrame({"id": [1], "other": [2]})\nderived = left.merge(right, on="id", copy=False).astype(float, copy=False)',
        'snapshot = len(right)\nprint(snapshot)',
        'derived["other"] = [9]'
      ],
      'open-science-python-pandas-chained-no-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps a callback container variable conservative across runs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nfrom transforms import aggregate\ncallbacks = [aggregate]\nframe = pd.DataFrame({"value": [1, 2, 3]})',
        'result = frame.pivot_table(values="value", aggfunc=callbacks)\nprint(result)'
      ],
      'open-science-python-pandas-callback-container-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('does not apply pandas copy rules to an unrelated same-named method', async () => {
    const projection = await projectScripts(
      'python',
      [
        'class Box:\n    def copy(self, deep=False):\n        return []\nbox = Box()',
        'snapshot = id(box)\nprint(snapshot)',
        'copied = box.copy(deep=False)\ncopied.append(1)'
      ],
      'open-science-python-method-identity-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })

  it('tracks a mutable file-like output target without tagging the writer run', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nframe = pd.DataFrame({"value": [1, 2, 3]})\nsink = []',
        'snapshot = len(sink)\nprint(snapshot)',
        'frame.to_csv(path_or_buf=sink, index=False)'
      ],
      'open-science-python-pandas-file-like-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks a direct-import scientific writer across runs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from numpy import savetxt\nsink = []\nvalues = [1, 2, 3]',
        'snapshot = len(sink)\nprint(snapshot)',
        'savetxt(fname=sink, X=values)'
      ],
      'open-science-python-direct-writer-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('does not treat a scientific writer data argument as its output target', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from numpy import savetxt\nsink = []',
        'values = [1, 2, 3]',
        'sink_snapshot = len(sink)\nprint(sink_snapshot)',
        'values_snapshot = sum(values)\nprint(values_snapshot)',
        'savetxt(sink, values)'
      ],
      'open-science-python-writer-positional-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('classifies common NumPy reshape and reduction operations as clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import numpy as np',
          'values = np.asarray([1, 2, 3, 4, 5, 6])',
          'matrix = values.reshape(2, 3)',
          'centered = matrix - matrix.mean(axis=0)',
          'bounds = np.concatenate([centered.min(axis=0), centered.max(axis=0)])',
          'summary = np.mean(bounds) + np.std(bounds) + np.min(bounds) + np.max(bounds)',
          'np.savetxt("bounds.csv", bounds, delimiter=",")',
          'print(bounds.tolist(), summary)'
        ].join('\n')
      ],
      'open-science-python-numpy-transform-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it.each([
    'derived = np.asarray(values)',
    'derived = values.reshape(2, 3)',
    'derived = values.ravel()'
  ])('keeps a possible NumPy view relationship conservative for %s', async (viewExpression) => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.array([[1, 2, 3], [4, 5, 6]])',
        'snapshot = values.sum()\nprint(snapshot)',
        `${viewExpression}\nderived.fill(0)`
      ],
      'open-science-python-numpy-view-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps a directly imported NumPy view-producing function conservative', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from numpy import array, asarray\nvalues = array([1, 2, 3])',
        'snapshot = values.sum()\nprint(snapshot)',
        'derived = asarray(values)\nderived.fill(0)'
      ],
      'open-science-python-numpy-imported-view-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks the first positional argument of a NumPy view independently from keyword roots', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.array([1, 2, 3])',
        'snapshot = values.sum()\nprint(snapshot)',
        'derived = np.asarray(dtype=np.float64, a=values)\nderived.fill(0)'
      ],
      'open-science-python-numpy-view-keyword-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks only the first positional argument of a NumPy view', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.array([1, 2, 3])',
        'dtype_spec = "float64"',
        'values_snapshot = values.sum()\nprint(values_snapshot)',
        'dtype_snapshot = str(dtype_spec)\nprint(dtype_snapshot)',
        'derived = np.asarray(values, dtype_spec)\nderived.fill(0)'
      ],
      'open-science-python-numpy-positional-view-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('tracks explicit NumPy output buffers as definite mutations', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\ntarget = np.zeros(4)',
        'snapshot = target.sum()\nprint(snapshot)',
        'np.concatenate([np.ones(2), np.ones(2)], out=target)'
      ],
      'open-science-python-numpy-output-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    ['np.concatenate([values[:1], values[1:]], 0, target)', 'target = np.zeros(2)'],
    ['np.stack([values, values], 0, target)', 'target = np.zeros((2, 2))'],
    ['np.sin(values, target)', 'target = np.zeros(2)']
  ])('tracks positional NumPy output buffers for %s', async (expression, targetSetup) => {
    const projection = await projectScripts(
      'python',
      [
        `import numpy as np\nvalues = np.asarray([1, 2])\n${targetSetup}`,
        'snapshot = target.sum()\nprint(snapshot)',
        expression
      ],
      'open-science-python-numpy-general-positional-output-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks NumPy reduction output buffers as definite mutations', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.asarray([1, 2, 3])\ntarget = np.zeros(1)',
        'snapshot = target.sum()\nprint(snapshot)',
        'np.mean(values, out=target)'
      ],
      'open-science-python-numpy-reduction-output-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each(['np.mean(values, None, None, target)', 'values.mean(None, None, target)'])(
    'tracks positional NumPy reduction output buffers for %s',
    async (expression) => {
      const projection = await projectScripts(
        'python',
        [
          'import numpy as np\nvalues = np.asarray([1, 2, 3])\ntarget = np.zeros(())',
          'snapshot = target.sum()\nprint(snapshot)',
          expression
        ],
        'open-science-python-numpy-positional-output-corpus-'
      )

      expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
      expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    }
  )

  it('does not invent a NumPy alias for the default copy path', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.asarray([1, 2, 3])',
        'snapshot = values.sum()\nprint(snapshot)',
        'derived = np.array(values)\nderived.fill(0)'
      ],
      'open-science-python-numpy-default-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    'derived = np.array(values, copy=False)',
    'derived = values.astype(float, copy=False)',
    'derived = values.astype(float, "K", "unsafe", True, False)'
  ])('keeps explicit NumPy no-copy paths conservative for %s', async (copyExpression) => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.asarray([1, 2, 3])',
        'snapshot = values.sum()\nprint(snapshot)',
        `${copyExpression}\nderived.fill(0)`
      ],
      'open-science-python-numpy-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps runtime NumPy copy flags conservative', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.asarray([1, 2, 3])\ncopy_data = False',
        'snapshot = values.sum()\nprint(snapshot)',
        'derived = np.array(values, copy=copy_data)\nderived.fill(0)'
      ],
      'open-science-python-numpy-runtime-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('marks a prior NumPy result after a definite ndarray mutation', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.array([1, 2, 3])',
        'snapshot = values.sum()\nprint(snapshot)',
        'values.fill(0)'
      ],
      'open-science-python-numpy-mutation-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks a direct SciPy statistic across runs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from scipy.stats import ttest_ind\ngroup_a = [1.0, 2.0, 3.0]\ngroup_b = [2.0, 3.0, 4.0]',
        'result = ttest_ind(group_a, group_b)\nprint(result.statistic, result.pvalue)',
        'group_a = [10.0, 20.0, 30.0]'
      ],
      'open-science-python-scipy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('marks a prior pandas result after an explicit inplace mutation', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\ndf = pd.read_csv("measurements.csv")',
        'row_count = len(df)\nprint(row_count)',
        'df.dropna(inplace=True)'
      ],
      'open-science-python-pandas-inplace-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('marks a prior pandas result unknown when inplace is dynamic', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\ndf = pd.read_csv("measurements.csv")',
        'row_count = len(df)\nprint(row_count)',
        'flag = True\ndf.dropna(inplace=flag)'
      ],
      'open-science-python-pandas-possible-inplace-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('keeps an unknown method at the end of a pandas chain conservative', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\ndf = pd.read_csv("measurements.csv")',
        'row_count = len(df)\nprint(row_count)',
        'df.dropna().custom_mutator()'
      ],
      'open-science-python-pandas-opaque-chain-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('keeps an unknown Python callback conservative', async () => {
    const projection = await projectScripts(
      'python',
      ['baseline = 1\nprint(baseline)', 'custom_pipeline()'],
      'open-science-python-dynamic-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('classifies common base R plotting and file output as clear', async () => {
    const projection = await projectScripts(
      'r',
      [
        [
          'angles <- seq(0, 2*pi, length.out = 9)[1:8]',
          'slices <- abs(c(sin(angles), cos(angles)))',
          'labels <- c(paste0("sin theta=", round(angles, 2)), paste0("cos theta=", round(angles, 2)))',
          'png("sin_cos_pie.png", width = 800, height = 800, res = 120)',
          'pie(slices, labels = labels, main = "Pie chart", col = rainbow(length(slices)))',
          'dev.off()',
          'cat("Saved:", file.exists("sin_cos_pie.png"), "\\n")'
        ].join('\n')
      ],
      'open-science-r-base-plot-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a common dplyr and ggplot2 workflow as clear', async () => {
    const projection = await projectScripts(
      'r',
      [
        [
          'library(dplyr)',
          'library(ggplot2)',
          'df <- data.frame(group = c("A", "A", "B"), value = c(1, 2, 3))',
          'summary <- df |>',
          '  filter(!is.na(value)) |>',
          '  mutate(centered = value - mean(value)) |>',
          '  group_by(group) |>',
          '  summarise(mean_value = mean(value), .groups = "drop") |>',
          '  arrange(desc(mean_value))',
          'p <- ggplot(summary, aes(x = group, y = mean_value)) +',
          '  geom_col() +',
          '  labs(title = "Mean by group") +',
          '  theme_minimal()',
          'ggsave("summary.png", p, width = 8, height = 5, dpi = 150)'
        ].join('\n')
      ],
      'open-science-r-tidyverse-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it.each(['%>%', '|>'])('classifies a common dplyr %s pipeline as clear', async (pipe) => {
    const projection = await projectScripts(
      'r',
      [
        [
          'library(dplyr)',
          'df <- data.frame(group = c("A", "A", "B"), value = c(1, 2, 3))',
          `summary <- df ${pipe} mutate(double = value * 2) ${pipe} group_by(group) ${pipe} summarise(total = sum(double))`,
          'print(summary)'
        ].join('\n')
      ],
      'open-science-r-dplyr-pipe-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('does not trust a lookalike qualified transform in an R pipe', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(dplyr)\ndf <- data.frame(value = c(1, 2, 3))\nresult <- df %>% custompkg::mutate(double = value * 2)\nprint(result)'
      ],
      'open-science-r-qualified-pipe-boundary-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it('tracks a dplyr data-mask summary across data replacement', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(dplyr)\ndf <- data.frame(group = c("A", "B"), value = c(1, 2))',
        'summary <- df |> group_by(group) |> summarise(mean_value = mean(value), .groups = "drop")\nprint(summary)',
        'df <- data.frame(group = c("A", "B"), value = c(10, 20))'
      ],
      'open-science-r-dplyr-lineage-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('marks a dplyr data-mask result unknown when an ambiguous environment name changes', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(dplyr)\ndf <- data.frame(value = c(1, 2, 3))',
        'threshold <- 1',
        'summary <- filter(df, value > threshold)\nprint(summary)',
        'threshold <- 2'
      ],
      'open-science-r-data-mask-environment-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
  })

  it('classifies namespace-qualified dplyr, ggplot2, and stats calls', async () => {
    const projection = await projectScripts(
      'r',
      [
        [
          'df <- data.frame(group = c("A", "B"), value = c(1, 2))',
          'summary <- dplyr::filter(df, !is.na(value))',
          'model <- stats::lm(value ~ group, data = summary)',
          'p <- ggplot2::ggplot(summary, ggplot2::aes(x = group, y = value)) + ggplot2::geom_col()',
          'ggplot2::ggsave("qualified.png", p)'
        ].join('\n')
      ],
      'open-science-r-qualified-calls-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps dynamic data-mask pronoun keys conservative', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(ggplot2)\ncolumn_name <- "value"\ndf <- data.frame(value = 1)\np <- ggplot(df, aes(y = .data[[column_name]]))'
      ],
      'open-science-r-dynamic-data-mask-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it('tracks data-mask environment callbacks and rejects unknown qualified callbacks', async () => {
    const environmentProjection = await projectScripts(
      'r',
      [
        'library(dplyr)\npredicate <- function(value) value > 0\ndf <- data.frame(value = 1)',
        'summary <- filter(df, .env$predicate(value))'
      ],
      'open-science-r-data-mask-callback-corpus-'
    )
    const qualifiedProjection = await projectScripts(
      'r',
      [
        'library(dplyr)\ndf <- data.frame(value = 1)\nsummary <- filter(df, custompkg::predicate(value))'
      ],
      'open-science-r-qualified-callback-corpus-'
    )

    expect(environmentProjection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(qualifiedProjection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it('marks a ggplot bare-name result unknown when the possible environment value changes', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(ggplot2)\ndf <- data.frame(value = 1)\nthreshold <- 1',
        'p <- ggplot(df, aes(y = threshold))',
        'threshold <- 2'
      ],
      'open-science-r-ggplot-environment-fallback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('keeps namespace-qualified tabular reads copy-on-modify', async () => {
    const projection = await projectScripts(
      'r',
      [
        'a <- utils::read.csv("data.csv")',
        'b <- a',
        'result <- nrow(a)\nprint(result)',
        'b[[1]] <- 99'
      ],
      'open-science-r-qualified-read-copy-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it('classifies base-qualified pure calls while keeping readRDS references conservative', async () => {
    const pureProjection = await projectScripts(
      'r',
      ['x <- c(1, 2, 3)\nresult <- base::mean(x) + base::sum(x)\nprint(result)'],
      'open-science-r-base-qualified-corpus-'
    )
    const referenceProjection = await projectScripts(
      'r',
      ['a <- base::readRDS("object.rds")', 'b <- a', 'snapshot <- a$x', 'b$x <- 1'],
      'open-science-r-base-read-rds-corpus-'
    )

    expect(pureProjection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(referenceProjection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
  })

  it('classifies a common ggplot2 pie-chart workflow as clear', async () => {
    const projection = await projectScripts(
      'r',
      [
        [
          'library(ggplot2)',
          'set.seed(1)',
          'angles <- seq(0, 2*pi, length.out = 9)[1:8]',
          'df <- data.frame(label = c(paste0("sin theta=", round(angles, 2)), paste0("cos theta=", round(angles, 2))), value = abs(c(sin(angles), cos(angles))))',
          'df$frac <- df$value / sum(df$value)',
          'df$label_pos <- cumsum(df$frac) - df$frac/2',
          'p <- ggplot(df, aes(x = "", y = value, fill = label)) +',
          '  geom_bar(stat = "identity", width = 1, color = "white") +',
          '  coord_polar(theta = "y") +',
          '  geom_text(aes(x = 1.2, y = label_pos, label = paste0(round(frac*100, 1), "%"))) +',
          '  labs(title = "Pie chart", fill = "Slice") +',
          '  theme_void()',
          'ggsave("sin_cos_pie_ggplot.png", p, width = 8, height = 8, dpi = 150)',
          'cat("Saved:", file.exists("sin_cos_pie_ggplot.png"), "\\n")'
        ].join('\n')
      ],
      'open-science-r-ggplot-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a common dplyr and tidyr reshape workflow as clear', async () => {
    const projection = await projectScripts(
      'r',
      [
        [
          'library(dplyr)',
          'library(tidyr)',
          'wide <- data.frame(sample = c("A", "B"), before = c(1, 2), after = c(3, 4))',
          'report <- wide |>',
          '  pivot_longer(cols = c(before, after), names_to = "time", values_to = "value") |>',
          '  mutate(centered = value - mean(value)) |>',
          '  group_by(sample, time) |>',
          '  summarise(mean_value = mean(centered), .groups = "drop") |>',
          '  pivot_wider(names_from = time, values_from = mean_value)',
          'write.csv(report, "tidy-report.csv", row.names = FALSE)',
          'print(report)'
        ].join('\n')
      ],
      'open-science-r-tidyr-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('tracks a tidyr reshape across source replacement', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(tidyr)\nwide <- data.frame(sample = c("A", "B"), before = c(1, 2), after = c(3, 4))',
        'long <- pivot_longer(wide, cols = c(before, after), names_to = "time", values_to = "value")\nprint(long)',
        'wide <- data.frame(sample = "C", before = 10, after = 20)'
      ],
      'open-science-r-tidyr-lineage-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('keeps a proven tidyr data-frame result copy-on-modify', async () => {
    const projection = await projectScripts(
      'r',
      [
        'wide <- data.frame(sample = c("A", "B"), before = c(1, 2), after = c(3, 4))',
        'long <- tidyr::pivot_longer(wide, cols = c(before, after), names_to = "time", values_to = "value")',
        'alias <- long',
        'result <- nrow(long)\nprint(result)',
        'alias[[1]] <- c("X", "Y", "X", "Y")'
      ],
      'open-science-r-tidyr-copy-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' },
      'run-5': { state: 'clear' }
    })
  })

  it('keeps a dplyr result with a reference-bearing list column conservative', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(dplyr)\nsource <- data.frame(id = 1)\nenv <- new.env()\nenv$value <- 1',
        'report <- mutate(source, ref = list(env))',
        'alias <- report',
        'snapshot <- report$ref[[1]]$value\nprint(snapshot)',
        'alias$ref[[1]]$value <- 2'
      ],
      'open-science-r-dplyr-reference-column-corpus-'
    )

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('keeps ordinary R list copy-on-modify runs clear', async () => {
    const projection = await projectScripts(
      'r',
      [
        'a <- list(1, 2, 3)',
        'b <- a',
        'result <- length(a)\nprint(result)',
        'b[[1]] <- 99\nprint(b)\nprint(a)'
      ],
      'open-science-r-copy-on-modify-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it('keeps readRDS results conservative because they may restore reference objects', async () => {
    const projection = await projectScripts(
      'r',
      ['a <- readRDS("object.rds")', 'b <- a', 'snapshot <- a$x\nprint(snapshot)', 'b$x <- 1'],
      'open-science-r-read-rds-reference-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
  })

  it('tracks a common base R model across data replacement', async () => {
    const projection = await projectScripts(
      'r',
      [
        'df <- data.frame(group = c("A", "A", "B"), value = c(1, 2, 3))',
        'model <- lm(value ~ group, data = df)\nreport <- summary(model)\nprint(report)',
        'df <- data.frame(group = c("A", "B"), value = c(10, 20))'
      ],
      'open-science-r-model-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('keeps dynamic R namespace access conservative', async () => {
    const projection = await projectScripts(
      'r',
      ['baseline <- 1\nprint(baseline)', 'assign("hidden", 1, envir = .GlobalEnv)'],
      'open-science-r-dynamic-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('classifies common NumPy transforms and distribution summaries as clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.linspace(0, 10, 101)',
        'baseline = np.sum(values)\nprint(baseline)',
        [
          'scaled = np.clip(np.log1p(np.abs(values)), 0, 2)',
          'finite = np.isfinite(scaled)',
          'quartiles = np.percentile(scaled, [25, 50, 75])',
          'selected = np.where(finite, scaled, 0)',
          'print(quartiles, selected.mean())'
        ].join('\n')
      ],
      'open-science-python-numpy-transforms-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' }
    })
  })

  it('classifies a common Seaborn plot and tracks its explicit axes mutation', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import pandas as pd',
          'import matplotlib.pyplot as plt',
          'import seaborn as sns',
          'frame = pd.DataFrame({"x": [1, 2], "y": [2, 4], "group": ["a", "b"]})',
          'fig, ax = plt.subplots()'
        ].join('\n'),
        'print(ax)',
        'plot_ax = sns.scatterplot(data=frame, x="x", y="y", hue="group", ax=ax)\nfig.savefig("scatter.png")',
        'print(ax)',
        'plot_ax.set_title("Updated")'
      ],
      'open-science-python-seaborn-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('keeps dynamic Seaborn estimators conservative', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'from analysis_callbacks import estimator',
          'import pandas as pd',
          'import seaborn as sns',
          'frame = pd.DataFrame({"group": ["a", "a"], "value": [1, 2]})',
          'plot_ax = sns.barplot(data=frame, x="group", y="value", estimator=estimator)'
        ].join('\n')
      ],
      'open-science-python-seaborn-callback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it('classifies common readr and tibble workflows as clear', async () => {
    const projection = await projectScripts(
      'r',
      [
        [
          'library(readr)',
          'library(tibble)',
          'library(dplyr)',
          'data <- read_csv("measurements.csv", show_col_types = FALSE)',
          'labels <- tibble(group = c("a", "b"), label = c("A", "B"))',
          'summary <- data |> mutate(ratio = value / sum(value))',
          'write_csv(summary, "summary.csv")',
          'print(labels)',
          'print(summary)'
        ].join('\n')
      ],
      'open-science-r-readr-tibble-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a common openxlsx workbook pipeline as clear', async () => {
    const projection = await projectScripts(
      'r',
      [
        [
          'book <- openxlsx::loadWorkbook("source.xlsx")',
          'openxlsx::addWorksheet(book, "Analysis")',
          'openxlsx::writeData(book, "Analysis", data.frame(value = c(1, 2, 3)))',
          'openxlsx::saveWorkbook(book, "result.xlsx", overwrite = TRUE)'
        ].join('\n')
      ],
      'open-science-r-openxlsx-pipeline-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('tracks openxlsx workbook mutations through aliases', async () => {
    const projection = await projectScripts(
      'r',
      [
        'book <- openxlsx::loadWorkbook("source.xlsx")',
        'alias <- book',
        'sheet_names <- names(book)\nprint(sheet_names)',
        'openxlsx::addWorksheet(alias, "Analysis")'
      ],
      'open-science-r-openxlsx-reference-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('does not trust a shadowed unqualified openxlsx mutator', async () => {
    const projection = await projectScripts(
      'r',
      [
        'book <- openxlsx::loadWorkbook("source.xlsx")',
        'addWorksheet <- function(book, name) invisible(NULL)\naddWorksheet(book, "Analysis")'
      ],
      'open-science-r-shadowed-openxlsx-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('keeps an attached readr table copy-on-modify across aliases', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(readr)\ndata <- read_csv("measurements.csv", show_col_types = FALSE)',
        'alias <- data',
        'snapshot <- nrow(data)\nprint(snapshot)',
        'alias[[1]] <- 99'
      ],
      'open-science-r-attached-readr-copy-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it('recognizes tribble column declarations and preserves value-copy semantics', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(tibble)\ndata <- tribble(~group, ~value, "a", 1, "b", 2)',
        'alias <- data',
        'snapshot <- data$value\nprint(snapshot)',
        'alias$value <- c(3, 4)'
      ],
      'open-science-r-tribble-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it('classifies qualified readr and tibble calls without trusting serialized references', async () => {
    const valueProjection = await projectScripts(
      'r',
      [
        [
          'data <- readr::read_csv("measurements.csv", show_col_types = FALSE)',
          'labels <- tibble::tibble(group = c("a", "b"))',
          'readr::write_csv(data, "summary.csv")',
          'print(labels)'
        ].join('\n')
      ],
      'open-science-r-qualified-readr-corpus-'
    )
    const referenceProjection = await projectScripts(
      'r',
      ['a <- readr::read_rds("object.rds")', 'b <- a', 'snapshot <- a$x', 'b$x <- 1'],
      'open-science-r-readr-rds-corpus-'
    )

    expect(valueProjection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(referenceProjection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
  })

  it('classifies a common scikit-learn preprocessing and regression workflow', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfeatures = np.array([[1.0, 2.0], [2.0, 4.0], [3.0, 6.0]])\ntarget = np.array([1.0, 2.0, 3.0])',
        [
          'from sklearn.preprocessing import StandardScaler',
          'scaler = StandardScaler()',
          'scaled = scaler.fit_transform(features)'
        ].join('\n'),
        'scaled_mean = scaled.mean()\nprint(scaled_mean)',
        [
          'from sklearn.linear_model import LinearRegression',
          'model = LinearRegression()',
          'model.fit(scaled, target)',
          'predictions = model.predict(scaled)',
          'print(predictions)'
        ].join('\n'),
        'features = np.array([[10.0, 20.0], [20.0, 40.0]])'
      ],
      'open-science-python-sklearn-workflow-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('does not trust an unrelated estimator with scikit-learn-style method names', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'from custom_models import Estimator',
          'features = [[1.0], [2.0]]',
          'target = [1.0, 2.0]',
          'model = Estimator()',
          'model.fit(features, target)',
          'predictions = model.predict(features)'
        ].join('\n')
      ],
      'open-science-python-custom-estimator-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it('marks a prior model consumer after a scikit-learn refit', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfeatures = np.array([[1.0], [2.0]])\ntarget = np.array([1.0, 2.0])',
        'from sklearn.linear_model import LinearRegression\nmodel = LinearRegression()',
        'fitted = model.fit(features, target)',
        'print(model)',
        'fitted.fit(features, target)'
      ],
      'open-science-python-sklearn-refit-corpus-'
    )

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('keeps a multi-cell PyTorch weights-only input lineage clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        "import torch\nstate = torch.load('inputs/model.pt', weights_only=True)",
        'print(state)',
        'print("weights loaded")'
      ],
      'open-science-python-torch-weights-only-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('classifies a common scikit-learn PCA transform as clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import numpy as np',
          'from sklearn.decomposition import PCA',
          'features = np.array([[1.0, 2.0], [2.0, 4.0], [3.0, 7.0]])',
          'reducer = PCA(n_components=2)',
          'reduced = reducer.fit_transform(features)',
          'restored = reducer.inverse_transform(reduced)',
          'print(restored)'
        ].join('\n')
      ],
      'open-science-python-sklearn-pca-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it.each([
    [
      'StandardScaler(copy=False)',
      'from sklearn.preprocessing import StandardScaler\nmodel = StandardScaler(copy=False)\nmodel.fit_transform(features)'
    ],
    [
      'PCA(copy=False)',
      'from sklearn.decomposition import PCA\nmodel = PCA(copy=False)\nmodel.fit(features)'
    ],
    [
      'LinearRegression(copy_X=False)',
      'from sklearn.linear_model import LinearRegression\nmodel = LinearRegression(copy_X=False)\nmodel.fit(features, target)'
    ],
    [
      'StandardScaler(copy=runtime_flag)',
      'from sklearn.preprocessing import StandardScaler\nruntime_flag = bool(target[0])\nmodel = StandardScaler(copy=runtime_flag)\nmodel.fit_transform(features)'
    ]
  ])('keeps %s input mutation conservative', async (_label, modelScript) => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfeatures = np.array([[1.0, 2.0], [2.0, 4.0]])\ntarget = np.array([1.0, 2.0])',
        'snapshot = features.mean()\nprint(snapshot)',
        modelScript
      ],
      'open-science-python-sklearn-copy-false-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    [
      'a StandardScaler copy field write',
      'from sklearn.preprocessing import StandardScaler\nmodel = StandardScaler()\nmodel.copy = False\nmodel.transform(features)'
    ],
    [
      'PCA.set_params(copy=False)',
      'from sklearn.decomposition import PCA\nmodel = PCA()\nmodel.set_params(copy=False)\nmodel.fit(features)'
    ],
    [
      'LinearRegression.set_params(copy_X=False)',
      'from sklearn.linear_model import LinearRegression\nmodel = LinearRegression()\nmodel.set_params(copy_X=False)\nmodel.fit(features, target)'
    ]
  ])('keeps input mutation conservative after %s', async (_label, modelScript) => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfeatures = np.array([[1.0, 2.0], [2.0, 4.0]])\ntarget = np.array([1.0, 2.0])',
        'snapshot = features.mean()\nprint(snapshot)',
        modelScript
      ],
      'open-science-python-sklearn-copy-reconfigure-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps a later StandardScaler copy reconfiguration across runs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfeatures = np.array([[1.0, 2.0], [2.0, 4.0]])',
        'snapshot = features.mean()\nprint(snapshot)',
        'from sklearn.preprocessing import StandardScaler\nmodel = StandardScaler()',
        'params = {"copy": False}\nmodel.set_params(**params)',
        'model.transform(features)'
      ],
      'open-science-python-sklearn-copy-reconfigure-runs-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('classifies a statsmodels OLS workflow and tracks its inputs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfeatures = np.array([1.0, 2.0, 3.0])\ntarget = np.array([2.0, 4.0, 6.0])',
        [
          'import statsmodels.api as sm',
          'design = sm.add_constant(features)',
          'model = sm.OLS(target, design)'
        ].join('\n'),
        [
          'results = model.fit()',
          'predictions = results.predict(design)',
          'print(predictions)',
          'print(results.summary())'
        ].join('\n'),
        'target = np.array([3.0, 6.0, 9.0])'
      ],
      'open-science-python-statsmodels-ols-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('classifies a statsmodels formula workflow and tracks its data frame', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nframe = pd.DataFrame({"x": [1.0, 2.0, 3.0], "y": [2.0, 4.0, 6.0]})',
        [
          'import statsmodels.formula.api as smf',
          'model = smf.ols("y ~ x", data=frame)',
          'results = model.fit()',
          'print(results.summary())'
        ].join('\n'),
        'frame = pd.DataFrame({"x": [10.0, 20.0], "y": [30.0, 60.0]})'
      ],
      'open-science-python-statsmodels-formula-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps dynamic statsmodels formula evaluation conservative', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nframe = pd.DataFrame({"x": [1.0, 2.0], "y": [2.0, 4.0]})',
        [
          'import statsmodels.formula.api as smf',
          'model = smf.ols("y ~ custom_transform(x)", data=frame)',
          'print(model)'
        ].join('\n')
      ],
      'open-science-python-statsmodels-dynamic-formula-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('tracks simple statsmodels formula names as possible environment lookups', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nframe = pd.DataFrame({"x": [1.0, 2.0], "y": [2.0, 4.0]})',
        'import statsmodels.formula.api as smf\nmodel = smf.ols("y ~ x", data=frame)',
        'x = [10.0, 20.0]'
      ],
      'open-science-python-statsmodels-formula-environment-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps an attached readxl table copy-on-modify across aliases', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(readxl)\ndata <- read_excel("measurements.xlsx")',
        'alias <- data',
        'snapshot <- nrow(data)\nprint(snapshot)',
        'alias[[1]] <- 99'
      ],
      'open-science-r-readxl-copy-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it.each([
    ['base fixed-width data', 'item <- read.fwf("measurements.txt", widths = c(4, 8))'],
    ['base text lines', 'item <- readLines("measurements.txt")'],
    ['jsonlite JSON', 'item <- jsonlite::fromJSON("measurements.json")'],
    ['yaml YAML', 'item <- yaml::read_yaml("config.yaml")'],
    ['vroom table', 'item <- vroom::vroom("measurements.csv")'],
    ['sf vector data', 'item <- sf::st_read("regions.gpkg")'],
    ['Matrix Market data', 'item <- Matrix::readMM("matrix.mtx")']
  ])('keeps a %s reader copy-on-modify across aliases', async (_label, read) => {
    const projection = await projectScripts(
      'r',
      [read, 'alias <- item', 'snapshot <- length(item)\nprint(snapshot)', 'alias[1] <- 99'],
      'open-science-r-value-file-reader-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it('keeps dynamic YAML evaluation namespace-unknown', async () => {
    const projection = await projectScripts(
      'r',
      ['item <- yaml::yaml.load_file("config.yaml", eval.expr = TRUE)'],
      'open-science-r-dynamic-yaml-reader-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it.each(['NULL', 'list()'])(
    'keeps a static empty YAML handlers=%s read clear',
    async (handlers) => {
      const projection = await projectScripts(
        'r',
        [`item <- yaml::yaml.load_file("config.yaml", handlers = ${handlers})`],
        'open-science-r-static-yaml-reader-corpus-'
      )

      expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    }
  )

  it.each([
    ['base con', 'values <- readBin(what = "integer", con = handle)'],
    ['YAML input', 'value <- yaml::yaml.load_file(input = handle)'],
    ['sf dsn', 'value <- sf::st_read(dsn = handle)'],
    ['jsonlite txt', 'value <- jsonlite::fromJSON(txt = handle)']
  ])('treats a variable R %s argument as a possible consumed connection', async (_label, read) => {
    const projection = await projectScripts(
      'r',
      ['handle <- new.env()\nhandle$value <- 1', 'snapshot <- handle$value\nprint(snapshot)', read],
      'open-science-r-consumed-file-handle-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    ['Arrow table', 'item <- arrow::read_parquet("measurements.parquet", as_data_frame = FALSE)'],
    ['terra raster', 'item <- terra::rast("elevation.tif")'],
    ['rio import', 'item <- rio::import("measurements.rds")']
  ])('recognizes a %s reader while preserving possible reference aliases', async (_label, read) => {
    const projection = await projectScripts(
      'r',
      [read, 'alias <- item', 'snapshot <- length(item)\nprint(snapshot)', 'alias[1] <- 99'],
      'open-science-r-reference-file-reader-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('keeps a terra raster crop linked to its source across cells', async () => {
    const projection = await projectScripts(
      'r',
      [
        'raster <- terra::rast("inputs/elevation.tif")',
        'extent <- terra::ext(0, 1, 0, 1)\nclipped <- terra::crop(raster, extent)',
        'terra::writeRaster(clipped, "outputs/elevation-crop.tif", overwrite = TRUE)'
      ],
      'open-science-r-terra-raster-crop-corpus-'
    )

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection.dependenciesByRunId?.['run-2']).toEqual(['run-1'])
    expect(projection.dependenciesByRunId?.['run-3']).toEqual(['run-2'])
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps terra crop filename side effects conservative', async () => {
    const [facts] = await analyzeRSources([
      'raster <- terra::rast("inputs/elevation.tif")',
      'extent <- terra::ext(0, 1, 0, 1)',
      'cropped <- terra::crop(raster, extent, filename = "outputs/cropped.tif")'
    ])

    expect(facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['external-state'])
    })
  })

  it('classifies qualified haven reads and writes as value-table I/O', async () => {
    const projection = await projectScripts(
      'r',
      [
        'data <- haven::read_sav("survey.sav")',
        'alias <- data',
        'snapshot <- nrow(data)\nhaven::write_sav(data, "survey-copy.sav")\nprint(snapshot)',
        'alias[[1]] <- 99'
      ],
      'open-science-r-haven-copy-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it('tracks data.table aliases and := updates by reference', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(data.table)\ntable <- data.table(value = c(1, 2, 3))',
        'alias <- table',
        'snapshot <- sum(table$value)\nprint(snapshot)',
        'alias[, value := value + 1]'
      ],
      'open-science-r-data-table-reference-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('keeps data.table reference identity through multiple aliases', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(data.table)\ntable <- data.table(value = c(1, 2, 3))',
        'first_alias <- table',
        'second_alias <- first_alias',
        'snapshot <- sum(table$value)\nprint(snapshot)',
        'second_alias[, value := value + 1]'
      ],
      'open-science-r-data-table-alias-chain-corpus-'
    )

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('detaches a data.table alias on ordinary R member replacement', async () => {
    const projection = await projectScripts(
      'r',
      [
        'table <- data.table::data.table(value = c(1, 2, 3))',
        'alias <- table',
        'snapshot <- sum(table$value)\nprint(snapshot)',
        'alias$value <- c(4, 5, 6)'
      ],
      'open-science-r-data-table-copy-on-member-write-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('preserves the remaining R copy alias class after one name detaches', async () => {
    const projection = await projectScripts(
      'r',
      [
        'first <- data.frame(value = c(1, 2, 3))',
        'second <- first',
        'third <- first',
        'first$value <- c(4, 5, 6)',
        'snapshot <- sum(third$value)\nprint(snapshot)',
        'data.table::setDT(second)'
      ],
      'open-science-r-copy-alias-equivalence-corpus-'
    )

    expect(projection?.stalenessByRunId['run-5']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-6']).toEqual({ state: 'clear' })
  })

  it('keeps mixed same-run copy and reference updates conservative', async () => {
    const projection = await projectScripts(
      'r',
      [
        'first <- data.frame(value = c(1, 2, 3))',
        'second <- first',
        'second$value <- c(4, 5, 6)\ndata.table::setDT(first)',
        'alias <- second',
        'snapshot <- sum(second$value)\nprint(snapshot)',
        'alias$value <- c(7, 8, 9)'
      ],
      'open-science-r-copy-reference-order-corpus-'
    )

    expect(projection?.stalenessByRunId['run-5']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-6']).toEqual({ state: 'clear' })
  })

  it('tracks data.table set helpers as definite alias mutations', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(data.table)\ntable <- data.table(value = c(1, 2, 3))',
        'alias <- table',
        'snapshot <- names(table)\nprint(snapshot)',
        'setnames(alias, "value", "measurement")'
      ],
      'open-science-r-data-table-set-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('does not treat a data.frame set helper as a data.table conversion', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, 2, 3))',
        'data.table::setnames(frame, "value", "measurement")',
        'holder <- list(frame)',
        'alias <- holder',
        'snapshot <- sum(holder[[1]]$measurement)\nprint(snapshot)',
        'alias[[1]]$measurement <- c(4, 5, 6)'
      ],
      'open-science-r-data-frame-set-helper-corpus-'
    )

    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-6']).toEqual({ state: 'clear' })
  })

  it('keeps same-run ordinary and reference updates uncertain for detached aliases', async () => {
    const projection = await projectScripts(
      'r',
      [
        'table <- data.table::data.table(value = c(1, 2, 3))',
        'alias <- table',
        'snapshot <- sum(alias$value)\nprint(snapshot)',
        'table$value <- c(4, 5, 6)\ntable[, doubled := value * 2]'
      ],
      'open-science-r-data-table-same-receiver-order-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['opaque-mutation']
    })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('keeps a same-run reference update and receiver rebind uncertain for old aliases', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, 2, 3))',
        'alias <- frame',
        'snapshot <- sum(alias$value)\nprint(snapshot)',
        'data.table::setDT(frame)\nframe <- data.frame(value = c(4, 5, 6))'
      ],
      'open-science-r-reference-update-rebind-order-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['opaque-mutation']
    })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('does not trust a shadowed unqualified data.table mutator', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, 2, 3))',
        'snapshot <- sum(frame$value)\nprint(snapshot)',
        'setnames <- function(...) NULL',
        'setnames(frame, "value", "measurement")'
      ],
      'open-science-r-shadowed-set-helper-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
  })

  it('does not keep a type conversion from a shadowed setDT call', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, 2, 3))',
        'setDT <- function(x) x',
        'setDT(frame)',
        'holder <- list(frame)',
        'alias <- holder',
        'snapshot <- sum(holder[[1]]$value)\nprint(snapshot)',
        'alias[[1]]$value <- c(4, 5, 6)'
      ],
      'open-science-r-shadowed-set-dt-type-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-6']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-7']).toMatchObject({ state: 'unknown' })
    expect(projection?.invalidatedByRunId['run-7']).toBeUndefined()
  })

  it('keeps a qualified data.table mutator definite beside a shadowed call', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, 2, 3))',
        'alias <- frame',
        'snapshot <- sum(alias$value)\nprint(snapshot)',
        'setDT <- function(x) x',
        'setDT(frame)\ndata.table::setDT(frame)'
      ],
      'open-science-r-mixed-qualified-set-dt-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-5']).toMatchObject({ state: 'unknown' })
  })

  it('keeps an attached data.table copy independent from later reference updates', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(data.table)\ntable <- data.table(value = c(1, 2, 3))',
        'clone <- copy(table)',
        'snapshot <- sum(table$value)\nprint(snapshot)',
        'clone[, value := value + 1]'
      ],
      'open-science-r-data-table-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('classifies a common data.table grouped aggregation as a read', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(data.table)\ntable <- data.table(group = c("a", "a", "b"), value = c(1, 2, 3))',
        'summary <- table[, .(total = sum(value)), by = group]\nprint(summary)'
      ],
      'open-science-r-data-table-aggregation-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' }
    })
  })

  it('classifies qualified data.table I/O and tracks setkey by reference', async () => {
    const projection = await projectScripts(
      'r',
      [
        'table <- data.table::fread("measurements.csv")',
        'snapshot <- nrow(table)\ndata.table::fwrite(table, "measurements-copy.csv")\nprint(snapshot)',
        'data.table::setkey(table, id)'
      ],
      'open-science-r-data-table-io-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks setDT and setnafill as definite data.table mutations', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, NA, 3))',
        'data.table::setDT(frame)',
        'alias <- frame',
        'snapshot <- sum(is.na(frame$value))\nprint(snapshot)',
        'data.table::setnafill(alias, fill = 0)'
      ],
      'open-science-r-data-table-conversion-corpus-'
    )

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('propagates setDT through aliases created before conversion', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, 2, 3))',
        'alias <- frame',
        'snapshot <- nrow(alias)\nprint(snapshot)',
        'data.table::setDT(frame)'
      ],
      'open-science-r-data-table-pre-conversion-alias-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('restores copy-on-modify semantics after data.table::setDF', async () => {
    const projection = await projectScripts(
      'r',
      [
        'table <- data.table::data.table(value = c(1, 2, 3))',
        'existing_alias <- table',
        'data.table::setDF(table)',
        'alias <- existing_alias',
        'snapshot <- sum(existing_alias$value)\nprint(snapshot)',
        'alias[[1]] <- 99'
      ],
      'open-science-r-data-table-set-df-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-6']).toEqual({ state: 'clear' })
  })

  it('tracks data.table::setindexv as a definite root mutation', async () => {
    const projection = await projectScripts(
      'r',
      [
        'table <- data.table::data.table(id = c(2, 1), value = c(10, 20))',
        'snapshot <- table$value\nprint(snapshot)',
        'data.table::setindexv(table, "id")'
      ],
      'open-science-r-data-table-set-index-v-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks SummarizedExperiment assay reads and replacement accessors', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(SummarizedExperiment)\ncounts <- matrix(c(1, 2, 3, 4), nrow = 2)\nse <- SummarizedExperiment(assays = list(counts = counts))',
        'snapshot <- sum(assay(se))\nprint(snapshot)',
        'assay(se) <- matrix(c(10, 20, 30, 40), nrow = 2)',
        'latest <- sum(assay(se))\nprint(latest)'
      ],
      'open-science-r-summarized-experiment-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('keeps a possibly delayed extracted assay linked conservatively', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(SummarizedExperiment)\nse <- SummarizedExperiment(assays = list(counts = matrix(c(1, 2), nrow = 1)))',
        'counts <- assay(se)',
        'snapshot <- sum(assay(se))\nprint(snapshot)',
        'counts[[1]] <- 99'
      ],
      'open-science-r-summarized-experiment-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('keeps an accessor on an unsummarized S4 receiver dynamic', async () => {
    const projection = await projectScripts(
      'r',
      ['custom <- external_container', 'values <- assay(custom)\nprint(values)'],
      'open-science-r-bioconductor-dynamic-dispatch-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
  })

  it('keeps a replacement accessor on an unsummarized S4 receiver dynamic', async () => {
    const projection = await projectScripts(
      'r',
      ['custom <- external_container', 'assay(custom) <- replacement'],
      'open-science-r-bioconductor-dynamic-replacement-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
  })

  it('tracks SingleCellExperiment reducedDim replacement accessors', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(SingleCellExperiment)\nsce <- SingleCellExperiment(assays = list(counts = matrix(1:4, nrow = 2)))',
        'embedding <- reducedDim(sce, "PCA")\nprint(embedding)',
        'reducedDim(sce, "PCA") <- matrix(c(1, 0, 0, 1), nrow = 2)'
      ],
      'open-science-r-single-cell-experiment-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks Bioconductor container transforms across normalization and PCA cells', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(SingleCellExperiment)\ncounts <- matrix(1:4, nrow = 2)\nsce <- SingleCellExperiment(assays = list(counts = counts))',
        'sce <- scuttle::logNormCounts(sce, pseudo.count = 1)',
        'sce <- scater::runPCA(sce, ncomponents = 2)'
      ],
      'open-science-r-single-cell-transform-corpus-'
    )

    expect(projection?.dependenciesByRunId?.['run-2']).toEqual(['run-1'])
    expect(projection?.dependenciesByRunId?.['run-3']).toEqual(['run-2'])
    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('marks stochastic Bioconductor reductions uncertain while preserving their call contract', async () => {
    const { facts } = await analyzeRNotebookSource(
      'library(SingleCellExperiment)\ncounts <- matrix(1:4, nrow = 2)\nsce <- SingleCellExperiment(assays = list(counts = counts))\nsce <- scater::runPCA(sce, ncomponents = 2)'
    )

    expect(facts.state).toBe('unknown')
    expect(facts).toMatchObject({
      reasons: expect.arrayContaining(['external-state'])
    })
    expect(facts.safeCallNames).toContain('scater::runPCA')
  })

  it('keeps dynamic Bioconductor transform options conservative', async () => {
    const { facts } = await analyzeRNotebookSource(
      'sce <- scuttle::logNormCounts(sce, subset.row = selected_genes)'
    )

    expect(facts.safeCallNames ?? []).not.toContain('scuttle::logNormCounts')
    expect(facts.receiverCalls).toEqual([
      {
        receiver: 'sce',
        member: 'logNormCounts',
        kind: 'generic',
        argumentNames: ['sce', 'selected_genes']
      }
    ])
  })

  it('tracks nested rowData replacement on a SummarizedExperiment root', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(SummarizedExperiment)\nse <- SummarizedExperiment(assays = list(counts = matrix(1:4, nrow = 2)))',
        'snapshot <- nrow(rowData(se))\nprint(snapshot)',
        'rowData(se)$batch <- c("a", "b")'
      ],
      'open-science-r-summarized-experiment-row-data-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps extracted ExpressionSet assay data linked conservatively', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(Biobase)\nset <- ExpressionSet(assayData = matrix(1:4, nrow = 2))',
        'values <- exprs(set)',
        'snapshot <- sum(exprs(set))\nprint(snapshot)',
        'values[[1]] <- 99'
      ],
      'open-science-r-expression-set-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('links DropletUtils 10x input to a downstream assay cell', async () => {
    const scripts = [
      'sce <- DropletUtils::read10xCounts("inputs/filtered_feature_bc_matrix")',
      'counts <- SummarizedExperiment::assay(sce)'
    ]
    const entries = await Promise.all(
      scripts.map(async (script, index) => ({
        run: completedRun(`run-${index + 1}`, `cell-${index + 1}`, 'r', script),
        facts: (await analyzeRNotebookSource(script)).facts
      }))
    )
    const projection = projectNotebookDependencies(entries)

    expect(entries[0]?.facts.typeBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'sce', typeName: 'SingleCellExperiment' })
      ])
    )
    expect(entries[1]?.facts.usedNames).toContain('sce')
    expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  })
})

describe('R primitive predicate evidence across cells', () => {
  it('retains owned class containers without certifying primitive dispatch', async () => {
    const { facts } = await analyzeRNotebookSource(
      'sensor <- structure(c(1., 2.), class="mercury_sensor")\nconverted <- as.numeric(sensor)'
    )
    expect(facts.copyOnModifyNames).toContain('sensor')
    expect(facts.rAtomicValueNames ?? []).not.toContain('sensor')
    expect(facts.rAtomicValueNames ?? []).not.toContain('converted')
  })

  it('does not publish verified dependencies for class-dispatched predicate results', async () => {
    const projection = await projectScripts(
      'r',
      [
        'original <- structure(c(1., 2.), class="mercury_sensor")\nsensor <- as.numeric(original)',
        'flags <- base::is.finite(sensor)',
        'sensor <- c(3., 4.)'
      ],
      'r-class-predicate-lineage-'
    )
    expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection.dependenciesByRunId?.['run-2']).toBeUndefined()
  })

  it('retains ordinary primitive coercion dependencies and invalidation', async () => {
    const projection = await projectScripts(
      'r',
      [
        'sensor <- as.numeric(c("1", "2"))',
        'flags <- base::is.finite(sensor)',
        'sensor <- c(3., 4.)'
      ],
      'r-primitive-predicate-lineage-'
    )
    expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection.invalidatedByRunId['run-3']).toEqual(
      expect.arrayContaining([expect.objectContaining({ runId: 'run-2', names: ['sensor'] })])
    )
  })
})

describe('R count and sequence atomic kernel context', () => {
  it('retains container ownership without exporting class-derived counts or endpoints as atomic', async () => {
    const { facts } = await analyzeRNotebookSource(
      [
        'sensor <- structure(c(1., 2.), class="mercury_sensor")',
        'count <- length(sensor)',
        'limit <- structure(3., class="mercury_limit")',
        'values <- seq(1., limit, by=1.)'
      ].join('\n')
    )
    expect(facts.copyOnModifyNames).toEqual(expect.arrayContaining(['sensor', 'limit']))
    expect(facts.rAtomicValueNames ?? []).not.toContain('count')
    expect(facts.rAtomicValueNames ?? []).not.toContain('values')
  })
})

describe('R opaque scientific closure captures', () => {
  // Reduced from an executed multi-cell Puromycin fit. Only the helper body is preserved;
  // the small data scaffold exercises static dependency projection, not numerical fitting.
  const helper = [
    'mm_response <- function(conc, Vm, K) {',
    '  scale_val <- as.numeric(readLines("outputs/assay-scale.txt", warn = FALSE)[1])',
    '  cat("call\\n", file = mm_log_path, append = TRUE)',
    '  calibration_gain * scale_val * Vm * conc / (K + conc)',
    '}'
  ].join('\n')
  const setup = [
    'calibration_gain <- 1.0',
    'mm_log_path <- "outputs/mm-calls.txt"',
    'd <- data.frame(conc=c(0.1,0.2,0.4),rate=c(100,150,190))'
  ].join('\n')
  const fit = 'fit <- stats::nls(rate ~ mm_response(conc,Vm,K),data=d,start=list(Vm=200,K=0.1))'
  const predict = 'p <- stats::predict(fit,newdata=data.frame(conc=c(0.1,0.2,0.4)))'
  const summarizeHelper = async (
    script: string
  ): Promise<{
    facts: NotebookRunDependencyFacts
    method: NotebookDependencyTypeSummary['methods'][number]
  }> => {
    const { facts } = await analyzeRNotebookSource(script)
    const typeName = facts.typeBindings?.find(
      (binding) => binding.target === 'mm_response'
    )?.typeName
    const method = facts.typeSummaries?.find((summary) => summary.name === typeName)?.methods[0]
    expect(method).toBeDefined()
    return { facts, method: method! }
  }
  const expectOpaqueFallback = async (script: string): Promise<void> => {
    const { method } = await summarizeHelper(script)
    expect(method).toMatchObject({ effect: 'unknown', unknownScope: 'namespace' })
    expect(method.usedNames ?? []).toEqual([])
    expect(method.safeCallNames).toBeUndefined()
    expect(method.returnType).toBeUndefined()
    expect(method.returnCopyArguments).toBeUndefined()
  }

  it.each([
    ['direct helper', 'v <- mm_response(c(0.1,0.2),200,0.1)', false],
    ['nls formula', fit, false],
    ['fit and later prediction', fit, true]
  ] as const)(
    'retains known captures through %s without certifying the call',
    async (_, call, consumer) => {
      for (const [name, replacement] of [
        ['calibration_gain', '2.0'],
        ['mm_log_path', '"outputs/alternative-calls.txt"']
      ]) {
        const scripts = [
          setup,
          helper,
          call,
          ...(consumer ? [predict] : []),
          `${name} <- ${replacement}`
        ]
        const projection = await projectScripts('r', scripts, 'r-opaque-scientific-captures-')
        const invalidated = projection.invalidatedByRunId[`run-${scripts.length}`] ?? []
        for (const runId of consumer ? ['run-3', 'run-4'] : ['run-3']) {
          expect(invalidated).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                runId,
                state: 'unknown',
                names: expect.arrayContaining([name])
              })
            ])
          )
        }
      }
    }
  )

  it('retains a true outer read before a later local assignment', async () => {
    const altered = prependFunctionBody(
      helper,
      '  previous_gain <- calibration_gain\n  calibration_gain <- 1.0'
    )
    const { method } = await summarizeHelper([setup, altered].join('\n'))
    expect(method.usedNames).toContain('calibration_gain')
    expect(method.usedNames ?? []).not.toContain('previous_gain')
  })

  it('keeps effectful helper and fitted model namespace opaque without return or copy evidence', async () => {
    const { facts, method } = await summarizeHelper([setup, helper, fit].join('\n'))
    expect(method).toMatchObject({ effect: 'unknown', unknownScope: 'namespace' })
    expect(method.safeCallNames).toBeUndefined()
    expect(method.returnType).toBeUndefined()
    expect(method.returnCopyArguments).toBeUndefined()
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
  })

  it('excludes formal parameters and genuine local bindings from outer captures', async () => {
    for (const [altered, excluded] of [
      [helper.replace('conc, Vm, K', 'conc, Vm, K, calibration_gain=1.0'), 'calibration_gain'],
      [prependFunctionBody(helper, '  calibration_gain <- 1.0'), 'calibration_gain'],
      [helper, 'scale_val']
    ]) {
      const projection = await projectScripts(
        'r',
        [setup + '\nscale_val <- 42', altered, fit, `${excluded} <- 2.0`],
        'r-opaque-scientific-local-bindings-'
      )
      expect(projection.invalidatedByRunId['run-4'] ?? []).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runId: 'run-3', names: expect.arrayContaining([excluded]) })
        ])
      )
    }
  })

  it.each(['formal', 'local', 'global'] as const)(
    'rejects lexical inference for %s-shadowed base callees and operators',
    async (scope) => {
      const scripts =
        scope === 'formal'
          ? [
              helper.replace('conc, Vm, K', 'conc, Vm, K, as.numeric'),
              helper.replace('conc, Vm, K', 'conc, Vm, K, `+`')
            ]
          : scope === 'local'
            ? [
                prependFunctionBody(helper, '  as.numeric <- function(x) 1'),
                prependFunctionBody(helper, '  `+` <- function(e1,e2) 1')
              ]
            : [
                'readLines <- function(...) "1.0"\n' + helper,
                'as.numeric <- function(x) 1\n' + helper,
                '`+` <- function(e1,e2) 1\n' + helper
              ]
      for (const script of scripts) {
        await expectOpaqueFallback([setup, script, fit].join('\n'))
      }
    }
  )

  it('does not let an unforced argument assignment hide a later outer read', async () => {
    const altered = helper.replace(
      '  scale_val <- as.numeric(readLines("outputs/assay-scale.txt", warn = FALSE)[1])',
      '  scale_val <- as.numeric(calibration_gain <- 2)'
    )
    // The formal is a lazy promise; this replacement never forces it.
    await expectOpaqueFallback([setup, 'as.numeric <- function(x) 1', altered, fit].join('\n'))
  })

  it.each([
    [
      'nonconstant default promise',
      helper.replace('conc, Vm, K', 'conc, Vm, K, calibration_gain=outer_gain')
    ],
    [
      'nonlocal assignment',
      prependFunctionBody(helper, '  calibration_gain <<- calibration_gain + 1')
    ],
    [
      'dynamic lookup',
      helper.replace('calibration_gain * scale_val', 'get("calibration_gain") * scale_val')
    ],
    [
      'data-mask ambiguity',
      helper.replace(
        'calibration_gain * scale_val * Vm * conc / (K + conc)',
        'transform(d, adjusted=conc * calibration_gain)'
      )
    ]
  ])('preserves the opaque fallback for %s', async (_, altered) => {
    await expectOpaqueFallback([setup, altered, fit].join('\n'))
  })
})

describe('R uniroot opaque capture-only callbacks', () => {
  const captures = ['TARGET_PATH', 'PHASE', 'ozone_values', 'BANDWIDTH', 'TRACE_PATH']
  const body = [
    'target <- as.numeric(readLines(TARGET_PATH)[1])',
    'score <- mean(1 / (1 + exp(-(ozone_values - theta) / BANDWIDTH))) - target',
    'call_id <- length(readLines(TRACE_PATH))',
    'cat(paste(PHASE, formatC(score), call_id), file=TRACE_PATH, append=TRUE)',
    'invisible(score)'
  ].join('\n')
  const callback = `score_callback <- function(theta) {\n${body}\n}`

  it('retains vectorized opaque captures through a named solver without return or ownership proof', async () => {
    const { facts, fileAccess } = await analyzeRNotebookSource(
      `${callback}\nroot <- stats::uniroot(f=score_callback, interval=c(-1,1))`
    )
    expect(facts.usedNames).toEqual(expect.arrayContaining(captures))
    const binding = facts.typeBindings?.find((item) => item.target === 'score_callback')
    const method = facts.typeSummaries?.find((item) => item.name === binding?.typeName)?.methods[0]
    expect(method).toMatchObject({ effect: 'unknown', unknownScope: 'namespace' })
    expect(method?.usedNames).toEqual(expect.arrayContaining(captures))
    expect(method?.safeCallNames).toBeUndefined()
    expect(method?.returnType).toBeUndefined()
    expect(method?.returnCopyArguments).toBeUndefined()
    expect(facts.safeCallNames ?? []).not.toContain('stats::uniroot')
    expect(facts.copyOnModifyNames ?? []).not.toContain('root')
    expect(facts.aliases ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'root', kind: 'reference' })])
    )
    expect(normalizeNotebookSourceFileAccess('r', facts, fileAccess)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect(facts.state).toBe('unknown')
    if (facts.state === 'unknown') expect(facts.reasons).toContain('opaque-call')
  })

  const analyzeCells = async (scripts: string[]): Promise<NotebookRunDependencyFacts> => {
    const entries: FileContextEntry[] = []
    let facts: NotebookRunDependencyFacts | undefined
    for (const script of scripts) {
      const result = await analyzeRNotebookSource(script, projectNotebookFileContext('r', entries))
      facts = result.facts
      if (result.fileAccess) entries.push({ facts, fileContext: result.fileAccess.context })
    }
    return facts!
  }
  const expectNoCaptures = (facts: NotebookRunDependencyFacts): void => {
    for (const name of captures) expect(facts.usedNames ?? []).not.toContain(name)
    expect(facts.safeCallNames ?? []).not.toContain('stats::uniroot')
    // Existing unresolved generic calls can be represented by receiver evidence;
    // the public projection still quarantines their effects.
    if (facts.state === 'available') expect(facts.receiverCalls?.length).toBeGreaterThan(0)
  }

  it.each([
    ['inline slot zero', `stats::uniroot(function(theta) {${body}}, c(-1,1))`],
    ['inline named f', `stats::uniroot(interval=c(-1,1), f=function(theta) {${body}})`],
    ['unshadowed bare solver', `${callback}\nuniroot(f=score_callback, interval=c(-1,1))`],
    [
      'ordinary callback alias',
      `${callback}\nselected <- score_callback\nstats::uniroot(selected, c(-1,1))`
    ],
    [
      'exact f instead of another positional function',
      `${callback}\nstats::uniroot(function(x) unrelated_value, f=score_callback, interval=c(-1,1))`
    ]
  ])('retains bounded captures for %s', async (_, source) => {
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.usedNames).toEqual(expect.arrayContaining(captures))
    expect(facts.usedNames ?? []).not.toContain('unrelated_value')
    expect(facts.state).toBe('unknown')
  })

  it.each(['score_callback', 'selected'])(
    'consumes %s from an available definition-only producer',
    async (name) => {
      const facts = await analyzeCells([
        `${callback}\nselected <- score_callback`,
        `stats::uniroot(f=${name}, interval=c(-1,1))`
      ])
      expect(facts.usedNames).toEqual(expect.arrayContaining(captures))
      expect(facts.state).toBe('unknown')
    }
  )

  it.each(['mean', 'exp', 'length', 'formatC', 'paste', 'invisible', '+', '::'])(
    'rejects late and cross-cell %s rebinding before consuming a callback',
    async (name) => {
      const rebound = `\`${name}\` <- function(...) 0`
      expectNoCaptures(
        (
          await analyzeRNotebookSource(
            `${callback}\n${rebound}\nstats::uniroot(score_callback,c(-1,1))`
          )
        ).facts
      )
      expectNoCaptures(
        await analyzeCells([callback, rebound, 'stats::uniroot(score_callback,c(-1,1))'])
      )
    }
  )

  it('revalidates stored read-only captures without inheriting their return or safe-call proofs', async () => {
    const pure = 'known_callback <- function(theta) theta - captured_offset'
    for (const name of ['known_callback', 'selected']) {
      const facts = await analyzeCells([
        `${pure}\nselected <- known_callback`,
        `root <- stats::uniroot(f=${name},interval=c(-1,1))`
      ])
      expect(facts.usedNames).toContain('captured_offset')
      expect(facts.state).toBe('unknown')
      expect(facts.safeCallNames ?? []).not.toContain('-')
      expect(facts.copyOnModifyNames ?? []).not.toContain('root')
    }
    const rebound = await analyzeCells([
      pure,
      '`-` <- function(...) 0',
      'stats::uniroot(known_callback,c(-1,1))'
    ])
    expect(rebound.usedNames ?? []).not.toContain('captured_offset')
    expect(rebound.state).toBe('unknown')
  })

  const normalizedCallbackContext = async (
    overrides: Partial<NotebookDependencyTypeSummary['methods'][number]> = {}
  ): Promise<NonNullable<ReturnType<typeof projectNotebookFileContext>>> => {
    const producer = await analyzeRNotebookSource(`${callback}\nselected <- score_callback`)
    const context = projectNotebookFileContext('r', [
      { facts: producer.facts, fileContext: producer.fileAccess!.context }
    ])!
    return {
      ...context,
      rFunctions: context.rFunctions?.map((item) => ({
        ...item,
        summary: {
          ...item.summary,
          methods: item.summary.methods.map((method) => ({
            ...method,
            // The public cache normalizes absent safe-call and return proofs.
            safeCallNames: [],
            returnType: null,
            ...overrides
          }))
        }
      }))
    }
  }

  it.each(['score_callback', 'selected'])(
    'retains normalized stored opaque captures for %s without certification',
    async (name) => {
      const { facts, fileAccess } = await analyzeRNotebookSource(
        `root <- stats::uniroot(f=${name}, interval=c(-1,1))`,
        await normalizedCallbackContext()
      )
      expect(facts.usedNames).toEqual(expect.arrayContaining(captures))
      expect(facts.priorUsedNames).toEqual(expect.arrayContaining(captures))
      expect(facts.state).toBe('unknown')
      expect(facts.safeCallNames ?? []).not.toContain('stats::uniroot')
      expect(facts.copyOnModifyNames ?? []).not.toContain('root')
      expect(normalizeNotebookSourceFileAccess('r', facts, fileAccess)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  const unsupportedProofs: [string, Partial<NotebookDependencyTypeSummary['methods'][number]>][] = [
    ['no bounded captures', { usedNames: [] }],
    ['safe-call proof', { safeCallNames: ['mean'] }],
    ['return proof', { returnType: 'vector' }],
    ['copy proof', { returnCopyArguments: true }]
  ]
  it.each(unsupportedProofs)(
    'rejects a normalized opaque summary with %s',
    async (_, overrides) => {
      const { facts } = await analyzeRNotebookSource(
        'stats::uniroot(score_callback,c(-1,1))',
        await normalizedCallbackContext(overrides)
      )
      expectNoCaptures(facts)
    }
  )

  it.each(['mean', 'exp', 'length', 'formatC', 'paste', 'invisible', '+', '::'])(
    'revalidates normalized opaque captures after %s rebinding',
    async (name) => {
      const { facts } = await analyzeRNotebookSource(
        `\`${name}\` <- function(...) 0\nstats::uniroot(score_callback,c(-1,1))`,
        await normalizedCallbackContext()
      )
      expectNoCaptures(facts)
    }
  )

  it('rejects empty stored unknown summaries without bounded capture authority', async () => {
    const producer = await analyzeRNotebookSource(callback)
    const context = projectNotebookFileContext('r', [
      {
        facts: producer.facts,
        fileContext: producer.fileAccess!.context
      }
    ])!
    // Removing a producer's bounded evidence models an empty generic fallback;
    // it must not become a supported callback merely because [] is truthy.
    const stripped = {
      ...context,
      rFunctions: context.rFunctions?.map((item) => ({
        ...item,
        summary: {
          ...item.summary,
          methods: item.summary.methods.map((method) => ({
            ...method,
            usedNames: []
          }))
        }
      }))
    }
    const { facts } = await analyzeRNotebookSource(
      'stats::uniroot(score_callback,c(-1,1))',
      stripped
    )
    expectNoCaptures(facts)
    if (facts.state === 'unknown') expect(facts.reasons).toContain('function-scope')
  })

  it('does not borrow a read-only summary with a shadowed formal operator', async () => {
    const facts = await analyzeCells([
      'known_callback <- function(theta, `-`) theta - captured_offset',
      'stats::uniroot(known_callback,c(-1,1))'
    ])
    expect(facts.usedNames ?? []).not.toContain('captured_offset')
    expect(facts.state).toBe('unknown')
  })

  it.each(['mean', 'exp', 'length', 'formatC', 'paste', 'invisible'])(
    'rejects formal and local %s shadowing in the opaque body',
    async (name) => {
      for (const altered of [
        callback.replace('function(theta)', `function(theta, ${name})`),
        prependFunctionBody(callback, `${name} <- function(...) 0`)
      ]) {
        expectNoCaptures(
          (await analyzeRNotebookSource(`${altered}\nstats::uniroot(score_callback,c(-1,1))`)).facts
        )
      }
    }
  )

  it.each([
    ['callback dots', callback.replace('function(theta)', 'function(theta, ...)')],
    [
      'nonconstant default',
      callback.replace('function(theta)', 'function(theta, value=outer_value)')
    ],
    ['lazy assignment', callback.replace('invisible(score)', 'invisible(hidden <- score)')],
    ['nonlocal mutation', callback.replace('invisible(score)', 'hidden <<- score')],
    ['dynamic lookup', callback.replace('invisible(score)', 'get("hidden")')],
    ['qualified body call', callback.replace('mean(', 'base::mean(')]
  ])('retains the opaque fallback for %s', async (_, altered) => {
    expectNoCaptures(
      (await analyzeRNotebookSource(`${altered}\nstats::uniroot(score_callback,c(-1,1))`)).facts
    )
  })

  it.each([
    ['duplicate f', 'stats::uniroot(f=score_callback,f=score_callback,interval=c(-1,1))'],
    ['missing f', 'stats::uniroot(interval=c(-1,1))'],
    ['named-before-positional f', 'stats::uniroot(interval=c(-1,1),score_callback)'],
    ['partial f name', 'stats::uniroot(f.lower=score_callback,interval=c(-1,1))'],
    ['dots expansion', 'stats::uniroot(score_callback,c(-1,1),...)'],
    ['private namespace', 'stats:::uniroot(score_callback,c(-1,1))'],
    ['wrong namespace', 'other::uniroot(score_callback,c(-1,1))'],
    ['solver alias', 'solver <- stats::uniroot\nsolver(score_callback,c(-1,1))'],
    ['dynamic solver', 'do.call(stats::uniroot,list(f=score_callback,interval=c(-1,1)))'],
    ['shadowed bare solver', 'uniroot <- function(...) 0\nuniroot(score_callback,c(-1,1))'],
    [
      'rebound callback',
      'score_callback <- function(...) 0\nstats::uniroot(score_callback,c(-1,1))'
    ],
    ['conditional alias', 'if(flag) selected <- score_callback\nstats::uniroot(selected,c(-1,1))']
  ])('does not consume hidden captures for %s', async (_, source) => {
    expectNoCaptures((await analyzeRNotebookSource(`${callback}\n${source}`)).facts)
  })

  it('keeps actual R2 top-level opaque checks as cross-cell context barriers', async () => {
    for (const guard of ['all(diff(ozone_values) > 0)', 'all(is.finite(ozone_values))']) {
      expectNoCaptures(
        await analyzeCells([
          `${callback}\nstopifnot(${guard})`,
          'stats::uniroot(score_callback,c(-1,1))'
        ])
      )
    }
  })

  it.each(['stats::uniroot', 'uniroot'])(
    'keeps unsupported %s aliases unknown in the public projection',
    async (solver) => {
      const projection = await projectScripts(
        'r',
        [callback, `solver <- ${solver}\nroot <- solver(score_callback,c(-1,1))`],
        'r-opaque-solver-alias-'
      )
      expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
      expect(projection.dependenciesByRunId?.['run-2']).toBeUndefined()
    }
  )

  it('does not promote nested solvers or opaque callbacks in existing functionals', async () => {
    for (const source of [
      `outer <- function(theta) stats::uniroot(function(x) {${body}}, c(-1,1))`,
      callback
    ]) {
      const { facts } = await analyzeRNotebookSource(source)
      const method = facts.typeSummaries?.find((summary) => summary.kind === 'r-function')
        ?.methods[0]
      expect(method).toMatchObject({ effect: 'unknown', unknownScope: 'namespace' })
      expect(method?.safeCallNames).toBeUndefined()
      expect(method?.returnType).toBeUndefined()
      expect(method?.returnCopyArguments).toBeUndefined()
    }
    for (const call of [
      'lapply(c(1,2),score_callback)',
      'Map(score_callback,c(1,2))',
      'Reduce(score_callback,c(1,2))',
      'purrr::map(c(1,2),score_callback)'
    ])
      expectNoCaptures((await analyzeRNotebookSource(`${callback}\n${call}`)).facts)
  })
})

describe('R integrate partial callback captures', () => {
  const captures = ['BANDWIDTH_PATH', 'PHASE', 'waiting_values', 'TRACE_PATH', 'read_next_batch_id']
  // Reduced from the genuinely generated Faithful producer. This is parser
  // coverage, not a replacement scientific execution or numerical fixture.
  const helper = [
    'read_next_batch_id <- function(path) {',
    '  lines <- readLines(path, warn=FALSE)',
    '  if (length(lines) <= 1L) return(1L)',
    '  max(as.integer(lines[-1])) + 1L',
    '}'
  ].join('\n')
  const body = [
    'if (!file.exists(BANDWIDTH_PATH)) stop("missing bandwidth", BANDWIDTH_PATH)',
    'bw_text <- readLines(BANDWIDTH_PATH, warn=FALSE)',
    'h <- as.numeric(bw_text[1])',
    'if (!is.finite(h) || h <= 0) stop("invalid bandwidth")',
    'x <- as.numeric(x)',
    'if (!all(is.finite(x))) stop("nonfinite nodes")',
    'next_batch <- read_next_batch_id(TRACE_PATH)',
    'n <- length(waiting_values)',
    'if (n <= 0L) stop("empty waiting values")',
    'norm_const <- 1 / (n * h * sqrt(2 * pi))',
    'nx <- length(x)',
    'y <- numeric(nx)',
    'for (j in seq_len(nx)) {',
    '  diffs <- (x[j] - waiting_values) / h',
    '  y[j] <- sum(exp(-0.5 * diffs * diffs)) * norm_const',
    '}',
    'if (length(y) != nx) stop("node count mismatch")',
    'if (any(!is.finite(y))) stop("nonfinite density")',
    'if (any(y < 0)) stop("negative density")',
    'con <- file(TRACE_PATH, open="ab")',
    'node_count <- nx',
    'for (k in seq_len(nx)) {',
    '  line <- sprintf("%d,%d,%s,%.17g", next_batch, k, PHASE, y[k])',
    '  writeLines(line, con=con, useBytes=TRUE)',
    '}',
    'close(con)',
    'y'
  ].join('\n')
  const callback = `kde_callback <- function(x) {\n${body}\n}`
  const producer = `${helper}\n${callback}\ncallback_alias <- kde_callback`
  const consumer = 'result <- stats::integrate(kde_callback, lower=60, upper=70)'
  const locals = [
    'x',
    'bw_text',
    'h',
    'next_batch',
    'n',
    'norm_const',
    'nx',
    'y',
    'j',
    'diffs',
    'con',
    'node_count',
    'k',
    'line'
  ]

  it('retains actual Faithful if-for-file captures without completing callback effects', async () => {
    const { facts: producerFacts } = await analyzeRNotebookSource(producer)
    const binding = producerFacts.typeBindings?.find((item) => item.target === 'kde_callback')
    const method = producerFacts.typeSummaries?.find((item) => item.name === binding?.typeName)
      ?.methods[0]
    expect(method).toMatchObject({ effect: 'unknown', unknownScope: 'namespace' })
    expect(method?.usedNames).toEqual(expect.arrayContaining(captures))
    expect(method?.safeCallNames).toBeUndefined()
    expect(method?.returnType).toBeUndefined()
    expect(method?.returnCopyArguments).toBeUndefined()
    for (const name of locals) expect(method?.usedNames ?? []).not.toContain(name)

    const { facts, fileAccess } = await analyzeRNotebookSource(`${producer}\n${consumer}`)
    expect(facts.usedNames).toEqual(expect.arrayContaining(captures))
    expect(facts.state).toBe('unknown')
    expect(facts.safeCallNames ?? []).not.toContain('stats::integrate')
    expect(facts.copyOnModifyNames ?? []).not.toContain('result')
    expect(facts.aliases ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'result', kind: 'reference' })])
    )
    expect(facts.typeBindings ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'result' })])
    )
    expect(normalizeNotebookSourceFileAccess('r', facts, fileAccess)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  const analyzeCells = async (scripts: string[]): ReturnType<typeof analyzeRNotebookSource> => {
    const entries: FileContextEntry[] = []
    let result: Awaited<ReturnType<typeof analyzeRNotebookSource>> | undefined
    for (const script of scripts) {
      result = await analyzeRNotebookSource(script, projectNotebookFileContext('r', entries))
      if (result.fileAccess)
        entries.push({ facts: result.facts, fileContext: result.fileAccess.context })
    }
    return result!
  }
  const expectNoCaptures = (facts: NotebookRunDependencyFacts): void => {
    for (const name of captures) expect(facts.usedNames ?? []).not.toContain(name)
    expect(facts.safeCallNames ?? []).not.toContain('stats::integrate')
    expect(facts.copyOnModifyNames ?? []).not.toContain('result')
  }
  const callbackMethod = (
    facts: NotebookRunDependencyFacts,
    name = 'kde_callback'
  ): NotebookDependencyTypeSummary['methods'][number] | undefined => {
    const binding = facts.typeBindings?.find((item) => item.target === name)
    return facts.typeSummaries?.find((item) => item.name === binding?.typeName)?.methods[0]
  }

  it.each([
    ['exact f', 'stats::integrate(lower=60, upper=70, f=kde_callback)'],
    ['unshadowed bare solver', 'integrate(f=kde_callback, lower=60, upper=70)'],
    ['ordinary callback alias', 'stats::integrate(callback_alias, lower=60, upper=70)'],
    ['inline callback', `stats::integrate(function(x) {${body}}, lower=60, upper=70)`],
    [
      'exact f instead of another positional function',
      'stats::integrate(function(x) unrelated_value, f=kde_callback, lower=60, upper=70)'
    ]
  ])('consumes bounded captures for %s without a solver return contract', async (_, call) => {
    const { facts } = await analyzeRNotebookSource(`${producer}\nresult <- ${call}`)
    expect(facts.usedNames).toEqual(expect.arrayContaining(captures))
    expect(facts.usedNames ?? []).not.toContain('unrelated_value')
    expect(facts.state).toBe('unknown')
    expect(facts.safeCallNames ?? []).not.toContain('stats::integrate')
    expect(facts.safeCallNames ?? []).not.toContain('integrate')
    expect(facts.copyOnModifyNames ?? []).not.toContain('result')
    expect(facts.typeBindings ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'result' })])
    )
  })

  it.each(['kde_callback', 'callback_alias'])(
    'consumes %s from a separate producer while retaining UNKNOWN and partial I/O',
    async (name) => {
      const { facts, fileAccess } = await analyzeCells([
        producer,
        `result <- stats::integrate(f=${name}, lower=60, upper=70)`
      ])
      expect(facts.usedNames).toEqual(expect.arrayContaining(captures))
      expect(facts.priorUsedNames).toEqual(expect.arrayContaining(captures))
      expect(facts.state).toBe('unknown')
      expect(facts.safeCallNames ?? []).not.toContain('stats::integrate')
      expect(facts.copyOnModifyNames ?? []).not.toContain('result')
      expect(normalizeNotebookSourceFileAccess('r', facts, fileAccess)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('borrows only captures from a read-only producer, not its return or copy authority', async () => {
    const { facts } = await analyzeCells([
      'known_callback <- function(x) x - captured_offset',
      'result <- stats::integrate(known_callback, lower=60, upper=70)'
    ])
    expect(facts.usedNames).toContain('captured_offset')
    expect(facts.state).toBe('unknown')
    expect(facts.safeCallNames ?? []).not.toContain('-')
    expect(facts.copyOnModifyNames ?? []).not.toContain('result')
    expect(facts.typeBindings ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'result' })])
    )
  })

  it('captures a plain helper name without recursively reading its body or forcing arguments', async () => {
    const source = [
      'read_next_batch_id <- function(path) hidden_helper_state + as.numeric(path)',
      callback.replace('read_next_batch_id(TRACE_PATH)', 'read_next_batch_id(UNFORCED_ARGUMENT)'),
      consumer
    ].join('\n')
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.usedNames).toEqual(expect.arrayContaining(captures))
    expect(facts.usedNames ?? []).not.toContain('hidden_helper_state')
    expect(facts.usedNames ?? []).not.toContain('UNFORCED_ARGUMENT')
    expect(facts.state).toBe('unknown')
  })

  it('does not infer a local binding from assignment inside an unforced helper argument', async () => {
    const altered = callback
      .replace(
        'read_next_batch_id(TRACE_PATH)',
        'read_next_batch_id(argument_local <- UNFORCED_ARGUMENT)'
      )
      .replace('\nclose(con)', '\nclose(con)\nargument_local')
    const { facts } = await analyzeRNotebookSource(`${helper}\n${altered}\n${consumer}`)
    expect(facts.usedNames ?? []).not.toContain('UNFORCED_ARGUMENT')
    expect(facts.usedNames).toContain('argument_local')
    expect(facts.state).toBe('unknown')
  })

  it('excludes deferred nested body and default reads while retaining direct outer captures', async () => {
    const altered = callback.replace(
      '\nclose(con)',
      '\nclose(con)\ndeferred <- function(z=DEFERRED_DEFAULT) { DEFERRED_BODY + z }'
    )
    const { facts } = await analyzeRNotebookSource(`${helper}\n${altered}\n${consumer}`)
    expect(facts.usedNames).toEqual(expect.arrayContaining(captures))
    for (const name of ['deferred', 'z', 'DEFERRED_DEFAULT', 'DEFERRED_BODY'])
      expect(callbackMethod(facts)?.usedNames ?? []).not.toContain(name)
    expect(callbackMethod(facts)?.safeCallNames).toBeUndefined()
    expect(callbackMethod(facts)?.returnType).toBeUndefined()
    expect(callbackMethod(facts)?.returnCopyArguments).toBeUndefined()
  })

  it.each([
    ['callback dots', callback.replace('function(x)', 'function(x, ...)')],
    ['nonconstant default', callback.replace('function(x)', 'function(x, value=DEFAULT_VALUE)')],
    [
      'effectful default',
      callback.replace('function(x)', 'function(x, value=readLines(DEFAULT_PATH))')
    ],
    ['dynamic lookup', callback.replace('y\n}', 'get(DYNAMIC_NAME)\ny\n}')],
    ['reflective evaluation', callback.replace('y\n}', 'eval(REFLECTIVE_CODE)\ny\n}')],
    [
      'dynamic invocation',
      callback.replace('y\n}', 'do.call(DYNAMIC_FUNCTION, list(DYNAMIC_ARGUMENT))\ny\n}')
    ],
    ['dynamic namespace', callback.replace('sum(exp(', 'get(PACKAGE)::sum(exp(')],
    ['nonlocal mutation', callback.replace('y\n}', 'SHARED_STATE <<- y\ny\n}')],
    ['reflective assignment', callback.replace('y\n}', 'assign(ASSIGNED_NAME, y)\ny\n}')],
    [
      'lazy argument assignment',
      callback.replace('readLines(BANDWIDTH_PATH,', 'readLines(hidden <- BANDWIDTH_PATH,')
    ]
  ])('retains the opaque fallback for %s', async (_, altered) => {
    const { facts } = await analyzeRNotebookSource(`${helper}\n${altered}\n${consumer}`)
    expectNoCaptures(facts)
    expect(facts.state).toBe('unknown')
  })

  it.each(['exp', 'readLines', 'file', 'writeLines', 'seq_len', 'sum', 'sqrt', 'sprintf'])(
    'does not force argument captures through formal, local, or late %s shadowing',
    async (callee) => {
      const minimal = `minimal <- function(x) ${callee}(HIDDEN_ARGUMENT)`
      for (const source of [
        minimal.replace('function(x)', `function(x, ${callee})`),
        `minimal <- function(x) { ${callee} <- function(...) 0; ${callee}(HIDDEN_ARGUMENT) }`,
        `${minimal}\n${callee} <- function(...) 0`
      ]) {
        const { facts } = await analyzeRNotebookSource(
          `${source}\nstats::integrate(minimal, lower=60, upper=70)`
        )
        expect(facts.usedNames ?? []).not.toContain('HIDDEN_ARGUMENT')
      }
    }
  )

  it.each(['exp', 'file', 'sprintf', '+', '::'])(
    'rejects stored captures after current %s rebinding',
    async (name) => {
      const { facts } = await analyzeCells([producer, `\`${name}\` <- function(...) 0`, consumer])
      expectNoCaptures(facts)
      expect(facts.state).toBe('unknown')
    }
  )

  it.each([
    ['duplicate f', 'stats::integrate(f=kde_callback,f=kde_callback,lower=60,upper=70)'],
    ['missing f', 'stats::integrate(lower=60,upper=70)'],
    ['named-before-positional f', 'stats::integrate(lower=60,kde_callback,upper=70)'],
    ['partial f name', 'stats::integrate(fu=kde_callback,lower=60,upper=70)'],
    ['dots expansion', 'stats::integrate(kde_callback,lower=60,upper=70,...)'],
    ['private namespace', 'stats:::integrate(kde_callback,lower=60,upper=70)'],
    ['wrong namespace', 'other::integrate(kde_callback,lower=60,upper=70)'],
    ['solver alias', 'solver <- stats::integrate\nsolver(kde_callback,lower=60,upper=70)'],
    ['dynamic solver', 'do.call(stats::integrate,list(f=kde_callback,lower=60,upper=70))'],
    [
      'shadowed bare solver',
      'integrate <- function(...) 0\nintegrate(kde_callback,lower=60,upper=70)'
    ],
    [
      'shadowed namespace operator',
      '`::` <- function(...) 0\nstats::integrate(kde_callback,lower=60,upper=70)'
    ],
    [
      'rebound callback',
      'kde_callback <- function(...) 0\nstats::integrate(kde_callback,lower=60,upper=70)'
    ],
    [
      'conditional alias',
      'if(flag) selected <- kde_callback\nstats::integrate(selected,lower=60,upper=70)'
    ]
  ])('does not consume hidden captures for %s', async (_, call) => {
    expectNoCaptures((await analyzeRNotebookSource(`${producer}\n${call}`)).facts)
  })

  it('preserves the later opaque consumer context barrier', async () => {
    const { facts } = await analyzeCells([producer, consumer, consumer])
    expectNoCaptures(facts)
    expect(facts.state).toBe('unknown')
  })

  it('does not certify nested solver returns or opaque callbacks in other functionals', async () => {
    const { facts: nested } = await analyzeRNotebookSource(
      `outer <- function(x) stats::integrate(function(z) DEFERRED_CAPTURE, lower=60, upper=70)`
    )
    const method = callbackMethod(nested, 'outer')
    expect(method).toMatchObject({ effect: 'unknown', unknownScope: 'namespace' })
    expect(method?.usedNames ?? []).not.toContain('DEFERRED_CAPTURE')
    expect(method?.safeCallNames).toBeUndefined()
    expect(method?.returnType).toBeUndefined()
    expect(method?.returnCopyArguments).toBeUndefined()
    for (const call of ['lapply(c(1,2),kde_callback)', 'Map(kde_callback,c(1,2))'])
      expectNoCaptures((await analyzeRNotebookSource(`${producer}\n${call}`)).facts)
  })

  it.each([
    ['branch', 'if (TRUE) exp <- function(ignored) x'],
    ['loop', 'for (j in 1:1) exp <- function(ignored) x']
  ])('does not force arguments after a possible %s callee shadow', async (_, shadow) => {
    const { facts } = await analyzeRNotebookSource(
      `cb <- function(x) { ${shadow}; exp(HIDDEN) }\nstats::integrate(cb, lower=60, upper=70)`
    )
    expect(facts.usedNames ?? []).not.toContain('HIDDEN')
    expect(callbackMethod(facts, 'cb')?.usedNames ?? []).not.toContain('HIDDEN')
    expect(callbackMethod(facts, 'cb')?.safeCallNames).toBeUndefined()
    expect(callbackMethod(facts, 'cb')?.returnType).toBeUndefined()
    expect(facts.state).toBe('unknown')
  })

  it('does not borrow a global helper after a possible branch or loop shadow', async () => {
    for (const shadow of [
      'if (TRUE) read_next_batch_id <- function(ignored) x',
      'for (j in 1:1) read_next_batch_id <- function(ignored) x'
    ]) {
      const { facts } = await analyzeRNotebookSource(
        `${helper}\ncb <- function(x) { ${shadow}; read_next_batch_id(HIDDEN) }\nstats::integrate(cb, lower=60, upper=70)`
      )
      expect(facts.usedNames ?? []).not.toContain('HIDDEN')
      expect(facts.usedNames ?? []).not.toContain('read_next_batch_id')
      expect(callbackMethod(facts, 'cb')?.safeCallNames).toBeUndefined()
      expect(callbackMethod(facts, 'cb')?.returnCopyArguments).toBeUndefined()
      expect(facts.state).toBe('unknown')
    }
  })
})

configureTestRuntimeMetadata()
