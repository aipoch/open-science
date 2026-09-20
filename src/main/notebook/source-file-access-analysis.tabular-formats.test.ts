import { describe, expect, it } from 'vitest'

import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

describe('tabular format file access coverage', () => {
  it.each([
    ['SPSS', "import pandas as pd\nframe = pd.read_spss('source.sav')", 'source.sav'],
    ['XML', "import pandas as pd\nframe = pd.read_xml('source.xml')", 'source.xml'],
    ['HTML', "import pandas as pd\nframes = pd.read_html('source.html')", 'source.html']
  ])('captures a pandas %s input', async (_format, source, path) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [path],
      writes: [],
      reasonCodes: []
    })
  })

  it.each([
    ['HTML', 'to_html', 'result.html'],
    ['LaTeX', 'to_latex', 'result.tex'],
    ['Markdown', 'to_markdown', 'result.md']
  ])('captures a pandas %s output', async (_format, method, path) => {
    const source = `import pandas as pd\nframe = pd.DataFrame({'value': [1]})\nframe.${method}('${path}')`

    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: [path],
      reasonCodes: []
    })
  })

  it.each([
    ['CSV', 'scan_csv', 'source.csv'],
    ['IPC', 'scan_ipc', 'source.arrow'],
    ['NDJSON', 'scan_ndjson', 'source.ndjson'],
    ['Parquet', 'scan_parquet', 'source.parquet']
  ])('captures a Polars %s lazy input', async (_format, method, path) => {
    const source = `import polars as pl\nframe = pl.${method}('${path}')`

    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [path],
      writes: [],
      reasonCodes: []
    })
  })

  it('captures Polars lazy sinks', async () => {
    const source = [
      'import polars as pl',
      "frame = pl.scan_csv('source.csv')",
      "frame.sink_csv('result.csv')",
      "frame.sink_ipc('result.arrow')",
      "frame.sink_ndjson('result.ndjson')",
      "frame.sink_parquet('result.parquet')"
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['source.csv'],
      writes: ['result.arrow', 'result.csv', 'result.ndjson', 'result.parquet'],
      reasonCodes: []
    })
  })

  it.each([
    ["import polars as pl\nframe = pl.scan_csv('inputs/*.csv')", 'readState'],
    ["frame.to_csv('outputs/part-*.csv')", 'writeState']
  ])('keeps multi-file collection paths conservative', async (source, partialState) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      [partialState]: 'partial',
      reads: [],
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })
})
