import { describe, expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

describe('biomedical local file workflows', () => {
  it('captures explicit BAM/CRAM data, index and reference resources', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `import pysam
alignment = pysam.AlignmentFile("inputs/reads.cram", "rc",
    index_filename="inputs/custom.crai", reference_filename="inputs/reference.fa")`
      )
    ).toMatchObject({
      reads: ['inputs/custom.crai', 'inputs/reads.cram', 'inputs/reference.fa'],
      writes: [],
      externalState: 'partial'
    })
  })

  it('records a CRAM output separately from its explicit reference input', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `from pysam import AlignmentFile as AF
output = AF("result.cram", "wc", reference_filename="inputs/reference.fa", header=header)`
      )
    ).toMatchObject({
      reads: ['inputs/reference.fa'],
      writes: ['result.cram'],
      externalState: 'partial'
    })
  })

  it.each([
    [
      'pysam.AlignmentFile(filename="inputs/reads.bam", filepath_index="inputs/custom.csi")',
      ['inputs/custom.csi', 'inputs/reads.bam']
    ],
    ['pysam.AlignmentFile("inputs/reads.bam", mode=None)', ['inputs/reads.bam']],
    [
      'pysam.AlignmentFile("inputs/reads.bam", "rb", index_filename="inputs/chosen.bai", filepath_index="unused.bai")',
      ['inputs/chosen.bai', 'inputs/reads.bam']
    ],
    [
      'pysam.AlignmentFile("inputs/reads.bam", "rb", index_filename=None, filepath_index="inputs/chosen.bai")',
      ['inputs/chosen.bai', 'inputs/reads.bam']
    ]
  ])('preserves only explicitly selected HTS inputs: %s', async (source, reads) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', `import pysam\n${source}`)
    ).toMatchObject({ reads, writes: [], externalState: 'partial' })
  })

  it('ignores read-index options in BAM write mode', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `import pysam
mode = "wb"
pysam.AlignmentFile("output.bam", mode, header=header,
    index_filename="unused.bai", reference_filename="unused.fa")`
      )
    ).toMatchObject({ reads: [], writes: ['output.bam'], externalState: 'partial' })
  })

  it('resolves a static empty primary index to its explicit fallback', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `import pysam
index = ""
pysam.AlignmentFile("inputs/reads.bam", "rb", index_filename=index,
    filepath_index="inputs/fallback.bai")`
      )
    ).toMatchObject({
      reads: ['inputs/fallback.bai', 'inputs/reads.bam'],
      externalState: 'partial'
    })
  })

  it.each([
    '"-"',
    '"/dev/stdin"',
    '"/dev/fd/3"',
    '"https://example.org/reads.bam"',
    '"reads.bam##idx##index.bai"'
  ])('does not invent a local HTS path for streams or encoded resources: %s', async (path) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `import pysam\npysam.AlignmentFile(${path}, "rb")`
      )
    ).toMatchObject({ reads: [], writes: [], readState: 'partial', externalState: 'partial' })
  })

  it('does not guess the direction of a dynamic HTS file mode', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import pysam\npysam.AlignmentFile("reads.bam", select_mode())'
      )
    ).toMatchObject({ reads: [], writes: [], readState: 'partial', writeState: 'partial' })
  })

  it('retains the known HTS primary file when its index is dynamic', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import pysam\npysam.AlignmentFile("inputs/reads.bam", "rb", index_filename=find_index())'
      )
    ).toMatchObject({ reads: ['inputs/reads.bam'], writes: [], externalState: 'partial' })
  })

  it.each([
    'import unrelated as pysam\npysam.AlignmentFile("unused.bam", "rb")',
    'import pysam\npysam = replacement\npysam.AlignmentFile("unused.bam", "rb")',
    'import pysam\npysam.AlignmentFile = replacement\npysam.AlignmentFile("unused.bam", "rb")'
  ])('does not borrow HTS paths after rebinding: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      writes: []
    })
  })

  it('captures an image and segmentation mask through SimpleITK before writing an array', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import SimpleITK as sitk
import numpy as np
image = sitk.ReadImage(fileName="inputs/ct.nii.gz")
mask = sitk.ReadImage("inputs/mask.nii.gz")
values = sitk.GetArrayFromImage(image)
labels = sitk.GetArrayFromImage(mask)
np.save("roi.npy", values[labels > 0])
sitk.WriteImage(image, "copy.nii.gz")`
    )
    expect(result).toMatchObject({
      reads: ['inputs/ct.nii.gz', 'inputs/mask.nii.gz'],
      writes: ['copy.nii.gz', 'roi.npy'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it('captures every explicitly listed DICOM slice', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `from SimpleITK import ReadImage
image = ReadImage(["inputs/001.dcm", "inputs/002.dcm"])`
      )
    ).toMatchObject({
      reads: ['inputs/001.dcm', 'inputs/002.dcm'],
      readState: 'complete'
    })
  })

  it('captures both local MR summary-statistic tables', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `exposure <- TwoSampleMR::read_exposure_data("inputs/exposure.tsv", sep="\\t", clump=FALSE)
outcome <- TwoSampleMR::read_outcome_data(filename="inputs/outcome.tsv", snps=exposure$SNP, sep="\\t")
saveRDS(list(exposure, outcome), "mr-inputs.rds")`
      )
    ).toMatchObject({
      reads: ['inputs/exposure.tsv', 'inputs/outcome.tsv'],
      writes: ['mr-inputs.rds'],
      // Missing ID columns may trigger internal RNG even with clumping disabled.
      readState: 'partial',
      writeState: 'complete',
      externalState: 'partial'
    })
  })
})

it('captures a local GEO series matrix with annotation downloads disabled', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'geo <- GEOquery::getGEO(getGPL=FALSE, filename="inputs/series_matrix.txt.gz", AnnotGPL=FALSE)'
    )
  ).toMatchObject({
    reads: ['inputs/series_matrix.txt.gz'],
    readState: 'complete',
    externalState: 'complete'
  })
})

it.each(['', ', getGPL=TRUE', ', getGPL=fetch_annotation', ', getGPL=FALSE, AnnotGPL=TRUE'])(
  'retains the GEO file without claiming annotation dependencies are captured: %s',
  async (options) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        `geo <- GEOquery::getGEO(filename="inputs/series_matrix.txt.gz"${options})`
      )
    ).toMatchObject({
      reads: ['inputs/series_matrix.txt.gz'],
      externalState: 'partial'
    })
  }
)

it('captures pathology entry files and radiomics image, mask and configuration', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      `from openslide import OpenSlide
slide = OpenSlide("inputs/slide.mrxs")`
    )
  ).toMatchObject({ reads: ['inputs/slide.mrxs'], externalState: 'partial' })
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      `from radiomics import featureextractor
extractor = featureextractor.RadiomicsFeatureExtractor("inputs/settings.yaml")
result = extractor.execute(maskFilepath="inputs/mask.nii.gz", imageFilepath="inputs/ct.nii.gz")`
    )
  ).toMatchObject({
    reads: ['inputs/ct.nii.gz', 'inputs/mask.nii.gz', 'inputs/settings.yaml'],
    externalState: 'partial'
  })
})

it('captures explicit SimpleITK output slices as writes, not inputs', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      `import SimpleITK as sitk
image = sitk.ReadImage("inputs/ct.nii.gz")
sitk.WriteImage(image, ["slice-001.png", "slice-002.png"])`
    )
  ).toMatchObject({
    reads: ['inputs/ct.nii.gz'],
    writes: ['slice-001.png', 'slice-002.png'],
    externalState: 'complete'
  })
})

it.each([
  'image = sitk.ReadImage("inputs/ct.mhd")',
  'image = sitk.ReadImage("inputs/ct.nii.gz", imageIO="MetaImageIO")',
  'image = sitk.ReadImage("inputs/ct.nii.gz", **reader_options)',
  'image = sitk.ReadImage("inputs/ct.nii.gz", FileName="other.nii.gz")',
  'image = sitk.ReadImage(["inputs/ct.nii.gz", extra_slice])',
  'image = sitk.ReadImage("inputs/ct.nii.gz")\nsitk.WriteImage(image, "output.mhd")'
])('does not hide image sidecars or dynamic reader overrides: %s', async (script) => {
  expect(
    await analyzeNotebookSourceFileAccess('python', `import SimpleITK as sitk\n${script}`)
  ).toMatchObject({ externalState: 'partial' })
})

it.each([
  ['r', 'x <- TCGAbiolinks::GDCquery(project="TCGA-BRCA")'],
  ['r', 'TCGAbiolinks::GDCdownload(query, directory="GDCdata")'],
  [
    'r',
    'x <- TCGAbiolinks::GDCprepare(query, directory="GDCdata", save=TRUE, remove.files.prepared=TRUE)'
  ],
  ['r', 'x <- TwoSampleMR::extract_outcome_data(snps=snps, outcomes="ieu-a-7")'],
  ['r', 'x <- TwoSampleMR::read_exposure_data("inputs/exposure.tsv", clump=TRUE)'],
  ['r', 'x <- GEOquery::getGEO("GSE1234")'],
  ['r', 'x <- RNifti::readNifti("inputs/ct.nii.gz", json="read")'],
  ['python', 'import wfdb\nx = wfdb.rdrecord("inputs/record")'],
  ['python', 'import wfdb\nx = wfdb.rdrecord("record", pn_dir="mimic/release")'],
  ['python', 'import pandas as pd\nx = pd.read_sql_query("select * from admissions", connection)']
] as const)('retains external-resource uncertainty for %s: %s', async (language, script) => {
  expect(await analyzeNotebookSourceFileAccess(language, script)).toMatchObject({
    externalState: 'partial'
  })
})

it.each([
  [
    'python',
    'import pandas as pd\na = pd.read_csv("inputs/admissions.csv.gz")\na.to_csv("summary.csv", index=False)'
  ],
  ['r', 'a <- read.csv(gzfile("inputs/admissions.csv.gz"))\nwrite.csv(a, "summary.csv")']
] as const)('keeps local MIMIC-style exports reproducible in %s', async (language, script) => {
  expect(await analyzeNotebookSourceFileAccess(language, script)).toMatchObject({
    reads: ['inputs/admissions.csv.gz'],
    writes: ['summary.csv'],
    externalState: 'complete'
  })
})

it.each([
  'GEOquery::getGEO(GEO=NULL, getGPL=FALSE, "inputs/series_matrix.txt.gz")',
  'GEOquery::getGEO(NULL, "inputs/series_matrix.txt.gz", getGPL=FALSE)',
  'GEOquery::getGEO(NULL, "inputs/series_matrix.txt.gz", "cache", NULL, TRUE, FALSE, FALSE)'
])('matches GEO named arguments before positional arguments: %s', async (call) => {
  expect(await analyzeNotebookSourceFileAccess('r', `geo <- ${call}`)).toMatchObject({
    reads: ['inputs/series_matrix.txt.gz'],
    externalState: 'complete'
  })
})

it('resolves a GEO reader attached through library', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'library(GEOquery)\ngeo <- getGEO(filename="inputs/matrix.txt.gz", getGPL=FALSE)'
    )
  ).toMatchObject({ reads: ['inputs/matrix.txt.gz'], externalState: 'complete' })
})

it('does not grant a local replacement the GEO library contract', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'getGEO <- function(filename, getGPL) 1\ngeo <- getGEO(filename="unused.txt", getGPL=FALSE)'
    )
  ).toMatchObject({ reads: [], externalState: 'complete' })
})

it('does not discard annotation mode when summarizing a GEO wrapper', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'load_geo <- function(path) GEOquery::getGEO(filename=path)\ngeo <- load_geo("inputs/matrix.txt.gz")'
    )
  ).toMatchObject({ externalState: 'partial' })
})

it('preserves file-owning object aliases and forgets a replaced object', async () => {
  const prefix =
    'from radiomics import featureextractor\nx = featureextractor.RadiomicsFeatureExtractor()\nalias = x\n'
  expect(
    await analyzeNotebookSourceFileAccess('python', prefix + 'alias.loadParams("settings.yaml")')
  ).toMatchObject({ reads: ['settings.yaml'] })
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      prefix + 'alias = object()\nalias.loadParams("unused.yaml")'
    )
  ).toMatchObject({ reads: [] })
})
