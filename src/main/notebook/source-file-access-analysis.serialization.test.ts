import { describe, expect, it } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

type SerializationCase = {
  name: string
  language: NotebookLanguage
  source: string
  reads: string[]
  writes: string[]
}

const cases: SerializationCase[] = [
  {
    name: 'Python OpenPyXL',
    language: 'python',
    source:
      "import openpyxl\nbook = openpyxl.load_workbook('source.xlsx')\nbook.save('result.xlsx')",
    reads: ['source.xlsx'],
    writes: ['result.xlsx']
  },
  {
    name: 'Python NumPy binary files',
    language: 'python',
    source: "import numpy as np\nvalues = np.fromfile('source.bin')\nvalues.tofile('result.bin')",
    reads: ['source.bin'],
    writes: ['result.bin']
  },
  {
    name: 'Python Plotly method HTML',
    language: 'python',
    source:
      "import plotly.graph_objects as go\nfigure = go.Figure()\nfigure.write_html('chart.html')",
    reads: [],
    writes: ['chart.html']
  },
  {
    name: 'Python Plotly method image',
    language: 'python',
    source:
      "import plotly.graph_objects as go\nfigure = go.Figure()\nfigure.write_image('chart.png')",
    reads: [],
    writes: ['chart.png']
  },
  {
    name: 'Python Plotly function HTML',
    language: 'python',
    source:
      "import plotly.graph_objects as go\nimport plotly.io as pio\nfigure = go.Figure()\npio.write_html(figure, 'chart.html')",
    reads: [],
    writes: ['chart.html']
  },
  {
    name: 'Python statsmodels pickle',
    language: 'python',
    source:
      "from statsmodels.iolib.smpickle import load_pickle, save_pickle\nvalue = load_pickle('source.pkl')\nsave_pickle(value, 'result.pkl')",
    reads: ['source.pkl'],
    writes: ['result.pkl']
  },
  {
    name: 'Python lxml tree',
    language: 'python',
    source: "from lxml import etree\ntree = etree.parse('source.xml')\ntree.write('result.xml')",
    reads: ['source.xml'],
    writes: ['result.xml']
  },
  {
    name: 'R dget and dput',
    language: 'r',
    source: "value <- dget('source.R')\ndput(value, file = 'result.R')",
    reads: ['source.R'],
    writes: ['result.R']
  },
  {
    name: 'R self-contained htmlwidget',
    language: 'r',
    source:
      "widget <- htmlwidgets::createWidget('chart', list())\nhtmlwidgets::saveWidget(widget, 'widget.html')",
    reads: [],
    writes: ['widget.html']
  }
]

describe('serialization and visualization file access coverage', () => {
  it.each(cases)('$name', async ({ language, source, reads, writes }) => {
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads,
      writes,
      reasonCodes: []
    })
  })

  it('keeps an unknown Python reader with a static file-looking argument conservative', async () => {
    const source =
      "from custom_science import read_measurements\nvalue = read_measurements('source.measurements')"

    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'partial',
      writeState: 'complete',
      externalState: 'partial',
      reads: [],
      writes: [],
      reasonCodes: ['dynamic-path-unresolved']
    })
  })

  it('does not treat a non-file string passed to an unknown Python reader as a file', async () => {
    const source =
      "from custom_science import read_measurements\nvalue = read_measurements('sample')"

    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      readState: 'complete',
      reads: [],
      reasonCodes: []
    })
  })

  it('keeps an htmlwidget with an external dependency directory conservative', async () => {
    const source =
      "widget <- htmlwidgets::createWidget('chart', list())\nhtmlwidgets::saveWidget(widget, 'widget.html', selfcontained = FALSE)"

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'partial',
      externalState: 'partial',
      reads: [],
      writes: ['widget.html'],
      reasonCodes: ['dynamic-path-unresolved']
    })
  })

  it('keeps htmltools output conservative because it can emit a dependency directory', async () => {
    const source = "page <- htmltools::tags$html('hello')\nhtmltools::save_html(page, 'page.html')"

    await expect(analyzeNotebookSourceFileAccess('r', source)).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining([
        'source-analysis-unsupported-call',
        'dynamic-path-unresolved'
      ])
    })
  })
})
