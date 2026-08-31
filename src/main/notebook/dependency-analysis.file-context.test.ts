import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Parser } from 'web-tree-sitter'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import type { NotebookSourceFileAccessContext } from './dependency-analysis-types'
import { projectNotebookFileContext, type FileContextEntry } from './dependency-file-context'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fileContext = async (
  language: 'python' | 'r',
  scripts: string[],
  overrides: Array<Partial<NotebookRunRecord>> = [],
  precompute = true,
  corruptCache?: (json: string) => string
): Promise<NotebookSourceFileAccessContext | undefined> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
  roots.push(storageRoot)
  const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
    runId: `run-${index}`,
    cellId: `cell-${index}`,
    source: 'agent',
    inputKind: 'cell',
    kernelKind: language,
    kernelEpochId: 'epoch-1',
    environment: `default-${language}`,
    script,
    status: 'completed',
    startedAt: index,
    endedAt: index,
    executionCount: index,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    inputFiles: [],
    ...overrides[index]
  }))
  const repository = { readSessionRuns: async () => runs }
  if (precompute)
    await new NotebookDependencyAnalyzer({ storageRoot, repository }).project({
      projectId: 'default-project',
      sessionId: 'session-1'
    })
  // Reload persisted facts, just as the file observer does after an app restart.
  if (corruptCache) {
    const cachePath = join(
      storageRoot,
      'notebooks/default-project/session-1/cache/dependency-analysis.json'
    )
    await writeFile(cachePath, corruptCache(await readFile(cachePath, 'utf8')))
  }
  return new NotebookDependencyAnalyzer({ storageRoot, repository }).sourceFileAccessContext({
    projectId: 'default-project',
    sessionId: 'session-1',
    currentRunId: 'next-run',
    language,
    environment: `default-${language}`,
    kernelEpochId: 'epoch-1'
  })
}

