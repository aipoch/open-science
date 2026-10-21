import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from './analysis-test-support'
import {
  NotebookDependencyAnalyzer,
  type NotebookDependencyInterpreter
} from './analysis-test-support'
import { analyzePythonNotebookSource, analyzePythonSources } from './dependency-analysis-python'
import { analyzeRNotebookSource, analyzeRSources } from './dependency-analysis-r'
import { projectNotebookDependencies } from './dependency-projection'
import { projectNotebookFileContext, type FileContextEntry } from './dependency-file-context'
import {
  analyzeNotebookSourceFileAccess,
  normalizeNotebookSourceFileAccess
} from './source-file-access-analysis'
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
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, maxRetries: 5, retryDelay: 100 }))
  )
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

describe('R implicit scientific method authority', () => {
  const calls = [
    ['median(df$x)', 'median.numeric'],
    ['median(df$x)', 'sort.numeric'],
    ['median(df$x)', 'mean.numeric'],
    ['quantile(df$x)', 'quantile.integer'],
    ['quantile(df$x)', 'sort.numeric'],
    ['weighted.mean(df$x,c(1,2))', 'weighted.mean.numeric'],
    ['IQR(df$x)', 'quantile.numeric'],
    ['IQR(df$x)', 'diff.numeric'],
    ['mad(df$x)', 'median.numeric'],
    ['mad(df$x,low=TRUE)', 'sort.numeric'],
    ['fivenum(df$x)', 'sort.numeric'],
    ['quantile(df$x,probs=c(' + Array(100).fill('.5').join(',') + '))', 'format.numeric']
  ]
  it.each(calls)('withdraws ordinary results from %s when %s is replaced', async (call, method) => {
    const source =
      'df<-read.csv("in.csv");value<-' + call + ';summary<-mean(value);write.csv(summary,"out.csv")'
    for (const prefix of ['', method + '<-function(x,...) structure(1,class="custom");']) {
      const context = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: [method]
      }
      const activeContext = prefix ? undefined : context
      const { facts } = await analyzeRNotebookSource(prefix + source, activeContext)
      expect(facts.rAtomicValueNames ?? []).not.toContain('value')
      expect(facts.rAtomicValueNames ?? []).not.toContain('summary')
      expect(
        await analyzeNotebookSourceFileAccess('r', prefix + source, activeContext)
      ).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        reads: ['in.csv'],
        writes: ['out.csv']
      })
    }
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.priorUsedNames).toContain(method)
    expect(facts.safeCallNames).toContain(method)
    const scripts = [
      'df<-read.csv("in.csv")',
      'value<-' + call,
      'copy<-value',
      'summary<-mean(copy)',
      'write.csv(summary,"out.csv")'
    ]
    expect(
      (await projectScripts('r', scripts, 'implicit-statistic-')).stalenessByRunId['run-5'].state
    ).toBe('clear')
    expect(
      (
        await projectScripts(
          'r',
          [...scripts, method + '<-function(x,...) 1'],
          'implicit-statistic-change-'
        )
      ).stalenessByRunId['run-5'].state
    ).toBe('unknown')
  })
  it('withdraws CSV column authority when type.convert.character is replaced', async () => {
    const method = 'type.convert.character'
    const source = 'df<-utils::read.csv("in.csv");value<-mean(df$x);write.csv(value,"out.csv")'
    for (const prefix of [
      '',
      method +
        '<-function(x,...) structure(as.double(x),class="custom");mean.custom<-function(x,...) {writeLines("effect","hidden.txt");1};'
    ]) {
      const context = prefix
        ? undefined
        : {
            staticStrings: [],
            staticCollections: [],
            localFileWrappers: [],
            resolvedKernelNames: [method]
          }
      const { facts } = await analyzeRNotebookSource(prefix + source, context)
      expect(facts.rAtomicTableNames ?? []).not.toContain('df')
      expect(facts.rAtomicValueNames ?? []).not.toContain('value')
      expect(await analyzeNotebookSourceFileAccess('r', prefix + source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        reads: ['in.csv'],
        writes: ['out.csv']
      })
    }
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.priorUsedNames).toContain(method)
    expect(facts.safeCallNames).toContain(method)
    const scripts = [
      'df<-read.csv("in.csv")',
      'copy<-df$x',
      'value<-mean(copy)',
      'write.csv(value,"out.csv")'
    ]
    expect(
      (
        await projectScripts(
          'r',
          [...scripts, method + '<-function(x,...) x'],
          'csv-convert-change-'
        )
      ).stalenessByRunId['run-4'].state
    ).toBe('unknown')
  })
  it('does not require format methods when quantile avoids S3 label formatting', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['format.numeric']
    }
    for (const options of ['', ',probs=c(' + Array(100).fill('.5').join(',') + '),names=FALSE']) {
      const source = 'value<-quantile(c(1,2,3)' + options + ')'
      const { facts } = await analyzeRNotebookSource(source, context)
      expect(facts.rAtomicValueNames).toContain('value')
      expect(facts.priorUsedNames).not.toContain('format.numeric')
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
        readState: 'complete',
        writeState: 'complete'
      })
    }
  })
})

describe('R file wrapper identity in statement order', () => {
  // Handwritten controls for the sealed native wrapper diagnosis, not new Agent science.
  const reader = 'reader <- function(path) utils::read.csv(path)'
  const writer = 'writer <- function(path) base::writeLines("done", con=path)'

  it.each([
    [
      'reader redefinition',
      reader,
      'reader <- function(path) NULL',
      'reader("inputs/obsolete.csv")'
    ],
    [
      'reader body replacement',
      reader,
      'body(reader) <- quote(NULL)',
      'reader("inputs/obsolete.csv")'
    ],
    ['reader identity assignment', reader, 'reader <- identity', 'reader("inputs/obsolete.csv")'],
    ['reader rightward assignment', reader, 'identity -> reader', 'reader("inputs/obsolete.csv")'],
    ['reader parent assignment', reader, 'reader <<- identity', 'reader("inputs/obsolete.csv")'],
    [
      'writer redefinition',
      writer,
      'writer <- function(path) NULL',
      'writer("outputs/obsolete.txt")'
    ],
    [
      'reader formal replacement',
      reader,
      'formals(reader) <- alist(unused=, path=, last=)',
      'reader("inputs/decoy.csv", "inputs/actual.csv", 0)'
    ]
  ])('discards the obsolete file contract after %s', async (_name, setup, replacement, call) => {
    const result = await analyzeRNotebookSource(`${setup}\n${replacement}\nresult <- ${call}`)
    expect(result.fileAccess?.reads).toEqual([])
    expect(result.fileAccess?.writes).toEqual([])
    expect(result.fileAccess?.context.localFileWrappers).toEqual([])
  })

  it('retains an earlier input and exports only a later stable restoration', async () => {
    const result = await analyzeRNotebookSource(
      `${reader}\nfirst <- reader("inputs/earlier.csv")\nreader <- identity\n` +
        'ignored <- reader("inputs/obsolete.csv")\n' +
        `${reader}\nlast <- reader("inputs/restored.csv")`
    )
    expect(result.fileAccess?.reads).toEqual(['inputs/earlier.csv', 'inputs/restored.csv'])
    expect(result.fileAccess?.context.localFileWrappers).toEqual([
      expect.objectContaining({ name: 'reader', kind: 'read' })
    ])
  })

  it('retains an earlier output without exporting its replaced writer', async () => {
    const result = await analyzeRNotebookSource(
      `${writer}\nwriter("outputs/earlier.txt")\nwriter <- function(path) NULL\n` +
        'writer("outputs/obsolete.txt")'
    )
    expect(result.fileAccess?.writes).toEqual(['outputs/earlier.txt'])
    expect(result.fileAccess?.context.localFileWrappers).toEqual([])
  })

  it('uses the incoming reader before a same-cell replacement at the public boundary', async () => {
    const initial = await analyzeRNotebookSource(reader)
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'first <- reader("inputs/earlier.csv")\nreader <- function(path) NULL\n' +
        'last <- reader("inputs/obsolete.csv")',
      initial.fileAccess?.context
    )
    expect(result.reads).toEqual(['inputs/earlier.csv'])
  })

  it('visits the old reader on the RHS before replacing its binding', async () => {
    const result = await analyzeRNotebookSource(
      `${reader}\nreader <- reader("inputs/earlier.csv")\nreader("inputs/obsolete.csv")`
    )
    expect(result.fileAccess?.reads).toEqual(['inputs/earlier.csv'])
    expect(result.fileAccess?.context.localFileWrappers).toEqual([])
  })

  it('preserves a first-formal writer path with a later named option', async () => {
    const result = await analyzeRNotebookSource(
      'cat <- function(file, append) writeLines("done", file)\n' +
        'cat("outputs/report.txt", append=TRUE)'
    )
    expect(normalizeNotebookSourceFileAccess('r', result.facts, result.fileAccess)).toMatchObject({
      reads: [],
      writes: ['outputs/report.txt'],
      writeState: 'complete'
    })
  })

  it('does not guess the first writer formal when its partial name is supplied', async () => {
    const result = await analyzeRNotebookSource(
      'cat <- function(file, append) writeLines("done", file)\n' +
        'cat(f="outputs/actual.txt", "outputs/decoy.txt")'
    )
    expect(normalizeNotebookSourceFileAccess('r', result.facts, result.fileAccess)).toMatchObject({
      reads: [],
      writes: [],
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    [
      'a primitive replaced before declaration',
      'writeLines <- function(...) NULL\nwriter <- function(path) writeLines("done", con=path)'
    ],
    [
      'a redeclaration after its primitive was replaced',
      'writer <- function(path) writeLines("done", con=path)\n' +
        'writeLines <- function(...) NULL\nwriter <- function(path) writeLines("done", con=path)'
    ]
  ])('does not reactivate a writer contract through %s', async (_label, setup) => {
    const result = await analyzeRNotebookSource(`${setup}\nwriter("outputs/obsolete.txt")`)
    expect(result.fileAccess?.context.localFileWrappers).toEqual([])
    expect(normalizeNotebookSourceFileAccess('r', result.facts, result.fileAccess)).toMatchObject({
      writes: [],
      writeState: 'partial'
    })
  })

  it('retains an explicit base writer despite replacement of its unqualified name', async () => {
    const result = await analyzeRNotebookSource(
      'writeLines <- function(...) NULL\n' + `${writer}\nwriter("outputs/actual.txt")`
    )
    expect(result.fileAccess?.writes).toEqual(['outputs/actual.txt'])
    expect(result.fileAccess?.context.localFileWrappers).toEqual([
      expect.objectContaining({ name: 'writer', kind: 'write' })
    ])
  })

  it.each([
    ['reader', 'utils::read.csv(path)', 'inputs'],
    ['writer', 'base::writeLines("done", con=path)', 'outputs']
  ])(
    'does not guess a %s path after named arguments consume later formals',
    async (name, body, directory) => {
      const result = await analyzeRNotebookSource(
        `${name} <- function(unused, path, last) ${body}\n` +
          `${name}(last=0, "${directory}/decoy.csv", "${directory}/actual.csv")`
      )
      expect(normalizeNotebookSourceFileAccess('r', result.facts, result.fileAccess)).toMatchObject(
        {
          reads: [],
          writes: [],
          externalState: 'partial',
          ...(name === 'reader' ? { readState: 'partial' } : { writeState: 'partial' })
        }
      )
    }
  )

  it.each([
    [
      'ordinary positional reader',
      'reader',
      'utils::read.csv(path)',
      'reader(0, "inputs/actual.csv", 0)',
      ['inputs/actual.csv'],
      []
    ],
    [
      'exact named reader',
      'reader',
      'utils::read.csv(path)',
      'reader(path="inputs/actual.csv", last=0, unused=0)',
      ['inputs/actual.csv'],
      []
    ],
    [
      'ordinary positional writer',
      'writer',
      'base::writeLines("done", con=path)',
      'writer(0, "outputs/actual.txt", 0)',
      [],
      ['outputs/actual.txt']
    ],
    [
      'exact named writer',
      'writer',
      'base::writeLines("done", con=path)',
      'writer(path="outputs/actual.txt", last=0, unused=0)',
      [],
      ['outputs/actual.txt']
    ]
  ])('preserves the %s contract', async (_label, name, body, call, reads, writes) => {
    const result = await analyzeRNotebookSource(
      `${name} <- function(unused, path, last) ${body}\n${call}`
    )
    expect(result.fileAccess?.reads).toEqual(reads)
    expect(result.fileAccess?.writes).toEqual(writes)
  })
})

describe('Python annotation-only source I/O preservation', () => {
  it.each([
    [
      'module identity',
      'import numpy as np\nnp: object',
      'np.genfromtxt("inputs/observations.csv")'
    ],
    [
      'reader identity',
      'from numpy import genfromtxt as reader\nreader: object',
      'reader("inputs/observations.csv")'
    ],
    [
      'static path',
      'import numpy as np\npath = "inputs/observations.csv"\npath: str',
      'np.genfromtxt(path)'
    ]
  ])('keeps the known input through an annotation-only %s', async (_, setup, read) => {
    const { fileAccess } = await analyzePythonNotebookSource(`${setup}\narray = ${read}`)
    expect(fileAccess?.reads).toEqual(['inputs/observations.csv'])
  })

  it('keeps module and path evidence for both input and output', async () => {
    const source =
      'import numpy as np\npath = "inputs/observations.csv"\n' +
      'np: object\npath: str\narray = np.genfromtxt(path)\n' +
      'np.savetxt("outputs/observations.csv", array)'
    const { fileAccess } = await analyzePythonNotebookSource(source)
    expect(fileAccess?.reads).toEqual(['inputs/observations.csv'])
    expect(fileAccess?.writes).toEqual(['outputs/observations.csv'])
    expect(fileAccess?.context?.pythonBindings).toContainEqual(
      expect.objectContaining({ name: 'np', qualifiedName: 'numpy' })
    )
    expect(fileAccess?.context?.staticStrings).toContainEqual({
      name: 'path',
      value: 'inputs/observations.csv'
    })
  })

  it('uses the replacement path after a real annotated assignment', async () => {
    const { fileAccess } = await analyzePythonNotebookSource(
      'import numpy as np\npath = "inputs/old.csv"\n' +
        'path: str = "inputs/observations.csv"\narray = np.genfromtxt(path)'
    )
    expect(fileAccess?.reads).toEqual(['inputs/observations.csv'])
  })

  it('does not erase a real path rebind within an annotation expression', async () => {
    const { fileAccess } = await analyzePythonNotebookSource(
      'import numpy as np\npath = "inputs/old.csv"\n' +
        'path: (path := "inputs/observations.csv")\narray = np.genfromtxt(path)'
    )
    expect(fileAccess?.reads).toEqual(['inputs/observations.csv'])
  })

  it.each(['np', 'path'])(
    'does not borrow a global for an unbound function-local annotation-only %s',
    async (name) => {
      const { fileAccess } = await analyzePythonNotebookSource(
        'import numpy as np\npath = "inputs/global.csv"\n' +
          `def read_values():\n    ${name}: object\n    values = np.loadtxt(path)\n    return values\n` +
          'result = read_values()'
      )
      expect(fileAccess?.reads ?? []).not.toContain('inputs/global.csv')
      expect(fileAccess?.unresolvedReads).toBe(true)
    }
  )

  it('retains an assigned function-local path beside its annotation-only declaration', async () => {
    const { fileAccess } = await analyzePythonNotebookSource(
      'import numpy as np\npath = "inputs/global.csv"\n' +
        'def read_values():\n    path = "inputs/local.csv"\n    path: str\n' +
        '    values = np.loadtxt(path)\n    return values\nresult = read_values()'
    )
    expect(fileAccess?.reads).toEqual(['inputs/local.csv'])
  })

  it('keeps partial callback I/O after recovering an annotation-only reader identity', async () => {
    const { facts, fileAccess } = await analyzePythonNotebookSource(
      'import numpy as np\nOFFSET = 2.\ndef convert(value): return float(value) + OFFSET\n' +
        'np: object\narray = np.genfromtxt("inputs/observations.csv", converters={0: convert})\n' +
        'np.savetxt("outputs/observations.csv", array)'
    )
    expect(fileAccess?.reads).toEqual(['inputs/observations.csv'])
    expect(fileAccess?.writes).toEqual(['outputs/observations.csv'])
    expect(facts.state).toBe('unknown')
    expect(normalizeNotebookSourceFileAccess('python', facts, fileAccess)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
  })
})

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

describe('SciPy named constraint record captures', () => {
  const setup = 'from scipy.optimize import minimize\nBOUND_PATH="bound.txt"\nSCALE=1.'
  const helpers =
    'def constraint(beta):\n    return beta[1]-float(open(BOUND_PATH).read())\ndef jacobian(beta):\n    return [0.,SCALE]'
  const call =
    'result=minimize(lambda beta:beta[0]**2+beta[1]**2,[1.,2.],method="SLSQP",constraints=records)'
  it.each([
    '{"type":"ineq","fun":constraint,"jac":jacobian}',
    '[{"type":"ineq","fun":constraint,"jac":jacobian}]',
    '({"type":"ineq","fun":constraint,"jac":jacobian},)'
  ])('retains captures through a fresh named record: %s', async (value) => {
    const projection = await projectScripts(
      'python',
      [setup, helpers, `records=${value}\n${call}`, 'BOUND_PATH="next.txt"\nSCALE=2.'],
      'notebook-named-constraint-'
    )
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-3',
          state: 'unknown',
          names: expect.arrayContaining(['BOUND_PATH', 'SCALE'])
        })
      ])
    )
  })
  it('retains an unused record across cells', async () => {
    const projection = await projectScripts(
      'python',
      [
        setup,
        helpers,
        'records=[{"type":"ineq","fun":constraint,"jac":jacobian}]',
        call,
        'BOUND_PATH="next.txt"\nSCALE=2.'
      ],
      'notebook-named-constraint-prior-'
    )
    expect(projection.invalidatedByRunId['run-5']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-4',
          state: 'unknown',
          names: expect.arrayContaining(['BOUND_PATH', 'SCALE'])
        })
      ])
    )
  })
  it('resolves prior-cell imports when projecting independently parsed cells', async () => {
    const scripts = [
      setup,
      helpers,
      'records=[{"type":"ineq","fun":constraint,"jac":jacobian}]\n' + call,
      'BOUND_PATH="next.txt"\nSCALE=2.'
    ]
    const analyzed = await Promise.all(
      scripts.map(async (script, i) => ({
        run: {
          ...completedRun(`run-${i + 1}`, `cell-${i + 1}`, 'python', script),
          startedAt: i + 1,
          endedAt: i + 1,
          executionCount: i + 1
        },
        facts: (await analyzePythonNotebookSource(script)).facts
      }))
    )
    const projection = projectNotebookDependencies(analyzed)
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-3',
          names: expect.arrayContaining(['BOUND_PATH', 'SCALE'])
        })
      ])
    )
  })
})

describe('SciPy named constraint identity boundaries', () => {
  const setup = 'from scipy.optimize import minimize\nBOUND_PATH="bound.txt"\nSCALE=1.\nDECOY=9.'
  const helpers =
    'def constraint(beta):\n    return beta[1]-float(open(BOUND_PATH).read())\ndef jacobian(beta):\n    return [0.,SCALE]\ndef decoy(beta):\n    return DECOY'
  const record = 'records=[{"type":"ineq","fun":constraint,"jac":jacobian}]'
  const call =
    'result=minimize(lambda beta:beta[0]**2+beta[1]**2,[1.,2.],method="SLSQP",constraints=records)'
  it.each([
    'records[0]["fun"]=decoy',
    'records.append({"type":"ineq","fun":decoy})',
    'alias=records',
    'inspect_unknown(records)',
    'def constraint(beta):\n    return DECOY',
    'constraint.__code__=decoy.__code__',
    'minimize=replacement',
    'records=unknown_records'
  ])('does not infer stored callback identity after %s', async (barrier) => {
    const projection = await projectScripts(
      'python',
      [
        setup,
        helpers,
        record + '\n' + barrier + '\n' + call,
        'BOUND_PATH="next.txt"\nSCALE=2.\nDECOY=10.'
      ],
      'notebook-named-constraint-barrier-'
    )
    const names =
      projection.invalidatedByRunId['run-4']?.find((item) => item.runId === 'run-3')?.names ?? []
    expect(names).not.toContain('BOUND_PATH')
    expect(names).not.toContain('SCALE')
    expect(names).not.toContain('DECOY')
  })
  it.each([
    '[{"type":"ineq","fun":constraint,"jac":jacobian,**options}]',
    '[{"type":"ineq","fun":constraint,key:jacobian}]',
    '[{"type":"ineq","fun":constraint,"jac":jacobian},unknown_record]'
  ])('keeps unclosed stored records opaque: %s', async (value) => {
    const projection = await projectScripts(
      'python',
      [setup, helpers, `records=${value}\n${call}`, 'BOUND_PATH="next.txt"\nSCALE=2.'],
      'notebook-named-constraint-unclosed-'
    )
    const names =
      projection.invalidatedByRunId['run-4']?.find((item) => item.runId === 'run-3')?.names ?? []
    expect(names).not.toContain('BOUND_PATH')
    expect(names).not.toContain('SCALE')
  })
  it('does not reinterpret constraint records as NumPy converters', async () => {
    const projection = await projectScripts(
      'python',
      [
        setup + '\nimport numpy as np',
        helpers,
        record + '\nresult=np.loadtxt("data.txt",converters=records)',
        'BOUND_PATH="next.txt"\nSCALE=2.'
      ],
      'notebook-named-constraint-contract-'
    )
    const names =
      projection.invalidatedByRunId['run-4']?.find((item) => item.runId === 'run-3')?.names ?? []
    expect(names).not.toContain('BOUND_PATH')
    expect(names).not.toContain('SCALE')
  })
  it('does not attach replacement callback captures after an earlier solver use', async () => {
    const projection = await projectScripts(
      'python',
      [
        setup,
        helpers,
        record,
        call,
        'def constraint(beta):\n    return DECOY\n' + call,
        'DECOY=10.'
      ],
      'notebook-named-constraint-reuse-'
    )
    const names =
      projection.invalidatedByRunId['run-6']?.find((item) => item.runId === 'run-5')?.names ?? []
    expect(names).not.toContain('DECOY')
  })
  it('restores tagged record candidates from cache without reparsing', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-named-constraint-cache-'))
    temporaryRoots.push(storageRoot)
    const scripts = [setup, helpers, record, call, 'BOUND_PATH="next.txt"\nSCALE=2.']
    const runs = scripts.map((script, i) => ({
      ...completedRun(`run-${i + 1}`, `cell-${i + 1}`, 'python', script),
      startedAt: i + 1,
      endedAt: i + 1,
      executionCount: i + 1
    }))
    const repository = { readSessionRuns: async () => runs }
    const request = {
      projectId: 'project',
      sessionId: 'session',
      interpreter: unusedInterpreter('python')
    }
    const initial = await new NotebookDependencyAnalyzer({ storageRoot, repository }).project(
      request
    )
    expect(initial.invalidatedByRunId['run-5']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-4',
          names: expect.arrayContaining(['BOUND_PATH', 'SCALE'])
        })
      ])
    )
    const cache = join(storageRoot, 'notebooks/project/session/cache/dependency-analysis.json')
    const sidecar = JSON.parse(await readFile(cache, 'utf8'))
    delete sidecar.projectionSnapshots
    await writeFile(cache, JSON.stringify(sidecar))
    const analyze = vi.fn(async () => {
      throw new Error('cached facts must be reusable')
    })
    expect(
      await new NotebookDependencyAnalyzer({ storageRoot, repository, analyze }).project(request)
    ).toEqual(initial)
    expect(analyze).not.toHaveBeenCalled()
  })
})

describe('SciPy literal constraint callback captures', () => {
  const setup = 'from scipy.optimize import minimize\nLIMIT=1.\nSCALE=1.\nDECOY=7.'
  const helpers =
    'def constraint(x):\n    return x[0]-LIMIT\ndef jacobian(x):\n    return [SCALE]\ndef decoy(x):\n    return DECOY'
  it.each([
    'minimize(lambda x:x[0]**2,[2.],method="SLSQP",constraints={"type":"ineq","fun":constraint,"jac":jacobian})',
    'minimize(lambda x:x[0]**2,[2.],method="SLSQP",constraints=[{"type":"ineq","fun":constraint,"jac":jacobian}])',
    'minimize(lambda x:x[0]**2,[2.],method="SLSQP",constraints=({"type":"ineq","fun":constraint,"jac":jacobian},))',
    'minimize(lambda x:x[0]**2,[2.],(),"SLSQP",None,None,None,None,{"type":"ineq","fun":constraint,"jac":jacobian})'
  ])('retains constraint function and Jacobian captures: %s', async (call) => {
    const projection = await projectScripts(
      'python',
      [setup, helpers, `result=${call}`, 'LIMIT=2.\nSCALE=2.\nDECOY=8.'],
      'notebook-literal-constraint-'
    )
    const names =
      projection.invalidatedByRunId['run-4']?.find((item) => item.runId === 'run-3')?.names ?? []
    expect(names).toEqual(expect.arrayContaining(['LIMIT', 'SCALE']))
    expect(names).not.toContain('DECOY')
    expect(projection.stalenessByRunId['run-3'].state).toBe('unknown')
  })
})

describe('SciPy constraint record boundaries', () => {
  const setup = 'from scipy.optimize import minimize\nLIMIT=1.\nSCALE=1.\nDECOY=7.'
  const helpers =
    'def constraint(x,*args):\n    return x[0]-LIMIT\ndef jacobian(x,*args):\n    return [SCALE]\ndef decoy(x):\n    return DECOY'
  const record = '{"type":"ineq","fun":constraint,"jac":jacobian}'
  const captured = async (call: string): Promise<string[]> => {
    const projection = await projectScripts(
      'python',
      [setup, helpers, call, 'LIMIT=2.\nSCALE=2.\nDECOY=8.'],
      'notebook-constraint-record-'
    )
    expect(['unknown', 'stale']).toContain(projection.stalenessByRunId['run-3'].state)
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
    return (
      projection.invalidatedByRunId['run-4']?.find((item) => item.runId === 'run-3')?.names ?? []
    )
  }
  it.each([
    '{"type":"ineq","fun":constraint,"jac":jacobian,"args":(decoy,)}',
    '{"type":"ineq","fun":constraint,"jac":jacobian,"unused":decoy}',
    '{"type":"ineq","fun":decoy,"fun":constraint,"jac":jacobian}',
    '{"type":"ineq","fun":constraint,"jac":decoy,"jac":jacobian}',
    '[{"type":"ineq","fun":constraint},{"type":"ineq","fun":lambda x:3-x[0],"jac":jacobian}]',
    '{"type":"ineq","fun":lambda x:x[0]-LIMIT,"jac":lambda x:[SCALE]}'
  ])('selects only effective fun and jac fields: %s', async (value) => {
    const names = await captured(
      `result=minimize(lambda x:x[0]**2,[2.],method="SLSQP",constraints=${value})`
    )
    expect(names).toEqual(expect.arrayContaining(['LIMIT', 'SCALE']))
    expect(names).not.toContain('DECOY')
  })
  it('uses last-key-wins for an overwritten constraint callback', async () => {
    const names = await captured(
      'result=minimize(lambda x:x[0]**2,[2.],method="SLSQP",constraints={"type":"ineq","fun":constraint,"fun":lambda x:x[0]-1.,"jac":jacobian})'
    )
    expect(names).toContain('SCALE')
    expect(names).not.toContain('LIMIT')
  })
  it.each([
    'constraints={"type":"ineq","fun":constraint,"jac":jacobian,**options}',
    'constraints={**options,"type":"ineq","fun":constraint,"jac":jacobian}',
    'constraints={key:decoy,"type":"ineq","fun":constraint,"jac":jacobian}',
    'constraints=records',
    'constraints=[]',
    'constraints=()',
    'constraints={"type":"ineq","fun":lambda x:x[0]-1.,"args":(constraint,jacobian,decoy)}'
  ])('keeps unclosed or data-only records conservative: %s', async (options) => {
    const names = await captured(`result=minimize(lambda x:x[0]**2,[2.],method="SLSQP",${options})`)
    expect(names).not.toEqual(expect.arrayContaining(['LIMIT']))
    expect(names).not.toContain('SCALE')
    expect(names).not.toContain('DECOY')
  })
  it('retains a closed stored record with its identity proof', async () => {
    const names = await captured(
      `records=${record}\nresult=minimize(lambda x:x[0]**2,[2.],method="SLSQP",constraints=records)`
    )
    expect(names).toEqual(expect.arrayContaining(['LIMIT', 'SCALE']))
  })
  it('does not interpret a record in the bounds slot as constraints', async () => {
    const names = await captured(
      `result=minimize(lambda x:x[0]**2,[2.],(),"SLSQP",None,None,None,${record})`
    )
    expect(names).not.toContain('LIMIT')
    expect(names).not.toContain('SCALE')
  })
  it('does not guess a positional record slot after argument expansion', async () => {
    const names = await captured(
      `result=minimize(lambda x:x[0]**2,*params,None,None,None,None,None,None,${record})`
    )
    expect(names).not.toContain('LIMIT')
    expect(names).not.toContain('SCALE')
  })
  it.each([
    `from scipy.optimize import minimize as solve\nresult=solve(lambda x:x[0]**2,[2.],constraints=${record})`,
    `import scipy.optimize as opt\nresult=opt.minimize(lambda x:x[0]**2,[2.],constraints=[${record}])`
  ])('retains record callbacks through canonical aliases: %s', async (call) => {
    expect(await captured(call)).toEqual(expect.arrayContaining(['LIMIT', 'SCALE']))
  })
  it.each([
    `minimize=lambda *args,**kwargs:None\nresult=minimize(lambda x:x[0]**2,[2.],constraints=${record})`,
    `import scipy.optimize as opt\nopt.minimize=replacement\nresult=opt.minimize(lambda x:x[0]**2,[2.],constraints=${record})`
  ])('does not reuse a replaced solver contract: %s', async (call) => {
    const names = await captured(call)
    expect(names).not.toContain('LIMIT')
    expect(names).not.toContain('SCALE')
  })
  it('uses a replaced constraint callback summary', async () => {
    const names = await captured(
      `def constraint(x):\n    return x[0]-DECOY\nresult=minimize(lambda x:x[0]**2,[2.],constraints=${record})`
    )
    expect(names).toEqual(expect.arrayContaining(['DECOY', 'SCALE']))
    expect(names).not.toContain('LIMIT')
  })
  it('restores transitive file-path captures from cache without reparsing', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-constraint-record-cache-'))
    temporaryRoots.push(storageRoot)
    const scripts = [
      'from scipy.optimize import minimize\nINPUT_PATH="limit.txt"\nOUTPUT_PATH="trace.txt"',
      'def read_limit():\n    return float(open(INPUT_PATH).read())\ndef constraint(x):\n    with open(OUTPUT_PATH,"a") as f:\n        f.write(str(x))\n    return x[0]-read_limit()',
      'result=minimize(lambda x:x[0]**2,[2.],method="SLSQP",constraints=[{"type":"ineq","fun":constraint}])',
      'INPUT_PATH="new-limit.txt"\nOUTPUT_PATH="new-trace.txt"'
    ]
    const runs = scripts.map((script, i) => ({
      ...completedRun(`run-${i + 1}`, `cell-${i + 1}`, 'python', script),
      startedAt: i + 1,
      endedAt: i + 1,
      executionCount: i + 1
    }))
    const repository = { readSessionRuns: async () => runs }
    const request = {
      projectId: 'project',
      sessionId: 'session',
      interpreter: unusedInterpreter('python')
    }
    const initial = await new NotebookDependencyAnalyzer({ storageRoot, repository }).project(
      request
    )
    expect(initial.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-3',
          state: 'unknown',
          names: expect.arrayContaining(['INPUT_PATH', 'OUTPUT_PATH'])
        })
      ])
    )
    const cache = join(storageRoot, 'notebooks/project/session/cache/dependency-analysis.json')
    const sidecar = JSON.parse(await readFile(cache, 'utf8'))
    delete sidecar.projectionSnapshots
    await writeFile(cache, JSON.stringify(sidecar))
    const analyze = vi.fn(async () => {
      throw new Error('cached facts must remain reusable')
    })
    expect(
      await new NotebookDependencyAnalyzer({ storageRoot, repository, analyze }).project(request)
    ).toEqual(initial)
    expect(analyze).not.toHaveBeenCalled()
    expect(
      await analyzeNotebookSourceFileAccess('python', scripts.slice(0, 3).join('\n'))
    ).toMatchObject({ readState: 'partial', writeState: 'partial', externalState: 'partial' })
  })
})

describe('SciPy auxiliary optimizer callback captures', () => {
  const callbacks =
    'def hessian(x):\n    return [[hessian_scale]]\ndef product(x,p):\n    return [product_scale*p[0]]\ndef progress(x):\n    open(TRACE_PATH,"w").write(str(x))\ndef method(fun,x0,**kwargs):\n    return method_scale\ndef derivative(x):\n    return derivative_scale*x\ndef second(x):\n    return second_scale'
  it.each([
    [
      'minimize(lambda x:x[0]**2,[1.],method="Newton-CG",jac=lambda x:2*x,hess=hessian)',
      'hessian_scale'
    ],
    ['minimize(lambda x:x[0]**2,[1.],(),"Newton-CG",lambda x:2*x,hessian)', 'hessian_scale'],
    [
      'minimize(lambda x:x[0]**2,[1.],method="Newton-CG",jac=lambda x:2*x,hessp=product)',
      'product_scale'
    ],
    ['minimize(lambda x:x[0]**2,[1.],(),"Newton-CG",lambda x:2*x,None,product)', 'product_scale'],
    ['minimize(lambda x:x[0]**2,[1.],callback=progress)', 'TRACE_PATH'],
    [
      'minimize(lambda x:x[0]**2,[1.],(),"BFGS",None,None,None,None,(),None,progress)',
      'TRACE_PATH'
    ],
    ['minimize(lambda x:x[0]**2,[1.],method=method)', 'method_scale'],
    ['minimize(lambda x:x[0]**2,[1.],(),method)', 'method_scale'],
    ['root_scalar(lambda x:x*x-2,x0=1.,method="newton",fprime=derivative)', 'derivative_scale'],
    ['root_scalar(lambda x:x*x-2,(),"newton",None,derivative,None,1.)', 'derivative_scale'],
    [
      'root_scalar(lambda x:x*x-2,x0=1.,method="halley",fprime=lambda x:2*x,fprime2=second)',
      'second_scale'
    ],
    ['root_scalar(lambda x:x*x-2,(),"halley",None,lambda x:2*x,second,1.)', 'second_scale']
  ])('invalidates earlier calls when an auxiliary capture changes: %s', async (call, capture) => {
    const projection = await projectScripts(
      'python',
      [
        'from scipy.optimize import minimize,root_scalar\nhessian_scale=2.\nproduct_scale=2.\nTRACE_PATH="trace.txt"\nmethod_scale=2.\nderivative_scale=2.\nsecond_scale=2.',
        callbacks,
        `result=${call}`,
        `${capture}=3.`
      ],
      'notebook-auxiliary-optimizer-captures-'
    )
    expect(projection.invalidatedByRunId['run-4'] ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-3', state: 'unknown', names: [capture] })
      ])
    )
    expect(projection.stalenessByRunId['run-3'].state).toBe('unknown')
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
  })
  it.each([
    'minimize(lambda x:x[0]**2,[1.],args=progress)',
    'minimize(lambda x:x[0]**2,[1.],bounds=progress)',
    'minimize(lambda x:x[0]**2,[1.],(),"BFGS",None,None,None,progress)',
    'root_scalar(lambda x:x*x-2,args=progress,x0=1.)',
    'root_scalar(lambda x:x*x-2,progress,"secant",None,None,None,1.,2.)',
    'root_scalar(lambda x:x*x-2,x0=1.,callback=progress)',
    'minimize(lambda x:x[0]**2,[1.],method="BFGS")',
    'root_scalar(lambda x:(x*x-2,2*x,2.),x0=1.,fprime=True,fprime2=True)'
  ])('does not treat data slots or closed options as callback invocations: %s', async (call) => {
    const projection = await projectScripts(
      'python',
      [
        'from scipy.optimize import minimize,root_scalar\nTRACE_PATH="before.txt"',
        callbacks,
        `result=${call}`,
        'TRACE_PATH="after.txt"'
      ],
      'notebook-auxiliary-optimizer-controls-'
    )
    const invalidation = projection.invalidatedByRunId['run-4']?.find(
      (item) => item.runId === 'run-3'
    )
    expect(invalidation?.names ?? []).not.toContain('TRACE_PATH')
  })
  it.each([
    'from scipy.optimize import minimize as solve\nresult=solve(lambda x:x[0]**2,[1.],callback=progress)',
    'import scipy.optimize as opt\nresult=opt.minimize(lambda x:x[0]**2,[1.],callback=progress)',
    'from scipy.optimize import root_scalar as solve\nresult=solve(lambda x:x*x-2,x0=1.,fprime=progress)'
  ])('retains callback file-path captures through canonical aliases: %s', async (call) => {
    const projection = await projectScripts(
      'python',
      ['TRACE_PATH="before.txt"', callbacks, call, 'TRACE_PATH="after.txt"'],
      'notebook-auxiliary-optimizer-aliases-'
    )
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-3', names: ['TRACE_PATH'], state: 'unknown' })
      ])
    )
  })
  it('uses the current callback summary after replacement', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from scipy.optimize import minimize\nTRACE_PATH="old.txt"\nNEW_PATH="new.txt"',
        callbacks,
        'def progress(x):\n    open(NEW_PATH,"w").write(str(x))',
        'result=minimize(lambda x:x[0]**2,[1.],callback=progress)',
        'TRACE_PATH="old2.txt"',
        'NEW_PATH="new2.txt"'
      ],
      'notebook-auxiliary-optimizer-replacement-'
    )
    expect(
      projection.invalidatedByRunId['run-5']?.find((item) => item.runId === 'run-4')?.names ?? []
    ).not.toContain('TRACE_PATH')
    expect(projection.invalidatedByRunId['run-6']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-4', names: ['NEW_PATH'], state: 'unknown' })
      ])
    )
  })
  it.each([
    'minimize=lambda *args,**kwargs:None\nresult=minimize(lambda x:x[0]**2,[1.],callback=progress)',
    'import scipy.optimize as opt\nopt.minimize=replacement\nresult=opt.minimize(lambda x:x[0]**2,[1.],callback=progress)'
  ])('does not reuse callback contracts after solver replacement: %s', async (call) => {
    const projection = await projectScripts(
      'python',
      [
        'from scipy.optimize import minimize\nTRACE_PATH="before.txt"',
        callbacks,
        call,
        'TRACE_PATH="after.txt"'
      ],
      'notebook-auxiliary-optimizer-shadow-'
    )
    expect(
      projection.invalidatedByRunId['run-4']?.find((item) => item.runId === 'run-3')?.names ?? []
    ).not.toContain('TRACE_PATH')
  })
  it('rebuilds transitive input/output captures from cached facts without reparsing', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-auxiliary-optimizer-cache-'))
    temporaryRoots.push(storageRoot)
    const scripts = [
      'from scipy.optimize import minimize\nINPUT_PATH="input.txt"\nOUTPUT_PATH="trace.txt"',
      'def read_scale():\n    return float(open(INPUT_PATH).read())\ndef progress(x):\n    with open(OUTPUT_PATH,"a") as f:\n        f.write(str(read_scale()))',
      'result=minimize(lambda x:x[0]**2,[1.],callback=progress)',
      'INPUT_PATH="next.txt"\nOUTPUT_PATH="next-trace.txt"'
    ]
    const runs = scripts.map((script, i) => ({
      ...completedRun(`run-${i + 1}`, `cell-${i + 1}`, 'python', script),
      startedAt: i + 1,
      endedAt: i + 1,
      executionCount: i + 1
    }))
    const repository = { readSessionRuns: async () => runs }
    const request = {
      projectId: 'project',
      sessionId: 'session',
      interpreter: unusedInterpreter('python')
    }
    const initial = await new NotebookDependencyAnalyzer({ storageRoot, repository }).project(
      request
    )
    expect(initial.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-3',
          state: 'unknown',
          names: expect.arrayContaining(['INPUT_PATH', 'OUTPUT_PATH'])
        })
      ])
    )
    const cache = join(storageRoot, 'notebooks/project/session/cache/dependency-analysis.json')
    const sidecar = JSON.parse(await readFile(cache, 'utf8'))
    delete sidecar.projectionSnapshots
    await writeFile(cache, JSON.stringify(sidecar))
    const analyze = vi.fn(async () => {
      throw new Error('cached facts must be reusable')
    })
    const reloaded = await new NotebookDependencyAnalyzer({
      storageRoot,
      repository,
      analyze
    }).project(request)
    expect(reloaded).toEqual(initial)
    expect(analyze).not.toHaveBeenCalled()
    const io = await analyzeNotebookSourceFileAccess('python', scripts.slice(0, 3).join('\n'))
    expect(io).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
})

