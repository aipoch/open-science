import { describe, expect, it } from 'vitest'

import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

describe('scientific storage modes', () => {
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
