import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { describe, expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { projectNotebookDependencies } from './dependency-projection'

import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

describe('scientific storage modes', () => {
  it.each([
    'file.copy("inputs/data.tsv", "outputs/observed.tsv")',
    'base::file.copy("inputs/data.tsv", "outputs/observed.tsv", overwrite=TRUE)',
    'file.copy(to="outputs/observed.tsv", from="inputs/data.tsv", recursive=FALSE)',
    'src <- "inputs/data.tsv"; dst <- "outputs/observed.tsv"; file.copy(src, dst)'
  ])(
    'retains possible base R copy paths without claiming complete filesystem coverage: %s',
    async (source) => {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['inputs/data.tsv'],
        writes: ['outputs/observed.tsv'],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('does not treat a possible copy as a successful producer for a later read', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'file.copy("inputs/data.tsv", "outputs/observed.tsv"); readLines("outputs/observed.tsv")'
      )
    ).toMatchObject({ reads: ['inputs/data.tsv', 'outputs/observed.tsv'], writeState: 'partial' })
  })

  it.each([
    'file.copy <- custom; file.copy("inputs/data.tsv", "outputs/observed.tsv")',
    'other::file.copy("inputs/data.tsv", "outputs/observed.tsv")',
    'file.copy("inputs/data.tsv", "outputs/observed.tsv", recursive=TRUE)',
    'file.copy(c("inputs/a.tsv", "inputs/b.tsv"), "outputs")'
  ])(
    'does not assign single-file copy paths to unrelated or recursive calls: %s',
    async (source) => {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: [],
        writes: [],
        readState: 'partial',
        writeState: 'partial'
      })
    }
  )

  it.each([
    'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)',
    'from importlib import util as u\nspec = u.spec_from_file_location("helper", "outputs/helper.py")\nmodule = u.module_from_spec(spec)\nspec.loader.exec_module(module)',
    'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nexecute = spec.loader.exec_module\nexecute(module)',
    'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nexecute = spec.loader.exec_module\nother = execute\nother(module)',
    'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nif True:\n    execute = spec.loader.exec_module\nexecute(module)',
    'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nexecute = spec.loader.exec_module\nif False:\n    execute = lambda module: None\nexecute(module)',
    'import importlib.machinery as machinery\nloader = machinery.SourceFileLoader("helper", "outputs/helper.py")\nloader.load_module("helper")'
  ])('keeps unmodeled Python module execution I/O uncertain: %s', async (source) => {
    const access = await analyzeNotebookSourceFileAccess('python', source)
    expect(access).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      writes: []
    })
    expect(access.reasonCodes).toContain('dynamic-path-unresolved')
  })

  it('preserves explicit paths alongside unmodeled Python module execution', async () => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nwith open("inputs/data.csv") as source:\n    data = source.read()\nwith open("outputs/report.txt", "w") as target:\n    target.write(data)'
    )
    expect(access).toMatchObject({
      reads: ['inputs/data.csv'],
      writes: ['outputs/report.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not treat constructing a module specification as module execution', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)'
      )
    ).toMatchObject({ writes: [], writeState: 'complete' })
  })

  it('does not impose loader effects on a local function with the same name', async () => {
    const source =
      'from pathlib import Path\ndef emit(path):\n    Path(path).write_text("done")\nemit("outputs/report.txt")'
    expect(
      await analyzeNotebookSourceFileAccess('python', source.replaceAll('emit', 'exec_module'))
    ).toEqual(await analyzeNotebookSourceFileAccess('python', source))
  })

  it('does not execute a bound loader alias after it is rebound', async () => {
    const source =
      'import importlib.util\nspec = importlib.util.spec_from_file_location("helper", "outputs/helper.py")\nmodule = importlib.util.module_from_spec(spec)\nexecute = spec.loader.exec_module\nexecute = lambda module: None\nexecute(module)'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      writes: [],
      writeState: 'complete'
    })
  })

  it('records the known trace destination of R cat', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'TRACE_PATH <- "outputs/score-trace.csv"; header <- "call_id,score"; cat(header, "\\n", file=TRACE_PATH, append=FALSE, sep="")'
      )
    ).toMatchObject({ reads: [], writes: ['outputs/score-trace.csv'] })
  })

  it.each([
    ['base::cat("next", file="report.txt", append=TRUE)', ['report.txt']],
    ['cat("next", file="report.txt", append=FALSE)', []],
    ['cat("next", file="report.txt")', []],
    ['cat("next", file="report.txt", app=TRUE)', []]
  ] as const)('matches only the exact post-dots R cat append option: %s', async (source, reads) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads,
      writes: ['report.txt'],
      writeState: 'complete'
    })
  })

  it('does not require old bytes after R cat replaces and then appends', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'cat("first", file="report.txt"); cat("next", file="report.txt", append=TRUE)'
      )
    ).toMatchObject({ reads: [], writes: ['report.txt'], writeState: 'complete' })
  })

  it('retains a known R cat destination with uncertain append intent', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'cat("next", file="report.txt", append=flag)')
    ).toMatchObject({ writes: ['report.txt'], readState: 'partial', writeState: 'partial' })
  })

  it.each([
    'con <- file("report.txt", "rt"); cat("next", file=con); readLines("report.txt")',
    'con <- file("report.txt", "wt"); close(con); cat("next", file=con); readLines("report.txt")',
    'con <- file("report.txt", mode); cat("next", file=con); readLines("report.txt")'
  ])(
    'does not certify a cat write through an unusable or unknown connection: %s',
    async (source) => {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['report.txt'],
        writes: ['report.txt'],
        readState: 'partial',
        writeState: 'partial'
      })
    }
  )

  it.each([
    ['at', 'FALSE', ['report.txt']],
    ['wt', 'TRUE', []],
    ['', 'TRUE', []]
  ] as const)('uses the R cat connection mode %s before append=%s', async (mode, append, reads) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `con <- file("report.txt", "${mode}"); alias <- con; cat("next", file=alias, append=${append})`
      )
    ).toMatchObject({ reads, writes: ['report.txt'], writeState: 'complete' })
  })

  it.each([
    'cat("next", "report.txt")',
    'cat("next", fil="report.txt")',
    'cat("next", fi="report.txt")'
  ])('does not interpret R cat data after dots as a file control: %s', async (source) => {
    expect((await analyzeNotebookSourceFileAccess('r', source)).writes).toEqual([])
  })

  it.each([
    'cat(readLines("input.txt"))',
    'base::cat(readLines("input.txt"), file="")',
    'cat(readLines("input.txt"), file="|consumer")',
    'cat(readLines("input.txt"), file=1)'
  ])('retains nested R cat readers without inventing a disk destination: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['input.txt'],
      writes: []
    })
  })

  it.each([
    'other::cat("next", file="report.txt")',
    'cat <- custom; cat("next", file="report.txt")',
    'if (flag) cat <- custom; cat("next", file="report.txt")',
    'emit <- base::cat; emit <- custom; emit("next", file="report.txt")',
    'emit <- function(path) cat("next", file=path); cat <- custom; emit("report.txt")',
    'emit <- function(path) base::cat("next", file=path); emit("")',
    'emit <- function(path) base::cat("next", file=path); emit("|consumer")'
  ])(
    'does not infer a base R cat destination through a different callable or wrapper: %s',
    async (source) => {
      expect((await analyzeNotebookSourceFileAccess('r', source)).writes).toEqual([])
    }
  )

  it('preserves opaque R effects alongside a known cat destination', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'opaque(); base::cat("next", file="report.txt")')
    ).toMatchObject({
      writes: ['report.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each(['TRUE', 'flag'])(
    'does not borrow base cat append=%s semantics for a known local replacement writer',
    async (append) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          `cat <- function(file, append) writeLines("next", file); cat("report.txt", append=${append})`
        )
      ).toMatchObject({ reads: [], writes: ['report.txt'], writeState: 'complete' })
    }
  )

  it('keeps base cat append separate from a same-name local replacement writer', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'cat <- function(file, append) writeLines("next", file); base::cat("base", file="base.txt", append=TRUE); cat("report.txt", append=TRUE)'
      )
    ).toMatchObject({
      reads: ['base.txt'],
      writes: ['base.txt', 'report.txt'],
      writeState: 'complete'
    })
  })

  it.each([
    'write("{}", "outputs/report.json")',
    'base::write("{}", file="outputs/report.json")',
    'write("outputs/report.json", x="{}")',
    'write("{}", fi="outputs/report.json")'
  ])('recognizes base R write destinations with R argument matching: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: ['outputs/report.json'],
      writeState: 'complete'
    })
  })

  it.each([
    'write("next", "report.txt", append=TRUE)',
    'base::write("next", "report.txt", 1, TRUE)',
    'write("report.txt", x="next", app=TRUE)',
    'con <- file("report.txt", "at"); other <- con; write("next", other)'
  ])('retains preceding bytes for an R write append: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['report.txt'],
      writes: ['report.txt'],
      writeState: 'complete'
    })
  })

  it('recognizes the base R write default file rather than console output', async () => {
    expect(await analyzeNotebookSourceFileAccess('r', 'write("next")')).toMatchObject({
      reads: [],
      writes: ['data'],
      writeState: 'complete'
    })
  })

  it('does not require old bytes after a same-cell replacement followed by append', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'write("first", "report.txt"); write("next", "report.txt", append=TRUE)'
      )
    ).toMatchObject({
      reads: [],
      writes: ['report.txt'],
      writeState: 'complete'
    })
  })

  it('keeps dynamic append intent uncertain while retaining the exact destination', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'write("next", "report.txt", append=flag)')
    ).toMatchObject({
      writes: ['report.txt'],
      writeState: 'partial',
      readState: 'partial'
    })
  })

  it.each(['write("next", "")', 'base::write("next", "|consumer")'])(
    'does not publish console or pipe output as a disk file: %s',
    async (source) => {
      const access = await analyzeNotebookSourceFileAccess('r', source)
      expect(access.writes).toEqual([])
      expect(access.externalState).toBe('partial')
    }
  )

  it.each([
    'utils::write("next", "report.txt")',
    'unknownPackage::write("next", "report.txt")',
    'write <- function(x, file) NULL; write("next", "report.txt")',
    'write <- custom_writer; write("next", "report.txt")',
    'emit <- function(x, file) utils::write(x, file); emit("next", "report.txt")'
  ])('does not apply the base R writer contract to a different function: %s', async (source) => {
    expect((await analyzeNotebookSourceFileAccess('r', source)).writes).toEqual([])
  })

  it.each([
    'write <- custom_writer; emit <- function(x, file) write(x, file); emit("next", "report.txt")',
    'write <- function(x, file) NULL; emit <- function(file) write("next", file); emit("report.txt")',
    'if (flag) write <- custom_writer; emit <- function(file) write("next", file); emit("report.txt")',
    'emit <- function(file) write("next", file); write <- custom_writer; emit("report.txt")',
    'emit <- function(file, write) write("next", file); emit("report.txt", custom_writer)'
  ])('does not infer a base R writer through a shadowed wrapper: %s', async (source) => {
    const access = await analyzeNotebookSourceFileAccess('r', source)
    expect(access.writes).toEqual([])
    expect(access.writeState).toBe('partial')
  })

  it('retains an explicitly qualified base writer inside a wrapper despite shadowing', async () => {
    const access = await analyzeNotebookSourceFileAccess(
      'r',
      'write <- custom_writer; emit <- function(x, file) base::write(x, file); emit("next", "report.txt")'
    )
    expect(access.writes).toEqual(['report.txt'])
  })

  it('does not promote an append wrapper into a replacement contract', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'emit <- function(file) write("next", file, append=TRUE); emit("report.txt")'
    )
    expect(result.externalState).toBe('partial')
    expect(result.writeState).toBe('partial')
  })

  it('retains nested readers when the R writer targets console output', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'write(readLines("input.txt"), "")')
    ).toMatchObject({
      reads: ['input.txt'],
      writes: [],
      externalState: 'partial'
    })
  })

  it('retains the destination without assuming custom R coercion has no hidden effects', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'x <- structure("next", class="custom"); write(x, "report.txt")'
      )
    ).toMatchObject({
      writes: ['report.txt'],
      externalState: 'partial',
      writeState: 'partial'
    })
  })

  it('preserves the mode of an already-open R connection', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'con <- file("counts.txt", "at")\nother <- con\nopen(other, "wt")\nwriteLines("row", con)'
    )
    expect(result).toMatchObject({
      reads: ['counts.txt'],
      writes: ['counts.txt'],
      writeState: 'complete'
    })
  })
  it.each(['app', 'appen'])('preserves append intent in R partial argument %s', async (name) => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      `write.table(data.frame(x=1), "counts.txt", ${name}=TRUE)`
    )
    expect(result).toMatchObject({
      reads: ['counts.txt'],
      writes: ['counts.txt'],
      writeState: 'complete'
    })
  })
  it.each([
    'con <- file("counts.txt", op="at")\nwriteLines("row", con)',
    'con <- file("counts.txt")\nopen(con, op="at")\nwriteLines("row", con)'
  ])('preserves partial open arguments for an R connection', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result).toMatchObject({
      reads: ['counts.txt'],
      writes: ['counts.txt'],
      writeState: 'complete'
    })
  })
  it.each([
    'if (FALSE) open(other, "wt")',
    'while (FALSE) open(other, "wt")',
    'if (flag) open(other, "wt")'
  ])('does not apply a conditional connection mode as certain: %s', async (branch) => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      `con <- file("counts.txt", "at")\nother <- con\n${branch}\nwriteLines("row", con)`
    )
    expect(result).toMatchObject({
      reads: ['counts.txt'],
      writes: ['counts.txt'],
      writeState: 'complete'
    })
  })

  it.each(['if (flag)', 'while (flag)'])(
    'keeps a conditional first open uncertain: %s',
    async (branch) => {
      const result = await analyzeNotebookSourceFileAccess(
        'r',
        `con <- file("counts.txt")\nother <- con\n${branch} open(other, "at")\nwriteLines("row", con)`
      )
      expect(result.writeState).toBe('partial')
    }
  )

  it.each([
    'con <- gzfile("counts.gz")\nopen(open="at", con=con)\nwriteLines("row", con)',
    'con <- gzfile("at", description="counts.gz")\nwriteLines("row", con)',
    'con <- gzfile(open="at", "counts.gz")\nwriteLines("row", con)'
  ])('matches named R connection arguments before positional arguments', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result).toMatchObject({
      reads: ['counts.gz'],
      writes: ['counts.gz'],
      writeState: 'complete'
    })
  })

  it.each([
    'other <- prior_connection\nrows <- readLines(other)',
    'con <- gzfile("input.gz", "rt")\nother <- con\nother <- unknown_connection\nrows <- readLines(other)'
  ])('does not infer an unknown connection from an earlier or replaced binding', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result.readState).toBe('partial')
  })

  it('preserves an input path through compressed R connection aliases', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'con <- gzfile("inputs/counts.csv.gz", "rt")\nother <- con\nrows <- readLines(other)\nclose(con)'
    )
    expect(result).toMatchObject({
      reads: ['inputs/counts.csv.gz'],
      writes: [],
      readState: 'complete'
    })
  })
  it('discards the old R connection when a name is rebound', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'con <- file("old.txt", "at")\ncon <- file("new.txt", "wt")\nwriteLines("row", con)'
    )
    expect(result).toMatchObject({ reads: [], writes: ['new.txt'] })
  })
  it('updates append mode through an R connection alias when explicitly opened', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'con <- file("counts.txt")\nother <- con\nopen(con, open="at")\nwriteLines("row", other)'
    )
    expect(result).toMatchObject({ reads: ['counts.txt'], writes: ['counts.txt'] })
  })
  it('keeps an explicitly closed R connection conservative', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'con <- file("counts.txt", "at")\nclose(con)\nwriteLines("row", con)'
    )
    expect(result.writeState).toBe('partial')
  })
  it.each(["mode='w'", "mode='w-'", 'compute=True'])(
    'keeps an eager replacement Zarr write supported: %s',
    async (option) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import xarray as xr\nds = xr.Dataset()\nds.to_zarr('counts.zarr', ${option})`
      )
      expect(result).toMatchObject({ reads: [], writes: ['counts.zarr'], writeState: 'complete' })
    }
  )
  it.each(['driver=None', "driver='sec2'", "driver='stdio'"])(
    'keeps ordinary HDF5 storage supported: %s',
    async (option) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import h5py\nf = h5py.File('counts.h5', 'r+', ${option})`
      )
      expect(result).toMatchObject({
        reads: ['counts.h5'],
        writes: ['counts.h5'],
        readState: 'complete',
        writeState: 'complete'
      })
    }
  )

  it.each(['file', 'gzfile', 'bzfile', 'xzfile'])(
    'retains old bytes through an R %s append connection and alias',
    async (constructor) => {
      const result = await analyzeNotebookSourceFileAccess(
        'r',
        `con <- ${constructor}("counts.csv.gz", "at")\nother <- con\nwriteLines("1,2", other)\nclose(con)`
      )
      expect(result).toMatchObject({
        reads: ['counts.csv.gz'],
        writes: ['counts.csv.gz'],
        readState: 'complete',
        writeState: 'complete'
      })
    }
  )
  it.each(['', 'wt'])(
    'keeps replacing R connection mode %s independent of old bytes',
    async (mode) => {
      const result = await analyzeNotebookSourceFileAccess(
        'r',
        `con <- gzfile("counts.csv.gz", "${mode}")\nwriteLines("1,2", con)\nclose(con)`
      )
      expect(result).toMatchObject({
        reads: [],
        writes: ['counts.csv.gz'],
        readState: 'complete',
        writeState: 'complete'
      })
    }
  )
  it('retains an inline binary append connection', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'writeBin(as.raw(1), file("counts.bin", "ab"))'
    )
    expect(result.reads).toEqual(['counts.bin'])
    expect(result.writes).toEqual(['counts.bin'])
  })
  it('keeps an unresolved R connection mode conservative', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'con <- file("counts.txt", open=unknown_mode)\nwriteLines("1", con)'
    )
    expect(result.writeState).toBe('partial')
  })
  it.each(["mode='a'", "append_dim='time'", "region={'time': slice(0, 1)}"])(
    'does not hide prior Zarr members for %s',
    async (option) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import xarray as xr\nds = xr.Dataset()\nds.to_zarr('counts.zarr', ${option})`
      )
      expect(result.readState).toBe('partial')
      expect(result.writes).toContain('counts.zarr')
    }
  )
  it.each(['to_zarr', 'to_netcdf'])(
    'does not claim %s delayed output is materialized',
    async (writer) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import xarray as xr\nds = xr.Dataset()\njob = ds.${writer}('counts.${writer === 'to_zarr' ? 'zarr' : 'nc'}', compute=False)`
      )
      expect(result.writeState).toBe('partial')
    }
  )
  it.each(["driver='split'", "driver='family'", "driver='core', backing_store=False"])(
    'keeps HDF5 alternate storage conservative: %s',
    async (options) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import h5py\nhandle = h5py.File('counts.h5', 'w', ${options})`
      )
      expect(result.writeState).toBe('partial')
    }
  )
})

it('records a writable NumPy load as both input and possible output', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    "import numpy as np\nmm = np.load('profiles.npy', mmap_mode='r+', allow_pickle=False)\nmm[:] = 2\nmm.flush()"
  )
  expect(result.reads).toContain('profiles.npy')
  expect(result.writes).toContain('profiles.npy')
})

it.each([
  ["np.load('profiles.npy')", false],
  ["np.load(file='profiles.npy', mmap_mode=None)", false],
  ["np.load('profiles.npy', 'r')", false],
  ["np.load('profiles.npy', mmap_mode='c')", false],
  ["np.load('profiles.npy', 'r+')", true],
  ["np.load(file='profiles.npy', mmap_mode='w+')", true],
  ["np.memmap('profiles.npy', mode='c')", false],
  ["np.lib.format.open_memmap('profiles.npy', mode='c')", false],
  ["np.lib.format.open_memmap('profiles.npy')", true]
])('distinguishes persistent and private NumPy mappings: %s', async (call, writable) => {
  const result = await analyzeNotebookSourceFileAccess('python', `import numpy as np\na = ${call}`)
  expect(result.reads).toContain('profiles.npy')
  expect(result.writes).toEqual(writable ? ['profiles.npy'] : [])
})
it('recognizes imported mapping aliases without claiming a write already happened', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    "from numpy.lib.format import open_memmap as mapping\na = mapping(filename='profiles.npy', mode='r+')\nb = mapping(filename='profiles.npy', mode='r')"
  )
  expect(result.reads).toEqual(['profiles.npy'])
  expect(result.writes).toEqual(['profiles.npy'])
})
it.each(['mmap_mode=unknown_mode', '**options'])(
  'keeps dynamic NumPy mapping modes uncertain: %s',
  async (option) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import numpy as np\na=np.load('profiles.npy',${option})`
    )
    expect(result.reads).toContain('profiles.npy')
    expect(result.writeState).toBe('partial')
  }
)
it('does not infer NumPy mapping effects after its loader is shadowed', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    "from numpy import load\nload = custom_loader\na = load('profiles.npy', mmap_mode='r+')"
  )
  expect(result.writes).toEqual([])
  expect(result.reads).toEqual([])
})

