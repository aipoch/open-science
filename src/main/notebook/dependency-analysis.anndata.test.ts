import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzePythonSources } from './dependency-analysis-python'
import { projectNotebookDependencies } from './dependency-projection'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const analyzedPythonPath = (value: string): string =>
  process.platform === 'win32' ? value.replaceAll('/', '\\') : value

it.each(['scanpy', 'anndata', 'anndata.io'])(
  'keeps %s file provenance and object mutation knowledge aligned',
  async (module) => {
    for (const reader of ['read_h5ad', 'read_mtx', 'read_loom', 'read_text', 'read_csv']) {
      const scripts = [
        `from ${module} import ${reader} as read_input\nitem = read_input(filename="inputs/cells.dat")`,
        'snapshot = item.n_obs\nprint(snapshot)',
        'item.obs_names_make_unique()'
      ]
      const facts = await analyzePythonSources(scripts)
      const analyzed = scripts.map((script, index) => {
        const run: NotebookRunRecord = {
          runId: `run-${index}`,
          cellId: `cell-${index}`,
          source: 'agent',
          kernelKind: 'python',
          kernelEpochId: 'epoch',
          environment: 'default-python',
          script,
          status: 'completed',
          startedAt: index,
          endedAt: index,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: [],
          inputFiles: []
        }
        return { run, facts: facts[index]! }
      })
      const projection = projectNotebookDependencies(analyzed)
      expect(projection.stalenessByRunId['run-1']).toMatchObject({ state: 'stale' })
      expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
      expect(await analyzeNotebookSourceFileAccess('python', scripts[0]!)).toMatchObject({
        readState: 'complete',
        reads: ['inputs/cells.dat']
      })
    }
  }
)

it('does not confuse a module text reader with a Path method', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'import scanpy as sc\nx = sc.read_text("inputs/cells.tsv")'
    )
  ).toMatchObject({ readState: 'complete', reads: ['inputs/cells.tsv'] })
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'from pathlib import Path\nx = Path("inputs/notes.txt").read_text()'
    )
  ).toMatchObject({
    readState: 'complete',
    reads: [analyzedPythonPath('inputs/notes.txt')]
  })
})

it('captures direct pyplot plotting as a known read', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import matplotlib.pyplot as plt',
        'plt.plot([0, 1, 2], [0, 1, 4])',
        'plt.scatter([0, 1, 2], [0, 1, 4])',
        'plt.bar([0, 1], [2, 3])',
        'plt.hist([0, 1, 1, 2])',
        'plt.errorbar([0, 1], [2, 3], yerr=[0.1, 0.2])',
        'plt.xlabel("value")',
        'plt.ylabel("count")',
        'plt.legend()'
      ].join('\n')
    )
  ).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: [],
    writes: []
  })
})

it('captures PIL image construction and output lineage', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import numpy as np',
        'from PIL import Image',
        'import matplotlib.pyplot as plt',
        'mask = Image.fromarray(np.zeros((2, 2), dtype=np.uint8))',
        'mask.save("outputs/mask.png")',
        'plt.imshow(mask, cmap="gray")',
        'plt.axis("off")'
      ].join('\n')
    )
  ).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: [],
    writes: ['outputs/mask.png']
  })
})

it.each([
  'custom.pp.normalize_total(data)',
  'custom.pl.umap(data)',
  'custom.tl.pca(data)',
  'import scanpy as sc\nsc = custom\nsc.pp.normalize_total(data)',
  'import scanpy as sc\nsc.pp = custom\nsc.pp.normalize_total(data)'
])('does not infer Scanpy effects from an untrusted receiver: %s', async (source) => {
  const [facts] = await analyzePythonSources([`custom = object()\n${source}`])
  expect(facts).toMatchObject({ state: 'unknown' })
  expect(facts?.pythonPlottingState).toBeUndefined()
})

it('tracks conservative AnnData mutation evidence across Scanpy namespaces', async () => {
  const scripts = [
    'import anndata as ad\nimport scanpy as sc\nadata = ad.read_h5ad("inputs/cells.h5ad")',
    'sc.pp.normalize_total(adata)\nsc.pp.log1p(adata)\nsc.tl.pca(adata)\nsc.pl.umap(adata)',
    'print(adata.obs.head())'
  ]
  const facts = await analyzePythonSources(scripts, {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    pythonBindings: [{ name: 'sc', qualifiedName: 'scanpy', kind: 'import' }]
  })
  expect(facts[1]).toMatchObject({
    pythonPlottingState: { reads: true },
    receiverCalls: expect.arrayContaining([
      expect.objectContaining({ receiver: 'sc', member: 'normalize_total' })
    ])
  })
})

it('recognizes local Visium objects and spatial plotting across notebook cells', async () => {
  const scripts = [
    'import scanpy as sc\nadata = sc.read_visium("inputs/visium_sample")',
    'sc.pp.normalize_total(adata)\nsc.pl.spatial(adata, color="gene_a")',
    'adata.write_h5ad("outputs/visium.h5ad")'
  ]
  const facts = await analyzePythonSources(scripts, {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    pythonBindings: [{ name: 'sc', qualifiedName: 'scanpy', kind: 'import' }]
  })
  expect(facts[0]?.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'adata', typeName: 'anndata.AnnData' })
    ])
  )
  expect(facts[1]).toMatchObject({
    pythonPlottingState: { reads: true },
    receiverCalls: expect.arrayContaining([
      expect.objectContaining({ receiver: 'sc', member: 'spatial' })
    ])
  })
})

it.each([
  ['write_h5ad', '', 'stale'],
  ['write', '', 'stale'],
  ['write_h5ad', ', convert_strings_to_categoricals=True', 'stale'],
  ['write_h5ad', ', convert_strings_to_categoricals=False', 'clear'],
  ['write_h5ad', ', convert_strings_to_categoricals=flag', 'unknown'],
  ['write_h5ad', ', **options', 'unknown']
])('tracks %s conversion side effects (%s)', async (method, options, expected) => {
  const scripts = [
    'import anndata as ad\nitem = ad.read_h5ad("cells.h5ad")',
    'snapshot = item.obs.copy()',
    `item.${method}("result.h5ad"${options})`
  ]
  const facts = await analyzePythonSources(scripts)
  const projection = projectNotebookDependencies(
    scripts.map((script, index) => {
      const run: NotebookRunRecord = {
        runId: `run-${index}`,
        cellId: `cell-${index}`,
        source: 'agent',
        kernelKind: 'python',
        kernelEpochId: 'epoch',
        environment: 'default-python',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }
      return { run, facts: facts[index]! }
    })
  )
  expect(projection.stalenessByRunId['run-1']?.state).toBe(expected)
})

configureTestRuntimeMetadata()
