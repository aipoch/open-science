import { describe, expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzePythonNotebookSource } from './dependency-analysis-python'

// Reduced from genuine Airquality R1, source SHA 2e074c0aed5044c4a44c72f9b82c6afd1287571413034d02449a4c6b424bbbcb.
const validatedCsvHelper = [
  'read_validated_csv <- function(path, required_columns) {',
  '  local_data <- utils::read.csv(path, check.names = FALSE, na.strings = "NA")',
  '  stopifnot(all(required_columns %in% names(local_data)))',
  '  local_data',
  '}'
].join('\n')

// Reduced from genuine Loblolly R1's zero-argument reader; its opaque prologue stays excluded.
const fixedCsvHelper = [
  'reader <- function() {',
  '  d <- utils::read.csv("inputs/loblolly-raw.csv", stringsAsFactors=FALSE, check.names=FALSE)',
  '  stopifnot(nrow(d) == 84L)',
  '  d',
  '}'
].join('\n')

// Reduced from generated notebook readers; their remaining behavior stays uncertified.
const composedCsvHelper =
  'read_events <- function(input_dir) { events <- utils::read.csv(base::file.path(input_dir,"events.csv"),stringsAsFactors=FALSE,check.names=FALSE); stopifnot(nrow(events)>0L); events }'
const matrixMethodHelper =
  'from scipy.io import mmread\ndef reopen_matrix(path):\n    return mmread(path).tocsr()'
const aliasedMatrixMethodHelper =
  'from scipy.io import mmread as reader\ndef reopen_matrix(path):\n    return reader(path).tocsr()'

// Reduced from a generated R reader with a fresh local composed path.
const checksumHelper = [
  'import hashlib',
  'import pathlib',
  'def file_meta(p):',
  '    data = pathlib.Path(p).read_bytes()',
  '    return {"path": p, "sha256": hashlib.sha256(data).hexdigest(), "bytes": pathlib.Path(p).stat().st_size}',
  'paths = ["inputs/quakes.csv", "outputs/shallow.csv", "outputs/deep.csv", "outputs/evidence.csv", "outputs/weighted-mag.svg"]',
  'files = [file_meta(p) for p in paths]'
].join('\n')
const localPathCsvHelper =
  'read_events <- function(input_dir) { path <- base::file.path(input_dir,"events.csv.gz"); utils::read.csv(base::gzfile(path),stringsAsFactors=FALSE) }'

describe('known R inputs after a pure local path prefix', () => {
  it.each([
    ['compressed CSV', localPathCsvHelper],
    ['plain CSV', localPathCsvHelper.replace('base::gzfile(path)', 'path')],
    [
      'table and local equals assignment',
      localPathCsvHelper.replace('path <-', 'path =').replace('read.csv', 'read.table')
    ]
  ])('retains the first %s input without certifying the helper', async (_name, definition) => {
    const source = `${definition}\nread_events("inputs")\nread_events("later")`
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/events.csv.gz'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const parsed = await analyzeRNotebookSource(source)
    expect(parsed.facts.state).toBe('unknown')
    expect(parsed.facts.safeCallNames ?? []).not.toContain('read_events')
    expect(parsed.fileAccess?.context.localFileWrappers).toEqual([])
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'read_events("next-cell")',
          parsed.fileAccess?.context
        )
      ).reads
    ).toEqual([])
  })

  it.each([
    localPathCsvHelper.replace('path <-', 'input_dir <-'),
    localPathCsvHelper.replace('path <-', 'path <<-'),
    localPathCsvHelper.replace('base::file.path', 'file.path'),
    localPathCsvHelper.replace('"events.csv.gz"', 'filename'),
    localPathCsvHelper.replace('"events.csv.gz"', '""'),
    localPathCsvHelper.replace('; utils::read.csv', '; mutate(); utils::read.csv'),
    localPathCsvHelper.replace('; utils::read.csv', '; events <- utils::read.csv'),
    localPathCsvHelper.replace('base::gzfile(path)', 'base::gzfile(other_path)'),
    localPathCsvHelper.replace('base::gzfile(path)', 'base::gzfile(base::gzfile(path))'),
    localPathCsvHelper.replace('base::gzfile(path)', 'base::gzfile(path,open="w")'),
    localPathCsvHelper.replace(
      'base::gzfile(path)',
      'base::gzfile(description=path,description=path)'
    ),
    localPathCsvHelper.replace('function(input_dir)', 'function(input_dir="inputs")'),
    localPathCsvHelper.replace('path <-', 'alias <- path <-')
  ])('does not interpret an unsupported helper prologue: %s', async (definition) => {
    expect(
      (await analyzeNotebookSourceFileAccess('r', `${definition}\nread_events("inputs")`)).reads
    ).toEqual([])
  })

  it.each([
    'alias <- read_events\nread_events("inputs")',
    'read_events <- replacement\nread_events("inputs")',
    'patch_namespace()\nread_events("inputs")',
    'if (flag) read_events("inputs")',
    'read_events(stop("blocked"))\nread_events("inputs")'
  ])('rejects an untrusted invocation or consumed candidate: %s', async (invocation) => {
    expect(
      (await analyzeNotebookSourceFileAccess('r', `${localPathCsvHelper}\n${invocation}`)).reads
    ).toEqual([])
  })
})

