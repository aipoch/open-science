import { describe, expect, it } from 'vitest'

import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

describe('omics file contracts', () => {
  it('captures explicitly requested MGF index generation without assuming existing index input', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `from pyteomics import mgf
mgf.IndexedMGF.prebuild_byte_offset_file("inputs/sample.mgf")`
      )
    ).toMatchObject({
      reads: ['inputs/sample.mgf'],
      writes: ['inputs/sample-mgf-byte-offsets.json'],
      externalState: 'partial'
    })
  })

  it.each([
    [
      'from pyteomics.mgf import IndexedMGF as Reader',
      'inputs/spectra',
      'inputs/spectra--byte-offsets.json'
    ],
    [
      'from pyteomics.mgf import IndexedMGF as Reader',
      'inputs/.spectra',
      'inputs/.spectra--byte-offsets.json'
    ],
    [
      'from pyteomics.mzml import MzML as Reader',
      'inputs/sample.mzML',
      'inputs/sample-mzML-byte-offsets.json'
    ]
  ])('captures explicit aliased index generation: %s %s', async (imports, path, output) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `${imports}\npath = "${path}"\nReader.prebuild_byte_offset_file(path=path)`
      )
    ).toMatchObject({ reads: [path], writes: [output], externalState: 'partial' })
  })

  it('does not invent an index filename from a dynamic source', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from pyteomics import mgf\nmgf.IndexedMGF.prebuild_byte_offset_file(get_source())'
      )
    ).toMatchObject({ reads: [], writes: [], readState: 'partial', writeState: 'partial' })
  })

  it('keeps index output paths with platform-dependent separators unresolved', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        String.raw`from pyteomics import mgf
mgf.IndexedMGF.prebuild_byte_offset_file(r"folder\\.spectra")`
      )
    ).toMatchObject({ writes: [], writeState: 'partial', externalState: 'partial' })
  })

  it('does not treat merely opening IndexedMGF as a sidecar write', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from pyteomics import mgf\nmgf.IndexedMGF("inputs/sample.mgf")'
      )
    ).toMatchObject({ reads: ['inputs/sample.mgf'], writes: [], externalState: 'partial' })
  })

  it('does not borrow index building effects after a class method is replaced', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `from pyteomics import mgf
mgf.IndexedMGF.prebuild_byte_offset_file = replacement
mgf.IndexedMGF.prebuild_byte_offset_file("unused.mgf")`
      )
    ).toMatchObject({ reads: [], writes: [], externalState: 'partial' })
  })

  it('does not borrow index building effects from a reassigned package name', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `import pyteomics.mgf
pyteomics = replacement
pyteomics.mgf.IndexedMGF.prebuild_byte_offset_file("unused.mgf")`
      )
    ).toMatchObject({ reads: [], writes: [], externalState: 'partial' })
  })

  it('captures each explicit transcript-quantification input', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `
files <- c(control="inputs/control/quant.sf", treated="inputs/treated/quant.sf")
tx2gene <- read.csv("inputs/tx2gene.csv")
counts <- tximport::tximport(files, type="salmon", tx2gene=tx2gene, dropInfReps=TRUE)
saveRDS(counts, "counts.rds")
`
      )
    ).toMatchObject({
      reads: ['inputs/control/quant.sf', 'inputs/treated/quant.sf', 'inputs/tx2gene.csv'],
      writes: ['counts.rds']
    })
  })

  it.each([
    ['mzml', 'reader = mzml.MzML("inputs/sample.mzML")'],
    ['mgf', 'reader = mgf.MGF("inputs/sample.mgf")']
  ])('captures an explicit %s reader input', async (module, call) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', `from pyteomics import ${module}\n${call}`)
    ).toMatchObject({ reads: [`inputs/sample.${module === 'mzml' ? 'mzML' : 'mgf'}`] })
  })

  it('allows the bounded transcript-level Salmon import with inferential replicates disabled', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `
files <- c(A="inputs/A/quant.sf", B="inputs/B/quant.sf.gz")
txi <- tximport::tximport(type="salmon", files, txOut=TRUE, dropInfReps=TRUE)
write.csv(txi$counts, "counts.csv")`
      )
    ).toMatchObject({
      reads: ['inputs/A/quant.sf', 'inputs/B/quant.sf.gz'],
      writes: ['counts.csv'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it.each([
    'type="salmon", txOut=TRUE',
    'type="salmon", txOut=TRUE, dropInfReps=drop',
    'type="salmon", txOut=TRUE, dropInfReps=TRUE, importer=custom_reader',
    'type="alevin", txOut=TRUE, dropInfReps=TRUE',
    'type="kallisto", txOut=TRUE, dropInfReps=FALSE'
  ])('retains replicate/dispatch uncertainty: %s', async (options) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `txi <- tximport::tximport(c("inputs/A/quant.sf", "inputs/B/quant.sf"), ${options})`
      )
    ).toMatchObject({ reads: ['inputs/A/quant.sf', 'inputs/B/quant.sf'], externalState: 'partial' })
  })

  it.each([
    'MSnbase::readMSData(files=c("inputs/A.mzML", "inputs/B.mzML"), mode="onDisk")',
    'Spectra::Spectra(c("inputs/A.mzML", "inputs/B.mzML"))'
  ])(
    'captures file-backed peak inputs without claiming a self-contained result: %s',
    async (source) => {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['inputs/A.mzML', 'inputs/B.mzML'],
        externalState: 'partial'
      })
    }
  )

  it.each(['IndexedMGF', 'read'])('keeps %s sidecar uncertainty', async (reader) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `from pyteomics import mgf\nspectra = mgf.${reader}("inputs/a.mgf")`
      )
    ).toMatchObject({ reads: ['inputs/a.mgf'], externalState: 'partial' })
  })

  it('does not certify mzML solely from disabled index/schema flags', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from pyteomics import mzml\nx = mzml.read("inputs/a.mzML", use_index=False, read_schema=False)'
      )
    ).toMatchObject({ reads: ['inputs/a.mzML'], externalState: 'partial' })
  })

  it.each([
    ['file_mode="w"', [], 'complete'],
    ['file_mode="a"', ['results.mgf'], 'complete'],
    ['', [], 'partial'],
    ['file_mode=mode', [], 'partial'],
    ['file_mode="w", **options', [], 'partial']
  ])('records MGF output mode: %s', async (option, reads, externalState) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `from pyteomics import mgf\nmgf.write([], output="results.mgf", ${option})`
      )
    ).toMatchObject({ reads, writes: ['results.mgf'], externalState })
  })

  it('does not borrow input contracts for namespace lookalikes', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import unrelated as mgf\nx = mgf.MGF("not-read.mgf")'
      )
    ).toMatchObject({ reads: [] })
    expect(
      await analyzeNotebookSourceFileAccess('r', 'unrelated::tximport("not-read.sf")')
    ).toMatchObject({ reads: [], externalState: 'partial' })
  })

  it('does not certify custom MGF formatters with uncaptured inputs', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `
from pyteomics import mgf
def format_title(key, value):
    return open("inputs/header.txt").read()
mgf.write([], output="out.mgf", file_mode="w", param_formatters={"title": format_title})
`
      )
    ).toMatchObject({ externalState: 'partial' })
  })

  it('keeps optional positional MGF writer callbacks conservative', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `
from pyteomics import mgf
mgf.write([], "out.mgf", "", [], None, True, False, None, formatters, file_mode="w")
`
      )
    ).toMatchObject({ writes: ['out.mgf'], externalState: 'partial' })
  })

  it('does not require old output bytes after an explicit overwrite in the same cell', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `
from pyteomics import mgf
mgf.write([], output="out.mgf", file_mode="w")
mgf.write([], output="out.mgf", file_mode="a")
`
      )
    ).toMatchObject({ reads: [], writes: ['out.mgf'], externalState: 'complete' })
  })

  it.each([
    ['w', []],
    ['a', ['out.mgf']]
  ])('resolves a static MGF mode variable: %s', async (mode, reads) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `
from pyteomics import mgf
mode = "${mode}"
mgf.write([], output="out.mgf", file_mode=mode)
`
      )
    ).toMatchObject({ reads, writes: ['out.mgf'], externalState: 'complete' })
  })

  it('does not certify a dynamically resolved mass-spectrum source', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `
from pyteomics import mgf
reader = mgf.MGF(resolve_sample())
`
      )
    ).toMatchObject({ readState: 'partial', externalState: 'partial' })
  })

  it('keeps custom tximport wrappers conservative instead of dropping hidden options', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'load_counts <- function(files) tximport::tximport(files, type="salmon")\nx <- load_counts("inputs/a.sf")'
      )
    ).toMatchObject({ externalState: 'partial' })
  })
})
