import { describe, expect, it } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

describe('scientific reader review regressions', () => {
  it.each([
    "from scipy import sparse\nsparse.load_npz('https://example.org/data.npz')",
    "from rdkit import Chem\nChem.MolFromMolFile('/vsis3/bucket/data.mol')",
    "from astropy.io import fits\nfits.getdata('https://example.org/data.fits')",
    "from scipy import sparse\nsparse.save_npz('s3://bucket/data.npz', matrix)"
  ])('does not certify external scientific paths: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      externalState: 'partial',
      reads: [],
      writes: []
    })
  })

  it.each([
    "import mne\nmne.io.read_raw_fif('input.fif')",
    "from mne.io import read_raw_fif\nread_raw_fif('input.fif')",
    "import mne.io as io\nio.read_raw_fif('input.fif')"
  ])('retains split FIF uncertainty: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'partial',
      reads: ['input.fif'],
      externalState: 'partial'
    })
  })

  it.each(['use_fsspec=True', 'use_fsspec=backend', '**options'])(
    'keeps FITS backend access partial: %s',
    async (options) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          `from astropy.io import fits\nhdul = fits.open('input.fits', ${options})`
        )
      ).toMatchObject({ readState: 'partial', externalState: 'partial' })
    }
  )

  it.each([
    "import fsspec\nwith fsspec.open('inputs/measurements.csv', 'rt') as handle:\n    text = handle.read()",
    "import fsspec\nhandles = fsspec.open_files(['inputs/a.csv', 'inputs/b.csv'])\ntext = [handle.read() for handle in handles]",
    "import fsspec\nmapper = fsspec.get_mapper('inputs/store.zarr')\nvalue = mapper['zarr.json']"
  ])('retains explicit local fsspec inputs while staying partial: %s', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result).toMatchObject({
      readState: 'partial',
      externalState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
    expect(result.reads).toEqual(
      expect.arrayContaining(
        source.includes('open_files') ? ['inputs/a.csv', 'inputs/b.csv'] : [expect.any(String)]
      )
    )
  })

  it('records fsspec write modes as outputs instead of inputs', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      "import fsspec\nwith fsspec.open('outputs/result.csv', 'wt') as handle:\n    handle.write('value\\n')"
    )
    expect(result).toMatchObject({
      readState: 'partial',
      externalState: 'partial',
      reads: [],
      writes: ['outputs/result.csv']
    })
  })

  it('does not infer mapper output from a filesystem mode option', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "import fsspec\nmapper = fsspec.get_mapper('outputs/store.zarr', mode = 'w')"
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      writes: []
    })
  })

  it.each([
    "fsspec.open('outputs/result.csv', 'wt', **options)",
    "fsspec.open('outputs/result.csv', 'wt', filesystem=custom_fs)",
    "fsspec.open('outputs/result.csv', 'wt', protocol='s3')",
    "fsspec.open('outputs/result.csv', 'wt', custom_option=True)",
    "fsspec.open('outputs/result.csv', mode=selected_mode, fs=custom_fs)",
    "fsspec.open_files(['outputs/a.csv'], 'wb', storage_options=options)",
    "fsspec.open('inputs/result.csv', 'rb', **options)"
  ])('keeps unproved fsspec outputs partial: %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', `import fsspec\nhandle = ${call}`)
    ).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      writes: []
    })
  })

  it.each([
    "fsspec.open('inputs/result.csv')",
    "fsspec.open('inputs/result.csv', 'rt')",
    "fsspec.open_files(['inputs/result.csv'], mode='rb')"
  ])('keeps proved read-only fsspec calls free of possible writes: %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', `import fsspec\nhandle = ${call}`)
    ).toMatchObject({
      readState: 'partial',
      writeState: 'complete',
      writes: [],
      reads: ['inputs/result.csv']
    })
  })

  it('tracks Visium directory input and VCF output paths', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      'spe <- SpatialExperiment::read10xVisium(samples = "inputs/visium")\nVariantAnnotation::writeVcf(vcf, "outputs/cohort.filtered.vcf.gz", index = TRUE)'
    )
    expect(result.reads).toContain('inputs/visium')
    expect(result.writes).toContain('outputs/cohort.filtered.vcf.gz')
    expect(result.readState).toBe('partial')
    expect(result.writeState).toBe('partial')
    expect(result.externalState).toBe('partial')
  })

  it.each([
    'param = VariantAnnotation::ScanVcfParam(which = GenomicRanges::GRanges("chr1", IRanges::IRanges(1, 10)))',
    '"hg38", VariantAnnotation::ScanVcfParam(which = GenomicRanges::GRanges("chr1", IRanges::IRanges(1, 10)))'
  ])('keeps indexed VariantAnnotation reads partial: %s', async (argumentsSource) => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'r',
        `vcf <- VariantAnnotation::readVcf("inputs/cohort.vcf.gz", ${argumentsSource})`
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      externalState: 'partial',
      reads: ['inputs/cohort.vcf.gz'],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it.each([
    'SpatialExperiment::read10xVisium(samples = "inputs/visium")',
    'SpatialExperiment::read10xVisium(samples = c("inputs/control", "inputs/treated"))',
    'DropletUtils::read10xCounts(samples = "inputs/matrix")'
  ])('retains directory evidence before collection reader returns: %s', async (source) => {
    const { fileAccess } = await analyzeRNotebookSource(`object <- ${source}`)
    expect(fileAccess).toMatchObject({ unresolvedReads: true, directoryStateRead: true })
  })

  it.each([
    "import scanpy as sc\nadata = sc.read_10x_mtx('inputs/matrix')",
    "import scanpy as sc\nadata = sc.read_visium('inputs/visium')"
  ])('marks directory-backed Scanpy readers as partial: %s', async (source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      readState: 'partial',
      externalState: 'partial',
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it.each([
    "import fsspec\nwith fsspec.open('https://example.org/measurements.csv', 'rt') as handle:\n    text = handle.read()",
    "import fsspec\nmapper = fsspec.get_mapper('s3://bucket/store.zarr')",
    "import fsspec\nwith fsspec.open('inputs/measurements.csv', filesystem=remote_fs) as handle:\n    text = handle.read()",
    "import fsspec\nwith fsspec.open('inputs/measurements.csv', fs=remote_fs) as handle:\n    text = handle.read()",
    "import fsspec\nmapper = fsspec.get_mapper('inputs/store.zarr', storage_options=remote_options)"
  ])('does not attribute fsspec inputs to remote resources: %s', async (source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      readState: 'partial',
      externalState: 'partial',
      reads: [],
      writes: []
    })
  })
})