describe('file context after mutable path collections', () => {
  it('retains R logical subsets across blocks and cache reloads', async () => {
    const context = await fileContext('r', [
      'paths <- c("keep.txt", "skip.txt", "last.txt")',
      'selected <- paths[c(TRUE,FALSE)]',
      'paths <- c("replacement.txt")'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('r', 'for (path in selected) readLines(path)', context)
    ).toMatchObject({
      reads: ['keep.txt', 'last.txt'],
      readState: 'complete'
    })
  })

  it('retains shadowed R sequence identity across cache reloads', async () => {
    const context = await fileContext('r', [
      'paths <- c("keep.txt", "skip.txt")',
      'seq_along <- function(x) c(2L)'
    ])
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'for (path in paths[seq_along(paths)]) readLines(path)',
          context
        )
      ).readState
    ).toBe('partial')
  })

  it.each(['python', 'r'] as const)(
    'retains independent %s subsets after the original changes and the cache reopens',
    async (language) => {
      const scripts =
        language === 'python'
          ? ['paths = ["keep.txt", "other.txt"]', 'selected = paths[:]', 'paths[0] = "changed.txt"']
          : [
              'paths <- c("keep.txt", "other.txt")',
              'selected <- paths[c(1,2)]',
              'paths[1] <- "changed.txt"'
            ]
      const context = await fileContext(language, scripts)
      const code = language === 'python' ? 'open(selected[0]).read()' : 'readLines(selected[[1]])'
      expect(await analyzeNotebookSourceFileAccess(language, code, context)).toMatchObject({
        reads: ['keep.txt'],
        readState: 'complete'
      })
      expect(context?.staticCollections.some(({ name }) => name === 'paths')).toBe(false)
    }
  )
  it.each(['python', 'r'] as const)(
    'shares parsing when projecting %s dependency and path context',
    async (language) => {
      const source =
        language === 'python' ? 'path = "inputs/counts.csv"' : 'path <- "inputs/counts.csv"'
      await analyzeNotebookSourceFileAccess(language, source)
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const context = await fileContext(language, [source])
      expect(context?.staticStrings).toContainEqual({ name: 'path', value: 'inputs/counts.csv' })
      expect(parse).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    [
      'python',
      'import xarray as xr\ndef read_inputs(paths):\n    return xr.open_mfdataset(paths)',
      'read_inputs(["inputs/a.nc", "inputs/b.nc"])',
      'paths',
      ['inputs/a.nc', 'inputs/b.nc']
    ],
    [
      'python',
      'import numpy as np\ndef read_inputs(lines):\n    return np.loadtxt(lines)',
      'read_inputs(["1 2", "3 4"])',
      'lines',
      []
    ],
    [
      'r',
      'read_inputs <- function(paths) Biostrings::readDNAStringSet(paths)',
      'read_inputs(c("inputs/a.fa", "inputs/b.fa"))',
      'paths',
      ['inputs/a.fa', 'inputs/b.fa']
    ]
  ] as const)(
    'retains %s wrapper input forms after cache reload',
    async (language, setup, call, inputForm, reads) => {
      const context = await fileContext(language, [setup])
      expect(context?.localFileWrappers).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'read_inputs', inputForm })])
      )
      expect(await analyzeNotebookSourceFileAccess(language, call, context)).toMatchObject({
        readState: 'complete',
        reads
      })
    }
  )

  it('does not reuse a builtin callback after same-run replacement and reopening', async () => {
    const context = await fileContext('r', [
      'formatter <- function(x) round(x)\nround <- function(x) readRDS("hidden.rds")'
    ])
    expect(context?.rFunctions?.map(({ name }) => name) ?? []).not.toContain('formatter')
    for (const fn of ['formatter', 'round', 'function(x) round(x)']) {
      expect(
        await analyzeNotebookSourceFileAccess('r', `result <- lapply(1:3, ${fn})`, context)
      ).toMatchObject({ readState: 'partial' })
    }
  })

  it('rebuilds R callable summaries after reopening and records invocation-time closure reads', async () => {
    const context = await fileContext('r', [
      'factor <- 2\nformatter <- function(x) round(x * factor)',
      'factor <- 3'
    ])
    expect(context?.rFunctions?.map(({ name }) => name)).toContain('formatter')
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'result <- lapply(1:3, formatter)\nwrite.csv(result, "result.csv")',
        context
      )
    ).toMatchObject({ readState: 'complete', writeState: 'complete', writes: ['result.csv'] })
    const sidecar = await readFile(
      join(roots.at(-1)!, 'notebooks/default-project/session-1/cache/dependency-analysis.json'),
      'utf8'
    )
    expect(sidecar).toContain('r-function')
    expect(sidecar).not.toContain('"rFunctions"')
  })

  it.each([
    ['formatter <- function(x) round(x)', 'formatter <- function(x) readRDS("hidden.rds")'],
    ['formatter <- function(x) round(x)', 'round <- function(x) readRDS("hidden.rds")']
  ])('discards unsafe R callable knowledge after replacement: %s', async (...scripts) => {
    const context = await fileContext('r', scripts)
    expect(context?.rFunctions?.map(({ name }) => name) ?? []).not.toContain('formatter')
    expect(
      await analyzeNotebookSourceFileAccess('r', 'result <- lapply(1:3, formatter)', context)
    ).toMatchObject({ readState: 'partial' })
  })

  const cases = [
    {
      language: 'python',
      name: 'append',
      scripts: ["paths = ['old.txt']", "paths.append('new.txt')"]
    },
    {
      language: 'python',
      name: 'subscript',
      scripts: ["paths = ['old.txt']", "paths[0] = 'new.txt'"]
    },
    {
      language: 'python',
      name: 'alias',
      scripts: ["paths = ['old.txt']", 'alias = paths', "alias[0] = 'new.txt'"]
    },
    {
      language: 'python',
      name: 'conditional alias',
      scripts: ["paths = ['old.txt']", 'if enabled:\n    alias = paths', "alias.append('new.txt')"]
    },
    {
      language: 'python',
      name: 'augmented assignment',
      scripts: ["paths = ['old.txt']", "paths += ['new.txt']"]
    },
    { language: 'python', name: 'deletion', scripts: ["paths = ['old.txt']", 'del paths[0]'] },
    {
      language: 'python',
      name: 'explicit setitem',
      scripts: ["paths = ['old.txt']", "paths.__setitem__(0, 'new.txt')"]
    },
    {
      language: 'python',
      name: 'explicit in-place addition',
      scripts: ["paths = ['old.txt']", "paths.__iadd__(['new.txt'])"]
    },
    {
      language: 'python',
      name: 'conditional rebind',
      scripts: [
        "paths = ['old.txt']",
        'alias = paths',
        "if enabled:\n    alias = ['other.txt']",
        "alias.append('new.txt')"
      ]
    },
    {
      language: 'r',
      name: 'replacement',
      scripts: ["paths <- c('old.txt', 'other.txt')", "paths[1] <- 'new.txt'"]
    }
  ] as const

  it.each(cases)(
    'does not reuse stale $language paths after $name across runs',
    async ({ language, scripts }) => {
      const context = await fileContext(language, [...scripts])
      const result = await analyzeNotebookSourceFileAccess(
        language,
        language === 'python'
          ? "for path in paths:\n    open(path, 'w').close()"
          : "for (path in paths) writeLines('data', path)",
        context
      )
      expect(result.writeState).toBe('partial')
      expect(result.writes).toEqual([])
    }
  )

  it.each(cases)(
    'does not enumerate stale $language paths after $name in one run',
    async ({ language, scripts }) => {
      const result = await analyzeNotebookSourceFileAccess(
        language,
        [
          ...scripts,
          language === 'python'
            ? "for path in paths:\n    open(path, 'w').close()"
            : "for (path in paths) writeLines('data', path)"
        ].join('\n')
      )
      expect(result.writeState).toBe('partial')
      expect(result.writes).toEqual([])
    }
  )

  it('invalidates persisted Python aliases during the current run', async () => {
    const context = await fileContext('python', ["paths = ['old.txt']", 'alias = paths'])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      ["alias.append('new.txt')", 'for path in paths:', "    open(path, 'w').close()"].join('\n'),
      context
    )
    expect(result.writeState).toBe('partial')
    expect(result.writes).toEqual([])
  })

  it('rebuilds alias identities without persisting transient context fields', async () => {
    const context = await fileContext('python', ["paths = ['old.txt']", 'alias = paths'])
    expect(context?.staticCollectionAliases).toHaveLength(1)
    const sidecar = await readFile(
      join(
        roots.at(-1)!,
        'notebooks',
        'default-project',
        'session-1',
        'cache',
        'dependency-analysis.json'
      ),
      'utf8'
    )
    expect(sidecar).not.toContain('staticCollectionAliases')
    expect(sidecar).not.toContain('resolvedKernelNames')
  })

  it('invalidates stale read paths as well as writes', async () => {
    const context = await fileContext('python', ["paths = ['old.txt']", "paths.append('new.txt')"])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      'for path in paths:\n    open(path).read()',
      context
    )
    expect(result.readState).toBe('partial')
    expect(result.reads).toEqual([])
  })

  it('does not enumerate a Python iterable that the loop body mutates', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        "paths = ['old.txt']",
        'for path in paths:',
        "    if path == 'old.txt':",
        "        paths.append('new.txt')",
        "    open(path, 'w').close()"
      ].join('\n')
    )
    expect(result.writeState).toBe('partial')
    expect(result.writes).toEqual([])
  })

  it.each([false, true])(
    'invalidates live Python iteration through an alias (%s)',
    async (viaAlias) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          "paths = ['first.txt', 'old.txt']",
          'alias = paths',
          'for path in paths:',
          `    ${viaAlias ? 'alias' : 'paths'}[1] = 'new.txt'`,
          "    open(path, 'w').close()"
        ].join('\n')
      )
      expect(result.writeState).toBe('partial')
      expect(result.writes).toEqual([])
    }
  )

  it('updates a static Python collection after a walrus assignment', async () => {
    const source = [
      "paths = ['old.txt']",
      "(paths := ['new.txt'])",
      "for path in paths:\n    open(path, 'w').close()"
    ].join('\n')
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.writeState).toBe('complete')
    expect(result.writes).toEqual(['new.txt'])
  })

  it('does not persist values derived from invalidated Python iteration', async () => {
    const context = await fileContext('python', [
      "paths = ['first.txt', 'old.txt']",
      "for path in paths:\n    paths[1] = 'new.txt'\n    last = path"
    ])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      "open(last, 'w').close()",
      context
    )
    expect(result.writeState).toBe('partial')
    expect(result.writes).toEqual([])
  })

  it('preserves independent collections after a mutation', async () => {
    const context = await fileContext('python', [
      "paths = ['old.txt']\nindependent = ['keep.txt']",
      "paths.append('new.txt')"
    ])
    expect(context?.staticCollections).toEqual([{ name: 'independent', values: ['keep.txt'] }])
  })

  it('detaches a rebound Python alias before later mutation', async () => {
    const context = await fileContext('python', [
      "paths = ['keep.txt']",
      'alias = paths',
      "alias = ['other.txt']",
      "alias.append('new.txt')"
    ])
    expect(context?.staticCollections).toEqual([{ name: 'paths', values: ['keep.txt'] }])
  })

  it('retains possible references through a conditional alias rebind', async () => {
    const context = await fileContext('python', [
      "paths = ['old.txt']",
      'alias = paths',
      "if enabled:\n    alias = ['other.txt']",
      "alias.append('new.txt')"
    ])
    expect(context?.staticCollections).toEqual([])
  })

  it('preserves an R copy when its source vector is replaced', async () => {
    const context = await fileContext('r', [
      "paths <- c('keep.txt', 'other.txt')",
      'copied <- paths',
      "paths[1] <- 'new.txt'"
    ])
    expect(context?.staticCollections).toEqual([
      { name: 'copied', values: ['keep.txt', 'other.txt'], rKind: 'vector' }
    ])
  })

  it('preserves the R iteration snapshot when its original vector is replaced', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      [
        "paths <- c('first.txt', 'old.txt')",
        'for (path in paths) {',
        "  paths[2] <- 'new.txt'",
        "  writeLines('data', path)",
        '}'
      ].join('\n')
    )
    expect(result.writeState).toBe('complete')
    expect(result.writes).toEqual(['first.txt', 'old.txt'])
  })

  it.each(['python', 'r'] as const)(
    'recovers %s paths defined after a failed run without reviving prior values',
    async (language) => {
      const scripts =
        language === 'python'
          ? ["old_path = 'old.txt'", "raise RuntimeError('failed')", "new_path = 'new.txt'"]
          : ["old_path <- 'old.txt'", "stop('failed')", "new_path <- 'new.txt'"]
      const context = await fileContext(
        language,
        scripts,
        [{}, { status: 'failed', kernelDispatched: true }],
        false
      )
      expect(context?.staticStrings).toEqual([{ name: 'new_path', value: 'new.txt' }])
      expect(context?.resolvedKernelNames ?? []).not.toContain('old_path')
    }
  )

  it('retains prior values when the failed run never reached the kernel', async () => {
    const context = await fileContext(
      'python',
      ["path = 'keep.txt'", "path = 'other.txt'"],
      [{}, { status: 'failed', kernelDispatched: false }]
    )
    expect(context?.staticStrings).toEqual([{ name: 'path', value: 'keep.txt' }])
  })

  it('recovers a fresh collection after mutation and explicit reassignment', async () => {
    const context = await fileContext('python', [
      "paths = ['old.txt']",
      "paths.append('extra.txt')\npaths = ['fresh.txt']"
    ])
    expect(context?.staticCollections).toEqual([{ name: 'paths', values: ['fresh.txt'] }])
  })
})

