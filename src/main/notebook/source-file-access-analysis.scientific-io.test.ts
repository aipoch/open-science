import { describe, expect, it } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

type ScientificIoCase = {
  name: string
  language: NotebookLanguage
  source: string
  reads: string[]
  writes: string[]
  writeScopes?: Array<{ kind: 'directory'; path: string }>
}

const cases: ScientificIoCase[] = [
  {
    name: 'Python JSON write handle',
    language: 'python',
    source:
      "import json\nwith open('result.json', 'w') as handle:\n    json.dump({'x': 1}, handle)",
    reads: [],
    writes: ['result.json']
  },
  {
    name: 'Python pickle write handle',
    language: 'python',
    source:
      "import pickle\nwith open('model.pkl', 'wb') as handle:\n    pickle.dump({'x': 1}, handle)",
    reads: [],
    writes: ['model.pkl']
  },
  {
    name: 'Python JSON read handle',
    language: 'python',
    source: "import json\nwith open('source.json', 'r') as handle:\n    value = json.load(handle)",
    reads: ['source.json'],
    writes: []
  },
  {
    name: 'Python compressed JSON handle',
    language: 'python',
    source:
      "import gzip\nimport json\nwith gzip.open('result.json.gz', 'wt') as handle:\n    json.dump({'x': 1}, handle)",
    reads: [],
    writes: ['result.json.gz']
  },
  {
    name: 'Python YAML write handle',
    language: 'python',
    source:
      "import yaml\nwith open('value.yml', 'w') as handle:\n    yaml.safe_dump({'x': 1}, handle)",
    reads: [],
    writes: ['value.yml']
  },
  {
    name: 'Python in-memory YAML',
    language: 'python',
    source: "import yaml\nvalue = yaml.safe_load('x: 1')",
    reads: [],
    writes: []
  },
  {
    name: 'Python NumPy binary output',
    language: 'python',
    source: "import numpy as np\nvalues = np.array([1])\nvalues.tofile('values.bin')",
    reads: [],
    writes: ['values.bin']
  },
  {
    name: 'Python SciPy sparse output',
    language: 'python',
    source:
      "from scipy.sparse import csr_matrix, save_npz\nmatrix = csr_matrix([[1]])\nsave_npz('matrix.npz', matrix)",
    reads: [],
    writes: ['matrix.npz']
  },
  {
    name: 'Python Pillow image pipeline',
    language: 'python',
    source: "from PIL import Image\nimage = Image.open('source.png')\nimage.save('result.png')",
    reads: ['source.png'],
    writes: ['result.png']
  },
  {
    name: 'Python PyArrow parquet output',
    language: 'python',
    source:
      "import pyarrow as pa\nimport pyarrow.parquet as pq\ntable = pa.table({'x': [1]})\npq.write_table(table, 'table.parquet')",
    reads: [],
    writes: ['table.parquet']
  },
  {
    name: 'Python Rasterio modes',
    language: 'python',
    source:
      "import rasterio\nwith rasterio.open('source.tif', 'r') as source:\n    profile = source.profile\nwith rasterio.open('result.tif', 'w', **profile) as result:\n    pass",
    reads: ['source.tif'],
    writes: ['result.tif']
  },
  {
    name: 'Python NetCDF output',
    language: 'python',
    source:
      "from netCDF4 import Dataset\nwith Dataset('result.nc', 'w') as dataset:\n    dataset.createDimension('x', 1)",
    reads: [],
    writes: ['result.nc']
  },
  {
    name: 'Python memmap modes',
    language: 'python',
    source:
      "import numpy as np\nsource = np.memmap('source.bin', mode='r')\nresult = np.memmap('result.bin', mode='w+', shape=(1,))",
    reads: ['source.bin'],
    writes: ['result.bin']
  },
  {
    name: 'Python HDFStore output',
    language: 'python',
    source:
      "import pandas as pd\nwith pd.HDFStore('store.h5', mode='w') as store:\n    store['values'] = pd.DataFrame({'x': [1]})",
    reads: [],
    writes: ['store.h5']
  },
  {
    name: 'Python ExcelWriter append mode',
    language: 'python',
    source:
      "import pandas as pd\nwith pd.ExcelWriter('book.xlsx', mode='a') as writer:\n    pd.DataFrame({'x': [1]}).to_excel(writer)",
    reads: ['book.xlsx'],
    writes: ['book.xlsx']
  },
  {
    name: 'Python Zarr directory output',
    language: 'python',
    source: "import zarr\nstore = zarr.open('store.zarr', mode='w')",
    reads: [],
    writes: ['store.zarr'],
    writeScopes: [{ kind: 'directory', path: 'store.zarr' }]
  },
  {
    name: 'R readr text outputs',
    language: 'r',
    source: "readr::write_lines(c('a', 'b'), 'lines.txt')\nreadr::write_file('done', 'note.txt')",
    reads: [],
    writes: ['lines.txt', 'note.txt']
  },
  {
    name: 'R JSON and YAML outputs',
    language: 'r',
    source:
      "value <- list(x = 1)\njsonlite::write_json(value, 'value.json')\nyaml::write_yaml(value, 'value.yml')",
    reads: [],
    writes: ['value.json', 'value.yml']
  },
  {
    name: 'R captured output',
    language: 'r',
    source: "capture.output(print(1:3), file = 'summary.txt')",
    reads: [],
    writes: ['summary.txt']
  },
  {
    name: 'R sink output',
    language: 'r',
    source: "sink('console.txt')\nprint(1)\nsink()",
    reads: [],
    writes: ['console.txt']
  },
  {
    name: 'R Cairo graphics output',
    language: 'r',
    source: "Cairo::CairoPNG('chart.png')\nplot(1:3)\ngrDevices::dev.off()",
    reads: [],
    writes: ['chart.png']
  },
  {
    name: 'R HDF5 write-read pipeline',
    language: 'r',
    source:
      "value <- 1:3\nrhdf5::h5write(value, 'data.h5', 'value')\nloaded <- rhdf5::h5read('data.h5', 'value')",
    reads: [],
    writes: ['data.h5']
  },
  {
    name: 'R Matrix Market output',
    language: 'r',
    source: "Matrix::writeMM(matrix(1:4, nrow = 2), 'matrix.mtx')",
    reads: [],
    writes: ['matrix.mtx']
  }
]

describe('scientific file access coverage', () => {
  it.each(cases)('$name', async ({ language, source, reads, writes, writeScopes }) => {
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads,
      writes,
      ...(writeScopes ? { writeScopes } : {}),
      reasonCodes: []
    })
  })

  it('keeps a Zarr directory input conservative', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "import zarr\nstore = zarr.open('store.zarr', mode='r')"
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      writes: [],
      reasonCodes: ['dynamic-path-unresolved']
    })
  })
})