describe('conservative minimize objective and gradient captures', () => {
  // Isolate the two-callback solver pattern observed in a real multi-cell fit.
  // These analysis-only controls do not claim scientific execution or complete lineage.
  const callbacks =
    'def objective(beta):\n    return (beta[0] - objective_gain)**2\ndef gradient(beta):\n    return [2 * (beta[0] - gradient_gain)]'

  it.each([
    ['from scipy.optimize import minimize', 'minimize(fun=objective, x0=p0, jac=gradient)'],
    ['from scipy.optimize import minimize as solve', 'solve(objective, p0, jac=gradient)'],
    ['import scipy.optimize as opt', 'opt.minimize(objective, p0, (), "BFGS", gradient)']
  ])('retains separate callback captures through %s', async (imports, call) => {
    const projection = await projectScripts(
      'python',
      [
        `${imports}\np0 = [0.]\nobjective_gain = 0.2\ngradient_gain = 0.4`,
        callbacks,
        `fit = ${call}`,
        'gradient_gain = 0.7',
        'objective_gain = 0.9'
      ],
      'notebook-minimize-captures-'
    )
    for (const [runId, name] of [
      ['run-4', 'gradient_gain'],
      ['run-5', 'objective_gain']
    ]) {
      expect(projection.invalidatedByRunId[runId]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runId: 'run-3', state: 'unknown', names: [name] })
        ])
      )
    }
    expect(projection.stalenessByRunId['run-3']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['scoped-opaque-call', 'external-state'])
    })
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
  })

  it('uses the current gradient summary after callback replacement', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from scipy.optimize import minimize\np0 = [0.]\nobjective_gain = 0.2\ngradient_gain = 0.4\nreplacement_gain = 0.6',
        callbacks,
        'def gradient(beta):\n    return [2 * (beta[0] - replacement_gain)]',
        'fit = minimize(objective, p0, jac=gradient)',
        'gradient_gain = 0.7',
        'replacement_gain = 0.9'
      ],
      'notebook-minimize-replaced-gradient-'
    )
    expect(projection.invalidatedByRunId['run-5'] ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-4', names: ['gradient_gain'] })
      ])
    )
    expect(projection.invalidatedByRunId['run-6']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-4', state: 'unknown', names: ['replacement_gain'] })
      ])
    )
  })

  it.each([
    'minimize = replacement\nfit = minimize(objective, p0, jac=gradient)',
    'import scipy.optimize as opt\nopt.minimize = replacement\nfit = opt.minimize(objective, p0, jac=gradient)'
  ])('does not reuse a replaced minimize contract: %s', async (call) => {
    const projection = await projectScripts(
      'python',
      [
        'from scipy.optimize import minimize\np0 = [0.]\nobjective_gain = 0.2\ngradient_gain = 0.4',
        callbacks,
        call,
        'gradient_gain = 0.7'
      ],
      'notebook-minimize-shadowed-solver-'
    )
    const invalidation = projection.invalidatedByRunId['run-4']?.find(
      (item) => item.runId === 'run-3'
    )
    expect(invalidation?.names ?? []).not.toContain('gradient_gain')
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
  })

  it.each(['gradient', 'True', 'None', '"2-point"'])(
    'keeps minimize opaque without certifying a return for jac=%s',
    async (jac) => {
      const [facts] = await analyzePythonSources([
        `from scipy.optimize import minimize\n${callbacks}\nfit = minimize(objective, p0, jac=${jac}, args=extra, bounds=limits)\nparameters = fit.x`
      ])
      expect(facts.state).toBe('unknown')
      if (facts.state !== 'unknown') throw new Error('minimize must remain conservative')
      expect(facts.reasons).toEqual(
        expect.arrayContaining(['scoped-opaque-call', 'external-state'])
      )
      for (const binding of [
        { target: 'fit', typeName: 'scipy.optimize.OptimizeResult' },
        { target: 'parameters', typeName: 'numpy.ndarray' }
      ])
        expect(facts.typeBindings ?? []).not.toContainEqual(expect.objectContaining(binding))
    }
  )

  it('preserves possible mutation of every minimize argument without a definite result alias', async () => {
    const setup =
      'from scipy.optimize import minimize\np0 = [0.]\nextra = ([1.],)\nlimits = [(0., 1.)]\nobjective_gain = 0.2\ngradient_gain = 0.4'
    const call = 'fit = minimize(objective, p0, jac=gradient, args=extra, bounds=limits)'
    const projection = await projectScripts(
      'python',
      [`${setup}\n${callbacks}`, 'print(p0, extra, limits)', call],
      'notebook-minimize-argument-mutation-'
    )
    expect(projection.invalidatedByRunId['run-3']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-2',
          state: 'unknown',
          names: expect.arrayContaining(['p0', 'extra', 'limits'])
        })
      ])
    )
    const [facts] = await analyzePythonSources([[setup, callbacks, call].join('\n')])
    expect(facts.aliases ?? []).not.toContainEqual(
      expect.objectContaining({ target: 'fit', kind: 'reference' })
    )
  })

  it('does not treat an x0 callable value as the minimize gradient callback', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from scipy.optimize import minimize\nobjective_gain = 0.2\ngradient_gain = 0.4',
        callbacks,
        'fit = minimize(objective, gradient, method="BFGS")',
        'gradient_gain = 0.7'
      ],
      'notebook-minimize-data-argument-'
    )
    const invalidation = projection.invalidatedByRunId['run-4']?.find(
      (item) => item.runId === 'run-3'
    )
    expect(invalidation?.names ?? []).not.toContain('gradient_gain')
    expect(projection.stalenessByRunId['run-3'].state).toBe('unknown')
  })
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

  it('keeps a read-clean-aggregate mean workflow uncertain without column proof', async () => {
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

    expect(projection.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
    expect(await analyzeNotebookSourceFileAccess('r', run.script)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      writes: ['summary.csv']
    })
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

  it('retains unproven cumulative column dispatch in a ggplot2 pie-chart workflow', async () => {
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

    // A frame's ordinary ownership does not prove that df$frac is class-free.
    expect(projection?.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
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

// https://stat.ethz.ch/R-manual/R-patched/library/stats/html/optimize.html
describe('R optimize opaque lexical captures', () => {
  const captures = ['OFFSET_PATH', 'time_values', 'demand_values', 'read_offset']
  const producer = [
    'read_offset <- function(path) as.numeric(readLines(path, warn=FALSE)[1])',
    'objective <- function(rate) {',
    '  path <- OFFSET_PATH',
    '  offset <- read_offset(path)',
    '  basis <- 1 - exp(-rate * time_values)',
    '  response <- demand_values + offset',
    '  amplitude <- sum(response * basis) / sum(basis * basis)',
    '  sum((response - amplitude * basis)^2)',
    '}'
  ].join('\n')

  it.each([
    ['slot zero', '', 'stats::optimize(objective, interval=c(0.1, 1))'],
    ['exact f', '', 'stats::optimize(interval=c(0.1, 1), f=objective)'],
    ['unshadowed bare solver', '', 'optimize(f=objective, interval=c(0.1, 1))'],
    [
      'qualified solver after a bare-name shadow',
      'optimize <- function(...) 0',
      'stats::optimize(objective, interval=c(0.1, 1))'
    ]
  ])('retains captures for %s without completing callback effects', async (_, prelude, call) => {
    const { facts, fileAccess } = await analyzeRNotebookSource(
      `${producer}\n${prelude}\nfit <- ${call}`
    )
    expect(facts.usedNames).toEqual(expect.arrayContaining(captures))
    expect(facts.priorUsedNames).toEqual(
      expect.arrayContaining(['OFFSET_PATH', 'time_values', 'demand_values'])
    )
    expect(facts.state).toBe('unknown')
    if (facts.state === 'unknown') {
      expect(facts.reasons).toEqual(expect.arrayContaining(['opaque-call', 'dynamic-namespace']))
    }
    expect(facts.safeCallNames ?? []).not.toContain('stats::optimize')
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.typeBindings ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'fit' })])
    )
    expect(facts.aliases ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'fit', kind: 'reference' })])
    )
    expect(normalizeNotebookSourceFileAccess('r', facts, fileAccess)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    ['missing f', 'stats::optimize(interval=c(0.1, 1))'],
    ['wrong slot', 'stats::optimize(interval=c(0.1, 1), objective)'],
    ['duplicate f', 'stats::optimize(f=objective, f=objective, interval=c(0.1, 1))'],
    ['wrong namespace', 'other::optimize(objective, interval=c(0.1, 1))'],
    ['private namespace', 'stats:::optimize(objective, interval=c(0.1, 1))'],
    ['unregistered spelling', 'stats::optimise(objective, interval=c(0.1, 1))'],
    ['solver alias', 'solver <- stats::optimize\nsolver(objective, interval=c(0.1, 1))'],
    [
      'shadowed bare solver',
      'optimize <- function(...) 0\noptimize(objective, interval=c(0.1, 1))'
    ],
    [
      'shadowed namespace operator',
      '`::` <- function(...) 0\nstats::optimize(objective, interval=c(0.1, 1))'
    ],
    [
      'rebound callback',
      'objective <- function(rate) rate^2\nstats::optimize(objective, interval=c(0.1, 1))'
    ],
    [
      'rebound callback dependency',
      'exp <- function(ignored) 1\nstats::optimize(objective, interval=c(0.1, 1))'
    ]
  ])('does not borrow old captures for %s', async (_, call) => {
    const { facts } = await analyzeRNotebookSource(`${producer}\n${call}`)
    for (const name of captures) expect(facts.usedNames ?? []).not.toContain(name)
    expect(facts.safeCallNames ?? []).not.toContain('stats::optimize')
  })

  it('keeps a nested optimizer callback deferred', async () => {
    const { facts } = await analyzeRNotebookSource(
      'outer <- function() stats::optimize(function(rate) rate + DEFERRED_CAPTURE, interval=c(0.1, 1))'
    )
    expect(facts.usedNames ?? []).not.toContain('DEFERRED_CAPTURE')
    expect(facts.safeCallNames ?? []).not.toContain('stats::optimize')
  })
})

// https://stat.ethz.ch/R-manual/R-patched/library/stats/html/optim.html
describe('R same-cell BFGS callback captures', () => {
  // Reduced from a real multi-cell ridge fit; these are analysis-only controls.
  // No direct callback diagnostic follows the solver and masks its slot selection.
  const callbacks = [
    'objective <- function(beta) {',
    '  objective_count <<- objective_count + 1L',
    '  residual <- response - X %*% beta',
    '  sum(weights * residual^2) + regularization * FN_ONLY * sum(beta^2)',
    '}',
    'gradient <- function(beta) {',
    '  gradient_count <<- gradient_count + 1L',
    '  residual <- response - X %*% beta',
    '  as.numeric(-2 * t(X) %*% (weights * residual) +',
    '    2 * regularization * GR_ONLY * penalty_mask * beta)',
    '}'
  ].join('\n')
  const captures = [
    'response',
    'X',
    'weights',
    'regularization',
    'penalty_mask',
    'FN_ONLY',
    'GR_ONLY'
  ]

  it.each([
    'stats::optim(par=0, fn=objective, gr=gradient, method="BFGS")',
    'stats::optim(gr=gradient, method="BFGS", fn=objective, par=0)',
    'optim(0, objective, gradient, method="BFGS")'
  ])('retains both callback captures without certifying %s', async (call) => {
    const { facts, fileAccess } = await analyzeRNotebookSource(`${callbacks}\nfit <- ${call}`)
    expect(facts.usedNames).toEqual(expect.arrayContaining(captures))
    expect(facts.usedNames).toEqual(expect.arrayContaining(['objective_count', 'gradient_count']))
    expect(facts.state).toBe('unknown')
    expect(facts.safeCallNames ?? []).not.toContain('stats::optim')
    expect(facts.safeCallNames ?? []).not.toContain('t')
    expect(facts.safeCallNames ?? []).not.toContain('%*%')
    expect(facts.copyOnModifyNames ?? []).not.toContain('fit')
    expect(facts.aliases ?? []).not.toContainEqual(
      expect.objectContaining({ target: 'fit', kind: 'reference' })
    )
    expect(facts.typeBindings ?? []).not.toContainEqual(expect.objectContaining({ target: 'fit' }))
    for (const summary of facts.typeSummaries?.filter((item) => item.kind === 'r-function') ?? []) {
      expect(summary.methods[0]?.usedNames ?? []).toEqual([])
      expect(summary.methods[0]?.safeCallNames).toBeUndefined()
      expect(summary.methods[0]?.returnType).toBeUndefined()
    }
    expect(normalizeNotebookSourceFileAccess('r', facts, fileAccess)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('reads the current objective before a solver result replaces its binding', async () => {
    const call = 'stats::optim(0, fn=objective, method="BFGS")'
    const control = await analyzeRNotebookSource(`${callbacks}\nfit <- ${call}`)
    const rebound = await analyzeRNotebookSource(`${callbacks}\nobjective <- ${call}`)
    const objectiveCaptures = ['response', 'X', 'weights', 'regularization', 'FN_ONLY']
    expect(control.facts.usedNames).toEqual(expect.arrayContaining(objectiveCaptures))
    expect(rebound.facts.usedNames).toEqual(expect.arrayContaining(objectiveCaptures))
    expect(rebound.facts.priorUsedNames).toEqual(expect.arrayContaining(objectiveCaptures))
    expect(rebound.facts.state).toBe('unknown')
    expect(rebound.facts.typeBindings ?? []).not.toContainEqual(
      expect.objectContaining({ target: 'objective' })
    )
    expect(normalizeNotebookSourceFileAccess('r', rebound.facts, rebound.fileAccess)).toMatchObject(
      {
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it.each([
    ['objective', 'objective = stats::optim(0, fn=objective, method="BFGS")'],
    ['objective', 'stats::optim(0, fn=objective, method="BFGS") -> objective'],
    ['gradient', 'gradient <- stats::optim(0, fn=objective, gr=gradient, method="BFGS")'],
    ['gradient', 'gradient = stats::optim(gr=gradient, method="BFGS", fn=objective, par=0)'],
    ['gradient', 'stats::optim(0, objective, gradient, method="BFGS") -> gradient']
  ])(
    'consumes %s before rebinding it and never exports its old authority: %s',
    async (name, source) => {
      const { facts } = await analyzeRNotebookSource(`${callbacks}\n${source}\nalias <- ${name}`)
      const expected = name === 'gradient' ? captures : ['response', 'X', 'weights', 'FN_ONLY']
      expect(facts.usedNames).toEqual(expect.arrayContaining(expected))
      expect(facts.priorUsedNames).toEqual(expect.arrayContaining(expected))
      expect(facts.state).toBe('unknown')
      for (const target of [name, 'alias'])
        expect(facts.typeBindings ?? []).not.toContainEqual(expect.objectContaining({ target }))
    }
  )

  it.each([
    ['duplicate callback', '', 'stats::optim(0, fn=objective, fn=objective, method="BFGS")'],
    ['partial callback', '', 'stats::optim(0, f=objective, method="BFGS")'],
    ['expanded arguments', '', 'stats::optim(0, fn=objective, method="BFGS", ...)'],
    ['unsupported method', '', 'stats::optim(0, fn=objective, method="SANN")'],
    ['solver alias', 'solver <- stats::optim', 'solver(0, fn=objective, method="BFGS")'],
    ['shadowed bare solver', 'optim <- function(...) 0', 'optim(0, fn=objective, method="BFGS")'],
    [
      'shadowed namespace operator',
      '`::` <- function(...) 0',
      'stats::optim(0, fn=objective, method="BFGS")'
    ]
  ])('does not defer a callback binding for %s', async (_, prelude, call) => {
    const { facts } = await analyzeRNotebookSource(`${callbacks}\n${prelude}\nobjective <- ${call}`)
    for (const capture of captures) expect(facts.usedNames ?? []).not.toContain(capture)
    expect(facts.state).toBe('unknown')
    expect(facts.typeBindings ?? []).not.toContainEqual(
      expect.objectContaining({ target: 'objective' })
    )
  })

  it('withdraws a mutated callback body without reconstructing the replacement', async () => {
    const { facts, fileAccess } = await analyzeRNotebookSource(
      'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
        'body(objective) <- quote((beta - NEW_ONLY)^2)\n' +
        'fit <- stats::optim(0, fn=objective, method="BFGS")'
    )
    expect(facts.usedNames ?? []).not.toContain('OLD_ONLY')
    expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
    expect(facts.typeBindings ?? []).not.toContainEqual(
      expect.objectContaining({ target: 'objective' })
    )
    expect(facts.state).toBe('unknown')
    if (facts.state === 'unknown') expect(facts.reasons).toContain('dynamic-assignment')
    expect(normalizeNotebookSourceFileAccess('r', facts, fileAccess)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'body(objective) = quote((beta - NEW_ONLY)^2)',
    'quote((beta - NEW_ONLY)^2) -> body(objective)',
    'alias <- objective\nbody(alias) <- quote((beta - NEW_ONLY)^2)\nobjective <- alias',
    'if (flag) body(objective) <- quote((beta - NEW_ONLY)^2)',
    'body(objective)[[2]] <- quote(NEW_ONLY)'
  ])('keeps replacement and alias boundaries conservative: %s', async (replacement) => {
    const { facts } = await analyzeRNotebookSource(
      'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
        `${replacement}\nfit <- stats::optim(0, fn=objective, method="BFGS")`
    )
    expect(facts.usedNames ?? []).not.toContain('OLD_ONLY')
    expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
    expect(facts.state).toBe('unknown')
    for (const target of ['objective', 'alias'])
      expect(facts.typeBindings ?? []).not.toContainEqual(expect.objectContaining({ target }))
  })

  it('reads a replacement RHS before withdrawing the callable authority', async () => {
    const { facts } = await analyzeRNotebookSource(
      'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
        'body(objective) <- {stats::optim(0, fn=objective, method="BFGS"); ' +
        'quote((beta - NEW_ONLY)^2)}'
    )
    expect(facts.usedNames).toContain('OLD_ONLY')
    expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
    expect(facts.typeBindings ?? []).not.toContainEqual(
      expect.objectContaining({ target: 'objective' })
    )
    expect(facts.state).toBe('unknown')
  })

  it('does not borrow or restore callable authority across solver argument replacement', async () => {
    const { facts } = await analyzeRNotebookSource(
      `${callbacks}\nobjective <- stats::optim(` +
        '{body(gradient) <- quote(NULL); 0}, fn=objective, method="BFGS")\nalias <- gradient'
    )
    expect(facts.usedNames ?? []).not.toContain('FN_ONLY')
    expect(facts.usedNames ?? []).not.toContain('GR_ONLY')
    for (const target of ['objective', 'gradient', 'alias'])
      expect(facts.typeBindings ?? []).not.toContainEqual(expect.objectContaining({ target }))
    expect(facts.state).toBe('unknown')
  })

  it.each([
    ['positional replacement', '{body(objective) <- quote((beta - NEW_ONLY)^2); 0}'],
    ['equals replacement', '{body(objective) = quote((beta - NEW_ONLY)^2); 0}'],
    ['rightward replacement', '{quote((beta - NEW_ONLY)^2) -> body(objective); 0}'],
    ['nonlocal rebind', '{objective <<- function(beta) (beta - NEW_ONLY)^2; 0}'],
    ['nonlocal rightward rebind', '{(function(beta) (beta - NEW_ONLY)^2) ->> objective; 0}'],
    ['conditional replacement', '{if (flag) body(objective) <- quote(NEW_ONLY); 0}'],
    ['nested constructor', 'c({body(objective)[[2]] <- quote(NEW_ONLY); 0})'],
    ['computed callee', '({body(objective) <- quote(NEW_ONLY); identity})(0)'],
    ['immediately invoked function', '(function() {body(objective) <<- quote(NEW_ONLY); 0})()'],
    [
      'immediately invoked function default',
      '(function(x={body(objective) <<- quote(NEW_ONLY); 0}) x)()'
    ],
    [
      'immediately invoked returned function',
      '(function() function() {body(objective) <<- quote(NEW_ONLY); 0})()()'
    ],
    [
      'immediately invoked conditional returned function',
      '(function() if (flag) function() {body(objective) <<- quote(NEW_ONLY); 0} else function() 0)()()'
    ],
    [
      'three-level immediately invoked returned function',
      '(function() function() function() {body(objective) <<- quote(NEW_ONLY); 0})()()()'
    ],
    [
      'forced default in an immediately invoked returned function',
      '(function() function(x={body(objective) <<- quote(NEW_ONLY); 0}) x)()()'
    ],
    [
      'immediately invoked returned function default',
      '(function(x=function() {body(objective) <<- quote(NEW_ONLY); 0}) x)()()'
    ],
    [
      'immediate function with a shadowed quote formal',
      '(function(quote=base::identity) quote({body(objective) <<- base::quote(NEW_ONLY); 0}))()'
    ],
    [
      'immediate function with a backtick quote formal',
      '(function(`quote`=base::identity) quote({body(objective) <<- base::quote(NEW_ONLY); 0}))()'
    ],
    [
      'immediate function with a shadowed expression formal',
      '(function(expression=base::identity) expression({body(objective) <<- base::quote(NEW_ONLY); 0}))()'
    ],
    [
      'default referring to a later quote formal',
      '(function(x=quote({body(objective) <<- base::quote(NEW_ONLY); 0}), quote=base::identity) x)()'
    ],
    [
      'immediate returned function inheriting a quote formal',
      '(function(quote=base::identity) function() quote({body(objective) <<- base::quote(NEW_ONLY); 0}))()()'
    ],
    [
      'package quotation with a shadowed namespace operator',
      '(function(`::`=function(...) identity) base::quote({body(objective) <<- quote(NEW_ONLY); 0}))()'
    ],
    [
      'package quotation with a shadowed internal namespace operator',
      '(function(`:::`=function(...) identity) base:::quote({body(objective) <<- quote(NEW_ONLY); 0}))()'
    ]
  ])('does not borrow an obsolete callback for %s in a solver argument', async (_, par) => {
    for (const target of ['fit', 'objective']) {
      const { facts, fileAccess } = await analyzeRNotebookSource(
        'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
          `${target} <- stats::optim(${par}, fn=objective, method="BFGS")`
      )
      expect(facts.usedNames ?? []).not.toContain('OLD_ONLY')
      expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
      expect(facts.state).toBe('unknown')
      if (facts.state === 'unknown') expect(facts.reasons).toContain('function-scope')
      expect(normalizeNotebookSourceFileAccess('r', facts, fileAccess)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  })

  it.each([
    'stats::optim(fn=objective, par={body(objective) <- quote(NEW_ONLY); 0}, method="BFGS")',
    'stats::optim(0, fn=objective, method="BFGS", control={body(objective) <- quote(NEW_ONLY); list()})',
    'stats::optim(0, fn=objective, gr={body(objective) <- base::quote(NEW_ONLY); NULL}, method="BFGS")',
    'stats::optimize(f=objective, interval={body(objective) <- quote(NEW_ONLY); c(0, 1)})',
    'stats::uniroot(f=objective, interval={body(objective) <- quote(NEW_ONLY); c(0, 1)})',
    'stats::integrate(f=objective, lower={body(objective) <- quote(NEW_ONLY); 0}, upper=1)'
  ])('denies obsolete captures across the existing solver slots: %s', async (call) => {
    for (const target of ['fit', 'objective']) {
      const { facts } = await analyzeRNotebookSource(
        `objective <- function(beta) (beta - OLD_ONLY)^2\n${target} <- ${call}`
      )
      expect(facts.usedNames ?? []).not.toContain('OLD_ONLY')
      expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
      expect(facts.state).toBe('unknown')
    }
  })

  it.each([
    '{body(objective) <- quote(NEW_ONLY); 0}',
    '(function() function() {body(objective) <<- quote(NEW_ONLY); 0})()()'
  ])('preserves explicit file evidence around an uncertain solver argument: %s', async (par) => {
    const { facts, fileAccess } = await analyzeRNotebookSource(
      'observations <- utils::read.csv("inputs/observations.csv")\n' +
        'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
        `fit <- stats::optim(${par}, fn=objective, method="BFGS")\n` +
        'utils::write.csv(observations, "outputs/observations.csv", row.names=FALSE)'
    )
    expect(facts.usedNames ?? []).not.toContain('OLD_ONLY')
    expect(fileAccess?.reads).toEqual(['inputs/observations.csv'])
    expect(fileAccess?.writes).toEqual(['outputs/observations.csv'])
    expect(normalizeNotebookSourceFileAccess('r', facts, fileAccess)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
  })

  it.each(['c(0)', 'numeric(1)', 'rep(0, 1)'])(
    'keeps same-name callback captures with ordinary arguments: %s',
    async (par) => {
      const { facts } = await analyzeRNotebookSource(
        `${callbacks}\nobjective <- stats::optim(${par}, fn=objective, gr=gradient, method="BFGS")`
      )
      expect(facts.usedNames).toEqual(expect.arrayContaining(captures))
      expect(facts.state).toBe('unknown')
    }
  )

  it.each([
    'control=list(maxit=10, reltol=1e-8)',
    'unused=quote(body(objective) <- NEW_ONLY)',
    'unused=base::expression(body(objective) <- NEW_ONLY)',
    'unused=function() {body(objective) <- NEW_ONLY}',
    'unused=function() function() {body(objective) <<- quote(NEW_ONLY); 0}',
    'unused=(function() function() {body(objective) <<- quote(NEW_ONLY); 0})()'
  ])('keeps ordinary and deferred argument syntax separate: %s', async (argument) => {
    const { facts } = await analyzeRNotebookSource(
      'objective <- function(beta, unused) (beta - OLD_ONLY)^2\n' +
        `objective <- stats::optim(0, fn=objective, method="BFGS", ${argument})`
    )
    expect(facts.usedNames).toContain('OLD_ONLY')
    expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
    expect(facts.state).toBe('unknown')
  })

  it.each([
    '{(function() function() {body(objective) <<- quote(NEW_ONLY); 0})(); 0}',
    '{(function() function() function() {body(objective) <<- quote(NEW_ONLY); 0})()(); 0}',
    '{(function(x=function() {body(objective) <<- quote(NEW_ONLY); 0}) x)(); 0}',
    '{(function(quote=base::identity) function() quote({body(objective) <<- base::quote(NEW_ONLY); 0}))(); 0}'
  ])('keeps an evaluated factory with an uninvoked leaf deferred: %s', async (par) => {
    for (const target of ['fit', 'objective']) {
      const { facts } = await analyzeRNotebookSource(
        'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
          `${target} <- stats::optim(${par}, fn=objective, method="BFGS")`
      )
      expect(facts.usedNames).toContain('OLD_ONLY')
      expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
      expect(facts.state).toBe('unknown')
    }
  })

  it.each([
    '(function(quote=base::identity) {base::quote(body(objective) <<- NEW_ONLY); 0})()',
    '(function(expression=base::identity) {base::expression(body(objective) <<- NEW_ONLY); 0})()',
    '(function(`::`=function(...) identity) {base:::quote(body(objective) <<- NEW_ONLY); 0})()',
    '(function(`:::`=function(...) identity) {base::quote(body(objective) <<- NEW_ONLY); 0})()',
    '{(function(quote=base::identity) 0)(); quote(body(objective) <- NEW_ONLY); 0}'
  ])('preserves trusted quotation without leaking immediate formal bindings: %s', async (par) => {
    const { facts } = await analyzeRNotebookSource(
      'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
        `fit <- stats::optim(${par}, fn=objective, method="BFGS")`
    )
    expect(facts.usedNames).toContain('OLD_ONLY')
    expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
    expect(facts.state).toBe('unknown')
  })

  it.each([
    [
      'hex quote',
      '(function(`qu\\x6fte`=base::identity) quote({body(objective) <<- base::quote(NEW_ONLY); 0}))()'
    ],
    [
      'octal quote',
      '(function(`quo\\164e`=base::identity) quote({body(objective) <<- base::quote(NEW_ONLY); 0}))()'
    ],
    [
      'later default binding',
      '(function(x=quote({body(objective) <<- base::quote(NEW_ONLY); 0}), `qu\\x6fte`=base::identity) x)()'
    ],
    [
      'inherited returned binding',
      '(function(`qu\\x6fte`=base::identity) function() quote({body(objective) <<- base::quote(NEW_ONLY); 0}))()()'
    ],
    [
      'invoked returned leaf',
      '(function() function(`quo\\164e`=base::identity) quote({body(objective) <<- base::quote(NEW_ONLY); 0}))()()'
    ],
    [
      'invoked default leaf',
      '(function(x=function(`qu\\x6fte`=base::identity) quote({body(objective) <<- base::quote(NEW_ONLY); 0})) x)()()'
    ]
  ])('denies obsolete callback captures for an escaped formal: %s', async (_, par) => {
    for (const target of ['fit', 'objective']) {
      const { facts } = await analyzeRNotebookSource(
        'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
          `${target} <- stats::optim(${par}, fn=objective, method="BFGS")`
      )
      expect(facts.usedNames ?? []).not.toContain('OLD_ONLY')
      expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
      expect(facts.state).toBe('unknown')
      if (facts.state === 'unknown') expect(facts.reasons).toContain('function-scope')
    }
  })

  it.each(['`unused\\x41`', '`unused\\101`'])(
    'keeps an invoked harmless escaped formal conservative: %s',
    async (formal) => {
      const { facts } = await analyzeRNotebookSource(
        'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
          `objective <- stats::optim((function(${formal}=0) 0)(), fn=objective, method="BFGS")`
      )
      expect(facts.usedNames ?? []).not.toContain('OLD_ONLY')
      expect(facts.typeBindings ?? []).not.toContainEqual(
        expect.objectContaining({ target: 'objective' })
      )
      expect(facts.state).toBe('unknown')
    }
  )

  it.each([
    'unused=function(`qu\\x6fte`=base::identity) quote({body(objective) <<- base::quote(NEW_ONLY); 0})',
    'unused=(function() function(`quo\\164e`=base::identity) quote({body(objective) <<- base::quote(NEW_ONLY); 0}))()'
  ])('retains captures beside a deferred escaped formal: %s', async (argument) => {
    const { facts } = await analyzeRNotebookSource(
      'objective <- function(beta, unused) (beta - OLD_ONLY)^2\n' +
        `objective <- stats::optim(0, fn=objective, method="BFGS", ${argument})`
    )
    expect(facts.usedNames).toContain('OLD_ONLY')
    expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
    expect(facts.state).toBe('unknown')
  })

  it('retains captures when an escaped formal returned leaf remains uninvoked', async () => {
    const { facts } = await analyzeRNotebookSource(
      'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
        'fit <- stats::optim({(function() function(`qu\\x6fte`=base::identity) ' +
        'quote({body(objective) <<- base::quote(NEW_ONLY); 0}))(); 0}, ' +
        'fn=objective, method="BFGS")'
    )
    expect(facts.usedNames).toContain('OLD_ONLY')
    expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
    expect(facts.state).toBe('unknown')
  })

  it.each(['`qu\\x6fte`', '`quo\\164e`'])(
    'projects four-cell dependency and explicit file paths for an escaped formal: %s',
    async (formal) => {
      const solverCell =
        'observations <- utils::read.csv("inputs/observations.csv")\n' +
        'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
        `fit <- stats::optim((function(${formal}=base::identity) ` +
        'quote({body(objective) <<- base::quote((beta - NEW_ONLY)^2); 0}))(), ' +
        'fn=objective, method="BFGS")\n' +
        'utils::write.csv(observations, "outputs/observations.csv", row.names=FALSE)'
      const projection = await projectScripts(
        'r',
        ['OLD_ONLY <- 10\nNEW_ONLY <- 3', solverCell, 'estimate <- fit$par', 'OLD_ONLY <- 20'],
        'r-escaped-formal-solver-'
      )
      expect(Object.keys(projection.stalenessByRunId).sort()).toEqual([
        'run-1',
        'run-2',
        'run-3',
        'run-4'
      ])
      expect(
        (projection.invalidatedByRunId['run-4'] ?? []).some(
          (item) => item.runId === 'run-2' && item.names.includes('OLD_ONLY')
        )
      ).toBe(false)
      expect(projection.stalenessByRunId['run-2'].state).toBe('unknown')
      const { facts, fileAccess } = await analyzeRNotebookSource(solverCell)
      expect(facts.usedNames ?? []).not.toContain('OLD_ONLY')
      expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
      expect(fileAccess?.reads).toEqual(['inputs/observations.csv'])
      expect(fileAccess?.writes).toEqual(['outputs/observations.csv'])
      expect(normalizeNotebookSourceFileAccess('r', facts, fileAccess)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect((await analyzeRNotebookSource('estimate <- fit$par')).facts.usedNames).toContain('fit')
    }
  )

  it.each([
    ['stable', 'stats::optim(0, fn=objective, gr=NULL, method="BFGS")', true],
    [
      'local quote formal',
      'stats::optim((function(quote=base::identity) ' +
        'quote({body(objective) <<- base::quote((beta - NEW_ONLY)^2); 0}))(), ' +
        'fn=objective, method="BFGS")',
      false
    ],
    [
      'sibling gradient expression',
      'stats::optim(0, fn=objective, ' +
        'gr={body(objective) <- base::quote((beta - NEW_ONLY)^2); NULL}, method="BFGS")',
      false
    ]
  ])(
    'projects four-cell solver argument authority for %s',
    async (_, call, expectedInvalidation) => {
      const solverCell =
        'observations <- utils::read.csv("inputs/observations.csv")\n' +
        'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
        `fit <- ${call}\n` +
        'utils::write.csv(observations, "outputs/observations.csv", row.names=FALSE)'
      const projection = await projectScripts(
        'r',
        ['OLD_ONLY <- 10\nNEW_ONLY <- 3', solverCell, 'estimate <- fit$par', 'OLD_ONLY <- 20'],
        'r-solver-argument-authority-'
      )
      expect(Object.keys(projection.stalenessByRunId).sort()).toEqual([
        'run-1',
        'run-2',
        'run-3',
        'run-4'
      ])
      const obsoleteInvalidation = (projection.invalidatedByRunId['run-4'] ?? []).some(
        (item) => item.runId === 'run-2' && item.names.includes('OLD_ONLY')
      )
      expect(obsoleteInvalidation).toBe(expectedInvalidation)
      expect(projection.stalenessByRunId['run-2'].state).toBe('unknown')
      const { facts, fileAccess } = await analyzeRNotebookSource(solverCell)
      expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
      expect(fileAccess?.reads).toEqual(['inputs/observations.csv'])
      expect(fileAccess?.writes).toEqual(['outputs/observations.csv'])
      expect(normalizeNotebookSourceFileAccess('r', facts, fileAccess)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const downstream = await analyzeRNotebookSource('estimate <- fit$par')
      expect(downstream.facts.usedNames).toContain('fit')
    }
  )

  it.each([false, true])(
    'projects independent capture invalidation with solver argument replacement=%s',
    async (replace) => {
      const par = replace ? '{body(objective) <- quote((beta - NEW_ONLY)^2); 0}' : '0'
      const projection = await projectScripts(
        'r',
        [
          'OLD_ONLY <- 10\nNEW_ONLY <- 3',
          'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
            `fit <- stats::optim(${par}, fn=objective, method="BFGS")`,
          'estimate <- fit$par',
          'OLD_ONLY <- 20'
        ],
        'r-solver-argument-capture-'
      )
      const oldCapture = (projection.invalidatedByRunId['run-4'] ?? []).some(
        (item) => item.runId === 'run-2' && item.names.includes('OLD_ONLY')
      )
      expect(oldCapture).toBe(!replace)
      expect(projection.stalenessByRunId['run-2'].state).toBe('unknown')
    }
  )

  it('does not invalidate a returned-function solver result for an obsolete capture', async () => {
    const projection = await projectScripts(
      'r',
      [
        'OLD_ONLY <- 10\nNEW_ONLY <- 3',
        'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
          'fit <- stats::optim((function() function() {' +
          'body(objective) <<- quote((beta - NEW_ONLY)^2); 0})()(), ' +
          'fn=objective, method="BFGS")',
        'estimate <- fit$par',
        'OLD_ONLY <- 20'
      ],
      'r-returned-solver-argument-'
    )
    expect(
      (projection.invalidatedByRunId['run-4'] ?? []).some(
        (item) => item.runId === 'run-2' && item.names.includes('OLD_ONLY')
      )
    ).toBe(false)
    expect(projection.stalenessByRunId['run-2'].state).toBe('unknown')
  })

  it('retains builtin shadowing after an unknown replacement', async () => {
    const { facts } = await analyzeRNotebookSource(
      '`+` <- function(...) 0\nbody(`+`) <- quote(0)\n' +
        'objective <- function(beta) beta + NEW_ONLY\n' +
        'fit <- stats::optim(0, fn=objective, method="BFGS")'
    )
    expect(facts.usedNames ?? []).not.toContain('NEW_ONLY')
    expect(facts.safeCallNames ?? []).not.toContain('+')
    expect(facts.state).toBe('unknown')
  })

  it('reestablishes capture authority only through a new explicit definition', async () => {
    const { facts } = await analyzeRNotebookSource(
      'objective <- function(beta) (beta - OLD_ONLY)^2\n' +
        'body(objective) <- quote((beta - UNPROVEN_BODY)^2)\n' +
        'objective <- function(beta) (beta - NEW_ONLY)^2\n' +
        'fit <- stats::optim(0, fn=objective, method="BFGS")'
    )
    expect(facts.usedNames).toContain('NEW_ONLY')
    expect(facts.usedNames ?? []).not.toContain('OLD_ONLY')
    expect(facts.usedNames ?? []).not.toContain('UNPROVEN_BODY')
    expect(facts.state).toBe('unknown')
  })

  it('retains existing optimize captures before replacing its callback binding', async () => {
    const { facts } = await analyzeRNotebookSource(
      'objective <- function(rate) (rate - OFFSET_ONLY)^2\n' +
        'objective <- stats::optimize(f=objective, interval=c(0,1))\nalias <- objective'
    )
    expect(facts.usedNames).toContain('OFFSET_ONLY')
    expect(facts.priorUsedNames).toContain('OFFSET_ONLY')
    for (const target of ['objective', 'alias'])
      expect(facts.typeBindings ?? []).not.toContainEqual(expect.objectContaining({ target }))
    expect(facts.state).toBe('unknown')
  })

  it('invalidates the fit for independent objective and gradient capture changes', async () => {
    const projection = await projectScripts(
      'r',
      [
        'FN_ONLY <- 1\nGR_ONLY <- 2',
        `${callbacks}\nfit <- stats::optim(0, objective, gradient, method="BFGS")`,
        'GR_ONLY <- 3',
        'FN_ONLY <- 4'
      ],
      'r-bfgs-captures-'
    )
    for (const [runId, name] of [
      ['run-3', 'GR_ONLY'],
      ['run-4', 'FN_ONLY']
    ]) {
      expect(projection.invalidatedByRunId[runId]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runId: 'run-2', state: 'unknown', names: [name] })
        ])
      )
    }
    expect(projection.stalenessByRunId['run-2'].state).toBe('unknown')
    expect(projection.dependenciesByRunId?.['run-2']).toBeUndefined()
  })

  it.each([
    'stats::optim(0, fn=objective, method="BFGS")',
    'stats::optim(0, fn=objective, gr=NULL, method="BFGS")',
    'stats::optim(par=0, accidental, gradient, fn=objective, method="BFGS")'
  ])('does not invent a gradient slot for %s', async (call) => {
    const { facts } = await analyzeRNotebookSource(`${callbacks}\nfit <- ${call}`)
    expect(facts.usedNames).toContain('FN_ONLY')
    expect(facts.usedNames ?? []).not.toContain('GR_ONLY')
    expect(facts.state).toBe('unknown')
  })

  it.each([
    'stats::optim(method="BFGS", 0, objective, gradient)',
    'stats::optim(0, objective, gradient, "BFGS")',
    'stats::optim(0, f=objective, g=gradient, method="BFGS")',
    'stats::optim(0, fn=objective, fn=objective, gr=gradient, method="BFGS")',
    'stats::optim(0, objective, gradient, method=selected_method)',
    'stats::optim(0, objective, gradient, method="SANN")',
    'stats::optim(0, objective, gradient, method="BFGS", ...)',
    'solver <- stats::optim\nsolver(0, objective, gradient, method="BFGS")',
    'optim <- function(...) 0\noptim(0, objective, gradient, method="BFGS")',
    '`::` <- function(...) 0\nstats::optim(0, objective, gradient, method="BFGS")'
  ])('keeps unsupported identities and matching opaque: %s', async (call) => {
    const { facts } = await analyzeRNotebookSource(`${callbacks}\n${call}`)
    for (const name of captures) expect(facts.usedNames ?? []).not.toContain(name)
  })

  it.each(['p', 'pa', 'f', 'g'])(
    'rejects a tail partial formal tag that shifts positional callbacks: %s',
    async (tag) => {
      const { facts } = await analyzeRNotebookSource(
        `${callbacks}\nstats::optim(0, objective, gradient, ${tag}=other, method="BFGS")`
      )
      for (const name of captures) expect(facts.usedNames ?? []).not.toContain(name)
    }
  )

  it.each([
    'n <<- other + 1L\nSENTINEL',
    'hidden <<- SENTINEL',
    'n[1] <<- n + 1L\nSENTINEL',
    'n + 1L ->> n\nSENTINEL',
    'sum(n <<- n + 1L) + SENTINEL',
    'n <<- n + 0.5\nSENTINEL',
    't <<- t + 1L\nt(SENTINEL)',
    'gradient <<- gradient + 1L\nSENTINEL',
    't(SENTINEL, extra=1)',
    '`%*%`(SENTINEL, beta, extra=1)'
  ])('does not extend capture authority to %s', async (body) => {
    const { facts } = await analyzeRNotebookSource(
      `candidate <- function(beta) {${body}}\ngradient <- function(beta) beta\n` +
        'stats::optim(0, fn=candidate, method="BFGS")'
    )
    expect(facts.usedNames ?? []).not.toContain('SENTINEL')
  })

  it.each(['t', '%*%', '<<-', '+'])('rejects a callback after rebinding %s', async (name) => {
    const { facts } = await analyzeRNotebookSource(
      `${callbacks}\n\`${name}\` <- function(...) 0\n` +
        'stats::optim(0, objective, gradient, method="BFGS")'
    )
    for (const capture of name === 't' ? ['GR_ONLY', 'penalty_mask'] : captures)
      expect(facts.usedNames ?? []).not.toContain(capture)
  })

  it.each([
    'function(beta, t) t(X) %*% beta + SENTINEL',
    'function(beta) { t <- replacement; t(X) %*% beta + SENTINEL }',
    'function(beta) { if(flag) t <- replacement; t(X) %*% beta + SENTINEL }',
    'function(beta, n) { n <<- n + 1L; SENTINEL }'
  ])('rejects shadowed invocation-local operations: %s', async (callback) => {
    const { facts } = await analyzeRNotebookSource(
      `candidate <- ${callback}\nstats::optim(0, fn=candidate, method="BFGS")`
    )
    expect(facts.usedNames ?? []).not.toContain('SENTINEL')
  })

  it('uses a current same-cell callback after replacement', async () => {
    const { facts } = await analyzeRNotebookSource(
      `${callbacks}\nobjective <- function(beta) beta - REPLACEMENT_ONLY\n` +
        'stats::optim(0, objective, gradient, method="BFGS")'
    )
    expect(facts.usedNames).toEqual(expect.arrayContaining(['REPLACEMENT_ONLY', 'GR_ONLY']))
    expect(facts.usedNames ?? []).not.toContain('FN_ONLY')
  })

  it('does not publish BFGS-only captures to other calls or later cells', async () => {
    const producer = await analyzeRNotebookSource(callbacks)
    const context = projectNotebookFileContext('r', [
      {
        facts: producer.facts,
        fileContext: producer.fileAccess!.context
      }
    ])
    const later = await analyzeRNotebookSource(
      'stats::optim(0, objective, gradient, method="BFGS")',
      context
    )
    for (const name of captures) expect(later.facts.usedNames ?? []).not.toContain(name)
    for (const call of [
      'stats::uniroot(objective, c(-1,1))',
      'stats::integrate(objective, 0, 1)',
      'stats::optimize(objective, c(0,1))',
      'objective(0)'
    ]) {
      const { facts } = await analyzeRNotebookSource(`${callbacks}\n${call}`)
      for (const name of captures) expect(facts.usedNames ?? []).not.toContain(name)
    }
  })
})

describe('NumPy converter consumption lineage', () => {
  // Reduce the real cars unit converters to their scalar captures. The public
  // analyzer must read these at reader invocation, not at converter definition.
  const converters = [
    'def speed_converter(value):',
    '    return float(value) * mph_to_mps',
    'def distance_converter(value):',
    '    return float(value) * feet_to_metres * distance_scale'
  ].join('\n')
  const dictionary = '{1: speed_converter, 2: distance_converter}'
  const path = '"outputs/cars-unit-labelled.csv"'

  it.each([
    ['loadtxt dictionary keyword', `np.loadtxt(${path}, converters=${dictionary})`, true],
    ['loadtxt dictionary slot four', `np.loadtxt(${path}, float, "#", ",", ${dictionary})`, true],
    [
      'loadtxt callable keyword',
      `np.loadtxt(${path}, converters=distance_converter, usecols=2)`,
      false
    ],
    [
      'loadtxt callable slot four',
      `np.loadtxt(${path}, float, "#", ",", distance_converter, usecols=2)`,
      false
    ],
    ['genfromtxt dictionary keyword', `np.genfromtxt(${path}, converters=${dictionary})`, true],
    [
      'genfromtxt dictionary slot six',
      `np.genfromtxt(${path}, float, "#", ",", 1, 0, ${dictionary})`,
      true
    ],
    [
      'loadtxt imported alias',
      `reader(${path}, converters=distance_converter, usecols=2)`,
      false,
      'from numpy import loadtxt as reader'
    ],
    [
      'genfromtxt imported alias',
      `reader(${path}, converters=${dictionary})`,
      true,
      'from numpy import genfromtxt as reader'
    ]
  ])(
    'invalidates the reader for consumed scalar changes through %s',
    async (_, call, hasSpeed, imports = 'import numpy as np') => {
      const projection = await projectScripts(
        'python',
        [
          `${imports}\nmph_to_mps = 0.44704\nfeet_to_metres = 0.3048\ndistance_scale = 1.`,
          converters,
          `arr = ${call}`,
          'distance_scale = 1.5',
          'mph_to_mps = 0.5'
        ],
        'notebook-numpy-converter-lineage-'
      )
      expect(projection.invalidatedByRunId['run-4']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runId: 'run-3', state: 'unknown', names: ['distance_scale'] })
        ])
      )
      const speedInvalidation = projection.invalidatedByRunId['run-5']?.find(
        (item) => item.runId === 'run-3'
      )
      expect(speedInvalidation?.names?.includes('mph_to_mps') ?? false).toBe(hasSpeed)
      for (const runId of ['run-4', 'run-5']) {
        expect(projection.invalidatedByRunId[runId] ?? []).not.toContainEqual(
          expect.objectContaining({ runId: 'run-2' })
        )
      }
      expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
      expect(projection.stalenessByRunId['run-3'].state).toBe('unknown')
      expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
    }
  )
})

describe('Python callback dictionary NumPy consumption', () => {
  // Handwritten controls for the named mapping gap; not newly generated Agent code.
  const helper = 'def convert(value):\n    return float(value) + temperature_offset'
  const path = '"inputs/observations.csv"'

  it.each([
    ['loadtxt integer keys', '{4: convert}', `np.loadtxt(${path}, converters=converters)`],
    [
      'genfromtxt string keys',
      '{"Temp": convert}',
      `np.genfromtxt(${path}, names=True, converters=converters)`
    ],
    ['loadtxt position four', '{4: convert}', `np.loadtxt(${path}, float, "#", ",", converters)`],
    [
      'genfromtxt position six',
      '{4: convert}',
      `np.genfromtxt(${path}, float, "#", ",", 0, 0, converters)`
    ],
    [
      'trusted imported reader',
      '{4: convert}',
      `reader(${path}, converters=converters)`,
      'from numpy import genfromtxt as reader'
    ]
  ])(
    'retains late scalar invalidation through %s without certifying callback I/O',
    async (_name, mapping, call, imports = 'import numpy as np') => {
      const scripts = [
        `${imports}\ntemperature_offset = 2.`,
        `${helper}\nconverters = ${mapping}`,
        `array = ${call}`,
        'temperature_offset = 3.5'
      ]
      const projection = await projectScripts('python', scripts, 'numpy-named-dictionary-')
      expect(projection.invalidatedByRunId['run-4']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: 'run-3',
            state: 'unknown',
            names: ['temperature_offset']
          })
        ])
      )
      expect(projection.invalidatedByRunId['run-4']).not.toContainEqual(
        expect.objectContaining({ runId: 'run-2' })
      )
      expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
      expect(projection.stalenessByRunId['run-3'].state).toBe('unknown')
      expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
      const source = await analyzePythonNotebookSource(scripts.slice(0, 3).join('\n'))
      expect(
        normalizeNotebookSourceFileAccess('python', source.facts, source.fileAccess)
      ).toMatchObject({
        reads: ['inputs/observations.csv'],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )
})

describe('pandas CSV converter consumption lineage', () => {
  it.each(['{"eruptions":convert}', 'converters'])(
    'retains late scalar captures through %s',
    async (mapping) => {
      const projection = await projectScripts(
        'python',
        [
          'import pandas as pd\nscale=60.',
          'def convert(value):\n    return float(value)*scale\nconverters={"eruptions":convert}',
          'frame=pd.read_csv("observations.csv",converters=' + mapping + ')',
          'scale=1.'
        ],
        'pandas-csv-converter-'
      )
      expect(projection.invalidatedByRunId['run-4']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runId: 'run-3', state: 'unknown', names: ['scale'] })
        ])
      )
      expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    }
  )
})

