import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { describe, expect, it } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

type ScientificFormatCase = {
  name: string
  language: NotebookLanguage
  source: string
  reads: string[]
  writes: string[]
  writeScopes?: Array<{ kind: 'shapefile'; path: string }>
}

const cases: ScientificFormatCase[] = [
  {
    name: 'Python SciPy MAT',
    language: 'python',
    source:
      "from scipy.io import loadmat, savemat\nvalue = loadmat('source.mat')\nsavemat('result.mat', value)",
    reads: ['source.mat'],
    writes: ['result.mat']
  },
  {
    name: 'Python Matrix Market',
    language: 'python',
    source:
      "from scipy.io import mmread, mmwrite\nmatrix = mmread('source.mtx')\nmmwrite('result.mtx', matrix)",
    reads: ['source.mtx'],
    writes: ['result.mtx']
  },
  {
    name: 'Python WAV',
    language: 'python',
    source:
      "from scipy.io import wavfile\nrate, samples = wavfile.read('source.wav')\nwavfile.write('result.wav', rate, samples)",
    reads: ['source.wav'],
    writes: ['result.wav']
  },
  {
    name: 'Python SoundFile',
    language: 'python',
    source:
      "import soundfile as sf\nsamples, rate = sf.read('source.flac')\nsf.write('result.flac', samples, rate)",
    reads: ['source.flac'],
    writes: ['result.flac']
  },
  {
    name: 'Python GeoPackage',
    language: 'python',
    source:
      "import geopandas as gpd\nframe = gpd.read_file('source.gpkg')\nframe.to_file('result.gpkg')",
    reads: ['source.gpkg'],
    writes: ['result.gpkg']
  },
  {
    name: 'Python Shapefile',
    language: 'python',
    source:
      "import geopandas as gpd\nframe = gpd.read_file('source.geojson')\nframe.to_file('result.shp')",
    reads: ['source.geojson'],
    writes: ['result.shp'],
    writeScopes: [{ kind: 'shapefile', path: 'result.shp' }]
  },
  {
    name: 'Python Astropy table',
    language: 'python',
    source:
      "from astropy.table import Table\ntable = Table.read('source.ecsv')\ntable.write('result.ecsv')",
    reads: ['source.ecsv'],
    writes: ['result.ecsv']
  },
  {
    name: 'Python Astropy FITS',
    language: 'python',
    source:
      "from astropy.io import fits\nhdul = fits.open('source.fits')\nhdul.writeto('result.fits', overwrite=True)",
    reads: ['source.fits'],
    writes: ['result.fits']
  },
  {
    name: 'Python Nibabel image',
    language: 'python',
    source:
      "import nibabel as nib\nimage = nib.load('source.nii.gz')\nimage.to_filename('result.nii.gz')",
    reads: ['source.nii.gz'],
    writes: ['result.nii.gz']
  },
  {
    name: 'Python BioPython FASTA',
    language: 'python',
    source:
      "from Bio import SeqIO\nrecords = list(SeqIO.parse('source.fasta', 'fasta'))\nSeqIO.write(records, 'result.fasta', 'fasta')",
    reads: ['source.fasta'],
    writes: ['result.fasta']
  },
  {
    name: 'Python Scanpy H5AD',
    language: 'python',
    source:
      "import scanpy as sc\ndata = sc.read_h5ad('source.h5ad')\ndata.write_h5ad('result.h5ad')",
    reads: ['source.h5ad'],
    writes: ['result.h5ad']
  },
  {
    name: 'Python DICOM',
    language: 'python',
    source:
      "import pydicom\ndata = pydicom.dcmread('source.dcm')\npydicom.dcmwrite('result.dcm', data)",
    reads: ['source.dcm'],
    writes: ['result.dcm']
  },
  {
    name: 'R readr text and RDS',
    language: 'r',
    source: "lines <- readr::read_lines('source.txt')\nreadr::write_rds(lines, 'result.rds')",
    reads: ['source.txt'],
    writes: ['result.rds']
  },
  {
    name: 'R jsonlite JSON',
    language: 'r',
    source:
      "value <- jsonlite::read_json('source.json')\njsonlite::write_json(value, 'result.json')",
    reads: ['source.json'],
    writes: ['result.json']
  },
  {
    name: 'R xml2 XML',
    language: 'r',
    source: "value <- xml2::read_xml('source.xml')\nxml2::write_xml(value, 'result.xml')",
    reads: ['source.xml'],
    writes: ['result.xml']
  },
  {
    name: 'R MATLAB',
    language: 'r',
    source:
      "value <- R.matlab::readMat('source.mat')\nR.matlab::writeMat('result.mat', value = value)",
    reads: ['source.mat'],
    writes: ['result.mat']
  },
  {
    name: 'R NetCDF',
    language: 'r',
    source:
      "source <- ncdf4::nc_open('source.nc')\nncdf4::nc_close(source)\nresult <- ncdf4::nc_create('result.nc', list())\nncdf4::nc_close(result)",
    reads: ['source.nc'],
    writes: ['result.nc']
  },
  {
    name: 'R Biostrings FASTA',
    language: 'r',
    source:
      "sequences <- Biostrings::readDNAStringSet('source.fasta')\nBiostrings::writeXStringSet(sequences, 'result.fasta')",
    reads: ['source.fasta'],
    writes: ['result.fasta']
  },
  {
    name: 'R ODS',
    language: 'r',
    source: "table <- readODS::read_ods('source.ods')\nreadODS::write_ods(table, 'result.ods')",
    reads: ['source.ods'],
    writes: ['result.ods']
  },
  {
    name: 'R magick image',
    language: 'r',
    source: "image <- magick::image_read('source.png')\nmagick::image_write(image, 'result.png')",
    reads: ['source.png'],
    writes: ['result.png']
  }
]