it('retains a readonly SQLite cursor input without certifying complete SQL capture', async () => {
  const { fileAccess } = await analyzePythonNotebookSource(
    [
      'import sqlite3',
      'conn = sqlite3.connect("file:inputs/observations.sqlite?mode=ro", uri=True)',
      'cur = conn.cursor()',
      'cur.execute("SELECT row_id, uptake FROM observations ORDER BY row_id")',
      'rows = cur.fetchall()'
    ].join('\n')
  )
  expect(fileAccess?.reads).toEqual(['inputs/observations.sqlite'])
  expect(fileAccess?.unsupportedExternalState).toBe(true)
  expect(fileAccess?.context?.pythonBindings).toEqual(
    expect.arrayContaining([
      {
        name: 'conn',
        qualifiedName: 'sqlite3.Connection',
        kind: 'object',
        filePath: 'inputs/observations.sqlite'
      },
      {
        name: 'cur',
        qualifiedName: 'sqlite3.Cursor',
        kind: 'object',
        filePath: 'inputs/observations.sqlite'
      }
    ])
  )
})

it('records the inherited readonly SQLite input of a parameterized continuation', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    'cur.execute("SELECT row_id, uptake FROM observations WHERE conc >= ? ORDER BY row_id", (500,))\nrows = cur.fetchall()',
    {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonBindings: [
        {
          name: 'cur',
          qualifiedName: 'sqlite3.Cursor',
          kind: 'object',
          filePath: 'inputs/observations.sqlite'
        }
      ]
    }
  )
  expect(result).toMatchObject({
    reads: ['inputs/observations.sqlite'],
    writes: [],
    readState: 'partial',
    externalState: 'partial'
  })
})