describe('pandas CSV converter capture boundaries', () => {
  it.each([
    ['import pandas as pd', 'pd.read_csv'],
    ['from pandas import read_csv as reader', 'reader']
  ])('retains captures with prior-cell imports: %s', async (imports, reader) => {
    const projection = await projectScripts(
      'python',
      [
        imports + '\nscale=60.',
        'def convert(value):\n    return float(value)*scale',
        'frame=' + reader + '("observations.csv",converters={"eruptions":convert})',
        'scale=30.'
      ],
      'pandas-csv-imports-'
    )
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-3', state: 'unknown', names: ['scale'] })
      ])
    )
  })
  it.each([
    'pd.read_csv=other',
    'converters["eruptions"]=other',
    'converters.update(other)',
    'inspect_unknown(converters)',
    'convert=other'
  ])('does not certify an invalidated mapping identity: %s', async (barrier) => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nscale=60.\ndef convert(value):\n    return float(value)*scale\nconverters={"eruptions":convert}',
        barrier + '\nframe=pd.read_csv("observations.csv",converters=converters)',
        'scale=30.'
      ],
      'pandas-csv-barriers-'
    )
    expect(
      (projection.invalidatedByRunId['run-3'] ?? [])
        .filter((x) => x.runId === 'run-2')
        .flatMap((x) => x.names)
    ).not.toContain('scale')
  })
})

describe('pandas CSV selection callback lineage', () => {
  it.each(['usecols', 'skiprows'])('captures the consumed %s function globals', async (option) => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nselection=3',
        'def select(value):\n    return value != selection',
        'frame=pd.read_csv("observations.csv",' + option + '=select)',
        'selection=4'
      ],
      'pandas-selection-'
    )
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-3', state: 'unknown', names: ['selection'] })
      ])
    )
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })
})

describe('pandas CSV selection callback authority', () => {
  it.each(['usecols', 'skiprows'])('supports imported reader aliases for %s', async (option) => {
    const projection = await projectScripts(
      'python',
      [
        'from pandas import read_csv as read\nselection=3',
        'def select(value):\n    return value != selection',
        'frame=read("observations.csv",' + option + '=select)',
        'selection=4'
      ],
      'pandas-selection-alias-'
    )
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-3', state: 'unknown', names: ['selection'] })
      ])
    )
  })
  it('captures both selection callbacks with inactive converters', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\ncolumns=["eruptions"]\nstride=3',
        'def keep(name):\n    return name in columns\ndef skip(index):\n    return index % stride == 0',
        'frame=pd.read_csv("observations.csv",usecols=keep,skiprows=skip,converters=None)',
        'columns=["waiting"]\nstride=4'
      ],
      'pandas-selection-both-'
    )
    const names = (projection.invalidatedByRunId['run-4'] ?? [])
      .filter((x) => x.runId === 'run-3')
      .flatMap((x) => x.names)
    expect(names).toEqual(expect.arrayContaining(['columns', 'stride']))
  })
  it.each(['pd.read_csv=other', 'select=other'])(
    'does not borrow captured globals after %s',
    async (barrier) => {
      const projection = await projectScripts(
        'python',
        [
          'import pandas as pd\nselection=3\ndef select(value):\n    return value != selection',
          barrier + '\nframe=pd.read_csv("observations.csv",skiprows=select)',
          'selection=4'
        ],
        'pandas-selection-shadow-'
      )
      expect(
        (projection.invalidatedByRunId['run-3'] ?? [])
          .filter((x) => x.runId === 'run-2')
          .flatMap((x) => x.names)
      ).not.toContain('selection')
    }
  )
})

describe('pandas bad-line callback lineage', () => {
  it('captures repair policy at CSV consumption', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nrepair_enabled=True',
        'def repair(fields):\n    return fields[:2] if repair_enabled else None',
        'frame=pd.read_csv("observations.csv",engine="python",on_bad_lines=repair)',
        'repair_enabled=False'
      ],
      'pandas-bad-line-'
    )
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-3', state: 'unknown', names: ['repair_enabled'] })
      ])
    )
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })
})

describe('pandas bad-line callback authority', () => {
  it('captures a policy through an imported reader alias', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from pandas import read_csv as read\nfield_count=2',
        'def repair(fields):\n    return fields[:field_count]',
        'frame=read("observations.csv",engine="python",on_bad_lines=repair)',
        'field_count=3'
      ],
      'pandas-bad-line-alias-'
    )
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-3', state: 'unknown', names: ['field_count'] })
      ])
    )
  })
  it.each(['pd.read_csv=other', 'repair=other'])(
    'does not borrow callback identity after %s',
    async (barrier) => {
      const projection = await projectScripts(
        'python',
        [
          'import pandas as pd\nfield_count=2\ndef repair(fields):\n    return fields[:field_count]',
          barrier + '\nframe=pd.read_csv("observations.csv",engine="python",on_bad_lines=repair)',
          'field_count=3'
        ],
        'pandas-bad-line-shadow-'
      )
      expect(
        (projection.invalidatedByRunId['run-3'] ?? [])
          .filter((x) => x.runId === 'run-2')
          .flatMap((x) => x.names)
      ).not.toContain('field_count')
    }
  )
})

describe('R scientific model argument evaluation', () => {
  it.each([
    'lm(formula_spec, observed)',
    'lm(formula=formula_spec, dat=observed)',
    'stats::lm(data=observed, formula_spec)',
    'glm(formula_spec, family=family_spec, dat=observed)',
    'aov(formula=formula_spec, observed)'
  ])('tracks formula and data as definite values: %s', async (call) => {
    const { facts } = await analyzeRNotebookSource('fit <- ' + call)
    expect(facts?.priorUsedNames).toEqual(expect.arrayContaining(['formula_spec', 'observed']))
    expect(facts?.possiblyUsedNames).not.toContain('observed')
    expect(facts?.possiblyUsedNames).not.toContain('formula_spec')
  })

  it('keeps only subset, weights and inline formula terms in the model data mask', async () => {
    const { facts } = await analyzeRNotebookSource(
      'fit <- lm(y ~ x, observed, subset=keep, weights=w, method=method_name, na.action=handler)'
    )
    expect(facts?.priorUsedNames).toEqual(
      expect.arrayContaining(['observed', 'method_name', 'handler'])
    )
    expect(facts?.possiblyUsedNames).toEqual(expect.arrayContaining(['x', 'y', 'keep', 'w']))
    expect(facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
  })

  it.each(['lm(f, observed, s=other)', 'lm(f, data=observed, data=other)', 'lm(f, ...)'])(
    'does not certify ambiguous or forwarded arguments: %s',
    async (call) => {
      const io = await analyzeNotebookSourceFileAccess('r', call)
      expect(io).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )
})

describe('R model argument lineage guards', () => {
  it.each([
    'lm(y ~ x, observed)',
    'lm(formula=y ~ x, dat=observed)',
    'stats::aov(y ~ x, observed)'
  ])(
    'invalidates the fitted result when its positional data provider changes: %s',
    async (call) => {
      const projection = await projectScripts(
        'r',
        [
          'observed <- data.frame(x=c(1,2,3),y=c(3,5,8))',
          'fit <- ' + call,
          'observed <- data.frame(x=c(1,2,3),y=c(6,9,13))'
        ],
        'open-science-r-model-arguments-'
      )
      expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    }
  )
  it('matches exact names before partial names and unnamed arguments', async () => {
    const { facts } = await analyzeRNotebookSource(
      'fit <- lm(y ~ x, subset=keep, s=singular_flag, dat=observed)'
    )
    expect(facts?.priorUsedNames).toEqual(expect.arrayContaining(['observed', 'singular_flag']))
    expect(facts?.possiblyUsedNames).toEqual(expect.arrayContaining(['x', 'y', 'keep']))
  })
  it.each(['lm', 'glm', 'aov'])(
    'does not certify a replacement %s or namespace operator',
    async (name) => {
      for (const source of [
        name + ' <- replacement; fit <- ' + name + '(y~x, observed)',
        'fit <- other::' + name + '(y~x, observed)',
        '\x60::\x60 <- replacement; fit <- stats::' + name + '(y~x, observed)'
      ]) {
        const io = await analyzeNotebookSourceFileAccess('r', source)
        expect(io.readState).toBe('partial')
      }
    }
  )
  it.each([
    'na.action=handler',
    'method=method_name',
    'contrasts=contrast_spec',
    'family=family_spec'
  ])(
    'does not certify hidden callback file effects through resolved bindings: %s',
    async (option) => {
      const call = option.startsWith('family') ? 'glm' : 'lm'
      const io = await analyzeNotebookSourceFileAccess(
        'r',
        call + '(y~x,data=observed,' + option + ')',
        {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          resolvedKernelNames: [
            'observed',
            'handler',
            'method_name',
            'contrast_spec',
            'family_spec'
          ]
        }
      )
      expect(io).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )
})

describe('R qualified model inspectors', () => {
  it.each(['coef', 'fitted', 'residuals'])(
    'retains generic uncertainty and explicit file outputs for stats::%s',
    async (name) => {
      const prefix =
        'observed <- read.csv("inputs/faithful.csv"); fit <- lm(waiting~eruptions,observed); result <- '
      const suffix = '(fit); write.csv(result,"outputs/result.csv",row.names=FALSE)'
      const bare = await analyzeNotebookSourceFileAccess('r', prefix + name + suffix)
      const qualified = await analyzeNotebookSourceFileAccess(
        'r',
        prefix + 'stats::' + name + suffix
      )
      expect(qualified).toEqual(bare)
      expect(qualified).toMatchObject({
        readState: 'partial',
        writeState: 'complete',
        writes: ['outputs/result.csv']
      })
      const { facts } = await analyzeRNotebookSource(prefix + 'stats::' + name + suffix)
      expect(facts?.safeCallNames).not.toContain('stats::' + name)
      expect(facts?.receiverCalls).toContainEqual(
        expect.objectContaining({ receiver: 'fit', member: name, kind: 'generic' })
      )
    }
  )
  it.each(['other::residuals(fit)', 'stats::residuals()', 'stats::residuals(make_model())'])(
    'keeps unsupported inspector identity or receiver opaque: %s',
    async (source) => {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
    }
  )
})

describe('R scientific namespace replacement guards', () => {
  it.each(
    ['coef', 'fitted', 'residuals', 'lm', 'glm', 'aov'].flatMap((name) =>
      ['::', ':::'].map((op) => [name, op])
    )
  )('keeps %s opaque when %s was replaced', async (name, op) => {
    const source = '\x60' + op + '\x60 <- replacement; stats' + op + name + '(fit)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
})

describe('R direct Gaussian identity family', () => {
  it.each([
    'gaussian()',
    'stats::gaussian()',
    'stats::gaussian(link="identity")',
    'gaussian("identity")'
  ])('keeps the explicit default equivalent to implicit glm family: %s', async (family) => {
    const prefix =
      'observed <- read.csv("inputs/faithful.csv"); fit <- glm(waiting~eruptions,data=observed'
    const suffix = '); write.csv(coef(fit),"outputs/fit.csv",row.names=FALSE)'
    const implicit = await analyzeNotebookSourceFileAccess('r', prefix + suffix)
    const explicit = await analyzeNotebookSourceFileAccess(
      'r',
      prefix + ',family=' + family + suffix
    )
    expect(explicit).toEqual(implicit)
    expect(explicit.writeState).toBe('complete')
  })
})

describe('R Gaussian identity family boundaries', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    resolvedKernelNames: ['observed', 'family_spec', 'link_spec']
  }
  it.each([
    'family_spec',
    'gaussian',
    'stats::gaussian',
    'gaussian(link_spec)',
    'gaussian(link="log")',
    'gaussian(link="inverse")',
    'gaussian(link=custom_link())',
    'gaussian(link="identity",extra=TRUE)',
    'gaussian(link="identity",link="identity")',
    'other::gaussian()'
  ])('keeps non-closed family effects partial: %s', async (family) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'fit <- glm(y~x,data=observed,family=' + family + ')',
        context
      )
    ).toMatchObject({ readState: 'partial', writeState: 'partial', externalState: 'partial' })
  })
  it.each(['::', ':::'])('rejects replaced namespace operator %s', async (op) => {
    const source =
      '\x60' +
      op +
      '\x60 <- replacement; fit <- glm(y~x,data=observed,family=stats' +
      op +
      'gaussian())'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
  })
  it('rejects a bare constructor replaced in this or an earlier cell', async () => {
    for (const [source, ctx] of [
      ['gaussian <- replacement; fit <- glm(y~x,data=observed,family=gaussian())', context],
      [
        'fit <- glm(y~x,data=observed,family=gaussian())',
        { ...context, resolvedKernelNames: [...context.resolvedKernelNames, 'gaussian'] }
      ]
    ] as const) {
      expect(
        await analyzeNotebookSourceFileAccess('r', source, {
          ...ctx,
          resolvedKernelNames: [...ctx.resolvedKernelNames]
        })
      ).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
    }
  })
  it('preserves the standard qualified constructor after a bare replacement', async () => {
    const { facts } = await analyzeRNotebookSource(
      'gaussian <- replacement; fit <- glm(y~x,data=observed,family=stats::gaussian())'
    )
    expect(facts?.safeCallNames).toContain('stats::gaussian')
    expect(facts).not.toMatchObject({ reasons: expect.arrayContaining(['opaque-call']) })
  })
  it('does not certify a stored family or export a family type', async () => {
    const { facts } = await analyzeRNotebookSource(
      'family_spec <- stats::gaussian(); fit <- glm(y~x,data=observed,family=family_spec)'
    )
    expect(facts).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
    expect(facts?.copyOnModifyNames).not.toContain('family_spec')
  })
  it('does not grant the contract to lm dots or another model', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'fit <- lm(y~x,data=observed,family=stats::gaussian())',
        context
      )
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
})

it('does not borrow Gaussian constructor identity across sibling promise assignments', async () => {
  const source =
    'fit <- glm(waiting~eruptions,family=gaussian(),data={gaussian <- replacement; observed})'
  const { facts } = await analyzeRNotebookSource(source)
  expect(facts?.safeCallNames).not.toContain('gaussian')
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    readState: 'partial',
    writeState: 'partial'
  })
})

describe('R primitive numeric scan and diff', () => {
  it.each([
    'diff(c(1,2,4))',
    'base::diff(range(c(1,2,4)))',
    'diff(x=c(1,2,4),lag=1,differences=1)'
  ])('certifies default difference on primitive input: %s', async (call) => {
    expect(await analyzeNotebookSourceFileAccess('r', 'result <- ' + call)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    expect((await analyzeRNotebookSource('result <- ' + call)).facts?.rAtomicValueNames).toContain(
      'result'
    )
  })
  it('retains numeric file type through differences and output', async () => {
    const source =
      'values <- scan("inputs/values.txt",what=numeric(),quiet=TRUE); delta <- diff(values); span <- diff(range(values)); write.csv(delta,"outputs/delta.csv",row.names=FALSE)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      reads: ['inputs/values.txt'],
      writes: ['outputs/delta.csv']
    })
    expect((await analyzeRNotebookSource(source)).facts?.rAtomicValueNames).toEqual(
      expect.arrayContaining(['values', 'delta', 'span'])
    )
  })
})

describe('R primitive numeric scan and diff boundaries', () => {
  it.each([
    'result <- diff(unknown)',
    'values <- structure(c(1,2,4),class="sensor"); result <- diff(values)',
    'values <- c(1,2,4); class(values) <- "sensor"; result <- diff(values)',
    'values <- c(1,2,4); attr(values,"class") <- "sensor"; result <- diff(values)',
    'values <- c(1,2,4); attributes(values) <- list(class="sensor"); result <- diff(values)',
    'diff <- replacement; result <- diff(c(1,2,4))',
    'diff.default <- replacement; result <- base::diff(c(1,2,4))',
    'range.default <- replacement; result <- diff(range(c(1,2,4)))',
    'range.default <- replacement; values <- range(c(1,2,4)); result <- diff(values)',
    'sort.default <- replacement; values <- sort(c(1,2,4)); result <- diff(values)',
    'result <- diff(c(1,2,4),lag=unknown)',
    'result <- diff(c(1,2,4),lag={diff.default <- replacement; 1})',
    'result <- diff(c(1,2,4),extra=1)',
    'result <- diff(x=c(1,2,4),x=c(4,5))',
    'result <- diff(c(1,2,4),lag=0)'
  ])('keeps unsupported dispatch partial: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
      'result'
    )
  })
  it.each([
    'scan("input.txt",what=list(numeric()),quiet=TRUE)',
    'scan("input.txt",what=prototype,quiet=TRUE)',
    'scan("input.txt",what=numeric(),nlines=limit)',
    'scan("input.txt",w=numeric())',
    'scan("input.txt",numeric(),TRUE)'
  ])('does not export unsupported scan types: %s', async (call) => {
    const source = 'values <- ' + call + '; result <- diff(values)'
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
      'values'
    )
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
  })
  it.each(['diff', 'diff.default', 'range.default', 'numeric', 'scan', '::'])(
    'invalidates an earlier replacement: %s',
    async (name) => {
      const source =
        'values <- ' +
        (name === '::' ? 'base::scan' : 'scan') +
        '("input.txt",what=numeric(),quiet=TRUE); result <- diff(range(values))'
      expect(
        await analyzeNotebookSourceFileAccess('r', source, {
          resolvedKernelNames: [name],
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: []
        })
      ).toMatchObject({ readState: 'partial', writeState: 'partial' })
    }
  )
  it('retains atomic evidence and data dependence across cells', async () => {
    const projection = await projectScripts(
      'r',
      [
        'values <- scan("inputs/values.txt",what=numeric(),quiet=TRUE)',
        'delta <- diff(values); write.csv(delta,"outputs/delta.csv",row.names=FALSE)',
        'values <- c(1,2,3)'
      ],
      'r-primitive-difference-'
    )
    expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection.invalidatedByRunId['run-3']).toEqual(
      expect.arrayContaining([expect.objectContaining({ runId: 'run-2', names: ['values'] })])
    )
  })
})

describe('R primitive interquartile range', () => {
  it.each([
    'IQR(c(1,2,4))',
    'stats::IQR(c(1,2,4))',
    'stats::IQR(x=c(1,2,4),na.rm=TRUE,type=8)',
    'IQR(type=7,c(1,2,4),FALSE)'
  ])('retains primitive result and complete IO: %s', async (call) => {
    const source = 'spread <- ' + call + '; write.csv(spread,"outputs/spread.csv",row.names=FALSE)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['outputs/spread.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toContain('spread')
    expect(facts.copyOnModifyNames).toContain('spread')
  })
  it('carries scanned primitive evidence into the scientific export cell', async () => {
    const projection = await projectScripts(
      'r',
      [
        'values <- scan("inputs/values.txt",what=numeric(),quiet=TRUE)',
        'spread <- stats::IQR(values); write.csv(spread,"outputs/spread.csv",row.names=FALSE)',
        'values <- c(1,3,7)'
      ],
      'r-primitive-iqr-'
    )
    expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection.invalidatedByRunId['run-3']).toEqual(
      expect.arrayContaining([expect.objectContaining({ runId: 'run-2', names: ['values'] })])
    )
  })
})

describe('R primitive interquartile range boundaries', () => {
  it.each([
    'spread <- stats::IQR(unknown)',
    'values <- structure(c(1,2,4),class="sensor"); spread <- stats::IQR(values)',
    'values <- c(1,2,4); class(values) <- "sensor"; spread <- IQR(values)',
    'IQR <- replacement; spread <- IQR(c(1,2,4))',
    'spread <- other::IQR(c(1,2,4))',
    'spread <- stats::IQR(c(1,2,4),type=algorithm)',
    'spread <- stats::IQR(c(1,2,4),type=0)',
    'spread <- stats::IQR(c(1,2,4),type=10)',
    'spread <- stats::IQR(c(1,2,4),type=1.5)',
    'spread <- stats::IQR(c(1,2,4),na.rm=remove_missing)',
    'spread <- stats::IQR(c(1,2,4),na.rm=NA)',
    'spread <- stats::IQR(c(1,2,4),na.rm={IQR<-replacement; TRUE})',
    'spread <- stats::IQR(c(1,2,4),na=TRUE)',
    'spread <- stats::IQR(c(1,2,4),type=7,type=8)',
    'spread <- stats::IQR(c(1,2,4),names=FALSE)',
    'spread <- stats::IQR()',
    'helper <- stats::IQR; spread <- helper(c(1,2,4))'
  ])('keeps unknown coercion or options partial: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
      'spread'
    )
  })
  it.each(['IQR', '::', ':::'])('rejects earlier binding replacement: %s', async (name) => {
    const call = name === 'IQR' ? 'IQR' : 'stats' + name + 'IQR'
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [name]
    }
    expect(
      await analyzeNotebookSourceFileAccess('r', 'spread <- ' + call + '(c(1,2,4))', context)
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
  it.each(['::', ':::'])('rejects same-cell namespace replacement: %s', async (op) => {
    const source = '\x60' + op + '\x60 <- replacement; spread <- stats' + op + 'IQR(c(1,2,4))'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
      'spread'
    )
  })
  it('keeps the qualified stats function after a bare IQR replacement', async () => {
    const source = 'IQR <- replacement; spread <- stats::IQR(c(1,2,4))'
    expect((await analyzeRNotebookSource(source)).facts.safeCallNames).toContain('stats::IQR')
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames).toContain('spread')
  })
  it('does not invent dependencies on globally replaced internal methods', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['diff.default', 'quantile.default', 'as.numeric']
    }
    const source = 'spread <- stats::IQR(c(1,2,4))'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    const { facts } = await analyzeRNotebookSource(source, context)
    expect(facts.priorUsedNames).not.toEqual(expect.arrayContaining(['quantile.default']))
    expect(facts.priorUsedNames).not.toEqual(expect.arrayContaining(['diff.default']))
  })
  it.each([1, 9])('accepts the supported quantile algorithm boundary: %s', async (type) => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'spread <- stats::IQR(c(1,2,4),type=' + type + ')')
    ).toMatchObject({ readState: 'complete', writeState: 'complete' })
  })
  it('withdraws proof after a class change in an earlier cell', async () => {
    const projection = await projectScripts(
      'r',
      [
        'values <- scan("inputs/values.txt",what=numeric(),quiet=TRUE)',
        'class(values) <- "sensor"',
        'spread <- stats::IQR(values)'
      ],
      'r-iqr-class-change-'
    )
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
  })
})