describe('SciPy curve_fit hidden callback I/O', () => {
  // Reduced from an executed mercury vapor-pressure workflow. The Jacobian
  // accesses these files during the solver call, not while it is defined.
  it.each([
    'model_fn, temperatures, log_observed, jac=jac_fn',
    'model_fn, temperatures, log_observed, None, None, False, None, (-np.inf, np.inf), "lm", jac_fn'
  ])('does not certify complete I/O for model/Jacobian callbacks: %s', async (arguments_) => {
    const source = [
      'import numpy as np',
      'from scipy.optimize import curve_fit',
      'kelvin_offset = 273.15',
      'ref_temperature = 298.15',
      'temperatures = np.array([0.0, 20.0, 40.0])',
      'log_observed = np.array([-8.5, -6.7, -5.1])',
      'def model_fn(temp_c, a, b):',
      '    return a + b * (1.0 / (temp_c + kelvin_offset) - 1.0 / ref_temperature)',
      'def jac_fn(temp_c, a, b):',
      '    with open("outputs/jacobian-scale.txt", "r") as fh:',
      '        scale = float(fh.read().strip())',
      '    n = len(temp_c)',
      '    dinv = 1.0 / (temp_c + kelvin_offset) - 1.0 / ref_temperature',
      '    with open("outputs/jacobian-calls.txt", "a") as fo:',
      '        fo.write("jac_fn called n=%d\\n" % n)',
      '    return np.column_stack([np.ones(n), dinv]) * scale',
      `popt, pcov = curve_fit(${arguments_})`
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      // Callback bodies are not expanded into exact paths without runtime evidence.
      reads: [],
      writes: [],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })
})

describe('SciPy Welch hidden callback I/O', () => {
  it.each(['x, detrend=detrend_calibrated', 'x, 12, "boxcar", 256, 128, 256, detrend_calibrated'])(
    'keeps scale reads and trace appends partial inside detrend: %s',
    async (arguments_) => {
      const source = [
        'import numpy as np',
        'from scipy.signal import welch',
        'x = np.array([1.0, 2.0, 1.0, 2.0])',
        'spectral_gain = 1.0',
        'calls_log_path = "outputs/detrend-calls.txt"',
        'def detrend_calibrated(segment):',
        '    with open("outputs/detrend-scale.txt", "r") as fh:',
        '        scale = float(fh.read().strip())',
        '    with open(calls_log_path, "a") as log_fh:',
        '        log_fh.write(str(spectral_gain))',
        '    return (segment - np.mean(segment, axis=-1, keepdims=True)) * spectral_gain * scale',
        `freq, psd = welch(${arguments_})`
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial',
        reads: [],
        writes: [],
        reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
      })
    }
  )
})