describe('known inputs inside partial notebook helpers', () => {
  it.each([
    ['plain CSV', 'base::file.path(input_dir,"events.csv")'],
    ['compressed CSV', 'base::gzfile(base::file.path(input_dir,"events.csv"))'],
    [
      'named readonly connection',
      'base::gzfile(open="rt",description=base::file.path(input_dir,"events.csv"))'
    ]
  ])('retains the first composed R %s input', async (_name, file) => {
    const definition = composedCsvHelper.replace('base::file.path(input_dir,"events.csv")', file)
    const source = `${definition}\nread_events(input_dir="inputs")\nread_events("later")`
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/events.csv'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const parsed = await analyzeRNotebookSource(source)
    expect(parsed.facts.state).toBe('unknown')
    expect(parsed.facts.safeCallNames ?? []).not.toContain('read_events')
    expect(parsed.fileAccess?.context.localFileWrappers).toEqual([])
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'read_events("other")',
          parsed.fileAccess?.context
        )
      ).reads
    ).toEqual([])
  })

  it.each([
    'file.path(input_dir,"events.csv")',
    'base:::file.path(input_dir,"events.csv")',
    'base::file.path(input_dir,filename)',
    'base::file.path(input_dir,"")',
    'base::file.path(input_dir,"nested","events.csv")',
    'base::gzfile(input_dir)',
    'base::gzfile(base::file.path(input_dir,"events.csv"),open="w")',
    'base::gzfile(base::gzfile(base::file.path(input_dir,"events.csv")))',
    'base::gzfile(base::file.path(input_dir,"events.csv"),open=mode)',
    'base::gzfile(description=base::file.path(input_dir,"events.csv"),description="other.csv")'
  ])('does not infer an R input from an unsupported path expression: %s', async (file) => {
    const definition = composedCsvHelper.replace('base::file.path(input_dir,"events.csv")', file)
    expect(
      (await analyzeNotebookSourceFileAccess('r', `${definition}\nread_events("inputs")`)).reads
    ).toEqual([])
  })

  it.each([
    `${composedCsvHelper}\nread_events(input_di="inputs")`,
    `${composedCsvHelper}\nread_events("inputs",input_dir="other")`,
    `${composedCsvHelper}\npatch_reader()\nread_events("inputs")`,
    `${composedCsvHelper}\n\`::\` <- function(...) NULL\nread_events("inputs")`,
    `${composedCsvHelper}\nif(flag) read_events("inputs")`,
    `${composedCsvHelper.replace('events <- utils::read.csv', 'path <- input_dir; events <- utils::read.csv')}\nread_events("inputs")`
  ])('keeps unstable composed R helper calls unresolved: %s', async (source) => {
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })

  it.each(['reopen_matrix("outputs/weights.mtx")', 'reopen_matrix(path="outputs/weights.mtx")'])(
    'retains a Python reader input before its unknown method: %s',
    async (call) => {
      const source = `${matrixMethodHelper}\nweights = ${call}`
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: ['outputs/weights.mtx'],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const parsed = await analyzePythonNotebookSource(source)
      expect(parsed.facts.safeCallNames ?? []).not.toContain('reopen_matrix')
      expect(parsed.fileAccess?.localFileWrappersComplete).toBe(false)
    }
  )

  it.each([
    'mmread(path, patch(mmread))',
    'mmread(path, unused=patch(mmread))',
    'mmread(unused=patch(mmread), source=path)',
    'mmread(path, source="other.mtx")',
    'mmread(path, *extras)',
    'mmread(path, **options)',
    'mmread(source=path, **options)',
    'mmread(source=path, unused=None)',
    'mmread(file=path)',
    'mmread(patch(path))',
    'mmread(paths[0])'
  ])('does not promote an input before uncertain inner reader arguments: %s', async (reader) => {
    const source = `${matrixMethodHelper.replace('mmread(path)', reader)}\nreopen_matrix("outputs/weights.mtx")`
    const parsed = await analyzePythonNotebookSource(source)
    expect(parsed.fileAccess).toMatchObject({
      reads: [],
      unresolvedReads: true,
      unresolvedWrites: true,
      localFileWrappersComplete: false
    })
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('retains a sole explicit Matrix Market source keyword', async () => {
    const source = `${matrixMethodHelper.replace('mmread(path)', 'mmread(source=path)')}\nreopen_matrix("outputs/weights.mtx")`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['outputs/weights.mtx'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    `${aliasedMatrixMethodHelper}\nreopen_matrix("inputs/a.mtx")`,
    `${aliasedMatrixMethodHelper}\nreopen_matrix(path="inputs/a.mtx")`,
    `${aliasedMatrixMethodHelper.replace('reader(path)', 'reader(source=path)')}\nreopen_matrix("inputs/a.mtx")`,
    'def reopen_matrix(path):\n    return reader(path).tocsr()\nfrom scipy.io import mmread as reader\nreopen_matrix("inputs/a.mtx")'
  ])('retains a Python explicit reader alias only at its stable invocation: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['inputs/a.mtx'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const parsed = await analyzePythonNotebookSource(source)
    expect(parsed.facts.safeCallNames ?? []).not.toContain('reopen_matrix')
    expect(parsed.fileAccess?.localFileWrappersComplete).toBe(false)
    expect(parsed.fileAccess?.context.localFileWrappers).toEqual([])
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'python',
          'reopen_matrix("later.mtx")',
          parsed.fileAccess?.context
        )
      ).reads
    ).toEqual([])
  })

  it.each([
    ['reader rebound', `${aliasedMatrixMethodHelper}\nreader = replacement`],
    ['helper rebound', `${aliasedMatrixMethodHelper}\nreopen_matrix = replacement`],
    ['reader escaped', `${aliasedMatrixMethodHelper}\npatch(reader)`],
    ['helper escaped', `${aliasedMatrixMethodHelper}\npatch(reopen_matrix)`],
    ['reader alias escaped', `${aliasedMatrixMethodHelper}\nalias = reader\npatch(alias)`],
    ['helper alias escaped', `${aliasedMatrixMethodHelper}\nalias = reopen_matrix\npatch(alias)`],
    ['namespace escaped', `${aliasedMatrixMethodHelper}\npatch(globals())`],
    ['wildcard import', `${aliasedMatrixMethodHelper}\nfrom other import *`],
    ['conditional wildcard', `${aliasedMatrixMethodHelper}\nif flag:\n    from other import *`],
    ['conditional rebind', `${aliasedMatrixMethodHelper}\nif flag:\n    reader = replacement`],
    [
      'conditional import',
      'reader = replacement\nif flag:\n    from scipy.io import mmread as reader\ndef reopen_matrix(path):\n    return reader(path).tocsr()'
    ],
    ['other canonical reader', `${aliasedMatrixMethodHelper}\nfrom numpy import loadtxt as reader`],
    ['unknown late import', `${aliasedMatrixMethodHelper}\nfrom other import mmread as reader`],
    [
      'formal shadow',
      aliasedMatrixMethodHelper.replace('reopen_matrix(path)', 'reopen_matrix(path,reader=None)')
    ],
    [
      'inner extra argument',
      aliasedMatrixMethodHelper.replace('reader(path)', 'reader(path,unused=patch(reader))')
    ],
    ['inner wrong keyword', aliasedMatrixMethodHelper.replace('reader(path)', 'reader(file=path)')],
    [
      'inner expanded argument',
      aliasedMatrixMethodHelper.replace('reader(path)', 'reader(path,*extras)')
    ],
    [
      'inner expanded keyword',
      aliasedMatrixMethodHelper.replace('reader(path)', 'reader(path,**options)')
    ],
    [
      'inner duplicate source',
      aliasedMatrixMethodHelper.replace('reader(path)', 'reader(path,source="other.mtx")')
    ]
  ])('rejects an eligible Python reader alias after %s', async (_name, setup) => {
    const source = `${setup}\nreopen_matrix("inputs/a.mtx")`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      readState: 'partial'
    })
    const parsed = await analyzePythonNotebookSource(source)
    expect(parsed.facts.safeCallNames ?? []).not.toContain('reopen_matrix')
    expect(parsed.fileAccess?.localFileWrappersComplete).toBe(false)
  })

  it.each([
    `${aliasedMatrixMethodHelper}\nreopen_matrix("inputs/a.mtx",path="other.mtx")`,
    `${aliasedMatrixMethodHelper}\nreopen_matrix(*paths)`,
    `${aliasedMatrixMethodHelper}\nreopen_matrix(**arguments)`,
    `${aliasedMatrixMethodHelper}\nif flag:\n    reopen_matrix("inputs/a.mtx")`,
    'def reopen_matrix(path):\n    return reader(path).tocsr()\nreopen_matrix("inputs/a.mtx")\nfrom scipy.io import mmread as reader',
    'from other import mmread as reader\ndef reopen_matrix(path):\n    return reader(path).tocsr()\nreopen_matrix("inputs/a.mtx")\nfrom scipy.io import mmread as reader'
  ])('does not use a later or uncertain Python reader alias call: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      readState: 'partial'
    })
  })

  it.each([
    aliasedMatrixMethodHelper.replace('from scipy.io', 'from other'),
    aliasedMatrixMethodHelper.replace('from scipy.io', 'from .scipy.io'),
    aliasedMatrixMethodHelper.replace('.tocsr()', '.tocsr(copy=True)')
  ])('does not admit an unsupported Python reader alias shape: %s', async (setup) => {
    // These shapes never enter reader-chain replay; an empty read is not guard evidence.
    expect(
      (await analyzeNotebookSourceFileAccess('python', `${setup}\nreopen_matrix("inputs/a.mtx")`))
        .reads
    ).toEqual([])
  })

  it.each([
    `${matrixMethodHelper}\nmmread = replacement\nreopen_matrix("outputs/weights.mtx")`,
    `${matrixMethodHelper}\nreopen_matrix = replacement\nreopen_matrix("outputs/weights.mtx")`,
    `${matrixMethodHelper}\npatch(reopen_matrix)\nreopen_matrix("outputs/weights.mtx")`,
    `${matrixMethodHelper}\npatch(mmread)\nreopen_matrix("outputs/weights.mtx")`,
    `${matrixMethodHelper}\nalias = mmread\npatch(alias)\nreopen_matrix("outputs/weights.mtx")`,
    `${matrixMethodHelper}\npatch(globals())\nreopen_matrix("outputs/weights.mtx")`,
    `${matrixMethodHelper}\nalias = reopen_matrix\npatch(alias)\nreopen_matrix("outputs/weights.mtx")`,
    `${matrixMethodHelper.replace('reopen_matrix(path)', 'reopen_matrix(path, mmread)')}\nreopen_matrix("outputs/weights.mtx",replacement)`,
    `${matrixMethodHelper}\nreopen_matrix(*paths)`,
    `${matrixMethodHelper}\nreopen_matrix(**arguments)`,
    `${matrixMethodHelper}\nif flag:\n    reopen_matrix("outputs/weights.mtx")`,
    'from scipy.io import mmread\nif flag:\n    def reopen_matrix(path):\n        return mmread(path).tocsr()\nreopen_matrix("outputs/weights.mtx")',
    'mmread = replacement\nif flag:\n    from scipy.io import mmread\ndef reopen_matrix(path):\n    return mmread(path).tocsr()\nreopen_matrix("outputs/weights.mtx")',
    'io = replacement\nif flag:\n    import scipy.io as io\ndef reopen_matrix(path):\n    return io.mmread(path).tocsr()\nreopen_matrix("outputs/weights.mtx")',
    `${matrixMethodHelper}\nfrom other import *\nreopen_matrix("outputs/weights.mtx")`,
    'from scipy.io import mmread\nfrom other import *\ndef reopen_matrix(path):\n    return mmread(path).tocsr()\nreopen_matrix("outputs/weights.mtx")',
    `${matrixMethodHelper}\nif flag:\n    from other import *\nreopen_matrix("outputs/weights.mtx")`,
    `from other import *\n${matrixMethodHelper}\nreopen_matrix("outputs/weights.mtx")`,
    'from scipy.io import mmread\n@decorate\ndef reopen_matrix(path):\n    return mmread(path).tocsr()\nreopen_matrix("outputs/weights.mtx")'
  ])('does not borrow a Python reader identity after an uncertain change: %s', async (source) => {
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
  })
})