describe('R primitive robust statistics', () => {
  it.each([
    'stats::mad(c(1,2,4))',
    'mad(c(1,2,4),center=0,constant=1,low=TRUE)',
    'stats::quantile(c(1,2,4),probs=c(.25,.75),names=FALSE)',
    'quantile(c(1,2,4),probs=c(.25,.75),type=8)'
  ])('retains primitive result and complete IO: %s', async (call) => {
    const source = 'result <- ' + call + '; write.csv(result,"output.csv",row.names=FALSE)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames).toContain('result')
  })
  it('retains cross-cell quantile and difference lineage', async () => {
    const scripts = [
      'values <- scan("input.txt",what=numeric(),quiet=TRUE)',
      'quartiles <- stats::quantile(values,probs=c(.25,.75),names=FALSE)',
      'spread <- diff(quartiles); write.csv(spread,"output.csv",row.names=FALSE)'
    ]
    const current = await projectScripts('r', scripts, 'r-robust-current-quantiles-')
    expect(current.dependenciesByRunId?.['run-3']).toContain('run-2')
    const projection = await projectScripts(
      'r',
      [...scripts, 'values <- c(1,3,7)'],
      'r-robust-quantiles-'
    )
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
  })
  it.each([
    'quantile.default <- replacement; result <- stats::quantile(c(1,2,4))',
    'values <- structure(c(1,2,4),class="sensor"); result <- stats::quantile(values)'
  ])('keeps custom quantile dispatch partial: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
  })
})

describe('R primitive means', () => {
  it.each([
    'mean(c(1,2,4))',
    'base::mean(c(1,2,4))',
    'mean(c(1,2,4),trim=0.1)',
    'mean(na.rm=TRUE,x=c(1,NA_real_,4),trim=0.25)',
    'base::mean.default(c(1,2,4))',
    'mean.default(c(1,2,4),trim=0.25)',
    'base:::mean.default(c(1,2,4),na.rm=TRUE)'
  ])('propagates primitive mean results: %s', async (call) => {
    const source = 'm <- ' + call + '; delta <- diff(c(m,1)); write.csv(delta,"mean.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['mean.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['m', 'delta']))
    expect(facts.copyOnModifyNames).toContain('m')
  })
  it('tracks separate means and transitive staleness across cells', async () => {
    const scripts = [
      'x<-scan("x.txt",what=numeric(),quiet=TRUE)',
      'y<-scan("y.txt",what=numeric(),quiet=TRUE)',
      'mx<-mean(x); my<-base::mean(y,trim=0.1)',
      'delta<-diff(c(mx,my));write.csv(delta,"out.csv")'
    ]
    const current = await projectScripts('r', scripts, 'r-mean-current-')
    expect(current.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(current.dependenciesByRunId?.['run-4']).toContain('run-3')
    const changed = await projectScripts('r', [...scripts, 'x<-c(8,9)'], 'r-mean-changed-')
    expect(changed.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
  })
  it.each([
    'mean(unknown)',
    'mean(structure(c(1,2),class="sensor"))',
    'base::mean.default(structure(c(1,2),class="sensor"),na.rm=TRUE)',
    'mean(c(1,2),trim=amount)',
    'mean(c(1,2),trim=structure(.1,class="cut"))',
    'mean(c(1,2),na.rm=remove)',
    'mean(c(1,2),tr=.1)',
    'mean(c(1,2),trim=.1,trim=.2)',
    'mean(c(1,2),extra=1)',
    'mean()',
    'other::mean(c(1,2))',
    'mean(c(1,2),trim=Inf)',
    'mean(c(1,2),trim=-.1)'
  ])('withholds result proof for uncertain inputs or arguments: %s', async (call) => {
    const source = 'm <- ' + call + '; delta <- diff(c(m,1))'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain('m')
  })
  it.each(['mean', 'mean.default', '::', ':::'])('honors replacement of %s', async (binding) => {
    const source =
      'm <- ' +
      (binding === '::' || binding === ':::' ? 'base' + binding + 'mean' : 'mean') +
      '(c(1,2)); delta <- diff(c(m,1))'
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [binding]
    }
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect(
      await analyzeNotebookSourceFileAccess('r', '\x60' + binding + '\x60<-replacement;' + source)
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
  it('uses the base default directly despite a global mean.default replacement', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['mean.default', 'sort', 'length', 'is.na']
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'm<-base::mean.default(c(1,2),trim=.25);delta<-diff(c(m,1))',
        context
      )
    ).toMatchObject({ readState: 'complete', writeState: 'complete' })
  })
  it.each(['mean', 'base::mean', 'base::mean.default'])(
    'does not infer primitive results from %s callbacks and aliases',
    async (name) => {
      for (const source of [
        'm<-lapply(list(structure(c(1,2),class="sensor")),' + name + ')',
        'helper<-' + name + '; m<-helper(unknown)'
      ]) {
        expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
          'm'
        )
        expect(
          await analyzeNotebookSourceFileAccess('r', source + '; delta <- diff(c(m,1))')
        ).toMatchObject({
          readState: 'partial',
          writeState: 'partial'
        })
      }
    }
  )
})

describe('R primitive cumulative statistics', () => {
  const names = ['cumsum', 'cumprod', 'cummin', 'cummax']

  it.each(names.flatMap((name) => [name, 'base::' + name, 'base:::' + name]))(
    'propagates stored cumulative results from %s',
    async (name) => {
      const source =
        'x <- c(3,1,2); accumulated <- ' +
        name +
        '(x=x); delta <- diff(accumulated); write.csv(delta,"output.csv",row.names=FALSE)'
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        writes: ['output.csv']
      })
      const { facts } = await analyzeRNotebookSource(source)
      expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['accumulated', 'delta']))
      expect(facts.copyOnModifyNames).toContain('accumulated')
    }
  )

  it.each(names)('propagates nested %s results', async (name) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'delta <- diff(base::' + name + '(c(3,1,2))); write.csv(delta,"out.csv")'
      )
    ).toMatchObject({ readState: 'complete', writeState: 'complete', writes: ['out.csv'] })
  })

  it.each(names)('tracks %s inputs, stored results and transitive staleness', async (name) => {
    const scripts = [
      'a <- scan("a.txt",what=numeric(),quiet=TRUE)',
      'b <- scan("b.txt",what=numeric(),quiet=TRUE)',
      'accumulated <- base::' + name + '(c(a,b))',
      'delta <- diff(accumulated); write.csv(delta,"out.csv")'
    ]
    const current = await projectScripts('r', scripts, 'r-cumulative-current-')
    expect(current.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(current.dependenciesByRunId?.['run-4']).toContain('run-3')
    const changed = await projectScripts('r', [...scripts, 'b <- c(5,6)'], 'r-cumulative-changed-')
    expect(changed.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
  })

  it.each(names)(
    'retains %s class dispatch and invalidates changed primitive values',
    async (name) => {
      for (const source of [
        'result <- base::' + name + '(structure(c(1,2),class="sensor"))',
        'x <- c(1,2); class(x)<-"sensor"; result <- ' + name + '(x)',
        'result <- base::' + name + '(unknown)',
        'result <- lapply(list(structure(c(1,2),class="sensor")),base::' + name + ')',
        'helper <- ' + name + '; result <- helper(unknown)',
        'helper <- base::' + name + '; result <- helper(unknown)',
        'helper <- base:::' + name + '; result <- helper(unknown)',
        'result <- base::' + name + '(list(1,2))'
      ]) {
        expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
          readState: 'partial',
          writeState: 'partial'
        })
        expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
          'result'
        )
      }
    }
  )

  it.each(names)('keeps malformed %s arguments and foreign identities partial', async (name) => {
    for (const call of [
      name + '()',
      name + '(c(1,2),c(3,4))',
      name + '(x=c(1,2),x=c(3,4))',
      name + '(value=c(1,2))',
      name + '(c(1,2),na.rm=TRUE)',
      'other::' + name + '(c(1,2))'
    ]) {
      expect(await analyzeNotebookSourceFileAccess('r', 'result <- ' + call)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
      expect(
        (await analyzeRNotebookSource('result <- ' + call)).facts.rAtomicValueNames ?? []
      ).not.toContain('result')
    }
  })

  it.each(names)('honors replacement of %s and namespace operators', async (name) => {
    for (const binding of [name, '::', ':::']) {
      const source = 'result <- ' + (binding === name ? name : 'base' + binding + name) + '(c(1,2))'
      const context = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: [binding]
      }
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          '\x60' + binding + '\x60 <- replacement; ' + source
        )
      ).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
    }
  })

  it.each(names)('retains unknown effects through cached %s aliases', async (name) => {
    const projection = await projectScripts(
      'r',
      ['helper <- base::' + name, 'result <- helper(structure(c(1,2),class="sensor"))'],
      'r-cumulative-alias-'
    )
    expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('does not depend on unused default methods for primitive cumulative calls', async () => {
    const source = 'result <- base::cumsum(c(1,2)); delta <- diff(result)'
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['cumsum', 'cumsum.default', 'Math.default']
    }
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    expect((await analyzeRNotebookSource(source, context)).facts.priorUsedNames).not.toContain(
      'Math.default'
    )
  })
})

describe('R primitive normal probabilities', () => {
  it.each([
    'pnorm(c(-1,0,1))',
    'stats::pnorm(c(1,2),mean=3,sd=1,lower.tail=FALSE)',
    'pnorm(q=c(-1,0,1),log.p=TRUE)',
    'stats::pnorm(c(-1,0,1),0,1,TRUE,FALSE)'
  ])('carries normal probabilities into adjustments: %s', async (call) => {
    const source =
      'p <- ' +
      call +
      '; adjusted <- stats::p.adjust(p,"BH"); delta <- diff(adjusted); write.csv(delta,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['out.csv']
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames).toEqual(
      expect.arrayContaining(['p', 'adjusted', 'delta'])
    )
  })
  it.each([
    'pnorm(unknown)',
    'pnorm(structure(1,class="sensor"))',
    'pnorm(1,mean=mu)',
    'pnorm(1,sd=scale)',
    'pnorm(1,lower.tail=flag)',
    'pnorm(1,log.p=flag)',
    'pnorm(1,lower=FALSE)',
    'pnorm(1,extra=TRUE)',
    'pnorm(1,sd=1,sd=2)',
    'other::pnorm(1)'
  ])('keeps unproven normal arguments partial: %s', async (call) => {
    expect(await analyzeNotebookSourceFileAccess('r', 'p <- ' + call)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
  })
  it.each(['pnorm', '::', ':::'])('honors normal function replacement: %s', async (binding) => {
    const name = binding === 'pnorm' ? 'pnorm' : 'stats' + binding + 'pnorm'
    const source = 'p <- ' + name + '(c(0,1))'
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [binding]
    }
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        '\x60' + binding + '\x60 <- replacement; ' + source
      )
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
})

describe('R primitive p-value adjustments', () => {
  it.each(['holm', 'hochberg', 'hommel', 'bonferroni', 'BH', 'BY', 'fdr', 'none'])(
    'propagates %s adjustment results through downstream differences',
    async (method) => {
      const source =
        'p <- c(0.01,0.04,0.2,0.8); adjusted <- stats::p.adjust(p,method="' +
        method +
        '"); delta <- diff(adjusted); write.csv(delta,"output.csv",row.names=FALSE)'
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        writes: ['output.csv']
      })
      const { facts } = await analyzeRNotebookSource(source)
      expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['adjusted', 'delta']))
      expect(facts.copyOnModifyNames).toContain('adjusted')
    }
  )
  it.each([
    'p.adjust(c(0.01,0.04))',
    'p.adjust(n=10,method="BH",p=c(0.01,0.04))',
    'stats::p.adjust(c(0.01,NA_real_,0.04),"holm",5)'
  ])('accepts default and exact reordered options: %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'result <- ' + call + '; delta <- diff(result)')
    ).toMatchObject({ readState: 'complete', writeState: 'complete' })
  })
  it('tracks separate input producers and stored adjustments across cells', async () => {
    const scripts = [
      'a <- scan("a.txt",what=numeric(),quiet=TRUE)',
      'b <- scan("b.txt",what=numeric(),quiet=TRUE)',
      'adjusted <- stats::p.adjust(c(a,b),method="BH")',
      'delta <- diff(adjusted); write.csv(delta,"output.csv",row.names=FALSE)'
    ]
    const current = await projectScripts('r', scripts, 'r-adjust-current-')
    expect(current.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(current.dependenciesByRunId?.['run-4']).toContain('run-3')
    const changed = await projectScripts('r', [...scripts, 'b <- c(0.1,0.3)'], 'r-adjust-changed-')
    expect(changed.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
  })
  it.each([
    'p.adjust(unknown)',
    'p.adjust(structure(c(0.1,0.2),class="sensor"))',
    'p.adjust(c(0.1,0.2),method=method)',
    'p.adjust(c(0.1,0.2),method="bh")',
    'p.adjust(c(0.1,0.2),method="bonf")',
    'p.adjust(c(0.1,0.2),meth="BH")',
    'p.adjust(c(0.1,0.2),method="BH",method="BY")',
    'p.adjust(c(0.1,0.2),extra=TRUE)',
    'p.adjust(c(0.1,0.2),n=count)',
    'p.adjust(c(0.1,0.2),n=-1)',
    'p.adjust(c(0.1,0.2),n=2.5)',
    'p.adjust(c(0.1,0.2),n=Inf)',
    'p.adjust(c(0.1,0.2),n=structure(3,class="count"))',
    'p.adjust(c(0.1,0.2),n=3,n=4)',
    'p.adjust()',
    'other::p.adjust(c(0.1,0.2))'
  ])('retains uncertain inputs and option expressions: %s', async (call) => {
    const source = 'adjusted <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
      'adjusted'
    )
  })
  it.each(['p.adjust', '::', ':::'])(
    'rejects earlier and local replacement of %s',
    async (binding) => {
      const call = binding === 'p.adjust' ? 'p.adjust' : 'stats' + binding + 'p.adjust'
      const source = 'result <- ' + call + '(c(0.1,0.2))'
      const context = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: [binding]
      }
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          '\x60' + binding + '\x60 <- replacement; ' + source
        )
      ).toMatchObject({ readState: 'partial', writeState: 'partial' })
    }
  )
  it('does not invent dependencies on internal coercion and ordering functions', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [
        'as.numeric',
        'as.double',
        'order',
        'cummin',
        'cummax',
        'p.adjust.methods'
      ]
    }
    const source = 'result <- stats::p.adjust(c(0.01,0.04,0.1),method="BH")'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    expect((await analyzeRNotebookSource(source, context)).facts.priorUsedNames).not.toContain(
      'as.numeric'
    )
  })
  it('does not certify unproven adjustment callbacks', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'result <- lapply(list(structure(c(0.1,0.2),class="sensor")),stats::p.adjust)'
      )
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
})

describe('R primitive median and ranks', () => {
  it.each([
    'stats::median(c(1,2,2,4))',
    'median(c(1,2,4))',
    'stats::median(c(1,NA_real_,4),na.rm=TRUE)',
    'median(na.rm=FALSE,x=c(1,2,4))',
    'rank(c(1,2,2,4))',
    'base::rank(c(1,2,2,4),ties.method="average")',
    'rank(c(1,2,2,4),ties.method="min")',
    'rank(c(1,NA_real_,4),na.last=FALSE)'
  ])('propagates a deterministic primitive result: %s', async (call) => {
    const source =
      'result <- ' +
      call +
      '; delta <- diff(c(result,1)); write.csv(delta,"output.csv",row.names=FALSE)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['output.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['result', 'delta']))
    expect(facts.copyOnModifyNames).toContain('result')
  })
  it('tracks file inputs and stored median/rank results across cells', async () => {
    const scripts = [
      'x <- scan("x.txt",what=numeric(),quiet=TRUE)',
      'm <- stats::median(x); ranks <- base::rank(x)',
      'gap <- diff(c(m,1)); span <- diff(range(ranks)); write.csv(c(gap,span),"output.csv",row.names=FALSE)'
    ]
    const current = await projectScripts('r', scripts, 'r-rank-median-current-')
    expect(current.dependenciesByRunId?.['run-2']).toContain('run-1')
    expect(current.dependenciesByRunId?.['run-3']).toContain('run-2')
    const changed = await projectScripts(
      'r',
      [...scripts, 'x <- c(1,4,7)'],
      'r-rank-median-changed-'
    )
    expect(changed.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
  })
  it.each([
    'median(unknown)',
    'median(structure(c(1,2),class="sensor"))',
    'median(c(1,2),na.rm=flag)',
    'median(c(1,2),na=TRUE)',
    'median(c(1,2),na.rm=TRUE,na.rm=FALSE)',
    'median(c(1,2),extra=1)',
    'other::median(c(1,2))',
    'rank(unknown)',
    'rank(structure(c(1,2),class="sensor"))',
    'rank(c(1,2),ties.method="random")',
    'rank(c(1,2),ties.method="ave")',
    'rank(c(1,2),ties.method=method)',
    'rank(c(1,2),na.last=flag)',
    'rank(c(1,2),na.last="last")',
    'rank(c(1,2),extra=1)',
    'rank(c(1,2),ties.method="first",ties.method="last")',
    'stats::rank(c(1,2))'
  ])('retains uncertainty for unsupported arguments and effects: %s', async (call) => {
    const source = 'result <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
      'result'
    )
  })
  it.each(['median', 'median.default', 'rank', '::', ':::'])(
    'respects earlier and local replacement of %s',
    async (binding) => {
      const call =
        binding === 'rank'
          ? 'rank(c(1,2))'
          : binding === ':::'
            ? 'stats:::median(c(1,2))'
            : binding === '::'
              ? 'stats::median(c(1,2))'
              : 'median(c(1,2))'
      const source = 'result <- ' + call
      const context = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: [binding]
      }
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          '\x60' + binding + '\x60 <- replacement; ' + source
        )
      ).toMatchObject({ readState: 'partial', writeState: 'partial' })
    }
  )
  it('records median default lookup but not internal global sort/mean lookup', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['sort', 'sort.default', 'mean', 'mean.default', 'is.na', 'sort.list']
    }
    const source = 'm <- stats::median(c(1,2,3,4)); r <- base::rank(c(1,2,2),ties.method="first")'
    const { facts } = await analyzeRNotebookSource(source, context)
    expect(facts.priorUsedNames).toContain('median.default')
    expect(facts.priorUsedNames).not.toContain('sort.default')
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
  })
  it.each(['stats::median', 'base::rank'])(
    'does not certify unproven callback arguments: %s',
    async (call) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          'result <- lapply(list(structure(c(1,2),class="sensor")),' + call + ')'
        )
      ).toMatchObject({ readState: 'partial', writeState: 'partial' })
    }
  )
})

describe('R primitive correlations', () => {
  it.each([
    'stats::cor(c(1,2,4),c(2,4,8))',
    'cor(c(1,2,4),c(2,4,8),method="pearson")',
    'stats::cor(c(1,2,2,4),c(1,3,2,4),method="spearman")',
    'stats::cor(c(1,2,2,4),c(1,3,2,4),method="kendall")',
    'stats::cov(c(1,2,2,4),c(1,3,2,4),method="spearman")',
    'stats::cov(c(1,2,2,4),c(1,3,2,4),method="kendall")',
    'cor(method="spearman",y=c(2,4,8),x=c(1,2,4))'
  ])('carries primitive result into downstream difference: %s', async (call) => {
    const source =
      'result <- ' +
      call +
      '; delta <- diff(c(result,1)); write.csv(delta,"output.csv",row.names=FALSE)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['output.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['result', 'delta']))
  })
  it.each(['spearman', 'kendall'])('supports exact NA policies for %s', async (method) => {
    for (const name of ['cor', 'cov'])
      for (const use of [
        'everything',
        'all.obs',
        'complete.obs',
        'na.or.complete',
        'pairwise.complete.obs'
      ]) {
        if (name === 'cov' && use === 'pairwise.complete.obs') continue
        const call =
          'stats::' + name + '(c(1,2,4),c(2,4,8),method="' + method + '",use="' + use + '")'
        expect(await analyzeNotebookSourceFileAccess('r', call)).toMatchObject({
          readState: 'complete',
          writeState: 'complete'
        })
      }
  })
  it('tracks both inputs and stored rank statistics across cells', async () => {
    const scripts = [
      'x <- scan("x.txt",what=numeric(),quiet=TRUE)',
      'y <- scan("y.txt",what=numeric(),quiet=TRUE)',
      'rho <- stats::cor(x,y,method="spearman"); tau <- stats::cor(x,y,method="kendall")',
      'gap <- diff(c(tau,rho)); write.csv(gap,"output.csv",row.names=FALSE)'
    ]
    const current = await projectScripts('r', scripts, 'r-correlation-current-')
    expect(current.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(current.dependenciesByRunId?.['run-4']).toContain('run-3')
    const changed = await projectScripts(
      'r',
      [...scripts, 'x <- c(1,3,5)'],
      'r-correlation-changed-'
    )
    expect(changed.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
  })
  it.each([
    'stats::cor(unknown,c(1,2))',
    'stats::cor(c(1,2),unknown)',
    'stats::cor(structure(c(1,2),class="sensor"),c(1,2),method="spearman")',
    'stats::cor(c(1,2),structure(c(1,2),class="sensor"))',
    'stats::cor(c(1,2),c(1,2),method=algorithm)',
    'stats::cor(c(1,2),c(1,2),method="spearm")',
    'stats::cor(c(1,2),c(1,2),use=policy)',
    'stats::cor(c(1,2),c(1,2),use="complete")',
    'stats::cor(c(1,2),c(1,2),method="pearson",method="kendall")',
    'stats::cor(c(1,2),c(1,2),na.rm=TRUE)',
    'stats::cor(c(1,2))',
    'stats::cor(matrix(1:6,ncol=2))',
    'stats::cov(c(1,2),c(1,2),method="spearman",use="pairwise.complete.obs")',
    'other::cor(c(1,2),c(1,2))'
  ])('retains uncertainty outside the direct primitive contract: %s', async (call) => {
    const source = 'result <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
      'result'
    )
  })
  it.each(['cor', '::', ':::'])(
    'rejects function or namespace replacement: %s',
    async (binding) => {
      const call = binding === 'cor' ? 'cor' : 'stats' + binding + 'cor'
      const source = 'result <- ' + call + '(c(1,2),c(2,4))'
      const context = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: [binding]
      }
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          '\x60' + binding + '\x60 <- replacement; ' + source
        )
      ).toMatchObject({ readState: 'partial', writeState: 'partial' })
    }
  )
  it('does not depend on global rank or NA-method replacements inside stats', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['rank', 'na.omit', 'na.omit.default', 'xtfrm.default']
    }
    const source = 'result <- stats::cor(c(1,2,4),c(2,4,8),method="spearman",use="complete.obs")'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    expect((await analyzeRNotebookSource(source, context)).facts.priorUsedNames).not.toContain(
      'rank'
    )
  })
  it('does not certify correlation aliases or callbacks globally', async () => {
    const source = 'result <- lapply(list(structure(c(1,2),class="sensor")),stats::cor)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
  })
})

describe('R primitive second moments', () => {
  it.each([
    'stats::sd(c(1,2,4))',
    'sd(c(1,NA_real_,4),na.rm=TRUE)',
    'stats::var(c(1,2,4))',
    'var(c(1,2,4),c(2,4,8))',
    'stats::var(na.rm=TRUE,x=c(1,NA_real_,4))',
    'stats::cov(c(1,2,4),c(2,4,8))',
    'cov(y=c(2,4,8),x=c(1,2,4),method="pearson")',
    'stats::cov(c(1,NA_real_,4),c(2,NA_real_,8),use="complete.obs")'
  ])('preserves primitive results through downstream calculations: %s', async (call) => {
    const source =
      'result <- ' +
      call +
      '; delta <- diff(c(result,1)); write.csv(delta,"output.csv",row.names=FALSE)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['output.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['result', 'delta']))
    expect(facts.copyOnModifyNames).toContain('result')
  })
  it('carries both covariance inputs and moments across cells', async () => {
    const scripts = [
      'x <- scan("x.txt",what=numeric(),quiet=TRUE)',
      'y <- scan("y.txt",what=numeric(),quiet=TRUE)',
      'moment <- stats::cov(x,y); scale <- stats::sd(x)',
      'delta <- diff(c(moment,scale)); write.csv(delta,"output.csv",row.names=FALSE)'
    ]
    const current = await projectScripts('r', scripts, 'r-moments-current-')
    expect(current.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(current.dependenciesByRunId?.['run-4']).toContain('run-3')
    const changed = await projectScripts('r', [...scripts, 'y <- c(1,2,3)'], 'r-moments-changed-')
    expect(changed.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(changed.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
  })
  it.each([
    'stats::sd(unknown)',
    'stats::sd(structure(c(1,2),class="sensor"))',
    'stats::sd(c(1,2),na.rm=remove_missing)',
    'stats::sd(c(1,2),na=TRUE)',
    'stats::sd(c(1,2),na.rm=TRUE,na.rm=FALSE)',
    'stats::var(unknown)',
    'stats::var(c(1,2),unknown)',
    'stats::var(c(1,2),use=mode)',
    'stats::var(c(1,2),use="complete")',
    'stats::var(c(1,2),method="pearson")',
    'stats::cov(unknown,c(1,2))',
    'stats::cov(c(1,2),unknown)',
    'stats::cov(c(1,2),structure(c(1,2),class="sensor"))',
    'stats::cov(c(1,2),c(1,2),method=method)',
    'stats::cov(c(1,2),c(1,2),method="p")',
    'stats::cov(c(1,2),c(1,2),use="invalid")',
    'stats::cov(c(1,2),c(1,2),na.rm=TRUE)',
    'other::sd(c(1,2))',
    'other::var(c(1,2))',
    'other::cov(c(1,2),c(1,2))'
  ])('retains unproven dispatch or options: %s', async (call) => {
    const source = 'result <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
      'result'
    )
  })
  it.each(['all.obs', 'complete.obs', 'pairwise.complete.obs', 'everything', 'na.or.complete'])(
    'accepts an exact missing-observation policy: %s',
    async (use) => {
      for (const name of ['var', 'cov'])
        expect(
          await analyzeNotebookSourceFileAccess(
            'r',
            'result <- stats::' + name + '(c(1,2),c(2,4),use="' + use + '")'
          )
        ).toMatchObject({ readState: 'complete', writeState: 'complete' })
    }
  )
  it.each(['sd', 'var', 'cov'])('honors function and namespace replacements: %s', async (name) => {
    for (const binding of [name, '::', ':::']) {
      const call = binding === name ? name : 'stats' + binding + name
      const source = 'result <- ' + call + (name === 'cov' ? '(c(1,2),c(2,4))' : '(c(1,2))')
      const context = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: [binding]
      }
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          '\x60' + binding + '\x60 <- replacement; ' + source
        )
      ).toMatchObject({ readState: 'partial', writeState: 'partial' })
    }
  })
  it('keeps internal variance/coercion lookup independent of global replacements', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['var', 'sqrt', 'as.double', 'as.matrix']
    }
    const source = 'result <- stats::sd(c(1,2,4)); other <- stats::cov(c(1,2),c(2,4))'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    const { facts } = await analyzeRNotebookSource(source, context)
    expect(facts.priorUsedNames).not.toContain('var')
    expect(facts.priorUsedNames).not.toContain('as.double')
  })
  it.each(['sd', 'var'])('does not certify a classed callback: %s', async (name) => {
    const source = 'result <- lapply(list(structure(c(1,2),class="sensor")),stats::' + name + ')'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
  })
})

describe('R primitive weighted summaries', () => {
  it.each([
    'stats::weighted.mean(c(1,2,4),c(1,2,1))',
    'weighted.mean(c(1,2,4))',
    'weighted.mean(na.rm=TRUE,w=c(1,2,1),c(1,2,4))',
    'stats::weighted.mean(c(1,NA_real_,4),c(1,2,1),na.rm=TRUE)',
    'stats::fivenum(c(1,2,4))',
    'fivenum(na.rm=FALSE,c(1,2,4))'
  ])('retains primitive results and complete export IO: %s', async (call) => {
    const source = 'result <- ' + call + '; write.csv(result,"output.csv",row.names=FALSE)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['output.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toContain('result')
    expect(facts.copyOnModifyNames).toContain('result')
  })
  it('carries both weighted inputs and stored hinges across cells', async () => {
    const scripts = [
      'values <- scan("values.txt",what=numeric(),quiet=TRUE)',
      'weights <- scan("weights.txt",what=numeric(),quiet=TRUE)',
      'average <- stats::weighted.mean(values,weights); hinges <- stats::fivenum(values)',
      'delta <- diff(hinges); write.csv(average+sum(delta),"output.csv",row.names=FALSE)'
    ]
    const current = await projectScripts('r', scripts, 'r-weighted-current-')
    expect(current.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(current.dependenciesByRunId?.['run-4']).toContain('run-3')
    const changed = await projectScripts(
      'r',
      [...scripts, 'weights <- c(1,2,3)'],
      'r-weighted-changed-'
    )
    expect(changed.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(changed.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
  })
  it.each([
    'stats::weighted.mean(unknown,c(1,2))',
    'stats::weighted.mean(c(1,2),unknown)',
    'stats::weighted.mean(structure(c(1,2),class="sensor"),c(1,2))',
    'stats::weighted.mean(c(1,2),structure(c(1,2),class="sensor"))',
    'stats::weighted.mean(c(1,2),c(1,2),TRUE)',
    'stats::weighted.mean(c(1,2),c(1,2),na=TRUE)',
    'stats::weighted.mean(c(1,2),c(1,2),na.rm=remove_missing)',
    'stats::weighted.mean(c(1,2),c(1,2),na.rm=NA)',
    'stats::weighted.mean(c(1,2),c(1,2),na.rm=FALSE,na.rm=TRUE)',
    'stats::weighted.mean(c(1,2),w=c(1,2),extra=1)',
    'stats::weighted.mean()',
    'stats::fivenum(unknown)',
    'stats::fivenum(structure(c(1,2),class="sensor"))',
    'stats::fivenum(c(1,2),na=TRUE)',
    'stats::fivenum(c(1,2),na.rm=remove_missing)',
    'stats::fivenum(c(1,2),na.rm=TRUE,na.rm=FALSE)',
    'other::weighted.mean(c(1,2),c(1,2))',
    'other::fivenum(c(1,2))'
  ])('retains unproven input or argument matching: %s', async (call) => {
    const source = 'result <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
      'result'
    )
  })
  it.each(['weighted.mean', 'fivenum'])(
    'honors function and namespace replacement: %s',
    async (name) => {
      for (const binding of [name, '::', ':::']) {
        const call = binding === name ? name : 'stats' + binding + name
        const source = 'result <- ' + call + '(c(1,2))'
        const context = {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          resolvedKernelNames: [binding]
        }
        expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
          readState: 'partial',
          writeState: 'partial'
        })
        expect(
          await analyzeNotebookSourceFileAccess(
            'r',
            '\x60' + binding + '\x60 <- replacement; ' + source
          )
        ).toMatchObject({ readState: 'partial', writeState: 'partial' })
      }
    }
  )
  it('tracks and invalidates the caller-visible weighted default', async () => {
    const source = 'result <- stats::weighted.mean(c(1,2),c(1,2))'
    expect((await analyzeRNotebookSource(source)).facts.priorUsedNames).toContain(
      'weighted.mean.default'
    )
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['weighted.mean.default']
    }
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect(
      await analyzeNotebookSourceFileAccess('r', 'weighted.mean.default <- replacement; ' + source)
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
  it('keeps fivenum internal methods independent of global replacements', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['sort.default', 'sort', 'is.na']
    }
    expect(
      await analyzeNotebookSourceFileAccess('r', 'result <- stats::fivenum(c(1,2,4))', context)
    ).toMatchObject({ readState: 'complete', writeState: 'complete' })
  })
  it.each(['weighted.mean', 'fivenum'])(
    'withdraws input evidence after class replacement: %s',
    async (name) => {
      const scripts = [
        'values <- scan("input.txt",what=numeric(),quiet=TRUE)',
        'class(values)<-"sensor"',
        'result <- stats::' + name + '(values)'
      ]
      const projection = await projectScripts('r', scripts, 'r-weighted-class-')
      expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    }
  )
})

describe('R primitive robust statistics boundaries', () => {
  it.each([
    'stats::mad(unknown)',
    'stats::mad(structure(c(1,2),class="sensor"))',
    'stats::mad(c(1,2),center=median(c(1,2)))',
    'stats::mad(c(1,2),center=structure(0,class="sensor"))',
    'stats::mad(c(1,2),constant=scale)',
    'stats::mad(c(1,2),na.rm=remove_missing)',
    'stats::mad(c(1,2),low=TRUE,high=TRUE)',
    'stats::mad(c(1,2),low={mad<-replacement; TRUE})',
    'stats::mad(c(1,2),center=0,center=1)',
    'stats::mad(c(1,2),con=1)',
    'stats::mad(c(1,2),type=7)',
    'stats::quantile(unknown)',
    'stats::quantile(c(1,2),probs=probabilities)',
    'stats::quantile(c(1,2),probs=structure(.5,class="prob"))',
    'stats::quantile(c(1,2),probs=c(-.1,.5))',
    'stats::quantile(c(1,2),probs=c(.5,1.1))',
    'stats::quantile(c(1,2),type=algorithm)',
    'stats::quantile(c(1,2),type=0)',
    'stats::quantile(c(1,2),type=10)',
    'stats::quantile(c(1,2),digits=0)',
    'stats::quantile(c(1,2),names=with_names)',
    'stats::quantile(c(1,2),na.rm=NA)',
    'stats::quantile(c(1,2),probs=.5,probs=.75)',
    'stats::quantile(c(1,2),pr=.5)',
    'stats::quantile(c(1,2),fuzz=0)',
    'other::mad(c(1,2))',
    'other::quantile(c(1,2))'
  ])('rejects unproven input or options: %s', async (call) => {
    const source = 'result <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
      'result'
    )
  })
  it.each(['mad', 'quantile'])('honors function and namespace replacement: %s', async (name) => {
    for (const binding of [name, '::', ':::']) {
      const call = binding === name ? name : 'stats' + binding + name
      const source = 'result <- ' + call + '(c(1,2,4))'
      const context = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: [binding]
      }
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
      const sameCell = '\x60' + binding + '\x60 <- replacement; ' + source
      expect(await analyzeNotebookSourceFileAccess('r', sameCell)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
    }
  })
  it('rejects an earlier quantile default method', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['quantile.default']
    }
    expect(
      await analyzeNotebookSourceFileAccess('r', 'q <- stats::quantile(c(1,2,4))', context)
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
  it.each([
    'stats::mad(c(1,2,4),center=-1,constant=1)',
    'mad(constant=1,c(1,2,4),0,FALSE,FALSE,TRUE)',
    'stats::quantile(c(1,2,4))',
    'stats::quantile(c(1,2,4),probs=c(0,1),type=1,digits=2)',
    'quantile(type=9,c(1,2,4),c(.25,.75),FALSE,FALSE)'
  ])('accepts bounded numeric options: %s', async (call) => {
    expect(await analyzeNotebookSourceFileAccess('r', 'result <- ' + call)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    expect((await analyzeRNotebookSource('result <- ' + call)).facts.rAtomicValueNames).toContain(
      'result'
    )
  })
  it('tracks the caller-visible default method rather than certifying it globally', async () => {
    const { facts } = await analyzeRNotebookSource('q <- stats::quantile(c(1,2,4))')
    expect(facts.priorUsedNames).toContain('quantile.default')
    expect(facts.safeCallNames).toContain('quantile.default')
  })
  it('keeps MAD lexical defaults independent of global replacements', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['median.default', 'sort.default', 'median']
    }
    expect(
      await analyzeNotebookSourceFileAccess('r', 'scale <- stats::mad(c(1,2,4))', context)
    ).toMatchObject({ readState: 'complete', writeState: 'complete' })
  })
  it.each(['mad', 'quantile'])(
    'does not retain primitive proof after class replacement: %s',
    async (name) => {
      const source =
        'values <- c(1,2,4); class(values)<-"sensor"; result <- stats::' + name + '(values)'
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
      expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
        'result'
      )
    }
  )
  it.each([
    'helper <- stats::quantile; q <- helper(c(1,2,4))',
    'q <- lapply(list(structure(c(1,2,4),class="sensor")),stats::quantile)'
  ])('does not grant generic quantile purity through a callback: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
  })
})