describe('SciPy solve_ivp hidden callback I/O', () => {
  // Minimal call-level reduction of the executed Indometh workflow. Its full
  // original cell was already partial due to other operations; the solver
  // reduction must not falsely certify the hidden callback accesses as complete.
  it.each([
    'fun=rhs, t_span=(0.0, 8.0), y0=initials, method="Radau", jac=jac, events=[half_first, half_last]',
    'rhs, (0.0, 8.0), initials, "Radau", None, False, [half_first, half_last], jac=jac'
  ])('keeps opaque RHS, Jacobian and event I/O partial: %s', async (arguments_) => {
    const source = String.raw`
import os
import numpy as np
from scipy.integrate import solve_ivp
rates = np.array([0.2, 0.25, 0.3, 0.35, 0.4, 0.45])
initials = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
rate_factor = 1.0
half_initial_first = float(initials[0])
half_initial_last = float(initials[5])
rhs_log_path = os.path.join('outputs', 'rhs-calls.txt')
jac_log_path = os.path.join('outputs', 'jac-calls.txt')
event_log_path = os.path.join('outputs', 'event-calls.txt')
def rhs(t, y):
    with open(os.path.join('outputs', 'rate-scale.txt'), 'r') as fh:
        scale = float(fh.read().strip())
    with open(rhs_log_path, 'a') as fh:
        fh.write('1\n')
    return -rate_factor * scale * rates * y
def jac(t, y):
    with open(os.path.join('outputs', 'rate-scale.txt'), 'r') as fh:
        scale = float(fh.read().strip())
    with open(jac_log_path, 'a') as fh:
        fh.write('1\n')
    return np.diag(-rate_factor * scale * rates)
def half_first(t, y):
    with open(os.path.join('outputs', 'event-fraction.txt'), 'r') as fh:
        fraction = float(fh.read().strip())
    with open(event_log_path, 'a') as fh:
        fh.write('half_first\n')
    return y[0] - half_initial_first * fraction
def half_last(t, y):
    with open(os.path.join('outputs', 'event-fraction.txt'), 'r') as fh:
        fraction = float(fh.read().strip())
    with open(event_log_path, 'a') as fh:
        fh.write('half_last\n')
    return y[5] - half_initial_last * fraction
solution = solve_ivp(${arguments_})
`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: [],
      writes: [],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })
})

