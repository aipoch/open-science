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
    name: 'Python tifffile image pipeline',
    language: 'python',
    source:
      "import tifffile\nimage = tifffile.imread('source.tiff')\ntifffile.imwrite('result.tiff', image)",
    reads: ['source.tiff'],
    writes: ['result.tiff']
  },
  {
    name: 'Python imageio keyword pipeline',
    language: 'python',
    source:
      "import imageio.v3 as iio\nimage = iio.imread(uri='source.tiff')\niio.imwrite(uri='result.tiff', image=image)",
    reads: ['source.tiff'],
    writes: ['result.tiff']
  },
  {
    name: 'Python scikit-image keyword pipeline',
    language: 'python',
    source:
      "from skimage import io\nimage = io.imread(fname='source.tiff')\nio.imsave(fname='result.tiff', arr=image)",
    reads: ['source.tiff'],
    writes: ['result.tiff']
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

  it('keeps an xarray Zarr directory input conservative while retaining its root', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "import xarray as xr\ndataset = xr.open_zarr('store.zarr')"
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      reads: ['store.zarr'],
      writes: [],
      reasonCodes: expect.arrayContaining([
        'dynamic-path-unresolved',
        'source-analysis-unsupported-call'
      ])
    })
  })

  it.each(['anndata', 'anndata.io', 'scanpy'])(
    'retains a %s AnnData Zarr directory input while keeping coverage partial',
    async (module) => {
      await expect(
        analyzeNotebookSourceFileAccess(
          'python',
          `import ${module === 'scanpy' ? 'scanpy as sc' : `${module} as ad`}
adata = ${module === 'scanpy' ? 'sc' : 'ad'}.read_zarr('inputs/cells.zarr')`
        )
      ).resolves.toMatchObject({
        readState: 'partial',
        reads: ['inputs/cells.zarr'],
        writes: [],
        reasonCodes: expect.arrayContaining([
          'dynamic-path-unresolved',
          'source-analysis-unsupported-call'
        ])
      })
    }
  )

  it.each([
    "adata.write_zarr('outputs/cells.zarr')",
    "anndata.io.write_zarr(adata, 'outputs/cells.zarr')"
  ])('captures AnnData Zarr directory output: %s', async (source) => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        `import anndata\nadata = anndata.read_h5ad('inputs/cells.h5ad')\n${source}`
      )
    ).resolves.toMatchObject({
      writes: ['outputs/cells.zarr'],
      writeScopes: [{ kind: 'directory', path: 'outputs/cells.zarr' }]
    })
  })

  it('downgrades xarray coverage when a lazy dataset method is unmodeled', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "import xarray as xr\ndataset = xr.open_dataset('climate.nc')\ndataset.persist()"
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      reads: ['climate.nc'],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it.each([
    "import pyarrow.dataset as ds\ndataset = ds.dataset('inputs/events')",
    "from pyarrow.dataset import dataset as open_dataset\ndataset = open_dataset('inputs/events')"
  ])('retains a Python Arrow Dataset directory root conservatively: %s', async (source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      readState: 'partial',
      reads: ['inputs/events'],
      writes: [],
      reasonCodes: expect.arrayContaining([
        'dynamic-path-unresolved',
        'source-analysis-unsupported-call'
      ])
    })
  })

  it.each([
    ["fits.open('source.fits', mode='update')", ['source.fits'], ['source.fits']],
    ["fits.open('source.fits', mode='append')", ['source.fits'], ['source.fits']]
  ])(
    'captures Astropy FITS read/write modes conservatively: %s',
    async (expression, reads, writes) => {
      await expect(
        analyzeNotebookSourceFileAccess(
          'python',
          `from astropy.io import fits\nhdul = ${expression}`
        )
      ).resolves.toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        reads,
        writes,
        reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
      })
    }
  )

  it('keeps remote Astropy FITS sources conservative', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "from astropy.io import fits\nhdul = fits.open('https://example.test/source.fits', use_fsspec=True)"
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })
})