describe('R p-value adjustment primitive length counts', () => {
  it.each(['length(p)', 'base::length(x=p)', 'base:::length(c(p,p))', 'length(numeric())'])(
    'propagates a bounded count through differences and export: %s',
    async (count) => {
      const source =
        'p <- c(.01,.04,.2); adjusted <- stats::p.adjust(p,"BH",n=' +
        count +
        '); delta <- diff(adjusted); write.csv(delta,"out.csv")'
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        writes: ['out.csv']
      })
      const { facts } = await analyzeRNotebookSource(source)
      expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['adjusted', 'delta']))
      expect(facts.copyOnModifyNames).toContain('adjusted')
    }
  )
  it.each([
    'length(unknown)',
    'length(structure(p,class="sensor"))',
    'length(p)+1',
    'count',
    'length()',
    'length(p,p)',
    'length(x=p,x=p)',
    'length(value=p)',
    'other::length(p)'
  ])('retains unsupported counts: %s', async (count) => {
    const source = 'p <- c(.01,.04); adjusted <- stats::p.adjust(p,"BH",n=' + count + ')'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
      'adjusted'
    )
  })
  it.each(['length', '::', ':::'])('honors local and prior replacement of %s', async (binding) => {
    const name = binding === 'length' ? 'length' : 'base' + binding + 'length'
    const source = 'p <- c(.01,.04); adjusted <- p.adjust(p,"BH",n=' + name + '(p))'
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [binding]
    }
    for (const result of [
      await analyzeRNotebookSource(source, context),
      await analyzeRNotebookSource('\x60' + binding + '\x60 <- replacement; ' + source)
    ]) {
      expect(result.facts.rAtomicValueNames ?? []).not.toContain('adjusted')
    }
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
  })
  it('does not dispatch length.default for atomic input or resolve a qualified length through a bare binding', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['length', 'length.default']
    }
    const source =
      'p <- c(.01,.04); adjusted <- p.adjust(p,"BH",n=base::length(p)); delta <- diff(adjusted)'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    expect((await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames).toContain(
      'adjusted'
    )
  })
  it('invalidates downstream exports when the count input or length binding changes', async () => {
    const scripts = [
      'p <- scan("p.txt",what=numeric(),quiet=TRUE)',
      'adjusted <- stats::p.adjust(p,"BH",n=length(p))',
      'delta <- diff(adjusted); write.csv(delta,"out.csv")'
    ]
    const current = await projectScripts('r', scripts, 'r-count-current-')
    expect(current.dependenciesByRunId?.['run-2']).toContain('run-1')
    expect(current.dependenciesByRunId?.['run-3']).toContain('run-2')
    for (const [replacement, state] of [
      ['p <- c(.1,.2)', 'stale'],
      ['length <- function(x) 10L', 'unknown']
    ]) {
      const changed = await projectScripts('r', [...scripts, replacement], 'r-count-changed-')
      expect(changed.stalenessByRunId['run-3']).toMatchObject({ state })
      expect(changed.invalidatedByRunId['run-4']).toEqual(
        expect.arrayContaining([expect.objectContaining({ runId: 'run-3', state })])
      )
    }
  })
})

describe('Builtin replacement propagates to existing downstream results', () => {
  it.each(['r', 'python'] as const)(
    'marks transitive %s consumers unknown without tainting unrelated cells',
    async (language) => {
      const scripts =
        language === 'r'
          ? [
              'x <- c(1,2)',
              'n <- length(x)',
              'a <- n + 1',
              'b <- a + 1',
              'other <- 42',
              'length <- function(x) 10L'
            ]
          : [
              'x = [1,2]',
              'n = len(x)',
              'a = n + 1',
              'b = a + 1',
              'other = 42',
              'len = lambda x: 10'
            ]
      const result = await projectScripts(language, scripts, 'builtin-descendants-')
      for (const id of ['run-2', 'run-3', 'run-4']) {
        expect(result.stalenessByRunId[id]).toMatchObject({
          state: 'unknown',
          reasons: ['opaque-call']
        })
        expect(result.invalidatedByRunId['run-6']).toEqual(
          expect.arrayContaining([expect.objectContaining({ runId: id, state: 'unknown' })])
        )
      }
      expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
      expect(result.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
    }
  )
  it('preserves stale descendants when a builtin is rebound later', async () => {
    const result = await projectScripts(
      'r',
      ['x <- c(1,2)', 'n <- length(x)', 'a <- n + 1', 'x <- c(3,4,5)', 'length <- function(x) 10L'],
      'builtin-stale-'
    )
    expect(result.stalenessByRunId['run-3']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-4'
    })
  })
})

describe('R bounded vector scaling', () => {
  it.each([
    'scale(x)',
    'base::scale(x,center=TRUE,scale=FALSE)',
    'base:::scale(x,FALSE,TRUE)',
    'base::scale.default(x)',
    'scale.default(scale=10,center=70,x=x)',
    'scale(x,center=-1,scale=2)',
    'scale(x,center=FALSE,scale=FALSE)'
  ])('proves file effects and matrix ownership for %s', async (call) => {
    const source = 'x <- c(1,2,3); z <- ' + call + '; write.csv(z,"out.csv",row.names=FALSE)'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['out.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.copyOnModifyNames).toContain('z')
    expect(facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it.each([
    'scale(unknown)',
    'scale(structure(1:3,class="sensor"))',
    'scale(matrix(1:4,2))',
    'scale(c(1,2),center=option)',
    'scale(c(1,2),scale=option)',
    'scale(c(1,2),center=NA)',
    'scale(c(1,2),scale=Inf)',
    'scale(c(1,2),center=structure(0,class="sensor"))',
    'scale(c(1,2),cent=TRUE)',
    'scale(c(1,2),scale=TRUE,scale=FALSE)',
    'scale(c(1,2),extra=TRUE)',
    'other::scale(c(1,2))',
    'scale()'
  ])('keeps unproven inputs/options partial: %s', async (call) => {
    const source = 'z <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.copyOnModifyNames ?? []).not.toContain('z')
  })
  it.each([
    'scale.numeric',
    'scale.double',
    'scale.integer',
    'scale.default',
    'as.matrix.numeric',
    'as.matrix.double',
    'as.matrix.integer',
    'aperm.matrix',
    'aperm.array'
  ])('rejects an accessible S3 method replacement: %s', async (binding) => {
    const source = 'z <- base::scale(c(1,2,3))'
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [binding]
    }
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect(
      await analyzeNotebookSourceFileAccess('r', binding + ' <- replacement; ' + source)
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
  it.each(['scale', 'scale.default', '::', ':::'])(
    'rejects function/operator replacement: %s',
    async (binding) => {
      const name = binding === '::' || binding === ':::' ? 'base' + binding + 'scale' : binding
      const context = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: [binding]
      }
      expect(
        await analyzeNotebookSourceFileAccess('r', 'z <- ' + name + '(c(1,2,3))', context)
      ).toMatchObject({ readState: 'partial', writeState: 'partial' })
    }
  )
  it('keeps internal lexical functions/defaults independent of global bindings', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [
        'scale',
        'scale.default',
        'as.matrix',
        'as.matrix.default',
        'aperm',
        'aperm.default',
        'sweep',
        'apply',
        'colMeans'
      ]
    }
    const source = 'z <- base::scale.default(c(1,2,3)); write.csv(z,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    const { facts } = await analyzeRNotebookSource(source, context)
    expect(facts.priorUsedNames).toContain('aperm.matrix')
    expect(facts.priorUsedNames).not.toContain('as.matrix.default')
    expect(facts.priorUsedNames).not.toContain('scale.default')
  })
  it('tracks matrix producers and invalidates exports after input or method replacement', async () => {
    const scripts = [
      'x <- scan("in.txt",what=numeric(),quiet=TRUE)',
      'z <- base::scale(x)',
      'write.csv(z,"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'r-scale-current-')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    for (const [replacement, state] of [
      ['x <- c(3,4)', 'stale'],
      ['as.matrix.numeric <- function(x,...) x', 'unknown'],
      ['aperm.matrix <- function(a,...) a', 'unknown']
    ]) {
      const after = await projectScripts('r', [...scripts, replacement], 'r-scale-change-')
      expect(after.stalenessByRunId['run-3']).toMatchObject({ state })
    }
  })
  it('does not grant bounded scale proof to opaque aliases or callbacks', async () => {
    for (const source of [
      'f <- base::scale; z <- f(structure(1:3,class="sensor"))',
      'z <- lapply(list(structure(1:3,class="sensor")),base::scale)'
    ]) {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
    }
  })
})

describe('R bounded approximate equality and truth predicates', () => {
  it.each([
    'all.equal(x,y,check.attributes=FALSE)',
    'base::all.equal(x,y,tolerance=1e-10,check.attributes=FALSE)',
    'base:::all.equal(x,y,scale=1,check.attributes=FALSE)',
    'base::all.equal.numeric(x,y,tolerance=0,check.attributes=FALSE)',
    'all.equal.numeric(current=y,target=x,check.attributes=FALSE,countEQ=FALSE,giveErr=FALSE)'
  ])('propagates comparison and truth results through export: %s', async (call) => {
    const source =
      'x <- c(1,2,3);y <- c(1,2,3);comparison <- ' +
      call +
      ';ok <- isTRUE(comparison); different <- base::isFALSE(ok);write.csv(c(ok,different),"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['out.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toEqual(
      expect.arrayContaining(['comparison', 'ok', 'different'])
    )
    expect(facts.copyOnModifyNames).toContain('comparison')
  })
  it.each([
    'all.equal(c(1,2),c(1,2))',
    'all.equal(unknown,c(1),check.attributes=FALSE)',
    'all.equal(c(1),unknown,check.attributes=FALSE)',
    'all.equal(structure(1,class="sensor"),1,check.attributes=FALSE)',
    'all.equal(1,1,check.attributes=TRUE)',
    'all.equal(1,1,check.attributes=flag)',
    'all.equal(1,1,tolerance=tol,check.attributes=FALSE)',
    'all.equal(1,1,tolerance=Inf,check.attributes=FALSE)',
    'all.equal(1,1,tolerance=-1,check.attributes=FALSE)',
    'all.equal(1,1,scale=0,check.attributes=FALSE)',
    'all.equal(1,1,countEQ=TRUE,check.attributes=FALSE)',
    'all.equal(1,1,giveErr=TRUE,check.attributes=FALSE)',
    'all.equal(1,2,formatFUN=callback,check.attributes=FALSE)',
    'all.equal(1,1,check.attr=FALSE)',
    'all.equal(1,1,check.attributes=FALSE,check.attributes=FALSE)',
    'all.equal(1,1,1e-8,FALSE)',
    'other::all.equal(1,1,check.attributes=FALSE)'
  ])('keeps unsupported comparison options partial: %s', async (call) => {
    const source = 'comparison <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain(
      'comparison'
    )
  })
  it.each([
    'all.equal.numeric',
    'all.equal.double',
    'all.equal.integer',
    'all.equal.logical',
    'all.equal.character',
    'all.equal.raw',
    'all.equal.default',
    'format.numeric',
    'format.double'
  ])('tracks S3 dispatch and diagnostic formatting: %s', async (binding) => {
    const source = 'comparison <- all.equal(c(1,2),c(2,4),check.attributes=FALSE)'
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [binding]
    }
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect(
      await analyzeNotebookSourceFileAccess('r', binding + ' <- replacement; ' + source)
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
  it('keeps qualified numeric comparison independent of generic methods and internal defaults', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [
        'all.equal',
        'all.equal.numeric',
        'all.equal.default',
        'format',
        'format.default',
        'as.vector',
        'mean'
      ]
    }
    const source =
      'comparison <- base::all.equal.numeric(c(1,2),c(2,4),check.attributes=FALSE);ok <- isTRUE(comparison)'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    const { facts } = await analyzeRNotebookSource(source, context)
    expect(facts.priorUsedNames).toContain('format.numeric')
    expect(facts.priorUsedNames).not.toContain('format.default')
  })
  it.each([
    'isTRUE(TRUE)',
    'base::isFALSE(FALSE)',
    'isTRUE(c(TRUE,FALSE))',
    'isFALSE(NA)',
    'isTRUE("difference")',
    'isFALSE(NULL)'
  ])('proves ordinary truth predicates: %s', async (call) => {
    expect(await analyzeNotebookSourceFileAccess('r', 'ok <- ' + call)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    expect((await analyzeRNotebookSource('ok <- ' + call)).facts.rAtomicValueNames).toContain('ok')
  })
  it.each([
    'isTRUE(unknown)',
    'isFALSE(structure(FALSE,class="sensor"))',
    'isTRUE(TRUE,FALSE)',
    'isTRUE(value=TRUE)',
    'other::isTRUE(TRUE)'
  ])('rejects unproven predicate inputs: %s', async (call) => {
    expect(await analyzeNotebookSourceFileAccess('r', 'ok <- ' + call)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
  })
  it.each(['all.equal', 'all.equal.numeric', 'isTRUE', 'isFALSE', '::', ':::'])(
    'honors function and namespace replacement: %s',
    async (binding) => {
      const name = binding === '::' || binding === ':::' ? 'base' + binding + 'all.equal' : binding
      const args = binding.startsWith('is') ? 'TRUE' : '1,1,check.attributes=FALSE'
      const context = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: [binding]
      }
      expect(
        await analyzeNotebookSourceFileAccess('r', 'value <- ' + name + '(' + args + ')', context)
      ).toMatchObject({ readState: 'partial', writeState: 'partial' })
    }
  )
  it('invalidates stored checks and exports after input or formatter rebinding', async () => {
    const scripts = [
      'x <- scan("x.txt",what=numeric(),quiet=TRUE)',
      'y <- scan("y.txt",what=numeric(),quiet=TRUE)',
      'comparison <- all.equal(x,y,check.attributes=FALSE)',
      'ok <- isTRUE(comparison);write.csv(ok,"out.csv")'
    ]
    const result = await projectScripts('r', scripts, 'r-equal-current-')
    expect(result.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(result.dependenciesByRunId?.['run-4']).toContain('run-3')
    for (const [replacement, state] of [
      ['x <- c(4,5)', 'stale'],
      ['format.numeric <- function(x,...) "different"', 'unknown'],
      ['all.equal.numeric <- function(...) TRUE', 'unknown']
    ]) {
      const after = await projectScripts('r', [...scripts, replacement], 'r-equal-changed-')
      expect(after.stalenessByRunId['run-4']).toMatchObject({ state })
    }
  })
  it('withholds contracts from opaque comparison aliases and callbacks', async () => {
    for (const source of [
      'f <- base::all.equal; z <- f(unknown,unknown,check.attributes=FALSE)',
      'z <- lapply(list(structure(TRUE,class="sensor")),base::isTRUE)'
    ]) {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
    }
  })
})

describe('R bounded normal density and quantile calls', () => {
  it.each([
    'dnorm(x)',
    'stats::dnorm(x,mean=1,sd=2,log=TRUE)',
    'stats:::dnorm(x,0,1,FALSE)',
    'dnorm(sd=2,x=x,mean=-1)',
    'qnorm(p)',
    'stats::qnorm(p,mean=1,sd=2)',
    'stats:::qnorm(p,0,1,FALSE,FALSE)',
    'qnorm(p,lower.tail=FALSE)',
    'qnorm(c(-2,-1),log.p=TRUE)',
    'qnorm(p=pnorm(x))'
  ])('propagates bounded results to exports: %s', async (call) => {
    const source = 'x <- c(-1,0,1); p <- c(.1,.5,.9); z <- ' + call + '; write.csv(z,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['out.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toContain('z')
    expect(facts.copyOnModifyNames).toContain('z')
    expect(facts.priorUsedNames).toContain(call.slice(0, call.indexOf('(')).replace(':::', '::'))
  })
  it.each([
    'dnorm(unknown)',
    'qnorm(unknown)',
    'dnorm(structure(1,class="sensor"))',
    'qnorm(structure(.5,class="sensor"))',
    'dnorm(1,mean=location)',
    'qnorm(.5,sd=spread)',
    'dnorm(1,log=flag)',
    'qnorm(.5,lower.tail=flag)',
    'qnorm(.5,log.p=flag)',
    'dnorm(1,lo=TRUE)',
    'qnorm(.5,lower=TRUE)',
    'dnorm(1,mean=0,mean=1)',
    'dnorm(1,extra=callback())',
    'other::dnorm(1)',
    'other::qnorm(.5)'
  ])('keeps unproven arguments conservative: %s', async (call) => {
    const source = 'z <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it.each(['dnorm', 'qnorm', '::', ':::'])('honors replacement of %s', async (binding) => {
    const call =
      binding === 'dnorm'
        ? 'dnorm(1)'
        : binding === 'qnorm'
          ? 'qnorm(.5)'
          : 'stats' + binding + 'dnorm(1)'
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [binding]
    }
    expect(await analyzeNotebookSourceFileAccess('r', 'z <- ' + call, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect(
      await analyzeNotebookSourceFileAccess('r', '`' + binding + '` <- replacement; z <- ' + call)
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
  it('keeps qualified calls independent of globals and nonexistent S3 defaults', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [
        'dnorm',
        'qnorm',
        'dnorm.default',
        'qnorm.default',
        'dnorm.numeric',
        'qnorm.numeric'
      ]
    }
    const source =
      'd <- stats::dnorm(c(0,1));q <- stats::qnorm(c(.1,.5));write.csv(c(d,q),"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    const { facts } = await analyzeRNotebookSource(source, context)
    expect(facts.priorUsedNames).toEqual(expect.arrayContaining(['stats::dnorm', 'stats::qnorm']))
    expect(facts.priorUsedNames).not.toContain('dnorm.default')
  })
  it('preserves argument side effects', async () => {
    const io = await analyzeNotebookSourceFileAccess(
      'r',
      'z <- dnorm({writeLines("effect","side.txt");1})'
    )
    expect(io.writes).toContain('side.txt')
  })
  it('does not promote unproven aliases or callbacks', async () => {
    for (const source of [
      'f <- stats::dnorm;z <- f(unknown)',
      'f <- stats::qnorm;z <- f(unknown)',
      'z <- lapply(list(unknown),stats::dnorm)',
      'z <- lapply(list(unknown),stats::qnorm)'
    ]) {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
    }
  })
  it('tracks cross-cell producers and invalidates downstream exports', async () => {
    const scripts = [
      'x <- scan("in.txt",what=numeric(),quiet=TRUE)',
      'p <- pnorm(x);d <- dnorm(x)',
      'q <- qnorm(p)',
      'write.csv(c(d,q),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'normal-current-')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-2', 'run-3'])
    )
    expect(before.stalenessByRunId['run-4']).toMatchObject({ state: 'clear' })
    for (const [replacement, state] of [
      ['x <- c(2,3)', 'stale'],
      ['dnorm <- function(x) x', 'unknown'],
      ['qnorm <- function(p) p', 'unknown']
    ]) {
      const after = await projectScripts('r', [...scripts, replacement], 'normal-changed-')
      expect(after.stalenessByRunId['run-4']).toMatchObject({ state })
    }
  })
})

describe('R fitted normal distribution parameters', () => {
  it.each([
    'dnorm(x,mean=mean(x),sd=sd(x))',
    'stats::pnorm(x,mean=mu,sd=sigma)',
    'qnorm(c(.1,.5,.9),mean=mu,sd=sigma)',
    'stats:::dnorm(x,mean=mu+1,sd=sigma*2,log=TRUE)',
    'pnorm(x,mean=median(x),sd=sqrt(var(x)),lower.tail=FALSE)',
    'qnorm(c(-3,-2,-1),mean=mean(x),sd=sd(x),log.p=TRUE)'
  ])('retains proven fitted parameters: %s', async (call) => {
    const source =
      'x <- c(1,2,3);mu <- mean(x);sigma <- sd(x);z <- ' + call + ';write.csv(z,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['out.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toContain('z')
    expect(facts.copyOnModifyNames).toContain('z')
  })
  it.each([
    'mu <- unknown; z <- dnorm(1,mean=mu)',
    'sigma <- unknown; z <- qnorm(.5,sd=sigma)',
    'mu <- structure(0,class="sensor"); z <- pnorm(1,mean=mu)',
    'sigma <- structure(1,class="sensor"); z <- dnorm(1,sd=sigma)',
    'x <- structure(1:3,class="sensor"); z <- dnorm(1,mean=mean(x))',
    'z <- qnorm(.5,sd=sd(unknown))',
    'x <- c(1,2,3);mean <- replacement; z <- dnorm(x,mean=mean(x))',
    'x <- c(1,2,3);mean.default <- replacement; z <- pnorm(x,mean=mean(x))',
    'x <- c(1,2,3);sd <- replacement; z <- qnorm(.5,sd=sd(x))',
    'mu <- 0; mu <- unknown; z <- pnorm(1,mean=mu)',
    'mu <- 0; class(mu) <- "sensor"; z <- dnorm(1,mean=mu)',
    'mu <- 0; z <- dnorm(1,mean=mu,log=flag)'
  ])('withholds unproven parameter values: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it('records parameter effects even when the call cannot be certified', async () => {
    const io = await analyzeNotebookSourceFileAccess(
      'r',
      'z <- dnorm(1,mean={writeLines("effect","parameter.txt");0})'
    )
    expect(io.writes).toContain('parameter.txt')
    expect(io).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
  it('separates copy ownership from atomic parameter proof', async () => {
    const source = 'x <- c(1,2,3);sigma <- scale(x);z <- pnorm(x,sd=sigma)'
    expect((await analyzeRNotebookSource(source)).facts.copyOnModifyNames).toContain('sigma')
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain('z')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
  })
  it('tracks cross-cell fitted parameters and invalidates downstream export', async () => {
    const scripts = [
      'x <- scan("in.txt",what=numeric(),quiet=TRUE)',
      'mu <- mean(x);sigma <- sd(x)',
      'p <- pnorm(x,mean=mu,sd=sigma);d <- dnorm(x,mean=mu,sd=sigma)',
      'q <- qnorm(p,mean=mu,sd=sigma)',
      'write.csv(c(d,q),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'fitted-current-')
    expect(before.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-2', 'run-3'])
    )
    expect(before.stalenessByRunId['run-5']).toMatchObject({ state: 'clear' })
    for (const [replacement, state] of [
      ['mu <- 0', 'stale'],
      ['sigma <- 1', 'stale'],
      ['x <- c(3,4,5)', 'stale'],
      ['mean.default <- function(x,...) 0', 'unknown'],
      ['sd <- function(x) 1', 'unknown']
    ]) {
      const after = await projectScripts('r', [...scripts, replacement], 'fitted-changed-')
      expect(after.stalenessByRunId['run-5']).toMatchObject({ state })
    }
  })
})

describe('R bounded Student t distribution calls', () => {
  it.each([
    'dt(x,df=degrees)',
    'stats::dt(x,df=degrees,log=TRUE)',
    'stats:::dt(x,2,0,FALSE)',
    'dt(df=length(x)-1,x=x)',
    'pt(x,df=degrees)',
    'stats::pt(x,df=degrees,lower.tail=FALSE)',
    'pt(x,df=degrees,log.p=TRUE)',
    'pt(x,2,0,FALSE,FALSE)',
    'qt(c(.1,.5,.9),df=degrees)',
    'stats::qt(c(.1,.5,.9),df=degrees,ncp=0)',
    'qt(pt(x,df=degrees),df=degrees)',
    'qt(c(-3,-2,-1),df=degrees,log.p=TRUE)'
  ])('propagates bounded values to export: %s', async (call) => {
    const source = 'x <- c(-1,0,1);degrees <- length(x)-1;z <- ' + call + ';write.csv(z,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['out.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toContain('z')
    expect(facts.copyOnModifyNames).toContain('z')
    expect(facts.priorUsedNames).toContain(call.slice(0, call.indexOf('(')).replace(':::', '::'))
  })
  it.each([
    'dt(unknown,df=2)',
    'pt(unknown,df=2)',
    'qt(unknown,df=2)',
    'dt(1)',
    'qt(.5)',
    'pt(1,df=unknown)',
    'dt(structure(1,class="sensor"),df=2)',
    'pt(1,df=structure(2,class="sensor"))',
    'qt(.5,df=scale(c(1,2,3)))',
    'dt(1,df=2,ncp=1)',
    'pt(1,df=2,ncp=noncentrality)',
    'qt(.5,df=2,ncp=0+0)',
    'dt(1,df=2,log=flag)',
    'pt(1,df=2,lower.tail=flag)',
    'qt(.5,df=2,log.p=flag)',
    'dt(1,df=2,df=3)',
    'pt(1,df=2,lower=FALSE)',
    'qt(.5,df=2,extra=callback())',
    'other::pt(1,df=2)'
  ])('keeps unsupported arguments partial: %s', async (call) => {
    const source = 'z <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it.each(['dt', 'pt', 'qt', '::', ':::'])('honors replacement of %s', async (binding) => {
    const call =
      binding === '::' || binding === ':::'
        ? 'stats' + binding + 'pt(1,df=2)'
        : binding + '(1,df=2)'
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [binding]
    }
    expect(await analyzeNotebookSourceFileAccess('r', 'z <- ' + call, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect(
      await analyzeNotebookSourceFileAccess('r', '`' + binding + '` <- replacement;z <- ' + call)
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
  it('keeps qualified native functions independent of global bindings and S3 defaults', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [
        'dt',
        'pt',
        'qt',
        'dt.numeric',
        'pt.numeric',
        'qt.numeric',
        'dt.default',
        'pt.default',
        'qt.default'
      ]
    }
    const source =
      'd <- stats::dt(c(0,1),df=2);p <- stats::pt(c(0,1),df=2);q <- stats::qt(p,df=2);write.csv(c(d,q),"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    expect((await analyzeRNotebookSource(source, context)).facts.priorUsedNames).toEqual(
      expect.arrayContaining(['stats::dt', 'stats::pt', 'stats::qt'])
    )
  })
  it('records effects in inputs and degrees of freedom', async () => {
    for (const source of [
      'd <- dt({writeLines("effect","input.txt");1},df=2)',
      'p <- pt(1,df={writeLines("effect","degrees.txt");2})'
    ]) {
      const io = await analyzeNotebookSourceFileAccess('r', source)
      expect(io.writes.length).toBe(1)
    }
  })
  it('keeps aliases and callback calls conservative', async () => {
    for (const name of ['dt', 'pt', 'qt'])
      for (const source of [
        'f <- stats::' + name + ';z <- f(unknown,df=2)',
        'z <- lapply(list(unknown),stats::' + name + ')'
      ]) {
        expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
          readState: 'partial',
          writeState: 'partial'
        })
      }
  })
  it('tracks cross-cell input and degrees and invalidates exports', async () => {
    const scripts = [
      'x <- scan("in.txt",what=numeric(),quiet=TRUE)',
      'degrees <- length(x)-1',
      'd <- dt(x,df=degrees);p <- pt(x,df=degrees)',
      'q <- qt(p,df=degrees)',
      'write.csv(c(d,q),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'student-current-')
    expect(before.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-2', 'run-3'])
    )
    expect(before.stalenessByRunId['run-5']).toMatchObject({ state: 'clear' })
    for (const [replacement, state] of [
      ['x <- c(1,2,3)', 'stale'],
      ['degrees <- 10', 'stale'],
      ['pt <- function(...) .5', 'unknown'],
      ['dt <- function(...) 1', 'unknown'],
      ['qt <- function(...) 0', 'unknown']
    ]) {
      const after = await projectScripts('r', [...scripts, replacement], 'student-change-')
      expect(after.stalenessByRunId['run-5']).toMatchObject({ state })
    }
  })
})

describe('R bounded chi-square distribution calls', () => {
  it.each([
    'dchisq(x,df=degrees)',
    'stats::dchisq(x,df=degrees,log=TRUE)',
    'stats:::dchisq(x,2,0,FALSE)',
    'dchisq(df=length(x)-1,x=x)',
    'pchisq(x,df=degrees)',
    'stats::pchisq(x,df=degrees,lower.tail=FALSE)',
    'pchisq(x,df=degrees,log.p=TRUE)',
    'pchisq(x,2,0,FALSE,FALSE)',
    'qchisq(c(.1,.5,.9),df=degrees)',
    'stats::qchisq(c(.1,.5,.9),df=degrees,ncp=0)',
    'qchisq(pchisq(x,df=degrees),df=degrees)',
    'qchisq(c(-3,-2,-1),df=degrees,log.p=TRUE)'
  ])('propagates bounded values to export: %s', async (call) => {
    const source = 'x <- c(-1,0,1);degrees <- length(x)-1;z <- ' + call + ';write.csv(z,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['out.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toContain('z')
    expect(facts.copyOnModifyNames).toContain('z')
    expect(facts.priorUsedNames).toContain(call.slice(0, call.indexOf('(')).replace(':::', '::'))
  })
  it.each([
    'dchisq(unknown,df=2)',
    'pchisq(unknown,df=2)',
    'qchisq(unknown,df=2)',
    'dchisq(1)',
    'qchisq(.5)',
    'pchisq(1,df=unknown)',
    'dchisq(structure(1,class="sensor"),df=2)',
    'pchisq(1,df=structure(2,class="sensor"))',
    'qchisq(.5,df=scale(c(1,2,3)))',
    'dchisq(1,df=2,ncp=1)',
    'pchisq(1,df=2,ncp=noncentrality)',
    'qchisq(.5,df=2,ncp=0+0)',
    'dchisq(1,df=2,log=flag)',
    'pchisq(1,df=2,lower.tail=flag)',
    'qchisq(.5,df=2,log.p=flag)',
    'dchisq(1,df=2,df=3)',
    'pchisq(1,df=2,lower=FALSE)',
    'qchisq(.5,df=2,extra=callback())',
    'other::pchisq(1,df=2)'
  ])('keeps unsupported arguments partial: %s', async (call) => {
    const source = 'z <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it.each(['dchisq', 'pchisq', 'qchisq', '::', ':::'])(
    'honors replacement of %s',
    async (binding) => {
      const call =
        binding === '::' || binding === ':::'
          ? 'stats' + binding + 'pchisq(1,df=2)'
          : binding + '(1,df=2)'
      const context = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: [binding]
      }
      expect(await analyzeNotebookSourceFileAccess('r', 'z <- ' + call, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
      expect(
        await analyzeNotebookSourceFileAccess('r', '`' + binding + '` <- replacement;z <- ' + call)
      ).toMatchObject({ readState: 'partial', writeState: 'partial' })
    }
  )
  it('keeps qualified native functions independent of global bindings and S3 defaults', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [
        'dchisq',
        'pchisq',
        'qchisq',
        'dchisq.numeric',
        'pchisq.numeric',
        'qchisq.numeric',
        'dchisq.default',
        'pchisq.default',
        'qchisq.default'
      ]
    }
    const source =
      'd <- stats::dchisq(c(0,1),df=2);p <- stats::pchisq(c(0,1),df=2);q <- stats::qchisq(p,df=2);write.csv(c(d,q),"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    expect((await analyzeRNotebookSource(source, context)).facts.priorUsedNames).toEqual(
      expect.arrayContaining(['stats::dchisq', 'stats::pchisq', 'stats::qchisq'])
    )
  })
  it('records effects in inputs and degrees of freedom', async () => {
    for (const source of [
      'd <- dchisq({writeLines("effect","input.txt");1},df=2)',
      'p <- pchisq(1,df={writeLines("effect","degrees.txt");2})'
    ]) {
      const io = await analyzeNotebookSourceFileAccess('r', source)
      expect(io.writes.length).toBe(1)
    }
  })
  it('keeps aliases and callback calls conservative', async () => {
    for (const name of ['dchisq', 'pchisq', 'qchisq'])
      for (const source of [
        'f <- stats::' + name + ';z <- f(unknown,df=2)',
        'z <- lapply(list(unknown),stats::' + name + ')'
      ]) {
        expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
          readState: 'partial',
          writeState: 'partial'
        })
      }
  })
  it('tracks cross-cell input and degrees and invalidates exports', async () => {
    const scripts = [
      'x <- scan("in.txt",what=numeric(),quiet=TRUE)',
      'degrees <- length(x)-1',
      'd <- dchisq(x,df=degrees);p <- pchisq(x,df=degrees)',
      'q <- qchisq(p,df=degrees)',
      'write.csv(c(d,q),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'chisq-current-')
    expect(before.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-2', 'run-3'])
    )
    expect(before.stalenessByRunId['run-5']).toMatchObject({ state: 'clear' })
    for (const [replacement, state] of [
      ['x <- c(1,2,3)', 'stale'],
      ['degrees <- 10', 'stale'],
      ['pchisq <- function(...) .5', 'unknown'],
      ['dchisq <- function(...) 1', 'unknown'],
      ['qchisq <- function(...) 0', 'unknown']
    ]) {
      const after = await projectScripts('r', [...scripts, replacement], 'chisq-change-')
      expect(after.stalenessByRunId['run-5']).toMatchObject({ state })
    }
  })
})

describe('R bounded F distribution calls', () => {
  it.each([
    'df(x,df1=degrees1,df2=degrees2)',
    'stats::df(x,df1=degrees1,df2=degrees2,log=TRUE)',
    'stats:::df(x,4,6,0,FALSE)',
    'df(df2=degrees2,x=x,df1=length(x)+1)',
    'pf(x,df1=degrees1,df2=degrees2)',
    'stats::pf(x,df1=degrees1,df2=degrees2,lower.tail=FALSE)',
    'pf(x,df1=degrees1,df2=degrees2,log.p=TRUE)',
    'pf(x,4,6,0,FALSE,FALSE)',
    'qf(c(.1,.5,.9),df1=degrees1,df2=degrees2)',
    'stats::qf(c(.1,.5,.9),df1=degrees1,df2=degrees2,ncp=0)',
    'qf(pf(x,df1=degrees1,df2=degrees2),df1=degrees1,df2=degrees2)',
    'qf(c(-3,-2,-1),df1=degrees1,df2=degrees2,log.p=TRUE)'
  ])('propagates bounded results to exports: %s', async (call) => {
    const source =
      'x <- c(.8,1,1.2);degrees1 <- 4;degrees2 <- 6;z <- ' + call + ';write.csv(z,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['out.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toContain('z')
    expect(facts.copyOnModifyNames).toContain('z')
    expect(facts.priorUsedNames).toContain(call.slice(0, call.indexOf('(')).replace(':::', '::'))
  })
  it.each([
    'df(unknown,df1=2,df2=3)',
    'pf(unknown,df1=2,df2=3)',
    'qf(unknown,df1=2,df2=3)',
    'df(1,df1=2)',
    'qf(.5,df2=3)',
    'pf(1,df1=unknown,df2=3)',
    'df(structure(1,class="sensor"),df1=2,df2=3)',
    'pf(1,df1=2,df2=structure(3,class="sensor"))',
    'qf(.5,df1=scale(c(1,2,3)),df2=3)',
    'df(1,df1=2,df2=3,ncp=1)',
    'pf(1,df1=2,df2=3,ncp=noncentrality)',
    'qf(.5,df1=2,df2=3,ncp=0+0)',
    'df(1,df1=2,df2=3,log=flag)',
    'pf(1,df1=2,df2=3,lower.tail=flag)',
    'qf(.5,df1=2,df2=3,log.p=flag)',
    'df(1,df1=2,df2=3,df1=4)',
    'pf(1,df1=2,df2=3,lower=FALSE)',
    'qf(.5,df1=2,df2=3,extra=callback())',
    'other::pf(1,df1=2,df2=3)'
  ])('keeps unsupported calls partial: %s', async (call) => {
    const source = 'z <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it.each(['df', 'pf', 'qf', '::', ':::'])('honors replacement of %s', async (binding) => {
    const call =
      binding === '::' || binding === ':::'
        ? 'stats' + binding + 'pf(1,df1=2,df2=3)'
        : binding + '(1,df1=2,df2=3)'
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [binding]
    }
    expect(await analyzeNotebookSourceFileAccess('r', 'z <- ' + call, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect(
      await analyzeNotebookSourceFileAccess('r', '`' + binding + '` <- replacement;z <- ' + call)
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
  it('keeps qualified native calls independent of globals and S3 defaults', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [
        'df',
        'pf',
        'qf',
        'df.numeric',
        'pf.numeric',
        'qf.numeric',
        'df.default',
        'pf.default',
        'qf.default'
      ]
    }
    const source =
      'd <- stats::df(c(.8,1),df1=4,df2=6);p <- stats::pf(c(.8,1),df1=4,df2=6);q <- stats::qf(p,df1=4,df2=6);write.csv(c(d,q),"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    expect((await analyzeRNotebookSource(source, context)).facts.priorUsedNames).toEqual(
      expect.arrayContaining(['stats::df', 'stats::pf', 'stats::qf'])
    )
  })
  it('keeps an ordinary variable named df distinct from the qualified function', async () => {
    const source = 'df <- 4;d <- stats::df(c(.8,1),df1=df,df2=df+2);write.csv(d,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['df', 'd']))
    expect(facts.priorUsedNames).toContain('stats::df')
  })
  it('preserves effects in both degrees', async () => {
    for (const source of [
      'p <- pf(1,df1={writeLines("effect","numerator.txt");2},df2=3)',
      'p <- pf(1,df1=2,df2={writeLines("effect","denominator.txt");3})'
    ]) {
      expect((await analyzeNotebookSourceFileAccess('r', source)).writes.length).toBe(1)
    }
  })
  it('keeps aliases and callbacks conservative', async () => {
    for (const name of ['df', 'pf', 'qf'])
      for (const source of [
        'f <- stats::' + name + ';z <- f(unknown,df1=2,df2=3)',
        'z <- lapply(list(unknown),stats::' + name + ')'
      ]) {
        expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
          readState: 'partial',
          writeState: 'partial'
        })
      }
  })
  it('tracks both cross-cell degrees and invalidates dependent exports', async () => {
    const scripts = [
      'x <- scan("in.txt",what=numeric(),quiet=TRUE)',
      'degrees1 <- length(x)-1',
      'degrees2 <- length(x)+1',
      'd <- df(x,df1=degrees1,df2=degrees2);p <- pf(x,df1=degrees1,df2=degrees2)',
      'q <- qf(p,df1=degrees1,df2=degrees2)',
      'write.csv(c(d,q),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'fdist-current-')
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-1', 'run-2', 'run-3'])
    )
    expect(before.dependenciesByRunId?.['run-5']).toEqual(
      expect.arrayContaining(['run-2', 'run-3', 'run-4'])
    )
    expect(before.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    for (const [replacement, state] of [
      ['x <- c(1,2,3)', 'stale'],
      ['degrees1 <- 10', 'stale'],
      ['degrees2 <- 12', 'stale'],
      ['df <- function(...) 1', 'unknown'],
      ['pf <- function(...) .5', 'unknown'],
      ['qf <- function(...) 1', 'unknown']
    ]) {
      const after = await projectScripts('r', [...scripts, replacement], 'fdist-change-')
      expect(after.stalenessByRunId['run-6']).toMatchObject({ state })
    }
  })
})

describe('R bounded Gamma distribution calls', () => {
  it.each([
    'dgamma(x,shape=shape)',
    'stats::dgamma(x,shape=shape,rate=rate)',
    'stats:::dgamma(x,shape=shape,scale=scale_value,log=TRUE)',
    'dgamma(x,3,2)',
    'dgamma(x,shape=shape,scale=1/rate)',
    'pgamma(x,shape=shape,rate=rate)',
    'stats::pgamma(x,shape=shape,scale=scale_value,lower.tail=FALSE)',
    'pgamma(x,shape=shape,rate=rate,log.p=TRUE)',
    'qgamma(c(.1,.5,.9),shape=shape,rate=rate)',
    'stats::qgamma(c(.1,.5,.9),shape=shape,scale=scale_value)',
    'qgamma(pgamma(x,shape=shape,rate=rate),shape=shape,rate=rate)',
    'qgamma(c(-3,-2,-1),shape=shape,scale=scale_value,log.p=TRUE)',
    'dgamma(rate=rate,x=x,shape=shape)'
  ])('propagates fitted shape/rate or scale: %s', async (call) => {
    const source =
      'x <- c(1,2,3);shape <- mean(x)^2/var(x);rate <- mean(x)/var(x);scale_value <- 1/rate;z <- ' +
      call +
      ';write.csv(z,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['out.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toContain('z')
    expect(facts.copyOnModifyNames).toContain('z')
    expect(facts.priorUsedNames).toContain(call.slice(0, call.indexOf('(')).replace(':::', '::'))
  })
  it.each([
    'dgamma(unknown,shape=2)',
    'pgamma(unknown,shape=2)',
    'qgamma(unknown,shape=2)',
    'dgamma(1)',
    'qgamma(.5)',
    'pgamma(1,shape=unknown)',
    'dgamma(structure(1,class="sensor"),shape=2)',
    'pgamma(1,shape=structure(2,class="sensor"))',
    'qgamma(.5,shape=scale(c(1,2,3)))',
    'dgamma(1,shape=2,rate=unknown)',
    'pgamma(1,shape=2,scale=unknown)',
    'qgamma(.5,shape=2,rate=structure(1,class="sensor"))',
    'dgamma(1,shape=2,scale=structure(1,class="sensor"))',
    'dgamma(1,shape=2,rate=2,scale=.5)',
    'pgamma(1,shape=2,rate=2,scale=2)',
    'qgamma(.5,shape=2,rate=2,scale=.5)',
    'dgamma(1,shape=2,log=flag)',
    'pgamma(1,shape=2,lower.tail=flag)',
    'qgamma(.5,shape=2,log.p=flag)',
    'dgamma(1,shape=2,shape=3)',
    'pgamma(1,shape=2,lower=FALSE)',
    'qgamma(.5,shape=2,extra=callback())',
    'other::pgamma(1,shape=2)'
  ])('keeps unsupported parameters partial: %s', async (call) => {
    const source = 'z <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it.each(['dgamma', 'pgamma', 'qgamma', '::', ':::'])(
    'honors replacement of %s',
    async (binding) => {
      const call =
        binding === '::' || binding === ':::'
          ? 'stats' + binding + 'pgamma(1,shape=2)'
          : binding + '(1,shape=2)'
      const context = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: [binding]
      }
      expect(await analyzeNotebookSourceFileAccess('r', 'z <- ' + call, context)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
      expect(
        await analyzeNotebookSourceFileAccess('r', '`' + binding + '` <- replacement;z <- ' + call)
      ).toMatchObject({ readState: 'partial', writeState: 'partial' })
    }
  )
  it('keeps native/default-scale lookup independent of globals and nonexistent S3 defaults', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [
        'dgamma',
        'pgamma',
        'qgamma',
        'dgamma.numeric',
        'pgamma.default',
        'qgamma.default',
        '/',
        'missing'
      ]
    }
    const source =
      'd <- stats::dgamma(c(1,2),shape=2,rate=2);p <- stats::pgamma(c(1,2),shape=2,rate=2);q <- stats::qgamma(p,shape=2,rate=2);write.csv(c(d,q),"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    expect((await analyzeRNotebookSource(source, context)).facts.priorUsedNames).toEqual(
      expect.arrayContaining(['stats::dgamma', 'stats::pgamma', 'stats::qgamma'])
    )
  })
  it('walks shape/rate/scale effects even without a value proof', async () => {
    for (const source of [
      'p <- pgamma(1,shape={writeLines("effect","shape.txt");2})',
      'p <- pgamma(1,shape=2,rate={writeLines("effect","rate.txt");1})',
      'p <- pgamma(1,shape=2,scale={writeLines("effect","scale.txt");1})'
    ]) {
      expect((await analyzeNotebookSourceFileAccess('r', source)).writes.length).toBe(1)
    }
  })
  it('keeps aliases and callbacks conservative', async () => {
    for (const name of ['dgamma', 'pgamma', 'qgamma'])
      for (const source of [
        'f <- stats::' + name + ';z <- f(unknown,shape=2)',
        'z <- lapply(list(unknown),stats::' + name + ')'
      ]) {
        expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
          readState: 'partial',
          writeState: 'partial'
        })
      }
  })
  it('tracks cross-cell shape/rate and invalidates exports after either change', async () => {
    const scripts = [
      'x <- scan("in.txt",what=numeric(),quiet=TRUE)',
      'shape <- mean(x)^2/var(x)',
      'rate <- mean(x)/var(x)',
      'd <- dgamma(x,shape=shape,rate=rate);p <- pgamma(x,shape=shape,rate=rate)',
      'q <- qgamma(p,shape=shape,rate=rate)',
      'write.csv(c(d,q),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'gamma-current-')
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-1', 'run-2', 'run-3'])
    )
    expect(before.dependenciesByRunId?.['run-5']).toEqual(
      expect.arrayContaining(['run-2', 'run-3', 'run-4'])
    )
    expect(before.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    for (const [replacement, state] of [
      ['x <- c(1,2,3)', 'stale'],
      ['shape <- 4', 'stale'],
      ['rate <- 2', 'stale'],
      ['dgamma <- function(...) 1', 'unknown'],
      ['pgamma <- function(...) .5', 'unknown'],
      ['qgamma <- function(...) 1', 'unknown']
    ]) {
      const after = await projectScripts('r', [...scripts, replacement], 'gamma-change-')
      expect(after.stalenessByRunId['run-6']).toMatchObject({ state })
    }
  })
})