describe('cross-cell biomedical readers', () => {
  it('retains a static MGF writer mode through persisted context', async () => {
    const context = await fileContext('python', ['from pyteomics import mgf', 'mode = "a"'])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'mgf.write([], output="out.mgf", file_mode=mode)',
        context
      )
    ).toMatchObject({ reads: ['out.mgf'], writes: ['out.mgf'], externalState: 'complete' })
  })

  it('retains a proteomics reader alias through persisted context', async () => {
    const context = await fileContext('python', [
      'from pyteomics.mgf import MGF as read_spectra',
      'path = "inputs/spectra.mgf"'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('python', 'reader = read_spectra(path)', context)
    ).toMatchObject({ reads: ['inputs/spectra.mgf'], externalState: 'complete' })
  })

  it('retains a named sample file vector across R cells and cache reload', async () => {
    const context = await fileContext('r', [
      'library(tximport)',
      'files <- c(A="inputs/A/quant.sf", B="inputs/B/quant.sf")'
    ])
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'txi <- tximport(files, type="salmon", txOut=TRUE, dropInfReps=TRUE)',
        context
      )
    ).toMatchObject({
      reads: ['inputs/A/quant.sf', 'inputs/B/quant.sf'],
      externalState: 'complete'
    })
  })
  it.each([
    [
      'import SimpleITK as sitk',
      'image = sitk.ReadImage("inputs/ct.nii.gz")',
      ['inputs/ct.nii.gz'],
      'complete'
    ],
    [
      'from SimpleITK import ReadImage as read_image',
      'image = read_image("inputs/ct.nii.gz")',
      ['inputs/ct.nii.gz'],
      'complete'
    ],
    [
      'from radiomics import featureextractor\nextractor = featureextractor.RadiomicsFeatureExtractor()',
      'features = extractor.execute("inputs/ct.nii.gz", "inputs/mask.nii.gz")',
      ['inputs/ct.nii.gz', 'inputs/mask.nii.gz'],
      'partial'
    ]
  ])(
    'retains the reader identity after cache reload: %s',
    async (setup, source, reads, externalState) => {
      const context = await fileContext('python', [setup])
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        reads,
        externalState
      })
    }
  )
})

