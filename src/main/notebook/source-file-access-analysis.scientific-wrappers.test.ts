import { describe, expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

describe('scientific input contracts through wrappers', () => {
  it.each([
    [
      'python',
      'import xarray as xr\ndef read_inputs(paths):\n    return xr.open_mfdataset(paths)',
      'read_inputs(["inputs/a.nc", "inputs/b.nc"])',
      ['inputs/a.nc', 'inputs/b.nc']
    ],
    [
      'python',
      'import numpy as np\ndef read_inputs(lines):\n    return np.loadtxt(lines)',
      'read_inputs(["1 2", "3 4"])',
      []
    ],
    [
      'r',
      'read_inputs <- function(paths) Biostrings::readDNAStringSet(paths)',
      'read_inputs(c("inputs/a.fa", "inputs/b.fa"))',
      ['inputs/a.fa', 'inputs/b.fa']
    ],
    [
      'r',
      'read_inputs <- function(paths) readr::read_csv(paths)',
      'read_inputs(c("inputs/a.csv", "inputs/b.csv"))',
      ['inputs/a.csv', 'inputs/b.csv']
    ],
    [
      'r',
      'read_inputs <- function(paths) readr::read_csv(show_col_types=FALSE, paths)',
      'read_inputs(c("inputs/a.csv", "inputs/b.csv"))',
      ['inputs/a.csv', 'inputs/b.csv']
    ],
    [
      'r',
      'read_inputs <- function(path) read.csv(header=TRUE, path)',
      'read_inputs("inputs/a.csv")',
      ['inputs/a.csv']
    ]
  ] as const)('retains %s input semantics: %s', async (language, setup, call, reads) => {
    const result = await analyzeNotebookSourceFileAccess(language, `${setup}\n${call}`)
    expect(result).toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads,
      writes: [],
      reasonCodes: []
    })
  })

  it.each([
    [
      'python',
      'import xarray as xr\ndef read_inputs(paths):\n    return xr.open_mfdataset(paths)\nread_inputs(["inputs/a.nc", other])'
    ],
    [
      'r',
      'read_inputs <- function(paths) Biostrings::readDNAStringSet(paths)\nread_inputs(c("inputs/a.fa", other))'
    ]
  ] as const)('keeps unresolved %s collections partial', async (language, source) => {
    expect(await analyzeNotebookSourceFileAccess(language, source)).toMatchObject({
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'import pysam\nhandle = pysam.AlignmentFile("inputs/reads.bam", "rb")',
    'from pysam import AlignmentFile as AF\nhandle = AF("inputs/reads", "rb")',
    'import pysam as ps\nhandle = ps.VariantFile("inputs/variants.vcf.gz")',
    'import pysam\nhandle = pysam.FastaFile("inputs/reference.fa")'
  ])('does not claim complete capture of implicit HTS resources: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'partial',
      externalState: 'partial',
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })
})