describe('R mean dispatch effect boundaries', () => {
  it.each([
    'mean(c(1,2,3))',
    'base::mean(c(1,2,3),trim=.1)',
    'base::mean.default(c(1,2,3))',
    'mean.default(c(1,2,3),na.rm=TRUE)'
  ])('preserves proven numeric computation: %s', async (call) => {
    const source = 'y <- ' + call + ';write.csv(y,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames).toContain('y')
  })
  it.each([
    'mean(unknown)',
    'base::mean(unknown)',
    'mean(structure(c(1,2),class="sensor"))',
    'base::mean(structure(c(1,2),class="sensor"))',
    'mean(c(1,2),trim=unknown)',
    'mean(c(1,2),na.rm=flag)',
    'other::mean(c(1,2))'
  ])('withholds generic purity and result ownership: %s', async (call) => {
    const source = 'y <- ' + call + ';write.csv(y,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.copyOnModifyNames ?? []).not.toContain('y')
    expect(facts.rAtomicValueNames ?? []).not.toContain('y')
  })
  it('does not certify a file-writing S3 method as complete', async () => {
    const source =
      'mean.sensor <- function(x,...) {writeLines("effect","hidden.txt");42};x <- structure(c(1,2,3),class="sensor");y <- mean(x);write.csv(y,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.state === 'unknown' ? facts.reasons : []).toContain('opaque-call')
  })
  it.each([
    'double',
    'numeric',
    'integer',
    'logical',
    'complex',
    'character',
    'raw',
    'NULL',
    'default'
  ])('records and guards the caller-visible mean.%s method', async (type) => {
    const binding = 'mean.' + type,
      source = 'y <- base::mean(c(1,2,3));write.csv(y,"out.csv")'
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [binding]
    }
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect(
      await analyzeNotebookSourceFileAccess('r', binding + ' <- replacement;' + source)
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
    expect((await analyzeRNotebookSource(source)).facts.priorUsedNames).toContain(binding)
  })
  it('keeps explicit base default independent of generic method overrides', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['mean', 'mean.default', 'mean.numeric', 'mean.double']
    }
    const source = 'y <- base::mean.default(c(1,2,3));write.csv(y,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    expect((await analyzeRNotebookSource(source, context)).facts.priorUsedNames).not.toContain(
      'mean.numeric'
    )
  })
  it('does not grant a pure callable contract through aliases or callbacks', async () => {
    for (const source of [
      'f <- base::mean;y <- f(unknown)',
      'f <- mean;y <- f(unknown)',
      'y <- lapply(list(unknown),base::mean)'
    ]) {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'partial',
        writeState: 'partial'
      })
    }
  })
  it('invalidates downstream exports after later numeric method rebinding', async () => {
    const scripts = [
      'x <- scan("in.txt",what=numeric(),quiet=TRUE)',
      'y <- mean(x)',
      'write.csv(y,"out.csv")'
    ]
    expect(
      (await projectScripts('r', scripts, 'mean-dispatch-current-')).stalenessByRunId['run-3']
    ).toMatchObject({ state: 'clear' })
    for (const binding of ['mean.numeric', 'mean.double', 'mean.default']) {
      const after = await projectScripts(
        'r',
        [...scripts, binding + ' <- function(...) 42'],
        'mean-dispatch-change-'
      )
      expect(after.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    }
  })
})

describe('R bounded Poisson distribution calls', () => {
  it.each([
    'dpois(x,lambda=lambda)',
    'stats::dpois(x,lambda=lambda,log=TRUE)',
    'stats:::dpois(x,lambda)',
    'dpois(lambda=lambda,x=x)',
    'ppois(x,lambda=lambda)',
    'stats::ppois(x,lambda=lambda,lower.tail=FALSE)',
    'ppois(x,lambda=lambda,log.p=TRUE)',
    'qpois(c(.1,.5,.9),lambda=lambda)',
    'stats::qpois(c(.1,.5,.9),lambda=lambda,lower.tail=FALSE)',
    'qpois(c(-3,-2,-1),lambda=lambda,log.p=TRUE)',
    'qpois(ppois(x,lambda=lambda),lambda=lambda)'
  ])('propagates ordinary counts and fitted lambda: %s', async (call) => {
    const source = 'x <- c(1,2,3);lambda <- mean(x);z <- ' + call + ';write.csv(z,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['out.csv']
    })
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames).toContain('z')
    expect(facts.copyOnModifyNames).toContain('z')
    expect(facts.priorUsedNames).toContain(call.slice(0, call.indexOf('(')).replace(':::', '::'))
  })
  it.each([
    'dpois(unknown,lambda=2)',
    'ppois(unknown,lambda=2)',
    'qpois(unknown,lambda=2)',
    'dpois(1)',
    'ppois(1,lambda=unknown)',
    'qpois(.5,lambda=unknown)',
    'dpois(structure(1,class="sensor"),lambda=2)',
    'ppois(1,lambda=structure(2,class="sensor"))',
    'qpois(.5,lambda=scale(c(1,2,3)))',
    'dpois(1,lambda=2,log=flag)',
    'ppois(1,lambda=2,lower.tail=flag)',
    'qpois(.5,lambda=2,log.p=flag)',
    'dpois(1,lambda=2,lambda=3)',
    'ppois(1,lam=2)',
    'qpois(.5,lambda=2,lower=FALSE)',
    'dpois(1,lambda=2,extra=callback())',
    'other::ppois(1,lambda=2)'
  ])('keeps unsupported inputs partial: %s', async (call) => {
    const source = 'z <- ' + call
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it.each(['dpois', 'ppois', 'qpois', '::', ':::'])('honors replacement of %s', async (binding) => {
    const call =
      binding === '::' || binding === ':::'
        ? 'stats' + binding + 'ppois(1,lambda=2)'
        : binding + '(1,lambda=2)'
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [binding]
    }
    expect(await analyzeNotebookSourceFileAccess('r', 'z <- ' + call, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
    expect(
      await analyzeNotebookSourceFileAccess('r', '`' + binding + '` <- replacement;z <- ' + call)
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
  it('keeps qualified native lookup independent of caller-visible defaults', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [
        'dpois',
        'ppois',
        'qpois',
        'dpois.numeric',
        'ppois.default',
        'qpois.default'
      ]
    }
    const source =
      'd <- stats::dpois(c(1,2),lambda=2);p <- stats::ppois(c(1,2),lambda=2);q <- stats::qpois(p,lambda=2);write.csv(c(d,q),"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    expect((await analyzeRNotebookSource(source, context)).facts.priorUsedNames).toEqual(
      expect.arrayContaining(['stats::dpois', 'stats::ppois', 'stats::qpois'])
    )
  })
  it('preserves argument effects and conservative aliases', async () => {
    for (const call of [
      'dpois({writeLines("effect","count.txt");1},lambda=2)',
      'ppois(1,lambda={writeLines("effect","lambda.txt");2})'
    ])
      expect((await analyzeNotebookSourceFileAccess('r', 'z <- ' + call)).writes.length).toBe(1)
    for (const name of ['dpois', 'ppois', 'qpois'])
      for (const source of [
        'f <- stats::' + name + ';z <- f(unknown,lambda=2)',
        'z <- lapply(list(unknown),stats::' + name + ')'
      ])
        expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
          readState: 'partial',
          writeState: 'partial'
        })
  })
  it('tracks independent lambda and count producers through downstream export', async () => {
    const scripts = [
      'x <- scan("in.txt",what=numeric(),quiet=TRUE)',
      'lambda <- mean(x)',
      'd <- dpois(x,lambda=lambda);p <- ppois(x,lambda=lambda)',
      'q <- qpois(p,lambda=lambda)',
      'write.csv(c(d,q),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'poisson-current-')
    expect(before.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-2', 'run-3'])
    )
    expect(before.stalenessByRunId['run-5']).toMatchObject({ state: 'clear' })
    for (const [replacement, state] of [
      ['x <- c(2,3,4)', 'stale'],
      ['lambda <- 3', 'stale'],
      ['dpois <- function(...) 1', 'unknown'],
      ['ppois <- function(...) .5', 'unknown'],
      ['qpois <- function(...) 1', 'unknown']
    ]) {
      const after = await projectScripts('r', [...scripts, replacement], 'poisson-change-')
      expect(after.stalenessByRunId['run-5']).toMatchObject({ state })
    }
  })
})

describe('R bounded CSV atomic columns', () => {
  it.each([
    'df <- read.csv("in.csv");x <- df$x',
    'df <- utils::read.csv("in.csv",check.names=FALSE);x <- df[["x"]]',
    'df <- utils:::read.csv(file="in.csv");x <- df[[1]]',
    'x <- read.csv("in.csv")$x',
    'df <- read.csv("in.csv",stringsAsFactors=FALSE);x <- df$x',
    'df <- read.csv("in.csv",as.is=TRUE);x <- df$x',
    'df <- read.csv("in.csv",colClasses="numeric");x <- df$x',
    'df <- read.csv("in.csv",colClasses=c("integer","character"));x <- df$x',
    'df <- read.csv("in.csv",colClasses="double");other <- df;x <- other$x'
  ])('proves ordinary columns and scientific results: %s', async (source) => {
    const script = source + ';z <- mean(x);ok <- is.finite(x);write.csv(z,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['in.csv'],
      writes: ['out.csv']
    })
    const { facts } = await analyzeRNotebookSource(script)
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['x', 'z', 'ok']))
  })
  it.each([
    'read.csv("in.csv",stringsAsFactors=TRUE)',
    'read.csv("in.csv",stringsAsFactors=flag)',
    'read.csv("in.csv",as.is=FALSE)',
    'read.csv("in.csv",as.is=flag)',
    'read.csv("in.csv",colClasses="factor")',
    'read.csv("in.csv",colClasses="Date")',
    'read.csv("in.csv",colClasses="POSIXct")',
    'read.csv("in.csv",colClasses="list")',
    'read.csv("in.csv",colClasses=classes)',
    'read.csv("in.csv",colClasses=c("numeric","Date"))',
    'read.csv("in.csv",colClasses={callback();"numeric"})',
    'read.csv("in.csv",stringsAsFactors=FALSE,stringsAsFactors=FALSE)',
    'read.csv("in.csv",stringsAs=FALSE)',
    'other::read.csv("in.csv")',
    'readRDS("in.rds")'
  ])('withholds atomic proof for unproven readers/options: %s', async (reader) => {
    const source = 'df <- ' + reader + ';x <- df$x;z <- mean(x)'
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain('x')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial'
    })
  })
  it.each([
    'df <- readRDS("in.rds")',
    'df$x <- structure(1,class="sensor")',
    'class(df) <- "sensor"',
    'attr(df,"class") <- "sensor"',
    'if(flag) df$x <- structure(1,class="sensor")',
    'unknown(df)',
    'f <- function() { df <- read.csv("other.csv") };df <- unknown',
    'eval(expr)',
    'source("script.R")',
    'assign("df",readRDS("in.rds"))',
    'load("data.RData")'
  ])('invalidates local column proof after %s', async (change) => {
    const source = 'df <- read.csv("in.csv");' + change + ';x <- df$x;z <- mean(x)'
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain('x')
  })
  it.each([
    'read.csv',
    '::',
    ':::',
    '$',
    '$.data.frame',
    '$.default',
    '[[',
    '[[.data.frame',
    '[[.default'
  ])('guards reader/extraction identity %s', async (binding) => {
    const extraction = binding.startsWith('[[') ? 'df[["x"]]' : 'df$x'
    const reader =
      binding === '::' || binding === ':::'
        ? 'utils' + binding + 'read.csv("in.csv")'
        : 'read.csv("in.csv")'
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: [binding]
    }
    const source = 'df <- ' + reader + ';x <- ' + extraction + ';z <- mean(x)'
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('x')
  })
  it('never upgrades a data frame root to an atomic vector after column replacement', async () => {
    const source = 'df <- read.csv("in.csv");df[["x"]] <- 1;z <- mean(df)'
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.rAtomicValueNames ?? []).not.toContain('df')
    expect(facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it('does not leak a function-local reader into the enclosing scope', async () => {
    const source = 'f <- function() { df <- read.csv("in.csv");df$x };x <- df$x;z <- mean(x)'
    expect((await analyzeRNotebookSource(source)).facts.rAtomicValueNames ?? []).not.toContain('x')
  })
  it('does not infer table columns from copy ownership or a prior-cell reader alone', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      rCopyOnModifyNames: ['df']
    }
    expect(
      (await analyzeRNotebookSource('x <- df$x;z <- mean(x)', context)).facts.rAtomicValueNames ??
        []
    ).not.toContain('x')
  })
  it('retains reader effects and implicit extraction dependencies', async () => {
    const source = 'df <- read.csv("in.csv");x <- df$x;z <- mean(x);write.csv(z,"out.csv")'
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.priorUsedNames).toEqual(
      expect.arrayContaining(['read.csv', '$', '$.data.frame', '$.default'])
    )
  })
  it('propagates extracted vectors across cells and invalidates downstream exports', async () => {
    const scripts = [
      'df <- read.csv("in.csv");x <- df$x',
      'z <- mean(x);s <- sd(x);ok <- is.finite(x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-columns-current-')
    expect(before.dependenciesByRunId?.['run-2']).toContain('run-1')
    expect(before.stalenessByRunId['run-3']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['x <- c(2,3)', 'stale'],
      ['mean <- function(...) 1', 'unknown'],
      ['`$.data.frame` <- function(...) structure(1,class="sensor")', 'unknown']
    ]) {
      const after = await projectScripts('r', [...scripts, change], 'csv-columns-change-')
      expect(after.stalenessByRunId['run-3']).toMatchObject({ state })
    }
  })
})

describe('R cross-cell CSV table evidence', () => {
  const empty = { staticStrings: [], staticCollections: [], localFileWrappers: [] }
  const contextFor = async (
    scripts: string[]
  ): Promise<ReturnType<typeof projectNotebookFileContext>> => {
    const entries: FileContextEntry[] = []
    for (const script of scripts) {
      const context = projectNotebookFileContext('r', entries)
      const { facts } = await analyzeRNotebookSource(script, context)
      entries.push({ facts, fileContext: empty })
    }
    return projectNotebookFileContext('r', entries)
  }
  it.each([
    'df <- read.csv("in.csv")',
    'df <- utils::read.csv("in.csv",check.names=FALSE)',
    'df <- read.csv("in.csv",stringsAsFactors=FALSE)',
    'df <- read.csv("in.csv",colClasses="numeric")',
    'df <- read.csv("in.csv",as.is=TRUE)'
  ])('carries proven table names through file context: %s', async (reader) => {
    const context = await contextFor([reader])
    expect(context).toMatchObject({ rAtomicTableNames: ['df'] })
    for (const extraction of ['df$x', 'df[["x"]]', 'df[[1]]']) {
      const source =
        'x <- ' + extraction + ';z <- mean(x);ok <- is.finite(x);write.csv(z,"out.csv")'
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete'
      })
    }
  })
  it.each([
    'df <- read.csv("in.csv",stringsAsFactors=TRUE)',
    'df <- read.csv("in.csv",colClasses="Date")',
    'df <- read.csv("in.csv",colClasses=classes)',
    'if(flag) df <- read.csv("in.csv")',
    'df <- readRDS("in.rds")'
  ])('does not promote unsupported readers: %s', async (reader) => {
    const context = await contextFor([reader])
    expect(
      await analyzeNotebookSourceFileAccess('r', 'x <- df$x;z <- mean(x)', context)
    ).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })
  it.each([
    'df <- readRDS("x.rds")',
    'df$x <- structure(1,class="sensor")',
    'df[["x"]] <- structure(1,class="sensor")',
    'class(df) <- "sensor"',
    'attr(df,"class") <- "sensor"',
    'if(flag) df$x <- structure(1,class="sensor")',
    'unknown(df)',
    'eval(expr)',
    'source("script.R")',
    'load("data.RData")',
    'assign("df",readRDS("x.rds"))',
    'rm(df)'
  ])('withdraws table evidence after %s', async (change) => {
    const context = await contextFor(['df <- read.csv("in.csv")', change])
    expect((context as { rAtomicTableNames?: string[] })?.rAtomicTableNames ?? []).not.toContain(
      'df'
    )
    expect(
      (await analyzeRNotebookSource('x <- df$x;z <- mean(x)', context)).facts.rAtomicValueNames ??
        []
    ).not.toContain('x')
  })
  it.each(['$', '$.data.frame', '$.default', '[[', '[[.data.frame', '[[.default'])(
    'honors extraction method replacement across cells: %s',
    async (method) => {
      const context = await contextFor([
        'df <- read.csv("in.csv")',
        '`' + method + '` <- function(...) structure(1,class="sensor")'
      ])
      const extraction = method.startsWith('[[') ? 'df[["x"]]' : 'df$x'
      expect(
        (await analyzeRNotebookSource('x <- ' + extraction + ';z <- mean(x)', context)).facts
          .rAtomicValueNames ?? []
      ).not.toContain('x')
    }
  )
  it('preserves ordinary value aliases without tying copies to later root changes', async () => {
    const context = await contextFor([
      'df <- read.csv("in.csv")',
      'alias <- df',
      'df <- readRDS("x.rds")'
    ])
    expect(context).toMatchObject({ rAtomicTableNames: ['alias'] })
    expect(
      await analyzeNotebookSourceFileAccess('r', 'x <- alias$x;z <- mean(x)', context)
    ).toMatchObject({ readState: 'complete', writeState: 'complete' })
  })
  it('retains table evidence through unrelated runs but never treats a whole table as an atomic vector', async () => {
    const context = await contextFor(['df <- read.csv("in.csv")', 'threshold <- 2'])
    expect(context).toMatchObject({ rAtomicTableNames: ['df'] })
    expect(
      (await analyzeRNotebookSource('z <- mean(df)', context)).facts.rAtomicValueNames ?? []
    ).not.toContain('z')
  })
  it('drops history at an unavailable entry and can reestablish evidence later', async () => {
    const { facts } = await analyzeRNotebookSource('df <- read.csv("in.csv")')
    const context = projectNotebookFileContext('r', [{ facts, fileContext: empty }, undefined])
    expect((context as { rAtomicTableNames?: string[] })?.rAtomicTableNames ?? []).not.toContain(
      'df'
    )
    expect(
      projectNotebookFileContext('r', [
        { facts, fileContext: empty },
        undefined,
        { facts, fileContext: empty }
      ])
    ).toMatchObject({ rAtomicTableNames: ['df'] })
  })
  it('keeps producer dependencies and invalidates scientific exports', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'x <- df$x',
      'mu <- mean(x);s <- sd(x)',
      'write.csv(c(mu,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-table-current-')
    expect(before.dependenciesByRunId?.['run-2']).toContain('run-1')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(before.stalenessByRunId['run-4']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("new.csv")', 'stale'],
      ['x <- c(2,3)', 'stale'],
      ['`$.data.frame` <- function(...) structure(1,class="sensor")', 'unknown']
    ]) {
      const after = await projectScripts('r', [...scripts, change], 'csv-table-change-')
      expect(after.stalenessByRunId['run-4']).toMatchObject({ state })
    }
  })
  it.each([null, 'df', [1], Array.from({ length: 513 }, (_, i) => 'table' + i)])(
    'rejects malformed cached table evidence %j',
    async (invalid) => {
      const root = await mkdtemp(join(tmpdir(), 'csv-table-invalid-cache-'))
      temporaryRoots.push(root)
      const runs = [
        completedRun('run-1', 'cell-1', 'r', 'df <- read.csv("in.csv")'),
        completedRun('run-2', 'cell-2', 'r', 'alias <- df')
      ]
      const options = {
        storageRoot: root,
        repository: { readSessionRuns: vi.fn(async () => runs) }
      }
      const query = {
        projectId: 'project',
        sessionId: 'r',
        currentRunId: 'run-3',
        language: 'r' as const,
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      }
      expect(
        await new NotebookDependencyAnalyzer(options).sourceFileAccessContext(query)
      ).toMatchObject({ rAtomicTableNames: ['alias', 'df'] })
      const path = join(root, 'notebooks', 'project', 'r', 'cache', 'dependency-analysis.json')
      const cache = JSON.parse(await readFile(path, 'utf8'))
      for (const runId of ['run-1', 'run-2']) cache.runs[runId].facts.rAtomicTableNames = invalid
      await writeFile(path, JSON.stringify(cache))
      expect(
        await new NotebookDependencyAnalyzer(options).sourceFileAccessContext(query)
      ).toMatchObject({ rAtomicTableNames: ['alias', 'df'] })
      const repaired = JSON.parse(await readFile(path, 'utf8'))
      expect(repaired.runs['run-1'].facts.rAtomicTableNames).toEqual(['df'])
      expect(repaired.runs['run-2'].facts.rAtomicTableNames).toEqual(['alias'])
    }
  )
  it('restores bounded facts from the persisted cache and isolates a fresh epoch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'csv-table-cache-'))
    temporaryRoots.push(root)
    let runs = [completedRun('run-1', 'cell-1', 'r', 'df <- read.csv("in.csv")')]
    const options = { storageRoot: root, repository: { readSessionRuns: vi.fn(async () => runs) } }
    const first = new NotebookDependencyAnalyzer(options)
    const query = {
      projectId: 'project',
      sessionId: 'r',
      currentRunId: 'run-2',
      language: 'r' as const,
      environment: 'default-r',
      kernelEpochId: 'epoch-1'
    }
    const before = await first.sourceFileAccessContext(query)
    expect(before).toMatchObject({ rAtomicTableNames: ['df'] })
    const restored = new NotebookDependencyAnalyzer(options)
    expect(await restored.sourceFileAccessContext(query)).toEqual(before)
    expect(
      (
        (await restored.sourceFileAccessContext({ ...query, kernelEpochId: 'epoch-2' })) as {
          rAtomicTableNames?: string[]
        }
      )?.rAtomicTableNames ?? []
    ).not.toContain('df')
    runs = [{ ...runs[0]!, status: 'failed' }]
    expect(
      ((await restored.sourceFileAccessContext(query)) as { rAtomicTableNames?: string[] })
        ?.rAtomicTableNames ?? []
    ).not.toContain('df')
  })
})

describe('R bounded CSV dataframe subsets', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    'df[,"x"]',
    'df[,1]',
    'df[,"x",drop=TRUE]',
    'df[1:3,"x"]',
    'df[c(TRUE,FALSE),"x"]',
    'df[df$x>2,"x"]',
    'df[is.finite(df$x),1,drop=TRUE]'
  ])('proves a single atomic column: %s', async (selection) => {
    const source = 'x <- ' + selection + ';z <- mean(x);write.csv(z,"out.csv")'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    expect((await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames).toEqual(
      expect.arrayContaining(['x', 'z'])
    )
  })
  it.each([
    'df["x"]',
    'df[c("x","y")]',
    'df[]',
    'df[,"x",drop=FALSE]',
    'df[,1,drop=FALSE]',
    'df[1:3,,drop=FALSE]',
    'df[df$x>2,,drop=FALSE]',
    'df[,c("x","y"),drop=FALSE]'
  ])('preserves table proof through %s', async (selection) => {
    const source = 'selected <- ' + selection + ';x <- selected$x;z <- mean(x)'
    const { facts } = await analyzeRNotebookSource(source, context)
    expect(facts.rAtomicTableNames).toContain('selected')
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['x', 'z']))
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete'
    })
    expect(
      (await analyzeRNotebookSource('selected <- ' + selection + ';z <- mean(selected)', context))
        .facts.rAtomicValueNames ?? []
    ).not.toContain('z')
  })
  it.each([
    'df[,column]',
    'df[rows,"x"]',
    'df[structure(1,class="sensor"),"x"]',
    'df[,structure(1,class="sensor")]',
    'df[,c("x","y")]',
    'df[1,c("x","y"),drop=TRUE]',
    'df[,0]',
    'df[,-1]',
    'df[,"x",drop=flag]',
    'df[,"x",dr=TRUE]',
    'df[,"x",drop=TRUE,drop=FALSE]',
    'df[i=1,j="x"]',
    'df["x",drop=TRUE]',
    'df[,"x",exact=TRUE]'
  ])('withholds ambiguous or unsupported subset proof: %s', async (selection) => {
    const { facts } = await analyzeRNotebookSource('x <- ' + selection + ';z <- mean(x)', context)
    expect(facts.rAtomicValueNames ?? []).not.toContain('x')
    expect(facts.rAtomicTableNames ?? []).not.toContain('x')
  })
  it.each([
    '[',
    '[.data.frame',
    '[.default',
    'names.data.frame',
    'names.default',
    'length.data.frame',
    'length.default'
  ])('honors replaced subset identity %s', async (method) => {
    const changed = { ...context, resolvedKernelNames: [method] }
    for (const selection of ['df[,"x"]', 'df["x"]', 'df[,"x",drop=FALSE]']) {
      const { facts } = await analyzeRNotebookSource(
        'selected <- ' + selection + ';x <- selected$x;z <- mean(x)',
        changed
      )
      expect(facts.rAtomicValueNames ?? []).not.toContain('selected')
      expect(facts.rAtomicTableNames ?? []).not.toContain('selected')
    }
  })
  it.each(['names.data.frame', 'length.data.frame'])(
    'never certifies a direct export with replaced internal method %s',
    async (method) => {
      const source = 'x <- df[,"x"];write.csv(x,"out.csv")'
      expect(
        await analyzeNotebookSourceFileAccess('r', source, {
          ...context,
          resolvedKernelNames: ['df', method]
        })
      ).toMatchObject({ readState: 'partial', writeState: 'partial', externalState: 'partial' })
    }
  )
  it.each([
    '[[.data.frame',
    '[[.default',
    'names<-.data.frame',
    'names<-.default',
    'names',
    'length'
  ])('keeps fixed base lookup independent of %s', async (binding) => {
    const script = 'selected <- df[1:2,,drop=FALSE];x <- selected[,"x"];z <- mean(x)'
    expect(
      await analyzeNotebookSourceFileAccess('r', script, {
        ...context,
        resolvedKernelNames: ['df', binding]
      })
    ).toMatchObject({ readState: 'complete', writeState: 'complete', externalState: 'complete' })
  })
  it('retains row-predicate and implicit-method dependencies', async () => {
    const { facts } = await analyzeRNotebookSource('x <- df[df$x>threshold,"x"];z <- mean(x)', {
      ...context,
      rAtomicValueNames: ['threshold']
    })
    expect(facts.priorUsedNames).toEqual(
      expect.arrayContaining([
        'df',
        'threshold',
        '[',
        '[.data.frame',
        '[.default',
        '$',
        '$.data.frame'
      ])
    )
  })
  it('keeps selector side effects visible without certifying their result', async () => {
    for (const source of [
      'x <- df[{writeLines("effect","rows.txt");1},"x"]',
      'x <- df[,{writeLines("effect","columns.txt");"x"}]'
    ]) {
      expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes.length).toBe(1)
      expect(
        (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
      ).not.toContain('x')
    }
  })
  it('invalidates table subset evidence after a classed column replacement', async () => {
    const { facts } = await analyzeRNotebookSource(
      'selected <- df[,"x",drop=FALSE];selected$x <- structure(1,class="sensor");x <- selected$x;z <- mean(x)',
      context
    )
    expect(facts.rAtomicTableNames ?? []).not.toContain('selected')
    expect(facts.rAtomicValueNames ?? []).not.toContain('x')
  })
  it('carries filtered tables and extracted vectors across cells', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'selected <- df[df$x>2,,drop=FALSE]',
      'x <- selected[,"x"]',
      'z <- mean(x);s <- sd(x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-subset-current-')
    expect(before.dependenciesByRunId?.['run-2']).toContain('run-1')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(before.stalenessByRunId['run-5']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("new.csv")', 'stale'],
      ['selected <- read.csv("other.csv")', 'stale'],
      ['`[.data.frame` <- function(...) structure(1,class="sensor")', 'unknown'],
      ['names.data.frame <- function(x) c("x","y")', 'unknown'],
      ['length.data.frame <- function(x) 2', 'unknown']
    ]) {
      const after = await projectScripts('r', [...scripts, change], 'csv-subset-change-')
      expect(after.stalenessByRunId['run-5']).toMatchObject({ state })
    }
  })
  it('keeps independent row-mask and threshold producers in downstream lineage', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'threshold <- 2',
      'keep <- df[,"x"]>threshold',
      'selected <- df[keep,,drop=FALSE]',
      'x <- selected[,"x"]',
      'z <- mean(x)',
      'write.csv(z,"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-mask-current-')
    expect(before.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-1', 'run-3'])
    )
    expect(before.stalenessByRunId['run-7']).toMatchObject({ state: 'clear' })
    for (const change of ['threshold <- 3', 'keep <- c(TRUE,FALSE)']) {
      const after = await projectScripts('r', [...scripts, change], 'csv-mask-change-')
      expect(after.stalenessByRunId['run-7']).toMatchObject({ state: 'stale' })
    }
  })
})