const readonlySqliteContext = {
  staticStrings: [],
  staticCollections: [],
  localFileWrappers: [],
  pythonBindings: [
    {
      name: 'conn',
      qualifiedName: 'sqlite3.Connection',
      kind: 'object' as const,
      filePath: 'inputs/observations.sqlite'
    },
    {
      name: 'cur',
      qualifiedName: 'sqlite3.Cursor',
      kind: 'object' as const,
      filePath: 'inputs/observations.sqlite'
    }
  ]
}

it('preserves readonly SQLite paths through the actual scalar LIVE_IDS diagnostic', async () => {
  const { fileAccess } = await analyzePythonNotebookSource(
    'cur.execute("SELECT 1")\nprint("LIVE_IDS", id(conn), id(cur))',
    readonlySqliteContext
  )
  expect(fileAccess?.context?.pythonBindings).toEqual(readonlySqliteContext.pythonBindings)
})

it('preserves readonly SQLite context through the actual pandas scalar summary diagnostic', async () => {
  const { fileAccess } = await analyzePythonNotebookSource(
    'import pandas as pd\nsummary = pd.DataFrame([[7]], columns=["n"])\nprint(sorted(summary["n"].unique().tolist()))',
    readonlySqliteContext
  )
  expect(fileAccess?.context?.pythonBindings).toEqual(
    expect.arrayContaining(readonlySqliteContext.pythonBindings)
  )
})