describe('Python function definition file access', () => {
  it.each([
    'def reader(value, calibration=open("calibration.txt").read()):\n    return value',
    'def reader(*, calibration=open("calibration.txt").read()):\n    return calibration',
    'from scipy.io import mmread\ndef reopen(path):\n    return mmread(path).tocsr()\ndef holder(matrix=reopen("outputs/weights.mtx")):\n    return matrix',
    'from scipy.io import mmread\ndef reopen(path):\n    return mmread(path).tocsr()\ndef holder(*, matrix=reopen("outputs/weights.mtx")):\n    return matrix'
  ])('captures eager inputs from a function definition header: %s', async (source) => {
    const access = await analyzeNotebookSourceFileAccess('python', source)
    expect(access.reads).toEqual(
      source.includes('weights.mtx') ? ['outputs/weights.mtx'] : ['calibration.txt']
    )
    expect(access.writes).toEqual([])
    expect(access.readState).toBe(source.includes('weights.mtx') ? 'partial' : 'complete')
    expect(access.writeState).toBe(source.includes('weights.mtx') ? 'partial' : 'complete')
    expect(access.externalState).toBe(source.includes('weights.mtx') ? 'partial' : 'complete')
  })

  it('does not capture a function body that is deferred until invocation', async () => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      'def reader(value):\n    return open("deferred-input.csv").read() + open("deferred-output.csv", "w").write(value)'
    )
    expect(access.reads).toEqual([])
    expect(access.writes).toEqual([])
  })

  it.each([
    '[open("comprehension.csv") for index in range(2)]',
    '(open("comprehension.csv") for index in range(2))'
  ])('keeps scoped function defaults conservatively partial: %s', async (value) => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      `def reader(value=${value}):\n    return value`
    )
    expect(access).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
})

