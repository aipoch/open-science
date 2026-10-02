import { describe, expect, it } from 'vitest'

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