it.each([
  'summary["n"].custom().tolist()',
  'summary["n"].unique(callback).tolist()',
  'summary["n"].unique().tolist(**options)',
  'summary["n"].map(callback).tolist()'
])(
  'does not close arbitrary summary calls around readonly SQLite context: %s',
  async (expression) => {
    const { fileAccess } = await analyzePythonNotebookSource(
      'import pandas as pd\nsummary = pd.DataFrame([[7]], columns=["n"])\nprint(' +
        expression +
        ')',
      readonlySqliteContext
    )
    expect(
      fileAccess?.context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)
    ).toEqual([])
  }
)

it.each(['id = custom', 'print(conn)', 'holder = list([cur])', 'alias = cur.connection'])(
  'does not exempt arbitrary or shadowed SQLite diagnostic escapes: %s',
  async (source) => {
    const { fileAccess } = await analyzePythonNotebookSource(
      source + '\nprint("LIVE_IDS", id(conn), id(cur))',
      readonlySqliteContext
    )
    expect(
      fileAccess?.context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)
    ).toEqual([])
  }
)

it.each([
  'alias = cur',
  'alias = conn',
  'holder = [cur]',
  'holder = {"cursor": cur}',
  'alias = cur.execute("SELECT 1")\nalias.close()',
  'cur.close()',
  'conn = replacement',
  'if flag:\n    cur = replacement',
  'cur.row_factory = custom',
  'conn.create_function("custom", 1, callback)',
  'cur.execute(sql)',
  'cur.execute("UPDATE observations SET uptake = 0")',
  'cur.execute("ATTACH DATABASE other AS aux")',
  'cur.executescript("SELECT 1;")',
  'conn.cursor(factory=custom)',
  'opaque()',
  'def close_database():\n    conn.close()\nclose_database()',
  'import os\nos.chdir("elsewhere")\nos.chdir("original")'
])('revokes readonly SQLite handle paths before a later cell after: %s', async (source) => {
  const { fileAccess } = await analyzePythonNotebookSource(source, readonlySqliteContext)
  expect(
    fileAccess?.context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)
  ).toEqual([])
  const next = await analyzeNotebookSourceFileAccess(
    'python',
    'cur.execute("SELECT 1")',
    fileAccess?.context
  )
  expect(next.reads).toEqual([])
  expect(next.readState).toBe('partial')
})