describe('bounded Python checksum helpers', () => {
  it('retains all literal paths consumed by a stable helper in a list comprehension', async () => {
    expect(await analyzeNotebookSourceFileAccess('python', checksumHelper)).toMatchObject({
      reads: [
        'inputs/quakes.csv',
        'outputs/deep.csv',
        'outputs/evidence.csv',
        'outputs/shallow.csv',
        'outputs/weighted-mag.svg'
      ],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    checksumHelper.replace(
      'files = [file_meta(p) for p in paths]',
      'file_meta = replacement\nfiles = [file_meta(p) for p in paths]'
    ),
    checksumHelper.replace(
      'files = [file_meta(p) for p in paths]',
      'alias = file_meta\nfiles = [alias(p) for p in paths]'
    ),
    checksumHelper.replace(
      'files = [file_meta(p) for p in paths]',
      'paths.append(dynamic_path)\nfiles = [file_meta(p) for p in paths]'
    ),
    checksumHelper.replace(
      'files = [file_meta(p) for p in paths]',
      'files = [file_meta(p) for (p, extra) in paths]'
    )
  ])('does not replay an unstable checksum comprehension: %s', async (source) => {
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
  })

  it.each([
    checksumHelper.replace('paths = [', 'paths = build_paths(['),
    checksumHelper.replace('pathlib.Path(p).read_bytes()', 'Path(p).read_bytes()'),
    checksumHelper.replace('import hashlib', 'import hashlib as h'),
    checksumHelper.replace(
      'return {"path": p, "sha256": hashlib.sha256(data).hexdigest(), "bytes": pathlib.Path(p).stat().st_size}',
      'open("side-effect.txt", "w").write("x")\n    return {"path": p}'
    ),
    checksumHelper.replace(
      'files = [file_meta(p) for p in paths]',
      'files = (file_meta(p) for p in paths)'
    )
  ])('keeps an unstable checksum helper unresolved: %s', async (source) => {
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
  })
})

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

  it.each([
    [
      'genuine validated CSV helper',
      `${validatedCsvHelper}\nraw_df <- read_validated_csv("inputs/airquality-raw.csv", c("Ozone", "Solar.R", "Wind", "Temp", "Month", "Day"))`,
      'inputs/airquality-raw.csv'
    ],
    [
      'named arguments before positional arguments',
      `${validatedCsvHelper}\nraw_df <- read_validated_csv(required_columns=c("Ozone"), "inputs/a.csv")`,
      'inputs/a.csv'
    ],
    [
      'path in the second helper formal',
      'reader <- function(columns, path) { d <- utils::read.table(file=path, header=TRUE); stopifnot(all(columns %in% names(d))); d }\nreader(c("x"), "inputs/a.csv")',
      'inputs/a.csv'
    ],
    [
      'direct first read statement',
      'reader <- function(path) { utils::read.table(path, header=TRUE); NULL }\nreader("inputs/a.csv")',
      'inputs/a.csv'
    ],
    [
      'fixed reader option before its positional file',
      'reader <- function(path) { d <- utils::read.csv(check.names=FALSE, path); d }\nreader("inputs/a.csv")',
      'inputs/a.csv'
    ],
    ['zero-argument validated reader', `${fixedCsvHelper}\nreader()`, 'inputs/loblolly-raw.csv'],
    [
      'zero-argument direct read.table prefix',
      'reader <- function() { utils::read.table(file="inputs/a.csv", header=TRUE); NULL }\nreader()',
      'inputs/a.csv'
    ],
    [
      'zero-argument reader with an option before its file',
      'reader <- function() { d <- utils::read.csv(check.names=FALSE, "inputs/a.csv"); d }\nreader()',
      'inputs/a.csv'
    ]
  ])(
    'retains a first literal R helper read without certifying the body: %s',
    async (_name, source, input) => {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial',
        reads: [input],
        writes: []
      })
      const parsed = await analyzeRNotebookSource(source)
      expect(parsed.facts.state).toBe('unknown')
      expect(parsed.facts.safeCallNames ?? []).not.toContain('read_validated_csv')
      expect(parsed.facts.safeCallNames ?? []).not.toContain('reader')
      expect(parsed.fileAccess?.localFileWrappersComplete).toBe(false)
      expect(parsed.fileAccess?.context.localFileWrappers).toEqual([])
      expect(parsed.fileAccess?.context.staticStrings).toEqual([])
      expect(parsed.fileAccess?.context.staticCollections).toEqual([])
    }
  )

  it.each([
    ['missing argument slots', `${fixedCsvHelper}\nreader(,)`],
    ['conditional invocation', `${fixedCsvHelper}\nif (flag) reader()`],
    ['extra positional argument', `${fixedCsvHelper}\nreader("inputs/other.csv")`],
    ['extra named argument', `${fixedCsvHelper}\nreader(path="inputs/other.csv")`],
    [
      'nonzero formals with a fixed file',
      'reader <- function(x) { d <- utils::read.csv("inputs/a.csv"); d }\nreader(1)'
    ],
    [
      'default formal with a fixed file',
      'reader <- function(x=1) { d <- utils::read.csv("inputs/a.csv"); d }\nreader()'
    ],
    [
      'dots with a fixed file',
      'reader <- function(...) { d <- utils::read.csv("inputs/a.csv"); d }\nreader()'
    ],
    ['empty literal', 'reader <- function() { d <- utils::read.csv(""); d }\nreader()'],
    [
      'global filename',
      'path <- "inputs/a.csv"\nreader <- function() { d <- utils::read.csv(path); d }\nreader()'
    ],
    [
      'text bypass',
      'reader <- function() { d <- utils::read.csv("inputs/a.csv", text="x\\n1"); d }\nreader()'
    ],
    [
      'option side effect',
      'reader <- function() { d <- utils::read.csv("inputs/a.csv", check.names=mutate()); d }\nreader()'
    ],
    [
      'nonfirst read',
      'reader <- function() { mutate(); d <- utils::read.csv("inputs/a.csv"); d }\nreader()'
    ],
    [
      'conditional read',
      'reader <- function() { if (flag) d <- utils::read.csv("inputs/a.csv"); d }\nreader()'
    ],
    [
      'genuine opaque package prologue',
      `suppressPackageStartupMessages(library(utils))\n${fixedCsvHelper}\nreader()`
    ],
    ['opaque call before invocation', `${fixedCsvHelper}\nmutate()\nreader()`],
    ['helper alias exposure', `${fixedCsvHelper}\nalias <- reader\nreader()`],
    ['helper rebind', `${fixedCsvHelper}\nreader <- function() NULL\nreader()`],
    ['namespace operator rebind', `${fixedCsvHelper}\n\`::\` <- function(...) NULL\nreader()`]
  ])('keeps the fixed-file R prefix unresolved after %s', async (_name, source) => {
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })

  it('keeps a fixed-file prefix partial and scoped to its defining cell', async () => {
    expect(await analyzeNotebookSourceFileAccess('r', `${fixedCsvHelper}\nreader()`)).toMatchObject(
      {
        reads: ['inputs/loblolly-raw.csv'],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      }
    )
    const parsed = await analyzeRNotebookSource(`${fixedCsvHelper}\nreader()`)
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'reader()', parsed.fileAccess?.context)).reads
    ).toEqual([])
  })

  it.each([
    ['uninvoked declaration', validatedCsvHelper],
    [
      'call before declaration',
      `read_validated_csv("inputs/a.csv", c("Ozone"))\n${validatedCsvHelper}`
    ],
    [
      'rebound helper',
      `${validatedCsvHelper}\nread_validated_csv <- function(path, required_columns) NULL\nread_validated_csv("inputs/a.csv", c("Ozone"))`
    ],
    [
      'helper body replacement',
      `${validatedCsvHelper}\nbody(read_validated_csv) <- quote(NULL)\nread_validated_csv("inputs/a.csv", c("Ozone"))`
    ],
    [
      'unknown zero-argument namespace mutation',
      `${validatedCsvHelper}\nreplace_reader()\nread_validated_csv("inputs/a.csv", c("Ozone"))`
    ],
    [
      'new declaration after namespace uncertainty',
      `unknown_namespace_mutator()\n${validatedCsvHelper}\nread_validated_csv("inputs/a.csv", c("Ozone"))`
    ],
    [
      'helper exposed through an alias',
      `${validatedCsvHelper}\nalias <- read_validated_csv\nread_validated_csv("inputs/a.csv", c("Ozone"))`
    ],
    [
      'conditional definition',
      'if (flag) { reader <- function(path) { d <- utils::read.csv(path); d } }\nreader("inputs/a.csv")'
    ],
    [
      'unqualified reader',
      'reader <- function(path) { d <- read.csv(path); d }\nreader("inputs/a.csv")'
    ],
    [
      'opaque prologue before the read',
      'reader <- function(path) { mutate_path(); d <- utils::read.csv(path); d }\nreader("inputs/a.csv")'
    ],
    [
      'path rebind before the read',
      'reader <- function(path) { path <- "inputs/b.csv"; d <- utils::read.csv(path); d }\nreader("inputs/a.csv")'
    ],
    [
      'deferred nested reader',
      'reader <- function(path) { deferred <- function() utils::read.csv(path); deferred }\nreader("inputs/a.csv")'
    ],
    [
      'duplicate path arguments',
      `${validatedCsvHelper}\nread_validated_csv(path="inputs/a.csv", path="inputs/b.csv", required_columns=c("Ozone"))`
    ],
    [
      'partial argument names',
      `${validatedCsvHelper}\nread_validated_csv(pat="inputs/a.csv", required_columns=c("Ozone"))`
    ],
    [
      'nonliteral file argument',
      `${validatedCsvHelper}\npath <- "inputs/a.csv"\nread_validated_csv(path, c("Ozone"))`
    ],
    [
      'default file argument',
      'reader <- function(path="inputs/a.csv") { d <- utils::read.csv(path); d }\nreader()'
    ],
    [
      'dots forwarding',
      'reader <- function(path, ...) { d <- utils::read.csv(path, ...); d }\nreader("inputs/a.csv", text="x\\n1")'
    ],
    [
      'read.table text bypass',
      'reader <- function(path) { d <- utils::read.table(file=path, text="1 2"); d }\nreader("inputs/a.csv")'
    ],
    [
      'read.csv text bypass',
      'reader <- function(path) { d <- utils::read.csv(file=path, text="x\\n1"); d }\nreader("inputs/a.csv")'
    ],
    [
      'reader option side effect',
      'reader <- function(path) { d <- utils::read.csv(path, check.names={path <- "inputs/b.csv"; FALSE}); d }\nreader("inputs/a.csv")'
    ],
    [
      'lazy helper argument side effect',
      `${validatedCsvHelper}\nread_validated_csv("inputs/a.csv", {body(read_validated_csv) <<- quote(NULL); c("Ozone")})`
    ]
  ])('does not invent a known R helper read after %s', async (_name, source) => {
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })

  it.each(['<-', 'function', 'c', '::', '{', '=', '->'])(
    'does not capture a literal helper input when prior R context shadows %s',
    async (name) => {
      const source = `${validatedCsvHelper}\nread_validated_csv("inputs/a.csv", c("Ozone"))`
      expect(
        await analyzeNotebookSourceFileAccess('r', source, {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          resolvedKernelNames: [name]
        })
      ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
    }
  )

  it.each(['::', '{', '<-', '=', '->', 'function'])(
    'discards a candidate when primitive %s is rebound before invocation',
    async (name) => {
      const source = `${validatedCsvHelper}\n\`${name}\` <- function(...) NULL\nread_validated_csv("inputs/a.csv", c("Ozone"))`
      expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
    }
  )

  it('does not establish a candidate after a prior namespace-operator rebind', async () => {
    const source = `\`::\` <- function(pkg, name) function(...) NULL\n${validatedCsvHelper}\nread_validated_csv("inputs/a.csv", c("Ozone"))`
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })

  it('keeps a recorded input when the namespace operator is rebound later', async () => {
    const source = `${validatedCsvHelper}\nread_validated_csv("inputs/a.csv", c("Ozone"))\n\`::\` <- function(pkg, name) function(...) NULL`
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['inputs/a.csv'])
  })

  it('keeps rightward helper definitions outside the partial prefix contract', async () => {
    const source =
      '(function(path) { d <- utils::read.csv(path); d }) -> reader\nreader("inputs/a.csv")'
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })

  it('keeps the first R helper read but discards future candidates after its opaque tail', async () => {
    const source = [
      'reader <- function(path) { d <- utils::read.csv(path); replace_reader(); d }',
      'reader("inputs/first.csv")',
      'reader("inputs/second.csv")'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/first.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('preserves an already captured R helper input across a later opaque call', async () => {
    const source = `${validatedCsvHelper}\nread_validated_csv("inputs/a.csv", c("Ozone"))\nunknown_call()`
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual(['inputs/a.csv'])
  })
})

describe('qualified readLines helper first inputs', () => {
  const helper = [
    'reader <- function(path) {',
    '  lines <- base::readLines(con=path, warn=FALSE)',
    '  stopifnot(length(lines) > 0L)',
    '  lines',
    '}'
  ].join('\n')

  it('retains the first literal input without certifying the helper body', async () => {
    const source = `${helper}\nreader("inputs/observations.txt")`
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/observations.txt'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const parsed = await analyzeRNotebookSource(source)
    expect(parsed.facts.state).toBe('unknown')
    expect(parsed.facts.safeCallNames ?? []).not.toContain('reader')
    expect(parsed.fileAccess?.context.localFileWrappers).toEqual([])
    expect(parsed.fileAccess?.localFileWrappersComplete).toBe(false)
  })

  it.each([
    'reader <- function(path) { lines <- base::readLines(warn=FALSE, path); lines }\nreader(path="inputs/observations.txt")',
    'reader <- function(path) { lines <- readLines(con=path); lines }\nreader("inputs/observations.txt")',
    'reader <- function() { base::readLines(con="inputs/observations.txt", skipNul=TRUE); NULL }\nreader()',
    'reader <- function(expected, path) { lines <- base::readLines(con=path); stopifnot(length(lines)==expected); lines }\nreader(path="inputs/observations.txt", 3L)',
    `readLines <- function(...) NULL\n${helper}\nreader("inputs/observations.txt")`
  ])('retains exact literal argument matching for %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/observations.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each(['unknown', 'UTF-8', 'latin1', 'bytes'])(
    'accepts a fixed encoding literal %s without completing the helper',
    async (encoding) => {
      const source = helper.replace('warn=FALSE', `warn=TRUE, encoding="${encoding}"`)
      expect(
        await analyzeNotebookSourceFileAccess('r', `${source}\nreader("inputs/observations.txt")`)
      ).toMatchObject({ reads: ['inputs/observations.txt'], readState: 'partial' })
    }
  )

  it.each([
    `${helper}\nreader("")`,
    `${helper}\nreader("stdin")`,
    `${helper}\nreader("stdout")`,
    `${helper}\nreader("stderr")`,
    `${helper}\nreader("clipboard")`,
    `${helper}\nreader("clipboard-128")`,
    `${helper}\nreader("X11_primary")`,
    `${helper}\nreader("X11_secondary")`,
    `${helper}\nreader("X11_clipboard")`,
    `${helper}\nreader("|consumer")`,
    `${helper}\nreader(" |consumer")`,
    `${helper}\nreader("https://example.invalid/observations.txt")`,
    `${helper}\nreader("file:///inputs/observations.txt")`,
    `${helper}\nreader("/vsicurl/https://example.invalid/observations.txt")`,
    `${helper}\nreader("custom:observations")`,
    'reader <- function() { lines <- base::readLines(con=""); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con="stdin"); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con="stdout"); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con="stderr"); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con="clipboard"); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con="clipboard-128"); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con="X11_primary"); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con="X11_secondary"); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con="X11_clipboard"); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con="|consumer"); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con=" |consumer"); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con="https://example.invalid/observations.txt"); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con="file:///inputs/observations.txt"); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con="/vsicurl/https://example.invalid/observations.txt"); lines }\nreader()',
    'reader <- function() { lines <- base::readLines(con="custom:observations"); lines }\nreader()'
  ])('does not invent a local file for a non-file connection description', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'customReadLines(con=path)',
    'base:::readLines(con=path)',
    'other::readLines(con=path)',
    'base::readLines(con=path, con=path)',
    'base::readLines(con=path, path)',
    'base::readLines(co=path)',
    'base::readLines(con=path, wa=FALSE)',
    'base::readLines(con=path, n=0L)',
    'base::readLines(con=path, ok=TRUE)',
    'base::readLines(con=path, warn=0L)',
    'base::readLines(con=path, skipNul=NA)',
    'base::readLines(con=path, encoding="UTF-16")',
    'base::readLines(con=path, encoding=ENCODING)',
    'base::readLines(con=path, warn={path <- "other.txt"; FALSE})'
  ])('keeps unsupported reader contracts unresolved: %s', async (call) => {
    const source = `reader <- function(path) { lines <- ${call}; lines }\nreader("inputs/observations.txt")`
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })

  it.each([
    `${helper}\nreader(0L)`,
    `${helper}\nreader(stdin())`,
    `${helper}\nreader(pat="inputs/observations.txt")`,
    `${helper}\nreader(path="inputs/observations.txt", path="other.txt")`,
    `${helper}\npath <- "inputs/observations.txt"\nreader(path)`,
    `${helper}\nreader("inputs/observations.txt", 1L)`,
    `${helper.replace('function(path)', 'function(path="inputs/observations.txt")')}\nreader()`,
    `${helper.replace('function(path)', 'function(path, ...)')}\nreader("inputs/observations.txt")`,
    `reader("inputs/observations.txt")\n${helper}`,
    `${helper}\nreader <- function(path) NULL\nreader("inputs/observations.txt")`,
    `${helper}\nalias <- reader\nreader("inputs/observations.txt")`,
    `${helper}\nreplace_reader()\nreader("inputs/observations.txt")`,
    `${helper}\n\`::\` <- function(...) NULL\nreader("inputs/observations.txt")`,
    `if (flag) { ${helper} }\nreader("inputs/observations.txt")`,
    `${helper}\nif (flag) reader("inputs/observations.txt")`,
    'reader <- function(path) { mutate(); lines <- base::readLines(con=path); lines }\nreader("inputs/observations.txt")'
  ])('does not borrow a first input outside the stable literal invocation: %s', async (source) => {
    expect((await analyzeNotebookSourceFileAccess('r', source)).reads).toEqual([])
  })

  it('retains only the first invocation and leaves later helper inputs unresolved', async () => {
    const source = `${helper}\nreader("inputs/first.txt")\nreader("inputs/second.txt")`
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/first.txt'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const parsed = await analyzeRNotebookSource(`${helper}\nreader("inputs/first.txt")`)
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'reader("inputs/later-cell.txt")',
          parsed.fileAccess?.context
        )
      ).reads
    ).toEqual([])
  })

  it('does not infer additional paths from the opaque helper tail', async () => {
    const source = helper.replace(
      'stopifnot(length(lines) > 0L)',
      'base::readLines("inputs/hidden-tail.txt")'
    )
    expect(
      await analyzeNotebookSourceFileAccess('r', `${source}\nreader("inputs/observations.txt")`)
    ).toMatchObject({ reads: ['inputs/observations.txt'], readState: 'partial' })
  })
})