it('retains a file object constructed in a later cell and then aliased', async () => {
  const context = await fileContext('python', [
    'from radiomics import featureextractor',
    'extractor = featureextractor.RadiomicsFeatureExtractor()',
    'alias = extractor'
  ])
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'alias.loadParams("inputs/settings.yaml")',
      context
    )
  ).toMatchObject({ reads: ['inputs/settings.yaml'], externalState: 'partial' })
})

it.each([
  'sitk = object()',
  'if flag:\n    sitk = object()',
  'del sitk',
  'def sitk():\n    return 1'
])('forgets a previous reader after rebinding or mutation: %s', async (replacement) => {
  const context = await fileContext('python', ['import SimpleITK as sitk', replacement])
  expect(context?.pythonBindings?.some((binding) => binding.name === 'sitk') ?? false).toBe(false)
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("unused.nii.gz")', context)
  ).toMatchObject({ reads: [] })
})

it('keeps a read before same-cell reassignment, but does not apply it after reassignment', async () => {
  const context = await fileContext('python', ['import SimpleITK as sitk'])
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'first = sitk.ReadImage("inputs/first.nii.gz")\nsitk = object()\nsecond = sitk.ReadImage("unused.nii.gz")',
      context
    )
  ).toMatchObject({ reads: ['inputs/first.nii.gz'] })
})