it.each([
  'cur.execute("SELECT ?", (conn.close(),))',
  'cur.execute("SELECT ?", (opaque(),))',
  'cur.execute("SELECT ?", parameters)',
  'cur.execute("SELECT 1"); cur.close(); cur.execute("SELECT 1")'
])('does not certify effectful or unknown SQLite query parameter lifetimes: %s', async (source) => {
  const { fileAccess } = await analyzePythonNotebookSource(source, readonlySqliteContext)
  expect(
    fileAccess?.context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)
  ).toEqual([])
  // An earlier SELECT can retain its potential read; effectful parameters cannot.
  expect(fileAccess?.reads).toEqual(
    source.startsWith('cur.execute("SELECT 1");') ? ['inputs/observations.sqlite'] : []
  )
  expect(fileAccess?.unsupportedExternalState).toBe(true)
})

it.each([
  'sqlite3.connect("file:data.sqlite?mode=ro", uri=True, factory=custom)',
  'sqlite3.connect("file:data.sqlite?mode=ro", **options)',
  'sqlite3.connect("file:data.sqlite?mode=ro&mode=rw", uri=True)',
  'sqlite3.connect("file:data.sqlite?mode=ro&vfs=custom", uri=True)',
  'sqlite3.connect("file:data.sqlite?mode=ro#fragment", uri=True)',
  'sqlite3.connect("file:data%00.sqlite?mode=ro", uri=True)',
  'sqlite3.connect("file:data%ZZ.sqlite?mode=ro", uri=True)',
  'sqlite3.connect("file:%5Cdata.sqlite?mode=ro", uri=True)',
  'sqlite3.connect("file://server/data.sqlite?mode=ro", uri=True)',
  'sqlite3.connect("file:data.sqlite?mode=ro", uri=True, database="other")',
  'sqlite3.connect = custom\nconn = sqlite3.connect("file:data.sqlite?mode=ro", uri=True)'
])('does not propagate ambiguous readonly SQLite constructors: %s', async (constructor) => {
  const { fileAccess } = await analyzePythonNotebookSource('import sqlite3\nconn = ' + constructor)
  expect(fileAccess?.reads).toEqual([])
  expect(
    fileAccess?.context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)
  ).toEqual([])
  expect(fileAccess?.unsupportedExternalState).toBe(true)
})

it('does not identify an unimported SQLite constructor by spelling alone', async () => {
  const { fileAccess } = await analyzePythonNotebookSource(
    'conn = sqlite3.connect("file:data.sqlite?mode=ro", uri=True)'
  )
  expect(fileAccess?.reads).toEqual([])
  expect(
    fileAccess?.context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)
  ).toEqual([])
})