describe('R bounded CSV subset function', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    'subset(df,df$x>2,select=c("x","y"))',
    'base::subset(df,df$x>2,select=c("x","y"),drop=FALSE)',
    'subset(x=df,subset=df$x>2,select="x",drop=FALSE)',
    'subset(df,df$x>2,select=c(1,2),drop=FALSE)'
  ])('preserves primitive columns through %s', async (selection) => {
    const source =
      'selected <- ' + selection + ';x <- selected$x;z <- mean(x);write.csv(z,"out.csv")'
    const changed = {
      ...context,
      rAtomicValueNames: ['threshold'],
      resolvedKernelNames: ['df', 'threshold']
    }
    const { facts } = await analyzeRNotebookSource(source, changed)
    expect(facts.rAtomicTableNames).toContain('selected')
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['x', 'z']))
    expect(facts.possiblyUsedNames).not.toContain('df')
    expect(await analyzeNotebookSourceFileAccess('r', source, changed)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
  it.each([
    'subset(df,waiting>70,select=c("x","y"))',
    'subset(df,df$x>2,select=c(x,y))',
    'subset(df,df$x>2,select=columns)',
    'subset(df,df$x>2,select=c("x","y"),drop=TRUE)',
    'subset(df,df$x>2,select="x",drop=flag)',
    'subset(df,df$x>2,select="x",dr=FALSE)',
    'subset(df,df$x>2,select="x",extra=TRUE)',
    'subset(df,df$x>2,select="x",drop=FALSE,drop=FALSE)',
    'subset(df,df$x>2)',
    'subset(df,select="x")',
    'subset(df,structure(TRUE,class="sensor"),select="x")',
    'subset(df,df$x>2,select={writeLines("effect","select.txt");"x"})'
  ])('withholds unproven mask and result proof: %s', async (selection) => {
    const source = 'selected <- ' + selection + ';x <- selected$x;z <- mean(x)'
    const { facts } = await analyzeRNotebookSource(source, context)
    expect(facts.rAtomicTableNames ?? []).not.toContain('selected')
    expect(facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it.each([
    'subset',
    'subset.data.frame',
    '[',
    '[.data.frame',
    '[.default',
    'names.data.frame',
    'names.default',
    'length.data.frame',
    'length.default'
  ])('keeps replaced dispatch %s opaque even for direct export', async (method) => {
    const source =
      'selected <- base::subset(df,df$x>2,select="x",drop=FALSE);write.csv(selected,"out.csv")'
    // Qualification protects the generic but never an S3 method.
    const script = method === 'subset' ? source.replace('base::subset', 'subset') : source
    const changed = { ...context, resolvedKernelNames: ['df', method] }
    expect(
      (await analyzeRNotebookSource(script, changed)).facts.rAtomicTableNames ?? []
    ).not.toContain('selected')
    expect(await analyzeNotebookSourceFileAccess('r', script, changed)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it('tracks actual mask and method producers across cells', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'threshold <- 2',
      'selected <- subset(df,df$x>threshold,select=c("x","y"),drop=FALSE)',
      'x <- selected$x',
      'z <- mean(x);s <- sd(x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-subset-call-')
    expect(before.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(before.dependenciesByRunId?.['run-4']).toContain('run-3')
    expect(before.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['threshold <- 3', 'stale'],
      ['df <- read.csv("other.csv")', 'stale'],
      ['subset.data.frame <- function(...) structure(1,class="sensor")', 'unknown'],
      ['names.data.frame <- function(x) c("x","y")', 'unknown']
    ]) {
      const after = await projectScripts('r', [...scripts, change], 'csv-subset-call-change-')
      expect(after.stalenessByRunId['run-6']).toMatchObject({ state })
    }
  })
  it('retains selector effects and revokes table proof after mutations', async () => {
    const source = 'selected <- subset(df,df$x>2,select={writeLines("effect","select.txt");"x"})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'select.txt'
    )
    const { facts } = await analyzeRNotebookSource(
      'selected <- subset(df,df$x>2,select="x");selected$x <- structure(1,class="sensor");z <- mean(selected$x)',
      context
    )
    expect(facts.rAtomicTableNames ?? []).not.toContain('selected')
    expect(facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it.each(['dim.data.frame', 'dim.default', 'as.list.default'])(
    'keeps fixed internal lookup independent of caller method %s',
    async (method) => {
      for (const selection of ['subset(df,select="x")', 'subset(df,df$x>2)'])
        expect(
          await analyzeNotebookSourceFileAccess(
            'r',
            'selected <- ' + selection + ';write.csv(selected,"out.csv")',
            { ...context, resolvedKernelNames: ['df', method] }
          )
        ).toMatchObject({
          readState: 'complete',
          writeState: 'complete',
          externalState: 'complete'
        })
    }
  )
  it('does not treat a table as an atomic mean input', async () => {
    const { facts } = await analyzeRNotebookSource(
      'selected <- subset(df,df$x>2,select="x");z <- mean(selected)',
      context
    )
    expect(
      (await analyzeRNotebookSource('selected <- subset(df,df$x>2,select="x")', context)).facts
        .rAtomicTableNames
    ).toContain('selected')
    expect(facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it('keeps namespace revocation and classed replacements uncertain', async () => {
    for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");']) {
      const { facts } = await analyzeRNotebookSource(
        prefix + 'selected <- subset(df,df$x>2,select="x");z <- mean(selected$x)',
        context
      )
      expect(facts.rAtomicTableNames ?? []).not.toContain('selected')
      expect(facts.rAtomicValueNames ?? []).not.toContain('z')
    }
  })
})

describe('R bounded CSV NA actions', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    'na.omit(df)',
    'stats::na.omit(df)',
    'na.exclude(df)',
    'stats::na.exclude(object=df)',
    'na.omit(object=df)'
  ])('preserves primitive columns through %s', async (cleaning) => {
    const source =
      'clean <- ' + cleaning + ';x <- clean$x;z <- mean(x);s <- sd(x);write.csv(c(z,s),"out.csv")'
    const { facts } = await analyzeRNotebookSource(source, context)
    expect(facts.rAtomicTableNames).toContain('clean')
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['x', 'z', 's']))
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
  it.each([
    'na.omit.data.frame',
    'na.exclude.data.frame',
    'names.data.frame',
    'names.default',
    'length.data.frame',
    'length.default',
    'seq.logical'
  ])('keeps replaced actual dispatch opaque: %s', async (method) => {
    const action = method.startsWith('na.exclude') ? 'na.exclude' : 'na.omit'
    const source = 'clean <- stats::' + action + '(df);write.csv(clean,"out.csv")'
    const changed = { ...context, resolvedKernelNames: ['df', method] }
    expect(
      (await analyzeRNotebookSource(source, changed)).facts.rAtomicTableNames ?? []
    ).not.toContain('clean')
    expect(await analyzeNotebookSourceFileAccess('r', source, changed)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    '[',
    '[.data.frame',
    '[.default',
    '[[',
    '[[.data.frame',
    '[[.default',
    'dim.data.frame',
    'dim.default',
    'seq.default',
    'names',
    'length',
    'seq'
  ])('keeps fixed stats lookup independent of caller %s', async (method) => {
    const changed = { ...context, resolvedKernelNames: ['df', method] }
    const source = 'clean <- stats::na.omit(df);x <- clean$x;z <- mean(x);write.csv(z,"out.csv")'
    expect((await analyzeRNotebookSource(source, changed)).facts.rAtomicTableNames).toContain(
      'clean'
    )
    expect(await analyzeNotebookSourceFileAccess('r', source, changed)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
  it.each([
    'na.omit(other)',
    'na.exclude(structure(df,class="sensor"))',
    'na.omit(df,extra=TRUE)',
    'na.omit(obj=df)',
    'na.omit(df,object=df)'
  ])('withholds unsupported proof: %s', async (cleaning) => {
    const { facts } = await analyzeRNotebookSource(
      'clean <- ' + cleaning + ';z <- mean(clean$x)',
      context
    )
    expect(facts.rAtomicTableNames ?? []).not.toContain('clean')
    expect(facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it('retains source reads and barriers without certifying effectful arguments', async () => {
    const source = 'clean <- na.omit({writeLines("effect","effect.txt");df});z <- mean(clean$x)'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'effect.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicTableNames ?? []
    ).not.toContain('clean')
    for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");'])
      expect(
        (await analyzeRNotebookSource(prefix + 'clean <- na.omit(df);z <- mean(clean$x)', context))
          .facts.rAtomicValueNames ?? []
      ).not.toContain('z')
  })
  it('keeps generic identity replacement opaque', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'clean <- na.omit(df);write.csv(clean,"out.csv")',
        { ...context, resolvedKernelNames: ['df', 'na.omit'] }
      )
    ).toMatchObject({ readState: 'partial', writeState: 'partial', externalState: 'partial' })
  })
  it('does not mistake an NA action table for an atomic mean input', async () => {
    expect(
      (await analyzeRNotebookSource('clean <- na.omit(df);z <- mean(clean)', context)).facts
        .rAtomicValueNames ?? []
    ).not.toContain('z')
  })
  it('carries table facts, scientific values and real method dependencies across cells', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'clean <- stats::na.omit(df)',
      'excluded <- stats::na.exclude(clean)',
      'x <- excluded$x',
      'z <- mean(x);s <- sd(x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-na-action-')
    expect(before.dependenciesByRunId?.['run-2']).toContain('run-1')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(before.dependenciesByRunId?.['run-4']).toContain('run-3')
    expect(before.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv")', 'stale'],
      ['na.omit.data.frame <- function(...) structure(1,class="sensor")', 'unknown'],
      ['seq.logical <- function(...) 1', 'unknown'],
      ['names.data.frame <- function(x) c("x","y")', 'unknown']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-na-action-change-')).stalenessByRunId[
          'run-6'
        ]
      ).toMatchObject({ state })
  })
})

describe('R bounded CSV NA vectors', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    'double',
    'numeric',
    'integer',
    'logical',
    'complex',
    'character',
    'raw',
    'NULL',
    'default'
  ])('keeps replaced implicit method %s opaque', async (type) => {
    for (const action of ['na.omit', 'na.exclude']) {
      const changed = { ...context, resolvedKernelNames: ['df', action + '.' + type] }
      const source = 'x <- stats::' + action + '(df$x);write.csv(x,"out.csv")'
      expect(
        (await analyzeRNotebookSource(source, changed)).facts.rAtomicValueNames ?? []
      ).not.toContain('x')
      expect(await analyzeNotebookSourceFileAccess('r', source, changed)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  })
  it.each([
    'na.omit.data.frame',
    'na.exclude.data.frame',
    'names.data.frame',
    'names.default',
    'length.data.frame',
    'length.default',
    'seq.logical',
    '[.default',
    'dim.default'
  ])('preserves fixed primitive/default internals despite %s', async (method) => {
    const changed = { ...context, resolvedKernelNames: ['df', method] }
    const source = 'x <- stats::na.omit(df$x);z <- mean(x);write.csv(z,"out.csv")'
    expect((await analyzeRNotebookSource(source, changed)).facts.rAtomicValueNames).toContain('x')
    expect(await analyzeNotebookSourceFileAccess('r', source, changed)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
  it('retains argument effects and mutation/namespace revocation', async () => {
    const source = 'x <- na.omit({writeLines("effect","effect.txt");df$x})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'effect.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('x')
    for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");'])
      expect(
        (await analyzeRNotebookSource(prefix + 'x <- na.omit(df$x);z <- mean(x)', context)).facts
          .rAtomicValueNames ?? []
      ).not.toContain('z')
  })
  it('carries extracted and cleaned vectors through independent cells', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'raw <- df$x',
      'x <- stats::na.omit(raw)',
      'y <- stats::na.exclude(x)',
      'z <- mean(y);s <- sd(y)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-na-vector-')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(before.dependenciesByRunId?.['run-4']).toContain('run-3')
    expect(before.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv")', 'stale'],
      ['raw <- c(3,4)', 'stale'],
      ['na.omit.numeric <- function(...) structure(1,class="sensor")', 'unknown'],
      ['na.exclude.default <- function(...) 1', 'unknown']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-na-vector-change-')).stalenessByRunId[
          'run-6'
        ]
      ).toMatchObject({ state })
  })
})

describe('R bounded CSV head tail tables', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    'head(df)',
    'utils::head(df,10)',
    'head(x=df,n=0)',
    'utils::tail(df,10)',
    'tail(df,n=3,keepnums=FALSE)',
    'tail(x=df,n=2,keepnums=TRUE)'
  ])('preserves primitive columns through %s', async (selection) => {
    const changed = {
      ...context,
      rAtomicValueNames: ['count'],
      resolvedKernelNames: ['df', 'count']
    }
    const source =
      'selected <- ' +
      selection +
      ';x <- selected$x;z <- mean(x);s <- sd(x);write.csv(c(z,s),"out.csv")'
    const { facts } = await analyzeRNotebookSource(source, changed)
    expect(facts.rAtomicTableNames).toContain('selected')
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['x', 'z', 's']))
    expect(await analyzeNotebookSourceFileAccess('r', source, changed)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
  it.each([
    'head.data.frame',
    'tail.data.frame',
    'names.data.frame',
    'names.default',
    'length.data.frame',
    'length.default'
  ])('keeps actual replaced method %s opaque for direct export', async (method) => {
    const action = method.startsWith('tail') ? 'tail' : 'head'
    const source = 'selected <- utils::' + action + '(df,10);write.csv(selected,"out.csv")'
    const changed = { ...context, resolvedKernelNames: ['df', method] }
    expect(
      (await analyzeRNotebookSource(source, changed)).facts.rAtomicTableNames ?? []
    ).not.toContain('selected')
    expect(await analyzeNotebookSourceFileAccess('r', source, changed)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each([
    'head.matrix',
    'tail.matrix',
    'head.default',
    'tail.default',
    '[',
    '[.data.frame',
    '[.default',
    'dim.data.frame',
    'dim.default',
    'dimnames.data.frame',
    'names',
    'length'
  ])('keeps fixed utils lookup independent of %s', async (method) => {
    const source = 'selected <- utils::tail(utils::head(df,10),3);x <- selected$x;z <- mean(x)'
    const changed = { ...context, resolvedKernelNames: ['df', method] }
    expect((await analyzeRNotebookSource(source, changed)).facts.rAtomicTableNames).toContain(
      'selected'
    )
    expect(await analyzeNotebookSourceFileAccess('r', source, changed)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
  it.each([
    'head(other,2)',
    'head(structure(df,class="sensor"),2)',
    'head(df,rows)',
    'head(df,structure(2,class="sensor"))',
    'head(df,n=2,extra=TRUE)',
    'head(df,n=2,n=3)',
    'head(df,nu=2)',
    'tail(df,2,keepnums=flag)',
    'tail(df,2,addrownums=TRUE)'
  ])('withholds unsupported result proof: %s', async (selection) => {
    const { facts } = await analyzeRNotebookSource(
      'selected <- ' + selection + ';z <- mean(selected$x)',
      context
    )
    expect(facts.rAtomicTableNames ?? []).not.toContain('selected')
    expect(facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it('retains effects and revocation without mistaking a table for a mean input', async () => {
    const source = 'selected <- head(df,{writeLines("effect","count.txt");2})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'count.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicTableNames ?? []
    ).not.toContain('selected')
    for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");'])
      expect(
        (
          await analyzeRNotebookSource(
            prefix + 'selected <- head(df,2);z <- mean(selected$x)',
            context
          )
        ).facts.rAtomicValueNames ?? []
      ).not.toContain('z')
    expect(
      (await analyzeRNotebookSource('selected <- head(df,2);z <- mean(selected)', context)).facts
        .rAtomicValueNames ?? []
    ).not.toContain('z')
  })
  it('tracks independent count producers and method changes across cells', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'count <- 10',
      'leading <- utils::head(df,count)',
      'selected <- utils::tail(leading,3)',
      'x <- selected$x',
      'z <- mean(x);s <- sd(x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-head-tail-')
    expect(before.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(before.dependenciesByRunId?.['run-4']).toContain('run-3')
    expect(before.stalenessByRunId['run-7']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['count <- 5', 'stale'],
      ['df <- read.csv("other.csv")', 'stale'],
      ['head.data.frame <- function(...) structure(1,class="sensor")', 'unknown'],
      ['tail.data.frame <- function(...) structure(1,class="sensor")', 'unknown'],
      ['names.data.frame <- function(x) c("x","y")', 'unknown']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-head-tail-change-')).stalenessByRunId[
          'run-7'
        ]
      ).toMatchObject({ state })
  })
})

describe('R bounded CSV head tail vectors', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    'double',
    'numeric',
    'integer',
    'logical',
    'complex',
    'character',
    'raw',
    'NULL',
    'default'
  ])('keeps replaced implicit %s methods opaque for direct export', async (type) => {
    for (const action of ['head', 'tail']) {
      const changed = { ...context, resolvedKernelNames: ['df', action + '.' + type] }
      const source = 'x <- utils::' + action + '(df$x,2);write.csv(x,"out.csv")'
      expect(
        (await analyzeRNotebookSource(source, changed)).facts.rAtomicValueNames ?? []
      ).not.toContain('x')
      expect(await analyzeNotebookSourceFileAccess('r', source, changed)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  })
  it.each([
    'head.data.frame',
    'tail.data.frame',
    'head.matrix',
    'tail.matrix',
    'names.data.frame',
    'names.default',
    'length.default',
    'dim.default',
    '[.default',
    'seq.logical'
  ])('keeps fixed default internals independent of %s', async (method) => {
    const changed = { ...context, resolvedKernelNames: ['df', method] }
    const source = 'x <- utils::tail(utils::head(df$x,5),2);z <- mean(x)'
    expect((await analyzeRNotebookSource(source, changed)).facts.rAtomicValueNames).toContain('x')
    expect(await analyzeNotebookSourceFileAccess('r', source, changed)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
  it('retains count effects and namespace/mutation revocation', async () => {
    const source = 'x <- head(df$x,{writeLines("effect","count.txt");2})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'count.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('x')
    for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");'])
      expect(
        (await analyzeRNotebookSource(prefix + 'x <- head(df$x,2);z <- mean(x)', context)).facts
          .rAtomicValueNames ?? []
      ).not.toContain('z')
  })
  it('preserves reassignment reads, independent counts and method invalidation', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'count <- 10',
      'x <- utils::head(df$x,count)',
      'x <- utils::tail(x,3)',
      'z <- mean(x);s <- sd(x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-vector-truncate-')
    expect(before.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(before.dependenciesByRunId?.['run-4']).toContain('run-3')
    expect(before.dependenciesByRunId?.['run-5']).toContain('run-4')
    expect(before.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['count <- 5', 'stale'],
      ['df <- read.csv("other.csv")', 'stale'],
      ['head.numeric <- function(...) structure(1,class="sensor")', 'unknown'],
      ['tail.default <- function(...) 1', 'unknown']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-vector-truncate-change-'))
          .stalenessByRunId['run-6']
      ).toMatchObject({ state })
  })
})

describe('R bounded primitive order indices', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    'order(df$x)',
    'base::order(df[,"x"])',
    'order(df$x,df$y)',
    'order(df$x,decreasing=TRUE)',
    'order(df$x,na.last=FALSE,method="shell")',
    'order(df$x,df$y,method="radix",decreasing=FALSE)',
    'order(df$x,method="auto")',
    'order(c(3,1,2))'
  ])('proves primitive ordering indices: %s', async (ordering) => {
    const source =
      'rows <- ' +
      ordering +
      ';selected <- df[rows,,drop=FALSE];x <- selected$x;z <- mean(x);write.csv(z,"out.csv")'
    const { facts } = await analyzeRNotebookSource(source, context)
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['rows', 'x', 'z']))
    expect(facts.rAtomicTableNames).toContain('selected')
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
  it.each([
    'order(other)',
    'order(df)',
    'order(structure(c(3,1,2),class="sensor"))',
    'order(df$x,decreasing=flag)',
    'order(df$x,na.last=NA)',
    'order(df$x,method=method)',
    'order(df$x,method="r")',
    'order(df$x,decreasing=c(TRUE,FALSE))',
    'order(df$x,decreasing=TRUE,decreasing=FALSE)',
    'order(df$x,unknown=TRUE)',
    'order()'
  ])('does not certify unproven/unsupported ordering effects: %s', async (ordering) => {
    const source = 'rows <- ' + ordering + ';write.csv(rows,"out.csv")'
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('rows')
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
  it.each(['xtfrm', 'xtfrm.default', 'xtfrm.numeric'])(
    'keeps primitive sorting independent of %s',
    async (method) => {
      const changed = { ...context, resolvedKernelNames: ['df', method] }
      const source =
        'rows <- base::order(df$x,method="radix");selected <- df[rows,,drop=FALSE];z <- mean(selected$x)'
      expect((await analyzeRNotebookSource(source, changed)).facts.rAtomicValueNames).toContain(
        'rows'
      )
      expect(await analyzeNotebookSourceFileAccess('r', source, changed)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete'
      })
    }
  )
  it('keeps generic replacement and explicit argument effects visible', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'rows <- order(df$x);write.csv(rows,"out.csv")', {
        ...context,
        resolvedKernelNames: ['df', 'order']
      })
    ).toMatchObject({ readState: 'partial', writeState: 'partial', externalState: 'partial' })
    const source = 'rows <- order({writeLines("effect","key.txt");df$x})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'key.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('rows')
  })
  it('retains key/index producers, cache context and stale invalidation', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'secondary <- df$y',
      'rows <- order(df$x,secondary)',
      'selected <- df[rows,,drop=FALSE]',
      'x <- selected$x',
      'z <- mean(x);s <- sd(x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-order-')
    expect(before.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-1', 'run-3'])
    )
    expect(before.stalenessByRunId['run-7']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv")', 'stale'],
      ['secondary <- c(3,2,1)', 'stale'],
      ['rows <- c(3,2,1)', 'stale'],
      ['order <- function(...) 1', 'unknown']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-order-change-')).stalenessByRunId[
          'run-7'
        ]
      ).toMatchObject({ state })
  })
})

describe('R bounded CSV missing masks', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    'numeric',
    'double',
    'integer',
    'logical',
    'complex',
    'character',
    'raw',
    'NULL',
    'default'
  ])('does not invent implicit is.na.%s dependencies', async (type) => {
    const source = 'x <- df$x;keep <- !base::is.na(x);clean <- x[keep];z <- mean(clean)'
    const { facts } = await analyzeRNotebookSource(source, {
      ...context,
      resolvedKernelNames: ['df', 'is.na.' + type]
    })
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['keep', 'clean', 'z']))
    expect(facts.usedNames).not.toContain('is.na.' + type)
  })
  it('respects generic replacement, explicit effects and CSV column revocation', async () => {
    for (const prefix of [
      'is.na <- function(x) structure(TRUE,class="sensor");',
      'source("helper.R");',
      'df$x <- structure(1,class="sensor");'
    ]) {
      const { facts } = await analyzeRNotebookSource(
        prefix + 'keep <- is.na(df$x);z <- mean(keep)',
        context
      )
      expect(facts.rAtomicValueNames ?? []).not.toContain('keep')
      expect(facts.rAtomicValueNames ?? []).not.toContain('z')
    }
    const source = 'keep <- is.na({writeLines("effect","mask.txt");df$x})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'mask.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('keep')
  })
  it('retains mask producers and downstream invalidation across cells', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'x <- df$x',
      'keep <- !is.na(x)',
      'clean <- x[keep]',
      'z <- mean(clean);s <- sd(clean)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-missing-mask-')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-2', 'run-3'])
    )
    expect(before.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv")', 'stale'],
      ['x <- c(2,3)', 'stale'],
      ['keep <- c(TRUE,FALSE)', 'stale'],
      ['is.na <- function(x) TRUE', 'unknown']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-missing-mask-change-'))
          .stalenessByRunId['run-6']
      ).toMatchObject({ state })
  })
})

describe('R bounded CSV complete cases masks', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    'is.na',
    'is.na.numeric',
    'is.na.data.frame',
    'is.na.default',
    'length.data.frame',
    'length.default',
    'names.data.frame',
    'names.default'
  ])('keeps native compcases independent of %s', async (method) => {
    const source = 'keep <- stats::complete.cases(df);z <- mean(keep)'
    const { facts } = await analyzeRNotebookSource(source, {
      ...context,
      resolvedKernelNames: ['df', method]
    })
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['keep', 'z']))
    expect(facts.usedNames).not.toContain(method)
  })
  it('distinguishes bare replacement from qualified stats identity', async () => {
    const changed = { ...context, resolvedKernelNames: ['df', 'complete.cases'] }
    expect(
      (await analyzeRNotebookSource('keep <- complete.cases(df)', changed)).facts
        .rAtomicValueNames ?? []
    ).not.toContain('keep')
    expect(
      (await analyzeRNotebookSource('keep <- stats::complete.cases(df)', changed)).facts
        .rAtomicValueNames
    ).toContain('keep')
    expect(
      (
        await analyzeRNotebookSource('keep <- stats::complete.cases(df)', {
          ...context,
          resolvedKernelNames: ['df', '::']
        })
      ).facts.rAtomicValueNames ?? []
    ).not.toContain('keep')
  })
  it('retains explicit effects and column-proof revocation', async () => {
    for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");']) {
      const { facts } = await analyzeRNotebookSource(
        prefix + 'keep <- complete.cases(df);z <- mean(keep)',
        context
      )
      expect(facts.rAtomicValueNames ?? []).not.toContain('keep')
      expect(facts.rAtomicValueNames ?? []).not.toContain('z')
    }
    const source = 'keep <- complete.cases({writeLines("effect","cases.txt");df})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'cases.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('keep')
  })
  it('retains independent vector producers and stale downstream results across cells', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'secondary <- df$y',
      'keep <- stats::complete.cases(df$x,secondary)',
      'selected <- df[keep,,drop=FALSE]',
      'z <- mean(selected$x);s <- sd(selected$x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-complete-cases-')
    expect(before.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-1', 'run-3'])
    )
    expect(before.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv")', 'stale'],
      ['secondary <- c(2,3)', 'stale'],
      ['keep <- c(TRUE,FALSE)', 'stale']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-complete-cases-change-'))
          .stalenessByRunId['run-6']
      ).toMatchObject({ state })
    const bare = scripts.map((s) => s.replace('stats::complete.cases', 'complete.cases'))
    expect(
      (
        await projectScripts(
          'r',
          [...bare, 'complete.cases <- function(...) TRUE'],
          'csv-complete-cases-replacement-'
        )
      ).stalenessByRunId['run-6']
    ).toMatchObject({ state: 'unknown' })
  })
})

describe('R bounded CSV which indices', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rAtomicValueNames: ['mask'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df', 'mask']
  }
  it.each(['isTRUE', 'dim', 'dimnames', 'arrayInd', 'which.numeric', 'which.default'])(
    'keeps native vector indices independent of %s',
    async (method) => {
      const source = 'rows <- base::which(mask);z <- mean(rows)'
      const { facts } = await analyzeRNotebookSource(source, {
        ...context,
        resolvedKernelNames: ['df', 'mask', method]
      })
      expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['rows', 'z']))
      expect(facts.usedNames).not.toContain(method)
    }
  )
  it('respects bare replacement and qualified binding identity', async () => {
    const changed = { ...context, resolvedKernelNames: ['df', 'mask', 'which'] }
    expect(
      (await analyzeRNotebookSource('rows <- which(mask)', changed)).facts.rAtomicValueNames ?? []
    ).not.toContain('rows')
    expect(
      (await analyzeRNotebookSource('rows <- base::which(mask)', changed)).facts.rAtomicValueNames
    ).toContain('rows')
    expect(
      (
        await analyzeRNotebookSource('rows <- base::which(mask)', {
          ...context,
          resolvedKernelNames: ['df', 'mask', '::']
        })
      ).facts.rAtomicValueNames ?? []
    ).not.toContain('rows')
  })
  it('retains explicit effects and CSV proof revocation', async () => {
    for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");']) {
      const { facts } = await analyzeRNotebookSource(
        prefix + 'rows <- which(df$x>0);z <- mean(rows)',
        context
      )
      expect(facts.rAtomicValueNames ?? []).not.toContain('rows')
      expect(facts.rAtomicValueNames ?? []).not.toContain('z')
    }
    const source = 'rows <- which({writeLines("effect","which.txt");mask})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'which.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('rows')
  })
  it('carries mask and row producers across cells and invalidates their downstream consumers', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'keep <- complete.cases(df)',
      'rows <- which(keep)',
      'selected <- df[rows,,drop=FALSE]',
      'z <- mean(selected$x);s <- sd(selected$x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-which-')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-1', 'run-3'])
    )
    expect(before.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv")', 'stale'],
      ['keep <- c(TRUE,FALSE)', 'stale'],
      ['rows <- c(1L,2L)', 'stale'],
      ['which <- function(...) 1L', 'unknown']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-which-change-')).stalenessByRunId[
          'run-6'
        ]
      ).toMatchObject({ state })
  })
})

describe('R bounded CSV sum totals', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each(['sum.numeric', 'sum.default', 'Summary.numeric', 'Summary.default'])(
    'keeps ordinary sums independent of %s',
    async (method) => {
      const { facts } = await analyzeRNotebookSource('total <- base::sum(df$x);z <- mean(total)', {
        ...context,
        resolvedKernelNames: ['df', method]
      })
      expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['total', 'z']))
      expect(facts.usedNames).not.toContain(method)
    }
  )
  it('respects bare replacement and qualified base identity', async () => {
    const changed = { ...context, resolvedKernelNames: ['df', 'sum'] }
    expect(
      (await analyzeRNotebookSource('total <- sum(df$x)', changed)).facts.rAtomicValueNames ?? []
    ).not.toContain('total')
    expect(
      (await analyzeRNotebookSource('total <- base::sum(df$x)', changed)).facts.rAtomicValueNames
    ).toContain('total')
    expect(
      (
        await analyzeRNotebookSource('total <- base::sum(df$x)', {
          ...context,
          resolvedKernelNames: ['df', '::']
        })
      ).facts.rAtomicValueNames ?? []
    ).not.toContain('total')
  })
  it('retains explicit effects and CSV type revocation', async () => {
    for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");']) {
      const { facts } = await analyzeRNotebookSource(
        prefix + 'total <- sum(df$x);z <- mean(total)',
        context
      )
      expect(facts.rAtomicValueNames ?? []).not.toContain('total')
      expect(facts.rAtomicValueNames ?? []).not.toContain('z')
    }
    const source = 'total <- sum({writeLines("effect","sum.txt");df$x})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'sum.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('total')
  })
  it('retains independent total and sample producers across cells', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'x <- df$x',
      'total <- sum(x,na.rm=TRUE)',
      'mu <- total/length(x)',
      'z <- dnorm(x,mean=mu,sd=1)',
      'write.csv(z,"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-sum-')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-2', 'run-3'])
    )
    expect(before.dependenciesByRunId?.['run-5']).toEqual(
      expect.arrayContaining(['run-2', 'run-4'])
    )
    expect(before.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv")', 'stale'],
      ['x <- c(2,3)', 'stale'],
      ['total <- 8', 'stale'],
      ['sum <- function(...) 1', 'unknown']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-sum-change-')).stalenessByRunId[
          'run-6'
        ]
      ).toMatchObject({ state })
  })
})

describe('R bounded CSV membership masks', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rAtomicValueNames: ['targets'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df', 'targets']
  }
  it.each([
    'match',
    'mtfrm',
    'mtfrm.default',
    'mtfrm.numeric',
    'as.character.numeric',
    'as.character.default'
  ])('keeps primitive matching independent of %s', async (method) => {
    const { facts } = await analyzeRNotebookSource('keep <- df$x %in% targets;z <- mean(keep)', {
      ...context,
      resolvedKernelNames: ['df', 'targets', method]
    })
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['keep', 'z']))
    expect(facts.usedNames).not.toContain(method)
  })
  it('respects bare operator replacement and qualified base identity', async () => {
    const changed = { ...context, resolvedKernelNames: ['df', 'targets', '%in%'] }
    expect(
      (await analyzeRNotebookSource('keep <- df$x %in% targets', changed)).facts
        .rAtomicValueNames ?? []
    ).not.toContain('keep')
    expect(
      (await analyzeRNotebookSource('keep <- base::`%in%`(df$x,targets)', changed)).facts
        .rAtomicValueNames
    ).toContain('keep')
    expect(
      (
        await analyzeRNotebookSource('keep <- base::`%in%`(df$x,targets)', {
          ...context,
          resolvedKernelNames: ['df', 'targets', '::']
        })
      ).facts.rAtomicValueNames ?? []
    ).not.toContain('keep')
  })
  it('retains explicit effects and CSV proof revocation', async () => {
    for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");']) {
      const { facts } = await analyzeRNotebookSource(
        prefix + 'keep <- df$x %in% targets;z <- mean(keep)',
        context
      )
      expect(facts.rAtomicValueNames ?? []).not.toContain('keep')
      expect(facts.rAtomicValueNames ?? []).not.toContain('z')
    }
    const source = 'keep <- df$x %in% {writeLines("effect","membership.txt");targets}'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'membership.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('keep')
  })
  it('retains target and sample producers and stale invalidation across cells', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'targets <- c(1,2)',
      'keep <- df$x %in% targets',
      'selected <- df[keep,,drop=FALSE]',
      'z <- mean(selected$x)',
      'write.csv(z,"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-membership-')
    expect(before.dependenciesByRunId?.['run-3']).toEqual(
      expect.arrayContaining(['run-1', 'run-2'])
    )
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-1', 'run-3'])
    )
    expect(before.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv")', 'stale'],
      ['targets <- c(2,3)', 'stale'],
      ['keep <- c(TRUE,FALSE)', 'stale'],
      ['`%in%` <- function(x,table) TRUE', 'unknown']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-membership-change-'))
          .stalenessByRunId['run-6']
      ).toMatchObject({ state })
  })
})

describe('R bounded CSV unname vectors', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    'names',
    'names<-',
    'names.numeric',
    'names.default',
    'names<-.numeric',
    'names<-.default',
    'dimnames',
    'dimnames.numeric',
    'dimnames.default',
    'dimnames<-',
    'is.null',
    'is.data.frame'
  ])('keeps primitive unname independent of %s', async (method) => {
    const { facts } = await analyzeRNotebookSource(
      'x <- base::unname(df$x,force=TRUE);z <- mean(x)',
      { ...context, resolvedKernelNames: ['df', method] }
    )
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['x', 'z']))
    expect(facts.usedNames).not.toContain(method)
  })
  it('respects bare replacement and qualified base identity', async () => {
    const changed = { ...context, resolvedKernelNames: ['df', 'unname'] }
    expect(
      (await analyzeRNotebookSource('x <- unname(df$x)', changed)).facts.rAtomicValueNames ?? []
    ).not.toContain('x')
    expect(
      (await analyzeRNotebookSource('x <- base::unname(df$x)', changed)).facts.rAtomicValueNames
    ).toContain('x')
    expect(
      (
        await analyzeRNotebookSource('x <- base::unname(df$x)', {
          ...context,
          resolvedKernelNames: ['df', '::']
        })
      ).facts.rAtomicValueNames ?? []
    ).not.toContain('x')
  })
  it('retains explicit effects and revoked column evidence', async () => {
    for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");']) {
      const { facts } = await analyzeRNotebookSource(
        prefix + 'x <- unname(df$x);z <- mean(x)',
        context
      )
      expect(facts.rAtomicValueNames ?? []).not.toContain('x')
      expect(facts.rAtomicValueNames ?? []).not.toContain('z')
    }
    const source = 'x <- unname({writeLines("effect","unname.txt");df$x})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'unname.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('x')
  })
  it('retains CSV and named-quantile producers and their invalidation across cells', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'raw <- df$x',
      'x <- unname(raw)',
      'q <- quantile(x,probs=c(0.25,0.75))',
      'bounds <- unname(q)',
      'z <- mean(bounds);s <- sd(x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-unname-')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(before.dependenciesByRunId?.['run-5']).toContain('run-4')
    expect(before.dependenciesByRunId?.['run-6']).toEqual(
      expect.arrayContaining(['run-3', 'run-5'])
    )
    expect(before.stalenessByRunId['run-7']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv")', 'stale'],
      ['raw <- c(2,3)', 'stale'],
      ['q <- c(2,3)', 'stale'],
      ['unname <- function(...) 1', 'unknown']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-unname-change-')).stalenessByRunId[
          'run-7'
        ]
      ).toMatchObject({ state })
  })
})

describe('R bounded CSV ifelse transformations', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rAtomicValueNames: ['lower', 'upper'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df', 'lower', 'upper']
  }
  it.each([
    'which',
    'rep',
    'length',
    'as.logical',
    'as.logical.numeric',
    'as.logical.default',
    'rep.numeric',
    'rep.default',
    '[<-',
    '[<-.numeric',
    '[<-.default',
    'storage.mode<-'
  ])('keeps ordinary base evaluation independent of %s', async (method) => {
    const source = 'x <- base::ifelse(df$x>2,2,df$x);z <- mean(x)'
    const { facts } = await analyzeRNotebookSource(source, {
      ...context,
      resolvedKernelNames: ['df', 'lower', 'upper', method]
    })
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['x', 'z']))
    expect(facts.usedNames).not.toContain(method)
  })
  it('respects bare replacement and qualified identity', async () => {
    const changed = { ...context, resolvedKernelNames: ['df', 'ifelse'] }
    expect(
      (await analyzeRNotebookSource('x <- ifelse(df$x>2,2,df$x)', changed)).facts
        .rAtomicValueNames ?? []
    ).not.toContain('x')
    expect(
      (await analyzeRNotebookSource('x <- base::ifelse(df$x>2,2,df$x)', changed)).facts
        .rAtomicValueNames
    ).toContain('x')
    expect(
      (
        await analyzeRNotebookSource('x <- base::ifelse(df$x>2,2,df$x)', {
          ...context,
          resolvedKernelNames: ['df', '::']
        })
      ).facts.rAtomicValueNames ?? []
    ).not.toContain('x')
  })
  it('retains branch effects and column evidence revocation', async () => {
    for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");']) {
      const { facts } = await analyzeRNotebookSource(
        prefix + 'x <- ifelse(df$x>2,2,df$x);z <- mean(x)',
        context
      )
      expect(facts.rAtomicValueNames ?? []).not.toContain('x')
      expect(facts.rAtomicValueNames ?? []).not.toContain('z')
    }
    const source = 'x <- ifelse(df$x>2,{writeLines("effect","ifelse.txt");2},df$x)'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'ifelse.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('x')
  })
  it('retains bounds and raw data producers with cross-cell stale invalidation', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'lower <- 2;upper <- 4',
      'raw <- df$x',
      'x <- ifelse(raw<lower,lower,ifelse(raw>upper,upper,raw))',
      'z <- mean(x);s <- sd(x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-ifelse-')
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-2', 'run-3'])
    )
    expect(before.dependenciesByRunId?.['run-5']).toContain('run-4')
    expect(before.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv")', 'stale'],
      ['lower <- 3', 'stale'],
      ['raw <- c(2,3)', 'stale'],
      ['ifelse <- function(...) 1', 'unknown']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-ifelse-change-')).stalenessByRunId[
          'run-6'
        ]
      ).toMatchObject({ state })
  })
})