it('invalidates a mutated library through an alias', async () => {
  const context = await fileContext('python', [
    'import SimpleITK as sitk\nalias = sitk',
    'alias.ReadImage = replacement'
  ])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("unused.nii.gz")', context)
  ).toMatchObject({ reads: [], externalState: 'partial' })
})

it.each([
  { status: 'failed' as const },
  { kernelEpochId: 'other-epoch' },
  { environment: 'other-python' }
])('does not borrow identities from an invalid execution boundary: %j', async (override) => {
  const context = await fileContext('python', ['import SimpleITK as sitk'], [override])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("unused.nii.gz")', context)
  ).toMatchObject({ reads: [] })
})

it('preserves imported readers after an operation rejected before kernel dispatch', async () => {
  const context = await fileContext(
    'python',
    ['import SimpleITK as sitk', 'sitk = object()'],
    [{}, { status: 'failed', kernelDispatched: false }]
  )
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("inputs/ct.nii.gz")', context)
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it.each(['sitk.ReadImage = replacement', 'alias = sitk\nalias.ReadImage = replacement'])(
  'does not certify a patched library in the current cell: %s',
  async (patch) => {
    const context = await fileContext('python', [
      'import SimpleITK as sitk\nreplacement = lambda path: 1'
    ])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `${patch}\nsitk.ReadImage("unused.nii.gz")`,
        context
      )
    ).toMatchObject({ reads: [], externalState: 'partial' })
  }
)