describe('scientific format file access coverage', () => {
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

  it('keeps Nibabel Analyze pair output partial until sibling files are observed', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "import nibabel as nib\nimage = nib.load('source.img')\nimage.to_filename('result.img')"
      )
    ).resolves.toMatchObject({
      writes: ['result.img'],
      writeState: 'partial',
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })
})

describe('single-cell file contracts', () => {
  it.each([
    '"matrix.mtx.gz", "barcodes.tsv.gz", "features.tsv.gz"',
    'mtx="matrix.mtx.gz", features="features.tsv.gz", cells="barcodes.tsv.gz"',
    'features="features.tsv.gz", "matrix.mtx.gz", "barcodes.tsv.gz"',
    'mtx="matrix.mtx.gz", "barcodes.tsv.gz", "features.tsv.gz"'
  ])('captures every ReadMtx file: %s', async (args) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `counts <- Seurat::ReadMtx(${args})\nsaveRDS(counts, "counts.rds")`
      )
    ).toMatchObject({
      reads: ['barcodes.tsv.gz', 'features.tsv.gz', 'matrix.mtx.gz'],
      writes: ['counts.rds'],
      readState: 'complete',
      writeState: 'complete'
    })
  })

  it('retains resolved ReadMtx inputs when one required input is dynamic', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'x <- Seurat::ReadMtx("matrix.mtx", cells=choose_cells(), features="features.tsv")'
      )
    ).toMatchObject({
      reads: ['features.tsv', 'matrix.mtx'],
      readState: 'partial'
    })
  })

  it('does not reduce a multi-input wrapper to its first argument', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'read_counts <- function(path) Seurat::ReadMtx(path, "barcodes.tsv", "features.tsv")\nx <- read_counts("matrix.mtx")'
      )
    ).toMatchObject({ readState: 'partial' })
  })

  it.each(['scanpy', 'anndata', 'anndata.io'])(
    'keeps writable %s backing files as inputs with unresolved writes',
    async (module) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          `from ${module} import read_h5ad\nx = read_h5ad("cells.h5ad", backed="r+")`
        )
      ).toMatchObject({
        reads: ['cells.h5ad'],
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each(['None', 'False', '"r"'])('keeps explicit backed=%s readers read-only', async (mode) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `import anndata as ad\nx = ad.read_h5ad("cells.h5ad", backed=${mode})`
      )
    ).toMatchObject({
      reads: ['cells.h5ad'],
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it('does not certify a dynamic backing mode or a backed wrapper as a pure reader', async () => {
    for (const source of [
      'import anndata as ad\nx = ad.read_h5ad("cells.h5ad", backed=mode)',
      'import anndata as ad\ndef load(path):\n    return ad.read_h5ad(path, backed="r+")\nx = load("cells.h5ad")'
    ]) {
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        externalState: 'partial'
      })
    }
  })

  it.each([
    `from astropy.io import fits\nhdul = fits.open('cells.fits', mode='update')`,
    `from astropy.io import fits\nhdul = fits.open('cells.fits', use_fsspec=True)`,
    `from astropy.io import fits\nhdul = fits.open('https://example.invalid/cells.fits')`
  ])('keeps non-readonly or remote FITS opens partial: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not invent a local root for dynamic or remote 10x inputs', async () => {
    expect(
      await analyzeNotebookSourceFileAccess('r', 'DropletUtils::read10xCounts(input_dir)')
    ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'DropletUtils::read10xCounts("https://example.test/matrix")'
      )
    ).toMatchObject({
      reads: ['https://example.test/matrix'],
      readState: 'partial',
      externalState: 'partial'
    })
  })
})