describe('SciPy generic_filter hidden callback I/O', () => {
  // Reduced from an executed lynx time-series filter. The callback accesses
  // files while filtering; source analysis must not replay its body as exact I/O.
  it.each([
    'values, neighborhood_response, size=5, output=filter_buffer',
    'values, function=neighborhood_response, size=5, output=filter_buffer',
    'values, neighborhood_response, 5, None, filter_buffer',
    'values, size=5, **options'
  ])('keeps callback and expanded-option access partial: %s', async (arguments_) => {
    const source = [
      'import numpy as np',
      'from scipy.ndimage import generic_filter',
      'filter_gain = 1.0',
      'SCALE_PATH = "outputs/filter-scale.txt"',
      'TRACE_PATH = "outputs/filter-calls.txt"',
      'values = np.array([1., 2., 3.])',
      'parent = np.full((3, 2), -999.)',
      'filter_buffer = parent[:, 0]',
      'def neighborhood_response(values):',
      '    with open(SCALE_PATH, "r") as f:',
      '        scale = float(f.read().strip())',
      '    with open(TRACE_PATH, "a") as f:',
      '        f.write("call\\n")',
      '    return float(np.median(values) * filter_gain * scale)',
      'options = {"output": filter_buffer, "function": neighborhood_response}',
      `ret = generic_filter(${arguments_})`
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: [],
      writes: [],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })
})

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
    name: 'Python SciPy sparse output appends NPZ suffix',
    language: 'python',
    source:
      "from scipy.sparse import csr_matrix, save_npz\nmatrix = csr_matrix([[1]])\nsave_npz('outputs/counts', matrix)",
    reads: [],
    writes: ['outputs/counts.npz']
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
    "anndata.io.write_zarr('outputs/cells.zarr', adata)"
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
    "import pyarrow.dataset as ds\ndataset = ds.dataset('inputs/events', filesystem=filesystem)",
    "import pyarrow.dataset as ds\ndataset = ds.dataset('inputs/events', filesystem=remote_fs)"
  ])('does not attribute Arrow Dataset sources to custom filesystems: %s', async (source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      readState: 'partial',
      reads: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
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

describe('Python scientific checkpoint record paths', () => {
  const records =
    'TARGETS = [("outputs/target-0.25.txt", "0.25"), ("outputs/target-0.50.txt", "0.50")]'

  it('records both target outputs selected from literal checkpoint rows', async () => {
    // Reduced from the executed airquality threshold-reference producer.
    const source = [
      'TARGETS = [("outputs/target-0.25.txt", "0.25"), ("outputs/target-0.50.txt", "0.50")]',
      'with open(TARGETS[0][0], "w") as handle:',
      '    handle.write(TARGETS[0][1] + "\\n")',
      'with open(TARGETS[1][0], "w") as handle:',
      '    handle.write(TARGETS[1][1] + "\\n")'
    ].join('\n')

    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['outputs/target-0.25.txt', 'outputs/target-0.50.txt'],
      reasonCodes: []
    })
  })

  it.each([
    ['TARGETS[-1][-2]', 'outputs/target-0.50.txt'],
    ['TARGETS[+0][+0]', 'outputs/target-0.25.txt'],
    ['[("outputs/inline.txt", "value")][0][0]', 'outputs/inline.txt']
  ])('resolves bounded scalar record access: %s', async (expression, path) => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        `${records}\nwith open(${expression}, "w") as handle:\n    pass`
      )
    ).resolves.toMatchObject({
      writeState: 'complete',
      writes: [path],
      reasonCodes: []
    })
  })

  it.each(['True', '0.0', 'index', '2', '-3', '9007199254740992'])(
    'does not resolve an unsupported row or column index: %s',
    async (index) => {
      await expect(
        analyzeNotebookSourceFileAccess(
          'python',
          [
            records,
            `with open(TARGETS[${index}][0], "w") as handle:`,
            '    pass',
            `with open(TARGETS[0][${index}], "w") as handle:`,
            '    pass'
          ].join('\n')
        )
      ).resolves.toMatchObject({
        writeState: 'partial',
        writes: [],
        reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
      })
    }
  )

  it.each([
    'TARGETS[:1][0][0]',
    'TARGETS[0][:1]',
    '[][0][0]',
    '[()][0][0]',
    '[(build_path(), "value")][0][0]'
  ])('keeps unresolved record shapes conservative: %s', async (expression) => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        `${records}\nwith open(${expression}, "w") as handle:\n    pass`
      )
    ).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    'TARGETS = custom',
    'if flag:\n    TARGETS = custom',
    'alias = TARGETS\nalias[0] = ("outputs/new.txt", "new")',
    'TARGETS[0][0] = "outputs/new.txt"'
  ])('drops record paths after an unresolved rebind or mutation: %s', async (update) => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        [
          'TARGETS = [["outputs/old.txt", "old"]]',
          update,
          'with open(TARGETS[0][0], "w") as handle:',
          '    pass'
        ].join('\n')
      )
    ).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('does not turn an extracted record into a new path collection', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        `${records}\nrow = TARGETS[0]\nwith open(row[0], "w") as handle:\n    pass`
      )
    ).resolves.toMatchObject({
      writeState: 'partial',
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('retains known target outputs without certifying opaque scientific operations', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        `${records}\nunknown_effect()\nwith open(TARGETS[0][0], "w") as handle:\n    pass`
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      writes: ['outputs/target-0.25.txt'],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it('does not attribute the builtin writer effect to a custom open callable', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        `${records}\ndef open(path, mode):\n    return None\nwith open(TARGETS[0][0], "w") as handle:\n    pass`
      )
    ).resolves.toMatchObject({ writes: [] })
  })

  it.each([
    ['import builtins as io', 'io.open'],
    ['from builtins import open as open_file', 'open_file']
  ])('retains an imported builtin opener: %s', async (importSource, opener) => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        `${records}\n${importSource}\nwith ${opener}(TARGETS[0][0], "w") as handle:\n    pass`
      )
    ).resolves.toMatchObject({ writes: ['outputs/target-0.25.txt'] })
  })

  it('uses the independent writer summary of a local helper named open', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        [
          records,
          'import numpy as np',
          'def open(path, mode):',
          '    np.savetxt(path, values)',
          'open(TARGETS[0][0], "r")'
        ].join('\n')
      )
    ).resolves.toMatchObject({ reads: [], writes: ['outputs/target-0.25.txt'] })
  })

  it.each([
    'def TARGETS():\n    pass',
    'async def TARGETS():\n    pass',
    'class TARGETS:\n    pass'
  ])(
    'drops stale checkpoint paths when a definition replaces the records: %s',
    async (definition) => {
      const source = [
        'TARGETS = [("outputs/old.txt", "old")]',
        definition,
        'with open(TARGETS[0][0], "w") as handle:',
        '    pass'
      ].join('\n')

      await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
        writeState: 'partial',
        writes: [],
        reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
      })
    }
  )

  it.each([
    [
      'ordinary',
      'def emit(path):\n    payload = "value"\n    with open(path, "w") as handle:\n        handle.write(payload)\nemit("outputs/result.txt")'
    ],
    [
      'nested',
      'def outer(path):\n    def emit(target):\n        with open(target, "w") as handle:\n            handle.write("value")\n    emit(path)\nouter("outputs/result.txt")'
    ],
    [
      'awaited async',
      'async def emit(path):\n    payload = "value"\n    with open(path, "w") as handle:\n        handle.write(payload)\nawait emit("outputs/result.txt")'
    ]
  ])('retains the current %s writer helper paths', async (_name, source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: [],
      writes: ['outputs/result.txt']
    })
  })

  it.each([
    'emit = replacement\ndef emit(path):\n    payload = "value"\n    with open(path, "w") as handle:\n        handle.write(payload)\nemit("outputs/result.txt")',
    'def emit(path):\n    payload = "value"\n    with open(path, "w") as handle:\n        handle.write(payload)\nemit = replacement\nemit("outputs/result.txt")'
  ])('keeps an already shadowed writer helper conservative: %s', async (source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      writes: []
    })
  })
})