describe('R bounded CSV extreme indices', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    'which.min.numeric',
    'which.max.numeric',
    'which.min.default',
    'which.max.default',
    'as.double',
    'as.double.numeric',
    'as.double.default'
  ])('keeps internal extrema independent of %s', async (method) => {
    const { facts } = await analyzeRNotebookSource(
      'lo <- base::which.min(df$x);hi <- base::which.max(df$x);z <- mean(c(lo,hi))',
      { ...context, resolvedKernelNames: ['df', method] }
    )
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['lo', 'hi', 'z']))
    expect(facts.usedNames).not.toContain(method)
  })
  it('respects bare replacement and qualified identity', async () => {
    for (const name of ['which.min', 'which.max']) {
      const changed = { ...context, resolvedKernelNames: ['df', name] }
      expect(
        (await analyzeRNotebookSource('row <- ' + name + '(df$x)', changed)).facts
          .rAtomicValueNames ?? []
      ).not.toContain('row')
      expect(
        (await analyzeRNotebookSource('row <- base::' + name + '(df$x)', changed)).facts
          .rAtomicValueNames
      ).toContain('row')
      expect(
        (
          await analyzeRNotebookSource('row <- base::' + name + '(df$x)', {
            ...context,
            resolvedKernelNames: ['df', '::']
          })
        ).facts.rAtomicValueNames ?? []
      ).not.toContain('row')
    }
  })
  it('retains explicit effects and CSV column revocation', async () => {
    for (const name of ['which.min', 'which.max']) {
      for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");']) {
        const { facts } = await analyzeRNotebookSource(
          prefix + 'row <- ' + name + '(df$x);z <- mean(row)',
          context
        )
        expect(facts.rAtomicValueNames ?? []).not.toContain('row')
        expect(facts.rAtomicValueNames ?? []).not.toContain('z')
      }
      const source = 'row <- ' + name + '({writeLines("effect","extreme.txt");df$x})'
      expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
        'extreme.txt'
      )
      expect(
        (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
      ).not.toContain('row')
    }
  })
  it('retains min/max producers and downstream stale invalidation', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'raw <- df$x',
      'lo <- which.min(raw)',
      'hi <- which.max(raw)',
      'selected <- df[-c(lo,hi),,drop=FALSE]',
      'z <- mean(selected$x);s <- sd(selected$x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-extreme-indices-')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(before.dependenciesByRunId?.['run-4']).toContain('run-2')
    expect(before.dependenciesByRunId?.['run-5']).toEqual(
      expect.arrayContaining(['run-1', 'run-3', 'run-4'])
    )
    expect(before.stalenessByRunId['run-7']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv")', 'stale'],
      ['raw <- c(2,3)', 'stale'],
      ['lo <- 1L', 'stale'],
      ['hi <- 2L', 'stale'],
      ['which.min <- function(...) 1', 'unknown'],
      ['which.max <- function(...) 1', 'unknown']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-extreme-indices-change-'))
          .stalenessByRunId['run-7']
      ).toMatchObject({ state })
  })
})

describe('R bounded CSV logical summaries', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    'Summary.numeric',
    'Summary.default',
    'all.default',
    'any.default',
    'all.numeric',
    'any.numeric'
  ])('does not invent dispatch through %s', async (method) => {
    const { facts } = await analyzeRNotebookSource(
      'a <- base::all(df$x>0);b <- base::any(df$x>0);z <- mean(c(a,b))',
      { ...context, resolvedKernelNames: ['df', method] }
    )
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['a', 'b', 'z']))
    expect(facts.usedNames).not.toContain(method)
  })
  it('respects caller bindings and qualified identity', async () => {
    for (const name of ['all', 'any']) {
      const changed = { ...context, resolvedKernelNames: ['df', name] }
      expect(
        (await analyzeRNotebookSource('ok <- ' + name + '(df$x>0)', changed)).facts
          .rAtomicValueNames ?? []
      ).not.toContain('ok')
      expect(
        (await analyzeRNotebookSource('ok <- base::' + name + '(df$x>0)', changed)).facts
          .rAtomicValueNames
      ).toContain('ok')
      expect(
        (
          await analyzeRNotebookSource('ok <- base::' + name + '(df$x>0)', {
            ...context,
            resolvedKernelNames: ['df', '::']
          })
        ).facts.rAtomicValueNames ?? []
      ).not.toContain('ok')
    }
  })
  it('retains argument effects and context revocation', async () => {
    for (const name of ['all', 'any']) {
      for (const prefix of ['source("helper.R");', 'df$x <- structure(TRUE,class="sensor");']) {
        expect(
          (await analyzeRNotebookSource(prefix + 'ok <- ' + name + '(df$x);z <- mean(ok)', context))
            .facts.rAtomicValueNames ?? []
        ).not.toContain('ok')
      }
      const source = 'ok <- ' + name + '({writeLines("effect","logical.txt");df$x})'
      expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
        'logical.txt'
      )
      expect(
        (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
      ).not.toContain('ok')
    }
  })
  it('preserves both summary producers and downstream invalidation', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'raw <- df$x',
      'valid <- all(is.finite(raw))',
      'high <- any(raw>=4)',
      'mask <- (raw>=2)&valid&high;selected <- df[mask,,drop=FALSE]',
      'z <- mean(selected$x);s <- sd(selected$x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-logical-summaries-')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(before.dependenciesByRunId?.['run-4']).toContain('run-2')
    expect(before.dependenciesByRunId?.['run-5']).toEqual(
      expect.arrayContaining(['run-1', 'run-2', 'run-3', 'run-4'])
    )
    expect(before.stalenessByRunId['run-7']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv")', 'stale'],
      ['raw <- c(2,3)', 'stale'],
      ['valid <- FALSE', 'stale'],
      ['high <- FALSE', 'stale'],
      ['all <- function(...) TRUE', 'unknown'],
      ['any <- function(...) TRUE', 'unknown']
    ]) {
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-logical-summaries-change-'))
          .stalenessByRunId['run-7']
      ).toMatchObject({ state })
    }
  })
})

describe('R bounded CSV products', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each(['Summary.numeric', 'Summary.default', 'prod.numeric', 'prod.default'])(
    'does not invent implicit dispatch through %s',
    async (method) => {
      const { facts } = await analyzeRNotebookSource('p <- base::prod(df$x);z <- mean(p)', {
        ...context,
        resolvedKernelNames: ['df', method]
      })
      expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['p', 'z']))
      expect(facts.usedNames).not.toContain(method)
    }
  )
  it('respects caller binding and qualified identity', async () => {
    const changed = { ...context, resolvedKernelNames: ['df', 'prod'] }
    expect(
      (await analyzeRNotebookSource('p <- prod(df$x)', changed)).facts.rAtomicValueNames ?? []
    ).not.toContain('p')
    expect(
      (await analyzeRNotebookSource('p <- base::prod(df$x)', changed)).facts.rAtomicValueNames
    ).toContain('p')
    expect(
      (
        await analyzeRNotebookSource('p <- base::prod(df$x)', {
          ...context,
          resolvedKernelNames: ['df', '::']
        })
      ).facts.rAtomicValueNames ?? []
    ).not.toContain('p')
  })
  it('retains evaluated argument effects and type revocation', async () => {
    for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");'])
      expect(
        (await analyzeRNotebookSource(prefix + 'p <- prod(df$x);z <- mean(p)', context)).facts
          .rAtomicValueNames ?? []
      ).not.toContain('p')
    const source = 'p <- prod(0,{writeLines("effect","product.txt");df$x})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'product.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('p')
  })
  it('preserves product/root producers and downstream invalidation', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'x <- df$x',
      'p <- base::prod(x)',
      'root <- p^(1/length(x))',
      'scaled <- x/root',
      'z <- mean(scaled);s <- sd(scaled)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-products-')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(before.dependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining(['run-2', 'run-3'])
    )
    expect(before.dependenciesByRunId?.['run-5']).toEqual(
      expect.arrayContaining(['run-2', 'run-4'])
    )
    expect(before.stalenessByRunId['run-7']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv")', 'stale'],
      ['x <- c(2,3)', 'stale'],
      ['p <- 2', 'stale'],
      ['root <- 3', 'stale'],
      ['prod <- function(...) 1', 'clear']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-products-change-')).stalenessByRunId[
          'run-7'
        ]
      ).toMatchObject({ state })
    const bare = scripts.map((script) => script.replace('base::prod(x)', 'prod(x)'))
    expect(
      (await projectScripts('r', [...bare, 'prod <- function(...) 1'], 'csv-products-bare-change-'))
        .stalenessByRunId['run-7']
    ).toMatchObject({ state: 'unknown' })
  })
})

describe('R bounded CSV as.double conversion', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each(['as.double.numeric', 'as.double.default'])(
    'does not invent implicit dispatch through %s',
    async (method) => {
      const { facts } = await analyzeRNotebookSource('x <- base::as.double(df$x);z <- mean(x)', {
        ...context,
        resolvedKernelNames: ['df', method]
      })
      expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['x', 'z']))
      expect(facts.usedNames).not.toContain(method)
    }
  )
  it('respects bare and qualified coercion identity', async () => {
    const changed = { ...context, resolvedKernelNames: ['df', 'as.double'] }
    expect(
      (await analyzeRNotebookSource('x <- as.double(df$x)', changed)).facts.rAtomicValueNames ?? []
    ).not.toContain('x')
    expect(
      (await analyzeRNotebookSource('x <- base::as.double(df$x)', changed)).facts.rAtomicValueNames
    ).toContain('x')
    expect(
      (
        await analyzeRNotebookSource('x <- base::as.double(df$x)', {
          ...context,
          resolvedKernelNames: ['df', '::']
        })
      ).facts.rAtomicValueNames ?? []
    ).not.toContain('x')
    expect(
      (
        await analyzeRNotebookSource('x <- as.double(df$x)', {
          ...context,
          resolvedKernelNames: ['df', 'as.numeric']
        })
      ).facts.rAtomicValueNames
    ).toContain('x')
  })
  it('retains argument effects and context revocation', async () => {
    for (const prefix of ['source("helper.R");', 'df$x <- structure(1,class="sensor");'])
      expect(
        (await analyzeRNotebookSource(prefix + 'x <- as.double(df$x);z <- mean(x)', context)).facts
          .rAtomicValueNames ?? []
      ).not.toContain('x')
    const source = 'x <- as.double({writeLines("effect","coercion.txt");df$x})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'coercion.txt'
    )
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('x')
  })
  it('preserves conversion producers and downstream invalidation', async () => {
    const scripts = [
      'df <- read.csv("in.csv",colClasses="character")',
      'raw <- df$x',
      'x <- as.double(raw)',
      'z <- mean(x);s <- sd(x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const before = await projectScripts('r', scripts, 'csv-as-double-')
    expect(before.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(before.dependenciesByRunId?.['run-4']).toContain('run-3')
    expect(before.stalenessByRunId['run-5']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df <- read.csv("other.csv",colClasses="character")', 'stale'],
      ['raw <- c("2","3")', 'stale'],
      ['x <- c(2,3)', 'stale'],
      ['as.double <- function(...) 1', 'unknown']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-as-double-change-')).stalenessByRunId[
          'run-5'
        ]
      ).toMatchObject({ state })
    const qualified = scripts.map((s) => s.replace('as.double(raw)', 'base::as.double(raw)'))
    expect(
      (
        await projectScripts(
          'r',
          [...qualified, 'as.double <- function(...) 1'],
          'csv-as-double-qualified-change-'
        )
      ).stalenessByRunId['run-5']
    ).toMatchObject({ state: 'clear' })
  })
  it('preserves copy-on-modify through a converted column alias', async () => {
    const source = 'converted <- as.double(df$x)'
    expect((await analyzeRNotebookSource(source, context)).facts.copyOnModifyNames).toContain(
      'converted'
    )
    expect(
      (
        await analyzeRNotebookSource(
          'converted <- as.double(structure(df$x,class="sensor"))',
          context
        )
      ).facts.copyOnModifyNames ?? []
    ).not.toContain('converted')
    const scripts = [
      'df <- read.csv("in.csv",colClasses="character")',
      'raw <- df$x',
      'converted <- base::as.double(raw)',
      'x <- converted',
      'z <- mean(x);s <- sd(x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const projection = await projectScripts('r', scripts, 'csv-as-double-alias-')
    expect(projection.dependenciesByRunId?.['run-4']).toContain('run-3')
    expect(projection.dependenciesByRunId?.['run-5']).toContain('run-4')
    expect(projection.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    expect(
      (
        await projectScripts(
          'r',
          [...scripts, 'converted <- c(2,3)'],
          'csv-as-double-alias-change-'
        )
      ).stalenessByRunId['run-6']
    ).toMatchObject({ state: 'stale' })
  })
})

describe('R bounded CSV is.double inspection', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df', 'obj']
  }
  it.each(['is.double.sensor', 'is.double.numeric', 'is.double.default'])(
    'does not invent dispatch through %s',
    async (method) => {
      const { facts } = await analyzeRNotebookSource(
        'flag <- base::is.double(structure(1,class="sensor"));z <- mean(flag)',
        { ...context, resolvedKernelNames: ['df', method] }
      )
      expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['flag', 'z']))
      expect(facts.usedNames).not.toContain(method)
    }
  )
  it('respects bare and qualified predicate identity', async () => {
    const changed = { ...context, resolvedKernelNames: ['df', 'obj', 'is.double'] }
    expect(
      (await analyzeRNotebookSource('flag <- is.double(obj)', changed)).facts.rAtomicValueNames ??
        []
    ).not.toContain('flag')
    expect(
      (await analyzeRNotebookSource('flag <- base::is.double(obj)', changed)).facts
        .rAtomicValueNames
    ).toContain('flag')
    expect(
      (
        await analyzeRNotebookSource('flag <- base::is.double(obj)', {
          ...context,
          resolvedKernelNames: ['df', 'obj', '::']
        })
      ).facts.rAtomicValueNames ?? []
    ).not.toContain('flag')
  })
  it('retains evaluation effects independently of a logical return', async () => {
    const source = 'flag <- is.double({writeLines("effect","predicate.txt");obj})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'predicate.txt'
    )
    expect((await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames).toContain(
      'flag'
    )
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'flag <- is.double(factory(obj))', context))
        .externalState
    ).toBe('partial')
  })
  it('does not promote the inspected input to an ordinary value', async () => {
    const { facts } = await analyzeRNotebookSource(
      'flag <- is.double(obj);x <- as.double(obj);z <- mean(x)',
      context
    )
    expect(facts.rAtomicValueNames).toContain('flag')
    expect(facts.rAtomicValueNames ?? []).not.toContain('x')
    expect(facts.rAtomicValueNames ?? []).not.toContain('z')
  })
  it('preserves predicate and copied-flag producer dependencies', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'converted <- as.double(df$x)',
      'flag <- is.double(converted)',
      'ok <- flag',
      'x <- converted[is.finite(converted)&ok]',
      'z <- mean(x);write.csv(z,"out.csv")'
    ]
    const p = await projectScripts('r', scripts, 'csv-is-double-')
    expect(p.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(p.dependenciesByRunId?.['run-4']).toContain('run-3')
    expect(p.dependenciesByRunId?.['run-5']).toEqual(expect.arrayContaining(['run-2', 'run-4']))
    expect(p.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
    for (const change of ['converted <- c(2,3)', 'flag <- FALSE', 'ok <- FALSE'])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-is-double-change-')).stalenessByRunId[
          'run-6'
        ]
      ).toMatchObject({ state: 'stale' })
  })
  it('does not retroactively poison ordinary science consumers', async () => {
    const scripts = [
      'df <- read.csv("in.csv")',
      'x <- as.double(df$x)',
      'z <- mean(x);write.csv(z,"out.csv")',
      'stopifnot(is.double(x))'
    ]
    expect(
      (await projectScripts('r', scripts, 'csv-is-double-after-')).stalenessByRunId['run-3']
    ).toMatchObject({ state: 'clear' })
    expect(
      (
        await projectScripts(
          'r',
          [
            ...scripts.slice(0, 3),
            'is.double <- function(x) {source("helper.R");TRUE}',
            scripts[3]
          ],
          'csv-is-double-shadowed-'
        )
      ).stalenessByRunId['run-3']
    ).toMatchObject({ state: 'unknown' })
  })
})

describe('R bounded CSV differences', () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    'double',
    'numeric',
    'integer',
    'logical',
    'complex',
    'character',
    'raw',
    'NULL',
    'default'
  ])('withholds ordinary result when diff.%s can dispatch', async (type) => {
    const changed = { ...context, resolvedKernelNames: ['df', 'diff.' + type] }
    for (const call of ['diff(df$x)', 'base::diff(df$x)', 'base::diff(c(1,3,6))']) {
      const source = 'delta <- ' + call + ';z <- mean(delta)'
      expect(
        (await analyzeRNotebookSource(source, changed)).facts.rAtomicValueNames ?? []
      ).not.toContain('delta')
      expect((await analyzeNotebookSourceFileAccess('r', source, changed)).externalState).toBe(
        'partial'
      )
    }
  })
  it('respects function, namespace, nested dispatch and CSV revocation', async () => {
    for (const [source, names] of [
      ['delta<-diff(df$x)', ['df', 'diff']],
      ['delta<-base::diff(df$x)', ['df', '::']],
      ['delta<-diff(range(df$x))', ['df', 'range.default']],
      ['source("helper.R");delta<-diff(df$x)', ['df']],
      ['df$x<-structure(1,class="sensor");delta<-diff(df$x)', ['df']]
    ] as [string, string[]][]) {
      expect(
        (await analyzeRNotebookSource(source, { ...context, resolvedKernelNames: names })).facts
          .rAtomicValueNames ?? []
      ).not.toContain('delta')
    }
    expect(
      (
        await analyzeRNotebookSource('delta<-base::diff(df$x)', {
          ...context,
          resolvedKernelNames: ['df', 'diff']
        })
      ).facts.rAtomicValueNames
    ).toContain('delta')
    const source = 'delta<-diff({writeLines("effect","diff.txt");df$x})'
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'diff.txt'
    )
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'delta<-diff(factory(df$x))', context))
        .externalState
    ).toBe('partial')
  })
  it('retains inline and stored column producer dependencies and invalidates methods', async () => {
    for (const expression of ['df$x', 'raw']) {
      const scripts = [
        'df<-read.csv("in.csv")',
        'raw<-df$x',
        'delta<-base::diff(' + expression + ')',
        'copy<-delta',
        'z<-mean(copy);s<-sd(copy)',
        'write.csv(c(z,s),"out.csv")'
      ]
      const p = await projectScripts('r', scripts, 'csv-diff-')
      expect(p.dependenciesByRunId?.['run-3']).toContain(expression === 'raw' ? 'run-2' : 'run-1')
      expect(p.dependenciesByRunId?.['run-4']).toContain('run-3')
      expect(p.stalenessByRunId['run-6']).toMatchObject({ state: 'clear' })
      for (const [change, state] of [
        ['df<-read.csv("other.csv")', 'stale'],
        ['delta<-c(1,2)', 'stale'],
        ['diff.numeric<-function(x,...) structure(1,class="sensor")', 'unknown'],
        ['diff.default<-function(x,...) structure(1,class="sensor")', 'unknown'],
        ['diff<-function(x,...) 1', 'clear']
      ])
        expect(
          (await projectScripts('r', [...scripts, change], 'csv-diff-change-')).stalenessByRunId[
            'run-6'
          ]
        ).toMatchObject({ state })
    }
  })
})

describe.each(['as.double', 'as.numeric'])('R bounded CSV scaled conversion via %s', (coercion) => {
  const sourceFor = (source: string): string =>
    source === 'as.double(matrix(1:4,2))' && coercion === 'as.numeric'
      ? 'as.numeric(scale(matrix(1:4,2)))'
      : source.replaceAll('as.double', coercion)

  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    resolvedKernelNames: ['df']
  }
  it.each([
    sourceFor('as.double(scale(df$x))'),
    sourceFor('base::as.double(base::scale(df[["x"]]))'),
    sourceFor('as.double(x=scale(x=df$x,center=TRUE,scale=TRUE))'),
    sourceFor('as.double(scale(df$x,center=FALSE,scale=FALSE))'),
    sourceFor('as.double(scale(df$x,center=2,scale=3))'),
    sourceFor('as.double(base::scale.default(df$x))'),
    sourceFor('as.double(scale(as.double(df$x)))'),
    sourceFor('as.double(scale(df$x[is.finite(df$x)]))')
  ])('proves the explicitly flattened result: %s', async (call) => {
    const source =
      'converted<-' + call + ';z<-mean(converted);s<-sd(converted);write.csv(c(z,s),"out.csv")'
    const { facts } = await analyzeRNotebookSource(source, context)
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['converted', 'z', 's']))
    expect(facts.copyOnModifyNames).toContain('converted')
    expect(facts.priorUsedNames).toEqual(
      expect.arrayContaining(['df', 'as.matrix.numeric', 'aperm.matrix'])
    )
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
  it.each([
    'scale.numeric',
    'scale.integer',
    'scale.default',
    'as.matrix.numeric',
    'as.matrix.integer',
    'aperm.matrix',
    'aperm.array'
  ])('retains uncertainty for a replaced scale method: %s', async (method) => {
    const changed = { ...context, resolvedKernelNames: ['df', method] }
    const source = sourceFor('converted<-base::as.double(base::scale(df$x));z<-mean(converted)')
    expect(
      (await analyzeRNotebookSource(source, changed)).facts.rAtomicValueNames ?? []
    ).not.toContain('converted')
    expect((await analyzeNotebookSourceFileAccess('r', source, changed)).externalState).toBe(
      'partial'
    )
  })
  it.each([
    sourceFor('as.double(scale(other))'),
    sourceFor('as.double(scale(df))'),
    sourceFor('as.double(scale(structure(df$x,class="sensor")))'),
    sourceFor('as.double(scale(df$x,center=option))'),
    sourceFor('as.double(scale(df$x,scale=option))'),
    sourceFor('as.double(scale(df$x,extra=1))'),
    sourceFor('as.double(scale(df$x),extra=1)'),
    sourceFor('as.double(x=scale(df$x),x=df$x)'),
    sourceFor('as.double(other::scale(df$x))'),
    sourceFor('other::as.double(scale(df$x))'),
    sourceFor('as.double(matrix(1:4,2))')
  ])('withholds unsupported conversion evidence: %s', async (call) => {
    const { facts } = await analyzeRNotebookSource('converted<-' + call, context)
    expect(facts.rAtomicValueNames ?? []).not.toContain('converted')
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'converted<-' + call, context)).externalState
    ).toBe('partial')
  })
  it('does not promote a matrix or an unproved stored matrix binding', async () => {
    const { facts } = await analyzeRNotebookSource(
      sourceFor('m<-scale(df$x);converted<-as.double(m)'),
      context
    )
    expect(facts.rAtomicValueNames ?? []).not.toContain('m')
    expect(facts.rAtomicValueNames ?? []).not.toContain('converted')
  })
  it('checks function/operator identity while ignoring nonexistent implicit coercion dispatch', async () => {
    for (const [code, names] of [
      [sourceFor('converted<-as.double(scale(df$x))'), ['df', sourceFor('as.double')]],
      [sourceFor('converted<-as.double(scale(df$x))'), ['df', 'scale']],
      [sourceFor('converted<-base::as.double(base::scale(df$x))'), ['df', '::']]
    ] as [string, string[]][])
      expect(
        (await analyzeRNotebookSource(code, { ...context, resolvedKernelNames: names })).facts
          .rAtomicValueNames ?? []
      ).not.toContain('converted')
    const { facts } = await analyzeRNotebookSource(
      sourceFor('converted<-base::as.double(base::scale.default(df$x))'),
      {
        ...context,
        resolvedKernelNames: [
          'df',
          sourceFor('as.double'),
          'scale',
          'scale.default',
          sourceFor('as.double.matrix'),
          sourceFor('as.double.array'),
          sourceFor('as.double.default'),
          'as.matrix.default'
        ]
      }
    )
    expect(facts.rAtomicValueNames).toContain('converted')
    expect(facts.usedNames).not.toContain(sourceFor('as.double.matrix'))
  })
  it('retains argument effects and revoked CSV proof', async () => {
    const source = sourceFor('converted<-as.double(scale({writeLines("effect","scale.txt");df$x}))')
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).writes).toContain(
      'scale.txt'
    )
    for (const prefix of ['source("helper.R");', 'df$x<-structure(1,class="sensor");'])
      expect(
        (
          await analyzeRNotebookSource(
            prefix + sourceFor('converted<-as.double(scale(df$x))'),
            context
          )
        ).facts.rAtomicValueNames ?? []
      ).not.toContain('converted')
  })
  it('retains producers and invalidates downstream exports after data or method changes', async () => {
    const scripts = [
      'df<-read.csv("in.csv")',
      sourceFor('converted<-base::as.double(base::scale(df$x))'),
      'x<-converted',
      'z<-mean(x);s<-sd(x)',
      'write.csv(c(z,s),"out.csv")'
    ]
    const p = await projectScripts('r', scripts, 'csv-scaled-double-')
    expect(p.dependenciesByRunId?.['run-2']).toContain('run-1')
    expect(p.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(p.stalenessByRunId['run-5']).toMatchObject({ state: 'clear' })
    for (const [change, state] of [
      ['df<-read.csv("other.csv")', 'stale'],
      ['converted<-c(1,2)', 'stale'],
      ['scale.numeric<-function(x,...) structure(x,class="sensor")', 'unknown'],
      ['as.matrix.numeric<-function(x,...) x', 'unknown'],
      ['aperm.matrix<-function(a,...) a', 'unknown'],
      ['scale<-function(x,...) x', 'clear'],
      [sourceFor('as.double<-function(x,...) x'), 'clear']
    ])
      expect(
        (await projectScripts('r', [...scripts, change], 'csv-scaled-double-change-'))
          .stalenessByRunId['run-5']
      ).toMatchObject({ state })
  })
})

describe.each([
  {
    name: 'NA vectors',
    known: [
      'na.omit(df$x)',
      'stats::na.omit(df[,"x"])',
      'na.exclude(df[["x"]])',
      'na.exclude(NULL)'
    ],
    unknown: [
      'na.omit(other)',
      'na.omit(structure(df$x,class="sensor"))',
      'na.omit(as.list(df$x))',
      'na.exclude(df$x,extra=TRUE)',
      'na.omit(obj=df$x)',
      'na.exclude(df$x,object=df$x)'
    ]
  },
  {
    name: 'head tail vectors',
    known: ['head(df$x)', 'utils::head(df[,"x"],3)', 'tail(df[["x"]],2)', 'head(NULL)'],
    unknown: [
      'head(other,2)',
      'head(structure(df$x,class="sensor"),2)',
      'head(as.list(df$x),2)',
      'head(df$x,rows)',
      'head(df$x,structure(2,class="sensor"))',
      'head(df$x,n=2,extra=TRUE)',
      'head(df$x,n=2,n=3)',
      'head(df$x,nu=2)',
      'tail(df$x,2,keepnums=flag)',
      'tail(df$x,2,addrownums=TRUE)'
    ]
  },
  {
    name: 'missing masks',
    known: [
      'is.na(df$x)',
      'base::is.na(df[,"x"])',
      'is.na(x=df[["x"]])',
      '!is.na(df$x)&!is.na(df$y)',
      'is.na(NULL)'
    ],
    unknown: [
      'is.na(other)',
      'is.na(df)',
      'is.na(as.list(df$x))',
      'is.na(structure(df$x,class="sensor"))',
      'is.na(df$x,TRUE)',
      'is.na(df$x,extra=TRUE)',
      'is.na(x=df$x,x=df$y)',
      'is.na()',
      'other::is.na(df$x)'
    ]
  },
  {
    name: 'complete cases masks',
    known: [
      'complete.cases(df)',
      'stats::complete.cases(df)',
      'complete.cases(df$x)',
      'complete.cases(na.omit(df))'
    ],
    unknown: [
      'complete.cases(other)',
      'complete.cases(as.list(df$x))',
      'complete.cases(structure(df$x,class="sensor"))',
      'complete.cases(data.frame(x=other))',
      'other::complete.cases(df)',
      'complete.cases()',
      'complete.cases(NULL)',
      'complete.cases(x=df$x)',
      'complete.cases(df$x,extra=TRUE)'
    ]
  },
  {
    name: 'which indices',
    known: [
      'which(df$x>0)',
      'base::which(df$x>0)',
      'which(x=df$x>0)',
      'which(!is.na(df$x))',
      'which(logical())'
    ],
    unknown: [
      'which(other)',
      'which(df)',
      'which(structure(mask,class="sensor"))',
      'which(mask,arr.ind=TRUE)',
      'which(mask,arr.ind=flag)',
      'which(mask,useNames=flag)',
      'which(mask,extra=FALSE)',
      'which(x=mask,x=mask)',
      'which(mask,arr=FALSE)',
      'which()',
      'which(NULL)',
      'which(mask,useNames=NA)',
      'other::which(mask)'
    ]
  },
  {
    name: 'sum totals',
    known: ['sum(df$x)', 'base::sum(df[,"x"])', 'sum(df$x,df$y)', 'sum(is.finite(df$x))', 'sum()'],
    unknown: [
      'sum(other)',
      'sum(df)',
      'sum(structure(df$x,class="sensor"))',
      'sum(as.list(df$x))',
      'sum(df$x,na.rm=flag)',
      'sum(df$x,na.rm=NA)',
      'sum(df$x,na.rm=TRUE,na.rm=FALSE)',
      'sum(x=df$x)',
      'sum(df$x,extra=TRUE)',
      'sum(df$x,na=TRUE)',
      'other::sum(df$x)'
    ]
  },
  {
    name: 'membership masks',
    known: [
      'df$x %in% c(1,2)',
      'base::`%in%`(df$x,c(1,2))',
      'base::`%in%`(x=df$x,table=c(1,2))',
      'df$x %in% c(1,2) & !is.na(df$y)'
    ],
    unknown: [
      'other %in% targets',
      'df$x %in% other',
      'df %in% targets',
      'df$x %in% df',
      'structure(df$x,class="sensor") %in% targets',
      'df$x %in% structure(targets,class="sensor")',
      'as.list(df$x) %in% targets',
      'df$x %in% as.list(targets)',
      'base::`%in%`(df$x,targets,extra=TRUE)',
      'base::`%in%`(x=df$x,x=df$x,table=targets)',
      'base::`%in%`(df$x,t=targets)',
      'other::`%in%`(df$x,targets)',
      'base::`%in%`()'
    ]
  },
  {
    name: 'unname vectors',
    known: [
      'unname(df$x)',
      'base::unname(df[,"x"])',
      'unname(obj=df[["x"]])',
      'unname(quantile(df$x,probs=c(0.25,0.75)))',
      'unname(NULL)'
    ],
    unknown: [
      'unname(other)',
      'unname(df)',
      'unname(as.list(df$x))',
      'unname(structure(df$x,class="sensor"))',
      'unname(df$x,force=flag)',
      'unname(df$x,force=NA)',
      'unname(df$x,force=TRUE,force=FALSE)',
      'unname(df$x,extra=TRUE)',
      'unname(ob=df$x)',
      'other::unname(df$x)',
      'unname()'
    ]
  },
  {
    name: 'ifelse transformations',
    known: [
      'ifelse(df$x>2,2,df$x)',
      'base::ifelse(df$x>2,2,df$x)',
      'ifelse(test=df$x>2,yes=2,no=df$x)',
      'ifelse(df$x<lower,lower,ifelse(df$x>upper,upper,df$x))'
    ],
    unknown: [
      'ifelse(other,1,2)',
      'ifelse(df$x>2,other,df$x)',
      'ifelse(df$x>2,df$x,other)',
      'ifelse(structure(c(TRUE,FALSE),class="flag"),1,2)',
      'ifelse(df$x>2,structure(1,class="sensor"),2)',
      'ifelse(df$x>2,1,structure(2,class="sensor"))',
      'ifelse(df,1,2)',
      'ifelse(df$x>2,as.list(df$x),2)',
      'ifelse(TRUE,function()1,2)',
      'ifelse(test=df$x>2,yes=1,no=2,extra=3)',
      'ifelse(test=df$x>2,test=TRUE,yes=1,no=2)',
      'ifelse(t=df$x>2,yes=1,no=2)',
      'ifelse(df$x>2,1)',
      'other::ifelse(df$x>2,1,2)'
    ]
  },
  {
    name: 'extreme indices',
    known: ['which.min', 'which.max'].flatMap((name) => [
      name + '(df$x)',
      'base::' + name + '(df[,"x"])',
      name + '(x=df[["x"]])',
      name + '(numeric())'
    ]),
    unknown: ['which.min', 'which.max'].flatMap((name) => [
      name + '(other)',
      name + '(df)',
      name + '(as.list(df$x))',
      name + '(structure(df$x,class="sensor"))',
      name + '(df$x,extra=TRUE)',
      name + '(x=df$x,x=df$x)',
      name + '()'
    ])
  },
  {
    name: 'logical summaries',
    known: ['all', 'any'].flatMap((name) => [
      name + '(is.finite(df$x))',
      'base::' + name + '(df[["x"]]>=2)',
      name + '(df$x>0,na.rm=TRUE)',
      name + '(logical())'
    ]),
    unknown: ['all', 'any'].flatMap((name) => [
      name + '(other)',
      name + '(df)',
      name + '(as.list(df$x))',
      name + '(structure(df$x,class="sensor"))',
      name + '(x=df$x)',
      name + '(df$x,na.rm=flag)',
      name + '(df$x,na.rm=TRUE,na.rm=FALSE)',
      name + '(df$x,na=TRUE)'
    ])
  },
  {
    name: 'products',
    known: ['prod(df$x)', 'base::prod(df[["x"]])', 'prod(2,df$x)', 'prod(numeric())'],
    unknown: [
      'prod(other)',
      'prod(df)',
      'prod(as.list(df$x))',
      'prod(structure(df$x,class="sensor"))',
      'prod(x=df$x)',
      'prod(df$x,na.rm=flag)',
      'prod(df$x,na.rm=TRUE,na.rm=FALSE)',
      'prod(df$x,na=TRUE)'
    ]
  },
  {
    name: 'as.double conversion',
    known: ['as.double(df$x)', 'base::as.double(df[["x"]])', 'as.double(x=df$x)', 'as.double()'],
    unknown: [
      'as.double(other)',
      'as.double(df)',
      'as.double(as.list(df$x))',
      'as.double(structure(df$x,class="sensor"))',
      'as.double(df$x,extra=1)',
      'as.double(x=df$x,x=df$x)',
      'as.double(y=df$x)',
      'other::as.double(df$x)'
    ]
  },
  {
    name: 'is.double inspection',
    known: [
      'is.double(df$x)',
      'base::is.double(df[["x"]])',
      'is.double(x=obj)',
      'is.double(new.env())'
    ],
    unknown: [
      'is.double()',
      'is.double(x=)',
      'is.double(x=obj,x=obj)',
      'is.double(obj,extra=1)',
      'is.double(y=obj)',
      'other::is.double(obj)'
    ]
  },
  {
    name: 'differences',
    known: [
      'diff(df$x)',
      'base::diff(df[["x"]])',
      'diff(x=df$x,lag=2,differences=2)',
      'diff(df$x[is.finite(df$x)])'
    ],
    unknown: [
      'diff(other)',
      'diff(df)',
      'diff(structure(df$x,class="sensor"))',
      'diff(df$x,lag=0)',
      'diff(df$x,lag=1.5)',
      'diff(df$x,differences=0)',
      'diff(df$x,differences=k)',
      'diff(df$x,extra=1)',
      'diff(x=df$x,x=df$x)',
      'diff(y=df$x)',
      'other::diff(df$x)'
    ]
  }
])('CSV primitive value contract: $name', ({ name, known, unknown }) => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAtomicTableNames: ['df'],
    rCopyOnModifyNames: ['df'],
    rAtomicValueNames: ['mask', 'targets', 'lower', 'upper', 'count'],
    resolvedKernelNames: ['df', 'obj', 'mask', 'targets', 'lower', 'upper', 'count']
  }
  it.each(known)('retains ordinary results through science and export: %s', async (expression) => {
    const source = 'value<-' + expression + ';summary<-mean(value);write.csv(summary,"out.csv")'
    const { facts } = await analyzeRNotebookSource(source, context)
    expect(facts.rAtomicValueNames).toEqual(expect.arrayContaining(['value', 'summary']))
    if (['as.double conversion', 'is.double inspection', 'differences'].includes(name))
      expect(facts.copyOnModifyNames).toContain('value')
    if (name === 'differences')
      expect(facts.priorUsedNames).toEqual(
        expect.arrayContaining(['df', 'diff.numeric', 'diff.integer', 'diff.default'])
      )
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
  it.each(unknown)('withholds unproved result and effect authority: %s', async (expression) => {
    const source = 'value<-' + expression + ';summary<-mean(value)'
    expect(
      (await analyzeRNotebookSource(source, context)).facts.rAtomicValueNames ?? []
    ).not.toContain('value')
    expect((await analyzeNotebookSourceFileAccess('r', source, context)).externalState).toBe(
      'partial'
    )
  })
})