it('retains a positional writable backing input across a subsequent read', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'import anndata as ad\nx = ad.read_h5ad("cells.h5ad", "r+")\ny = ad.read_h5ad("cells.h5ad")'
    )
  ).toMatchObject({
    reads: ['cells.h5ad'],
    writes: [],
    writeState: 'partial',
    externalState: 'partial'
  })
})

describe('explicit files behind R backends and caches', () => {
  it.each([
    'Spectra::MsBackendMzR(), files=c("inputs/A.mzML", "inputs/B.mzML")',
    'files=c("inputs/A.mzML", "inputs/B.mzML"), object=Spectra::MsBackendMzR()',
    'Spectra::MsBackendMzR(), c("inputs/A.mzML", "inputs/B.mzML")'
  ])('captures raw sources without certifying a lazy backend: %s', async (args) => {
    expect(
      await analyzeNotebookSourceFileAccess('r', `backend <- Spectra::backendInitialize(${args})`)
    ).toMatchObject({
      reads: ['inputs/A.mzML', 'inputs/B.mzML'],
      writes: [],
      externalState: 'partial'
    })
  })

  it.each([
    'cache, "annotation", fpath="inputs/annotation.rds"',
    'fpath="inputs/annotation.rds", rname="annotation", x=cache',
    'cache, "inputs/annotation.rds"',
    'rname="inputs/annotation.rds"',
    'cache, "annotation", "inputs/annotation.rds", action="move"'
  ])(
    'captures the existing cache source rather than an invented cache output: %s',
    async (args) => {
      expect(
        await analyzeNotebookSourceFileAccess('r', `resource <- BiocFileCache::bfcadd(${args})`)
      ).toMatchObject({
        reads: ['inputs/annotation.rds'],
        writes: [],
        externalState: 'partial'
      })
    }
  )

  it.each([
    'Spectra::backendInitialize(custom_backend, files="inputs/unknown.mzML")',
    'Spectra::backendInitialize(other::MsBackendMzR(), files="inputs/unknown.mzML")',
    'other::backendInitialize(Spectra::MsBackendMzR(), files="inputs/unknown.mzML")',
    'other::bfcadd(cache, "label", fpath="inputs/unknown.rds")',
    'BiocFileCache::bfcnew(cache, rname="inputs/not-an-input.rds")',
    'BiocFileCache::bfcrpath(cache, rnames="annotation")',
    'BiocFileCache::bfcadd(cache, rname="inputs/not-an-input.rds", fpath=source)',
    'BiocFileCache::bfcadd(cache, rname="inputs/not-an-input.rds", fpath=NULL)'
  ])('does not invent local inputs for an unproven backend or cache lookup: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      externalState: 'partial'
    })
  })

  it('retains the cache source as an input when a later call replaces it', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `BiocFileCache::bfcadd(cache, "annotation", fpath="inputs/annotation.rds")
saveRDS(replacement, "inputs/annotation.rds")`
      )
    ).toMatchObject({
      reads: ['inputs/annotation.rds'],
      writes: ['inputs/annotation.rds'],
      externalState: 'partial'
    })
  })
})

describe('DropletUtils single-cell matrix inputs', () => {
  it.each([
    ['DropletUtils::read10xCounts("inputs/sample-filtered")', ['inputs/sample-filtered']],
    [
      'library(DropletUtils)\ncounts <- read10xCounts(samples = c("inputs/a", "inputs/b"))',
      ['inputs/a', 'inputs/b']
    ]
  ])('retains 10x matrix roots while flagging discovered sidecars: %s', async (source, roots) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: expect.arrayContaining(roots),
      readState: 'partial',
      externalState: 'partial'
    })
  })
})

configureTestRuntimeMetadata()