it.each([
  "import sqlite3\ncon = sqlite3.connect('outputs/checkpoint.sqlite')",
  "import sqlite3 as db\nfrom pathlib import Path\np=Path('outputs') / 'checkpoint.sqlite'\ncon=db.connect(database=p, uri=False)",
  "from sqlite3 import connect as connect_db\ncon=connect_db('outputs/checkpoint.sqlite')"
])(
  'retains an ordinary SQLite checkpoint as potential input/output without claiming complete SQL capture: %s',
  async (code) => {
    const result = await analyzeNotebookSourceFileAccess('python', code)
    expect({
      ...result,
      reads: result.reads.map((p) => p.replaceAll('\\', '/')),
      writes: result.writes.map((p) => p.replaceAll('\\', '/'))
    }).toMatchObject({
      reads: ['outputs/checkpoint.sqlite'],
      writes: ['outputs/checkpoint.sqlite'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  }
)
it.each([
  "sqlite3.connect(':memory:')",
  "sqlite3.connect('')",
  "sqlite3.connect('file:cache?mode=memory', uri=True)",
  'sqlite3.connect(path)',
  "sqlite3.connect('checkpoint.sqlite', uri=unknown)",
  "sqlite3.connect('checkpoint.sqlite', **options)",
  "sqlite3.connect('checkpoint.sqlite', factory=custom)",
  "sqlite3.connect('file:cache?mode=memory', 5, 0, None, True, custom, 128, True)"
])(
  'does not invent a disk path for unresolved, in-memory or custom SQLite connections: %s',
  async (call) => {
    const result = await analyzeNotebookSourceFileAccess('python', `import sqlite3\ncon=${call}`)
    expect(result.reads).toEqual([])
    expect(result.writes).toEqual([])
    expect(result.externalState).toBe('partial')
  }
)
it('does not apply SQLite effects after the imported constructor is rebound', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    "from sqlite3 import connect\nconnect=custom\ncon=connect('checkpoint.sqlite')"
  )
  expect(result.reads).toEqual([])
  expect(result.writes).toEqual([])
})

describe('R compressed serialization path evidence', () => {
  it.each([
    'gzfile <- custom\ncon <- gzfile("fake.gz", "wb")\nserialize(list(x = 1), con)',
    'gzcon <- custom\nserialize(list(x = 1), gzcon(gzfile("fake.gz", "wb")))',
    'gzfile <- custom\nrestored <- unserialize(gzfile("fake.gz", "rb"))'
  ])('does not infer a base connection from a shadowed constructor: %s', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result.reads).not.toContain('fake.gz')
    expect(result.writes).not.toContain('fake.gz')
  })
  const captureSerialization = async (
    source: string
  ): Promise<
    Awaited<ReturnType<typeof analyzeRNotebookSource>> & {
      normalized: Awaited<ReturnType<typeof analyzeNotebookSourceFileAccess>>
    }
  > => ({
    ...(await analyzeRNotebookSource(source)),
    normalized: await analyzeNotebookSourceFileAccess('r', source)
  })

  it.each([
    [
      'literal gz writer',
      'con <- gzfile("outputs/checkpoint.gz", "wb")\nserialize(list(values = c(1, 2)), con)\nclose(con)'
    ],
    [
      'aliased gz writer',
      'pack <- base::serialize\ncon <- gzfile("outputs/checkpoint.gz", "wb")\nother <- con\npack(list(values = c(1, 2)), other)\nclose(con)'
    ]
  ])('captures exact compressed output evidence: %s', async (_label, source) => {
    const result = await captureSerialization(source)
    expect(result.fileAccess?.writes).toContain('outputs/checkpoint.gz')
    expect(result.normalized.writes).toContain('outputs/checkpoint.gz')
  })

  it.each([
    [
      'literal gz reader',
      'con <- gzfile("outputs/checkpoint.gz", "rb")\nrestored <- unserialize(con)\nclose(con)'
    ],
    ['qualified gz reader', 'restored <- base::unserialize(gzfile("outputs/checkpoint.gz", "rb"))'],
    [
      'aliased gz reader',
      'restore <- base::unserialize\ncon <- gzfile("outputs/checkpoint.gz", "rb")\nother <- con\nrestored <- restore(other)\nclose(con)'
    ]
  ])('captures exact compressed input evidence: %s', async (_label, source) => {
    const result = await captureSerialization(source)
    expect(result.fileAccess?.reads).toContain('outputs/checkpoint.gz')
    expect(result.normalized.reads).toContain('outputs/checkpoint.gz')
  })

  it.each([
    ['raw serialization', 'payload <- serialize(list(values = c(1, 2)), NULL)'],
    [
      'raw roundtrip',
      'payload <- serialize(list(values = c(1, 2)), NULL)\nrestored <- unserialize(payload)'
    ],
    [
      'aliased raw roundtrip',
      'pack <- base::serialize\nrestore <- base::unserialize\npayload <- pack(list(values = c(1, 2)), NULL)\nrestored <- restore(payload)'
    ],
    [
      'invalid character deserializer argument',
      'restored <- base::unserialize("not-a-file-argument")'
    ]
  ])('does not invent a disk artifact for %s', async (_label, source) => {
    const result = await captureSerialization(source)
    expect(result.normalized.reads).toEqual([])
    expect(result.normalized.writes).toEqual([])
  })

  it.each([
    [
      'serialize refhook',
      'con <- gzfile("outputs/checkpoint.gz", "wb")\nserialize(new.env(), con, refhook = function(x) { writeLines("hook", "outputs/hook.txt"); "token" })\nclose(con)'
    ],
    [
      'unserialize refhook',
      'con <- gzfile("outputs/checkpoint.gz", "rb")\nrestored <- unserialize(con, refhook = function(x) readRDS("inputs/reference.rds"))\nclose(con)'
    ]
  ])('retains uncertainty for %s', async (_label, source) => {
    const result = await captureSerialization(source)
    expect(result.facts.state).toBe('unknown')
    expect(result.normalized.readState).toBe('partial')
    expect(result.normalized.writeState).toBe('partial')
  })

  it('retains an append checkpoint as both input and output through aliases', async () => {
    const source =
      'pack <- base::serialize\ncon <- gzfile("state.bin.gz", "ab")\nother <- con\npack(list(x = 1), other)\nclose(con)'
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result.reads).toContain('state.bin.gz')
    expect(result.writes).toContain('state.bin.gz')
  })

  it.each([
    'pack <- base::serialize\npack <- custom\npack(list(x = 1), gzfile("fake.gz", "wb"))',
    'if (flag) pack <- base::serialize\npack(list(x = 1), gzfile("fake.gz", "wb"))',
    'custom::serialize(list(x = 1), gzfile("fake.gz", "wb"))',
    'serialize(list(x = 1), "fake.gz")',
    'con <- gzfile("fake.gz", "rb")\nserialize(list(x = 1), con)',
    'con <- gzfile("fake.gz")\nserialize(list(x = 1), con)',
    'con <- gzfile("fake.gz", "wb")\nclose(con)\nserialize(list(x = 1), con)'
  ])(
    'does not publish a serialization write without valid known callable/connection: %s',
    async (source) => {
      const result = await analyzeNotebookSourceFileAccess('r', source)
      expect(result.writes).not.toContain('fake.gz')
      expect(result.writeState).toBe('partial')
    }
  )

  it.each([
    'restore <- base::unserialize\nrestore <- custom\nrestored <- restore(gzfile("fake.gz", "rb"))',
    'custom::unserialize(gzfile("fake.gz", "rb"))',
    'restored <- unserialize("fake.gz")',
    'con <- gzfile("fake.gz", "wb")\nrestored <- unserialize(con)',
    'con <- gzfile("fake.gz", "rb")\nclose(con)\nrestored <- unserialize(con)'
  ])('does not publish an invalid/unknown unserialization input: %s', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('r', source)
    expect(result.reads).not.toContain('fake.gz')
    expect(result.readState).toBe('partial')
  })

  it('captures reordered named connection arguments without certifying restored ownership', async () => {
    const writer = await analyzeRNotebookSource(
      'con <- gzfile("state.gz", "wb")\nserialize(connection = con, object = list(x = 1))'
    )
    expect(writer.fileAccess?.writes).toContain('state.gz')
    expect(writer.facts.serializedValueWrites ?? []).toEqual([])
    const reader = await analyzeRNotebookSource(
      'con <- gzfile("state.gz", "rb")\nrestored <- unserialize(connection = con)'
    )
    expect(reader.fileAccess?.reads).toContain('state.gz')
    expect(reader.facts.typeBindings ?? []).toEqual([])
    expect(reader.facts.safeCallNames ?? []).not.toContain('unserialize')
    const run: NotebookRunRecord = {
      runId: 'restore-run',
      cellId: 'restore-cell',
      source: 'agent',
      kernelKind: 'r',
      kernelEpochId: 'epoch',
      environment: 'r',
      script: 'con <- gzfile("state.gz", "rb")\nrestored <- unserialize(connection = con)',
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }
    const snapshotScript = 'snapshot <- sum(restored$x)\nprint(snapshot)'
    const mutationScript = 'external_mutation(restored)'
    const snapshot = (await analyzeRNotebookSource(snapshotScript)).facts
    const mutation = (await analyzeRNotebookSource(mutationScript)).facts
    const projection = projectNotebookDependencies([
      { run, facts: reader.facts },
      {
        run: {
          ...run,
          runId: 'snapshot',
          cellId: 'snapshot',
          startedAt: 3,
          endedAt: 4,
          script: snapshotScript
        },
        facts: snapshot
      },
      {
        run: {
          ...run,
          runId: 'mutation',
          cellId: 'mutation',
          startedAt: 5,
          endedAt: 6,
          script: mutationScript
        },
        facts: mutation
      }
    ])
    expect(projection.stalenessByRunId.snapshot).toMatchObject({ state: 'unknown' })
  })

  it('keeps NULL serialization with a refhook conservative for both IO directions', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'payload <- serialize(new.env(), NULL, refhook = function(x) { writeLines("hook", "side.txt"); "token" })'
    )
    expect(result.readState).toBe('partial')
    expect(result.writeState).toBe('partial')
    expect(result.writes).not.toContain('NULL')
  })
})

