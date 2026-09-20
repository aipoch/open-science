import { describe, expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

describe('flow cytometry file contracts', () => {
  it.each([
    'flowCore::read.FCS("inputs/sample.fcs")',
    'flowCore::read.FCS(transformation = FALSE, filename = "inputs/sample.fcs")',
    'library(flowCore)\nread.FCS("inputs/sample.fcs", which.lines = NULL)',
    'flowCore::read.FCS("inputs/sample.fcs", which.lines = 2:5)'
  ])('captures eager single-file reads: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/sample.fcs'],
      writes: [],
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it.each(['100', 'sample_count', 'c(100)'])(
    'retains sampling uncertainty: %s',
    async (selection) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          `flowCore::read.FCS("inputs/sample.fcs", which.lines = ${selection})`
        )
      ).toMatchObject({
        reads: ['inputs/sample.fcs'],
        externalState: 'partial'
      })
    }
  )

  it.each([
    'flowCore::write.FCS(frame, "output.fcs")',
    'flowCore::write.FCS(filename = "output.fcs", x = frame)',
    'flowCore::write.FCS(x = frame, "output.fcs")'
  ])('captures a replacement output with R argument matching: %s', async (source) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `frame <- flowCore::read.FCS("inputs/sample.fcs")\n${source}`
      )
    ).toMatchObject({
      reads: ['inputs/sample.fcs'],
      writes: ['output.fcs'],
      writeState: 'complete'
    })
  })

  it('captures explicit file vectors without guessing companion files', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'flowCore::read.flowSet(files = c("inputs/a.fcs", "inputs/b.fcs"), transformation = FALSE)'
      )
    ).toMatchObject({
      reads: ['inputs/a.fcs', 'inputs/b.fcs'],
      writes: [],
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it('does not attribute ignored files when phenotype metadata selects the inputs', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'flowCore::read.flowSet(files = "unused.fcs", path = "inputs", phenoData = "samples.tsv")'
    )
    expect(result).toMatchObject({
      reads: ['inputs/samples.tsv'],
      readState: 'partial',
      externalState: 'partial'
    })
    expect(result.reads).not.toContain('unused.fcs')
  })

  it('keeps directory discovery partial without inventing FCS files', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'flowCore::read.flowSet(path = "inputs", pattern = "[.]fcs$")'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('retains uncertainty when the file selection depends on a dynamic directory', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'flowCore::read.flowSet(files = "sample.fcs", path = input_dir)'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('joins explicit files to a static directory using flowCore path semantics', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `library(flowCore)
folder <- "inputs/batch"
files <- c("a.fcs", "b.fcs")
read.flowSet(path = folder, files, phenoData = NULL)`
      )
    ).toMatchObject({
      reads: ['inputs/batch/a.fcs', 'inputs/batch/b.fcs'],
      externalState: 'complete'
    })
  })

  it('captures partial argument names with their actual formal positions', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `frame <- flowCore::read.FCS(trans = FALSE, file = "inputs/sample.fcs")
flowCore::write.FCS(x = frame, file = "output.fcs")`
      )
    ).toMatchObject({
      reads: ['inputs/sample.fcs'],
      writes: ['output.fcs'],
      writeState: 'complete'
    })
  })

  it('does not invent a read path for dynamic filenames', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'flowCore::read.FCS(filename = input_file)')
    ).toMatchObject({
      reads: [],
      readState: 'partial'
    })
  })

  it('does not read an earlier output as an original input', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `frame <- flowCore::read.FCS("inputs/sample.fcs")
flowCore::write.FCS(frame, "output.fcs")
flowCore::read.FCS("output.fcs")`
      )
    ).toMatchObject({
      reads: ['inputs/sample.fcs'],
      writes: ['output.fcs']
    })
  })

  it('retains partial state for a local reader that can access additional resources', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `read.FCS <- function(filename) custom_reader(filename)
read.FCS("inputs/sample.fcs")`
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it.each(['c()', 'character(0)', 'NULL'])(
    'does not certify an empty or default file selection: %s',
    async (files) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          `flowCore::read.flowSet(files = ${files}, path = "inputs")`
        )
      ).toMatchObject({
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each(['https://example.org/sample.fcs', '|cat sample.fcs', '-', '/dev/stdin', 'inputs/*.fcs'])(
    'does not invent file sets from unsupported special paths: %s',
    async (path) => {
      expect(
        await analyzeNotebookSourceFileAccess('r', `flowCore::read.flowSet(files = c("${path}"))`)
      ).toMatchObject({
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('keeps deprecated ncdf input eager instead of inventing a disk cache', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'flowCore::read.FCS("inputs/sample.fcs", ncdf = TRUE)'
      )
    ).toMatchObject({
      reads: ['inputs/sample.fcs'],
      writes: [],
      externalState: 'complete'
    })
  })

  it('does not borrow flowCore contracts from another namespace', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'other::read.FCS("unused.fcs")\nother::write.FCS(frame, "unused-output.fcs")'
      )
    ).toMatchObject({
      reads: [],
      writes: [],
      externalState: 'partial'
    })
  })

  it('keeps unknown readers and writer objects partial', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'flowCore::write.FCS(frame, "output.fcs")')
    ).toMatchObject({
      writes: ['output.fcs'],
      externalState: 'partial'
    })
  })
})
