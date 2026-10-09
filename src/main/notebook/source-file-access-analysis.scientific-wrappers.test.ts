import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { describe, expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'

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

configureTestRuntimeMetadata()