describe('base R generic predicates require primitive dispatch proof', () => {
  it.each([
    'sensor <- as.numeric(read.csv("inputs/pressure.csv")$pressure)\nstopifnot(all(is.finite(sensor)))',
    'sensor <- as.numeric(structure(c(1., 2.), class="mercury_sensor"))\nflags <- is.finite(sensor)',
    'original <- structure(c(1., 2.), class="mercury_sensor")\nsensor <- as.integer(original)\nflags <- is.infinite(sensor)',
    'sensor <- as.logical(structure(c(1., 2.), .Dim=c(1L,2L)))\nflags <- is.nan(sensor)',
    'sensor <- as.character(structure(c(1., 2.), class="mercury_sensor"))\nflags <- base::is.finite(sensor)',
    'raw <- read.csv("inputs/pressure.csv")\nsensor <- structure(as.numeric(raw$pressure),class="mercury_sensor")\nis.finite.mercury_sensor <- function(x) { writeLines(as.character(length(x)), "outputs/r-sensor-audit.txt"); base::is.finite(unclass(x)) }\nflags <- base::is.finite(sensor)',
    'sensor <- structure(c(1., 2.), class = "mercury_sensor")\nstopifnot(all(is.finite(sensor)))',
    'sensor <- structure(c(1., 2.), class = "mercury_sensor")\nflags <- is.finite(sensor)',
    'sensor <- structure(c(1., 2.), class = "mercury_sensor")\nalias <- sensor\nflags <- is.infinite(alias)',
    'sensor <- structure(c(1., 2.), class = "mercury_sensor")\nflags <- base::is.nan(sensor)',
    'original <- structure(c(1., 2.), class = "mercury_sensor")\nsensor <- structure(original)\nstopifnot(all(is.finite(sensor)))',
    'sensor <- structure(get_sensor(), names = c("first", "second"))\nflags <- is.finite(sensor)',
    'sensor <- structure(c(1., 2.), ...)\nflags <- is.finite(sensor)',
    'sensor <- structure(c(1., 2.), dim = c(1L, 2L))\nstopifnot(all(is.finite(sensor)))',
    'sensor <- structure(c(1., 2.), .Dim = c(1L, 2L))\nflags <- is.finite(sensor)',
    'sensor <- matrix(c(1., 2.), nrow = 1L)\nflags <- is.finite(sensor)',
    'sensor <- structure(c(1., 2.), names = c("first", "second"))\nflags <- is.finite(sensor)',
    'sensor <- structure(c(1., 2.), .Names = c("first", "second"))\nflags <- is.finite(sensor)'
  ])('does not borrow ownership as proof of an unmodeled predicate method: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'sensor <- as.numeric(c(first="1",second="2"))\nflags <- is.finite(sensor)',
    'sensor <- as.integer(c(1.,2.))\nflags <- is.infinite(sensor)',
    'sensor <- as.logical(c(1L,0L))\nflags <- is.nan(sensor)',
    'sensor <- as.character(c(1.,2.))\nflags <- is.finite(sensor)',
    'sensor <- c(first = 1., second = 2.)\nstopifnot(all(is.finite(sensor)))',
    'sensor <- c(1., 2.)\nstopifnot(all(base::is.finite(sensor)))',
    'sensor <- seq_len(2L)\nflags <- is.infinite(sensor)',
    'sensor <- numeric(2L)\nflags <- is.nan(sensor)'
  ])('retains fresh primitive vector predicate certainty: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it('uses existing atomic context without inventing class metadata', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['sensor'],
      rAtomicValueNames: ['sensor'],
      rCopyOnModifyNames: ['sensor']
    }
    expect(
      await analyzeNotebookSourceFileAccess('r', 'flags <- is.finite(sensor)', context)
    ).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it('does not equate contextual copy ownership with primitive dispatch', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['sensor'],
      rCopyOnModifyNames: ['sensor']
    }
    expect(
      await analyzeNotebookSourceFileAccess('r', 'flags <- is.finite(sensor)', context)
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
})