it('does not treat re-importing a monkeypatched module as recovery', async () => {
  const context = await fileContext('python', [
    'import SimpleITK as sitk\nreplacement = lambda path: 1',
    'sitk.ReadImage = replacement',
    'import SimpleITK as recovered'
  ])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'recovered.ReadImage("unused.nii.gz")', context)
  ).toMatchObject({ reads: [], externalState: 'partial' })
})

it.each([true, false])(
  'retains module modifications before a dispatched failure (precompute=%s)',
  async (precompute) => {
    const context = await fileContext(
      'python',
      [
        'import SimpleITK as sitk\nreplacement = lambda path: 1',
        'sitk.ReadImage = replacement\nraise RuntimeError()',
        'import SimpleITK as recovered'
      ],
      [{}, { status: 'failed', kernelDispatched: true }, {}],
      precompute
    )
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'recovered.ReadImage("unused.nii.gz")',
        context
      )
    ).toMatchObject({ reads: [], externalState: 'partial' })
  }
)

it('can re-import an unmodified reader after an ordinary execution failure', async () => {
  const context = await fileContext(
    'python',
    ['import SimpleITK as sitk', 'import missing_package', 'import SimpleITK as recovered'],
    [{}, { status: 'failed', kernelDispatched: true }, {}]
  )
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'recovered.ReadImage("inputs/ct.nii.gz")',
      context
    )
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it.each(['mutate(sitk)', 'mutate(module=sitk)', 'setattr(sitk, "ReadImage", replacement)'])(
  'does not revive a module exposed to an opaque mutation: %s',
  async (mutation) => {
    const context = await fileContext('python', [
      'import SimpleITK as sitk',
      mutation,
      'import SimpleITK as recovered'
    ])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'recovered.ReadImage("unused.nii.gz")',
        context
      )
    ).toMatchObject({ reads: [], externalState: 'partial' })
  }
)

it('clears observed module modifications at the kernel epoch boundary', async () => {
  const context = await fileContext(
    'python',
    ['import SimpleITK as sitk\nsitk.ReadImage = replacement', 'import SimpleITK as sitk'],
    [{ kernelEpochId: 'old-epoch' }, {}]
  )
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("inputs/ct.nii.gz")', context)
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it('rebuilds malformed cached reader identities from saved code', async () => {
  const context = await fileContext('python', ['import SimpleITK as sitk'], [], true, (json) => {
    expect(json).toMatch(/"kind":\s*"import"/)
    return json.replace(/"kind":\s*"import"/g, '"kind":"invalid"')
  })
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("inputs/ct.nii.gz")', context)
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it.each(['bindings', 'taints'] as const)(
  'bounds accumulated Python %s without reviving trusted effects',
  async (kind) => {
    const entries: FileContextEntry[] = Array.from({ length: 514 }, (_, index) => ({
      facts: { state: 'available', definedNames: [`lib${index}`], usedNames: [], mutatedNames: [] },
      fileContext: {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        ...(kind === 'bindings'
          ? {
              pythonBindings: [
                { name: `lib${index}`, qualifiedName: `module${index}`, kind: 'import' as const }
              ]
            }
          : { pythonTaintedNamespaces: [`module${index}`] })
      }
    }))
    const context = projectNotebookFileContext('python', entries)
    expect(context?.pythonTaintedNamespaces).toEqual(['*'])
    expect(context?.pythonBindings ?? []).toEqual([])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import SimpleITK as sitk\nsitk.ReadImage("unused.nii.gz")',
        context
      )
    ).toMatchObject({ reads: [], externalState: 'partial' })
  }
)

it('keeps network readers external when imported in an earlier cell', async () => {
  const context = await fileContext('python', ['import requests as client'])
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'response = client.get("https://example.org/data")',
      context
    )
  ).toMatchObject({ reads: [], externalState: 'partial' })
})

it('does not invalidate a module merely printed for inspection', async () => {
  const context = await fileContext('python', ['import SimpleITK as sitk', 'print(sitk)'])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("inputs/ct.nii.gz")', context)
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})