describe('first helper inputs before rebinding', () => {
  const helper = 'reader <- function(path) { lines <- base::readLines(con=path); lines }'

  it.each([
    [helper, 'reader <- reader("inputs/observations.txt")', 'inputs/observations.txt'],
    [helper, 'reader = reader("inputs/observations.txt")', 'inputs/observations.txt'],
    [helper, 'reader("inputs/observations.txt") -> reader', 'inputs/observations.txt'],
    [
      'reader <- function(path) { data <- utils::read.csv(file=path); data }',
      'reader <- reader("inputs/observations.csv")',
      'inputs/observations.csv'
    ],
    [
      'reader <- function(path) { data <- utils::read.table(file=path, header=TRUE); data }',
      'reader <- reader("inputs/observations.csv")',
      'inputs/observations.csv'
    ],
    [
      'reader <- function() { lines <- base::readLines(con="inputs/observations.txt"); lines }',
      'reader <- reader()',
      'inputs/observations.txt'
    ],
    [
      'reader <- function() { lines <- base::readLines(con="inputs/observations.txt"); lines }',
      'reader() -> reader',
      'inputs/observations.txt'
    ]
  ])('retains the RHS input of %s followed by %s', async (definition, assignment, path) => {
    const source = `${definition}\n${assignment}\nreader("inputs/later.txt")`
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [path],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const parsed = await analyzeRNotebookSource(source)
    expect(parsed.facts.state).toBe('unknown')
    expect(parsed.facts.safeCallNames ?? []).not.toContain('reader')
    expect(parsed.fileAccess?.context.localFileWrappers).toEqual([])
  })

  it.each([
    `${helper}\nreader <- reader(stop("blocked"))`,
    `${helper}\nreader <- reader(path="inputs/observations.txt", path="other.txt")`,
    `${helper}\nreader <- reader("inputs/observations.txt", "extra")`,
    `${helper}\nreader <- reader(pat="inputs/observations.txt")`,
    `${helper}\nreader <- reader({ path <- "inputs/observations.txt"; path })`,
    `${helper}\nreader <- identity(reader("inputs/observations.txt"))`,
    'reader <- function(path, unused) { lines <- base::readLines(con=path); lines }\nreader <- reader("inputs/observations.txt", stop("not forced"))',
    `${helper}\nalias <- reader\nreader <- reader("inputs/observations.txt")`,
    `${helper}\nif (flag) reader <- reader("inputs/observations.txt")`
  ])('does not borrow a known RHS input from an unproven call: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not export the old first-reader identity after rebinding', async () => {
    const source = `${helper}\nreader <- reader("inputs/observations.txt")`
    const parsed = await analyzeRNotebookSource(source)
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'reader("inputs/later-cell.txt")',
          parsed.fileAccess?.context
        )
      ).reads
    ).toEqual([])
  })
})