describe('R count and sequence generic dispatch', () => {
  it.each(['length', 'nrow', 'ncol'])(
    'keeps classed %s results conservative when a predicate can dispatch hidden IO',
    async (inspector) => {
      // Native R permits length/dim methods to return classed counts. nrow/ncol
      // select dim(x), so a classed dimension's subset method can preserve that class.
      const source = [
        'sensor <- structure(c(1., 2.), class="mercury_sensor")',
        'length.mercury_sensor <- function(x) structure(base::length(unclass(x)), class="classed_count")',
        'dim.mercury_sensor <- function(x) structure(c(2L, 1L), class="classed_dim")',
        '`[.classed_dim` <- function(x, ...) structure(NextMethod("["), class="classed_count")',
        'is.finite.classed_count <- function(x) { writeLines("audit", "outputs/count-audit.txt"); base::is.finite(unclass(x)) }',
        `count <- ${inspector}(sensor)`,
        'flags <- base::is.finite(count)'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('does not infer a pure sequence from only its primitive starting value', async () => {
    const source = [
      'Ops.mercury_limit <- function(e1, e2) { writeLines(.Generic, "outputs/seq-audit.txt"); do.call(.Generic, list(unclass(e1), unclass(e2))) }',
      'limit <- structure(3., class="mercury_limit")',
      'values <- seq(1., limit, by=1.)',
      'flags <- is.finite(values)'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not borrow table ownership to prove a primitive count', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'raw <- read.csv("inputs/pressure.csv")\ncount <- nrow(raw)\nflags <- is.finite(count)'
      )
    ).toMatchObject({
      reads: ['inputs/pressure.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'count <- length(c(first="one", second="two"))\nflags <- is.finite(count)',
    'endpoint <- length(c(1., 2., 3.))\nvalues <- seq(1., endpoint, by=1.)\nflags <- is.finite(values)',
    'values <- seq(0, 2*pi, length.out=400)\nflags <- is.finite(values)'
  ])('retains recursively proven primitive counts and endpoints: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it('retains sequence proof through existing atomic kernel context', async () => {
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['endpoint'],
      rAtomicValueNames: ['endpoint'],
      rCopyOnModifyNames: ['endpoint']
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'values <- seq(1., endpoint, by=1.)\nflags <- is.finite(values)',
        context
      )
    ).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })
})

configureTestRuntimeMetadata()

// A library statistic can perform I/O independently of explicit notebook paths.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.binned_statistic.html
it.each([
  'result = binned_statistic(depth_arr, mag_arr, statistic=bin_reducer, bins=edges)',
  'result = binned_statistic(depth_arr, mag_arr, bin_reducer, edges)'
])(
  'keeps binned_statistic callback I/O partial while retaining explicit paths: %s',
  async (call) => {
    const source = [
      'from scipy.stats import binned_statistic',
      'CALIBRATION_PATH = "inputs/offset.txt"',
      'depth_arr = [40., 100., 680.]',
      'mag_arr = [4., 5., 6.]',
      'edges = [0., 40., 100., 680.]',
      'def calibrate():\n    with open(CALIBRATION_PATH) as handle:\n        return float(handle.read())',
      'def bin_reducer(values):\n    return sum(values) + calibrate()',
      'with open("inputs/metadata.txt") as handle:\n    metadata = handle.read()',
      call,
      'with open("outputs/report.txt", "w") as handle:\n    handle.write(metadata)'
    ].join('\n')
    const access = await analyzeNotebookSourceFileAccess('python', source)
    expect(access).toMatchObject({
      reads: ['inputs/metadata.txt'],
      writes: ['outputs/report.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    // The callback's potential global input does not identify each actual file open.
    expect(access.reads).not.toContain('inputs/offset.txt')
  }
)

// A reduced quad call must remain opaque even when its surrounding notebook has
// no other opaque operations; explicit paths do not describe complete callback I/O.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.quad.html
it.each([
  'result = quad(integrand, 0.0, 2.0, points=[1.0])',
  'result = quad(func=integrand, a=0.0, b=2.0, points=[1.0])'
])('keeps quad callback I/O partial while preserving explicit paths: %s', async (call) => {
  const source = [
    'from scipy.integrate import quad',
    'CALIBRATION_PATH = "inputs/offset.txt"',
    'def calibrate():\n    with open(CALIBRATION_PATH, "r", encoding="utf-8") as f:\n        return float(f.read().strip())',
    'def integrand(t):\n    return t + calibrate()',
    'with open("inputs/metadata.txt") as f:\n    metadata = f.read()',
    call,
    'with open("outputs/report.txt", "w") as f:\n    f.write(metadata)'
  ].join('\n')
  const access = await analyzeNotebookSourceFileAccess('python', source)
  expect(access).toMatchObject({
    reads: ['inputs/metadata.txt'],
    writes: ['outputs/report.txt'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect(access.reads).not.toContain('inputs/offset.txt')
})

// The executed pressure notebook read its calibration through a solver callback.
// Explicit top-level paths must not make that unmodeled callback I/O complete.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.root_scalar.html
it.each([
  'result = optimize.root_scalar(objective, args=(50.0,), bracket=(0.0, 360.0), method="brentq")',
  'result = optimize.root_scalar(f=objective, args=(50.0,), bracket=(0.0, 360.0), method="brentq")'
])('keeps root_scalar callback I/O partial while preserving explicit paths: %s', async (call) => {
  const source = [
    'from scipy import optimize',
    'OFFSET_PATH = "inputs/offset.txt"',
    'def calibrated_pressure(t):\n    with open(OFFSET_PATH, "r") as f:\n        return t + float(f.read().strip())',
    'def objective(t, target):\n    return calibrated_pressure(t) - target',
    'with open("inputs/metadata.txt") as f:\n    metadata = f.read()',
    call,
    'with open("outputs/report.txt", "w") as f:\n    f.write(metadata)'
  ].join('\n')
  const access = await analyzeNotebookSourceFileAccess('python', source)
  expect(access).toMatchObject({
    reads: ['inputs/metadata.txt'],
    writes: ['outputs/report.txt'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
  expect(access.reads).not.toContain('inputs/offset.txt')
})
