import { describe, expect, it } from 'vitest'

import { analyzePythonSources } from './dependency-analysis-python'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

// Adapted from the upstream cyvcf2 VCF rewriting example and API contracts:
// https://brentp.github.io/cyvcf2/ and /docstrings.html
describe('variant file contracts', () => {
  it('captures a VCF header output constructed entirely from explicit text', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `
from cyvcf2 import Writer
writer = Writer.from_string("header.vcf", "##fileformat=VCFv4.2")
writer.close()
`
    )
    expect(result).toMatchObject({ reads: [], writes: ['header.vcf'], writeState: 'complete' })
  })

  it('resolves an explicit index through a saved typed reader binding', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      'reader.set_index("inputs/custom.csi")',
      {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonBindings: [{ name: 'reader', qualifiedName: 'cyvcf2.VCF', kind: 'object' }],
        resolvedKernelNames: ['reader']
      }
    )
    expect(result).toMatchObject({ reads: ['inputs/custom.csi'], externalState: 'partial' })
  })

  it('captures the input, explicit index and rewritten VCF without claiming index completeness', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `
from cyvcf2 import VCF, Writer
reader = VCF(fname="inputs/cohort.vcf.gz")
reader.set_index(index_path="inputs/custom.tbi")
reader.add_info_to_header({'ID': 'reviewed', 'Description': 'Reviewed', 'Type': 'Flag', 'Number': '0'})
writer = Writer("filtered.vcf.gz", reader, mode="wz4")
for variant in reader:
    if variant.FILTER is None:
        writer.write_record(variant)
writer.close()
reader.close()
`
    )
    expect(result).toMatchObject({
      reads: ['inputs/cohort.vcf.gz', 'inputs/custom.tbi'],
      writes: ['filtered.vcf.gz'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not interpret a region query as a new VCF filename', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `
import cyvcf2 as cv
reader = cv.VCF("inputs/cohort.bcf")
selected = reader("chr1:100-200")
`
    )
    expect(result).toMatchObject({
      reads: ['inputs/cohort.bcf'],
      writes: [],
      externalState: 'partial'
    })
  })

  it.each([
    'reader.set_index()',
    'reader.set_index("")',
    'reader.set_index(index_path=chosen_index)'
  ])('retains missing or dynamic index uncertainty: %s', async (call) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `
from cyvcf2 import VCF
reader = VCF("inputs/cohort.vcf.gz")
${call}
`
    )
    expect(result).toMatchObject({
      reads: ['inputs/cohort.vcf.gz'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    '"-"',
    '"/dev/stdin"',
    '"https://example.org/cohort.vcf.gz"',
    '0',
    'stream',
    '"inputs/cohort.vcf.gz##idx##inputs/custom.tbi"'
  ])('does not freeze an HTS stream or composite input as a local file: %s', async (path) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `from cyvcf2 import VCF\nreader = VCF(${path})`
    )
    expect(result).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
  })

  it.each(['"-"', '"/dev/stdout"', '"https://example.org/out.vcf"', '1'])(
    'does not freeze a non-file output: %s',
    async (path) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `
from cyvcf2 import Writer
writer = Writer.from_string(${path}, "##fileformat=VCFv4.2")
`
      )
      expect(result).toMatchObject({ writes: [], writeState: 'partial', externalState: 'partial' })
    }
  )

  it.each(['"w"', '"wb"', '"wbu"', '"wz"', '"wb9"', 'None'])(
    'captures writer destinations with documented mode %s',
    async (mode) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `
import cyvcf2 as cv
source = cv.VCF("inputs/source.vcf")
output = cv.Writer(fname="output.bcf", tmpl=source, mode=${mode})
output.close()
`
      )
      expect(result).toMatchObject({
        reads: ['inputs/source.vcf'],
        writes: ['output.bcf'],
        writeState: 'complete'
      })
    }
  )

  it('does not decide read versus write for a dynamic HTS mode', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `
from cyvcf2 import Writer
output = Writer.from_string("output.vcf", "##fileformat=VCFv4.2", mode=chosen_mode)
`
    )
    expect(result).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial'
    })
  })

  it('keeps template dependencies and header changes in the common variable analysis', async () => {
    const [facts] = await analyzePythonSources([
      `
from cyvcf2 import VCF, Writer
reader = VCF(source_path)
reader.add_info_to_header(header)
writer = Writer(destination, reader)
writer.close()
`
    ])
    expect(facts).toMatchObject({
      priorUsedNames: expect.arrayContaining(['source_path', 'header', 'destination'])
    })
  })

  it('does not trust a replaced constructor', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `
from cyvcf2 import VCF
VCF = replacement
reader = VCF("not-a-proven-input.vcf")
`
    )
    expect(result.reads).toEqual([])
    expect(result.readState).toBe('partial')
  })
})
