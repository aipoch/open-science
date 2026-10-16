import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Parser } from 'web-tree-sitter'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from './analysis-test-support'
import { NotebookDependencyAnalyzer } from './analysis-test-support'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import type { NotebookSourceFileAccessContext } from './dependency-analysis-types'
import { projectNotebookFileContext, type FileContextEntry } from './dependency-file-context'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const roots: string[] = []
const analyzedPythonPath = (value: string): string =>
  process.platform === 'win32' ? value.replaceAll('/', '\\') : value

it('restores writer paths from sliced collections after cache reload', async () => {
  const context = await fileContext('r', [
    'paths <- c("a.csv","b.csv","unused.csv")',
    'selected <- paths[1:2]'
  ])
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'list(data.frame(n=1)) |> purrr::walk2(selected,utils::write.csv)',
      context
    )
  ).toMatchObject({
    writes: ['a.csv', 'b.csv'],
    writeState: 'complete',
    externalState: 'complete'
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  )
})

const fileContext = async (
  language: 'python' | 'r',
  scripts: string[],
  overrides: Array<Partial<NotebookRunRecord>> = [],
  precompute = true,
  corruptCache?: (json: string) => string,
  currentKernelEpochId = 'epoch-1',
  currentRunOverrides?: Partial<NotebookRunRecord>,
  afterPrecompute?: (runs: NotebookRunRecord[]) => void
): Promise<NotebookSourceFileAccessContext | undefined> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
  roots.push(storageRoot)
  const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
    runId: `run-${index}`,
    cellId: `cell-${index}`,
    source: 'agent',
    inputKind: 'cell',
    kernelKind: language,
    kernelEpochId: 'epoch-1',
    environment: `default-${language}`,
    script,
    status: 'completed',
    startedAt: index,
    endedAt: index,
    executionCount: index,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    inputFiles: [],
    ...overrides[index]
  }))
  const currentRun = currentRunOverrides
    ? {
        ...runs.at(-1)!,
        runId: 'next-run',
        cellId: 'next-cell',
        script: '',
        ...currentRunOverrides
      }
    : undefined
  const repository = { readSessionRuns: async () => (currentRun ? [...runs, currentRun] : runs) }
  if (precompute)
    await new NotebookDependencyAnalyzer({ storageRoot, repository }).project({
      projectId: 'default-project',
      sessionId: 'session-1'
    })
  // Reload persisted facts, just as the file observer does after an app restart.
  if (corruptCache) {
    const cachePath = join(
      storageRoot,
      'notebooks/default-project/session-1/cache/dependency-analysis.json'
    )
    await writeFile(cachePath, corruptCache(await readFile(cachePath, 'utf8')))
  }
  afterPrecompute?.(runs)
  return new NotebookDependencyAnalyzer({ storageRoot, repository }).sourceFileAccessContext({
    projectId: 'default-project',
    sessionId: 'session-1',
    currentRunId: 'next-run',
    language,
    environment: `default-${language}`,
    kernelEpochId: currentKernelEpochId
  })
}

describe('partial notebook reader inputs after cache reload', () => {
  it.each(['path', 'base::gzfile(path)', 'base::gzfile(open="rb",description=path)'])(
    'retains one R local-path prefix input without exporting its candidate: %s',
    async (file) => {
      const definition = `read_events <- function(input_dir) { path <- base::file.path(input_dir,"events.csv.gz"); utils::read.csv(${file},stringsAsFactors=FALSE) }`
      const source = `${definition}\nread_events("inputs")\nread_events("later")`
      const prior = await fileContext('r', ['input_dir <- "decoy"', 'path <- "inputs/decoy.csv"'])
      expect(await analyzeNotebookSourceFileAccess('r', source, prior)).toMatchObject({
        reads: ['inputs/events.csv.gz'],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const parsed = await analyzeRNotebookSource(source, prior)
      expect(parsed.facts.state).toBe('unknown')
      expect(parsed.facts.safeCallNames ?? []).not.toContain('read_events')
      expect(parsed.fileAccess?.context.localFileWrappers).toEqual([])
      const context = await fileContext('r', [source])
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'read_events("other")', context)).reads
      ).toEqual([])
    }
  )

  it.each(['..0', '..1', '..01', '..20'])(
    'rejects an R local-path prefix using special dots formal %s',
    async (formal) => {
      const source = `read_events <- function(${formal}) { path <- base::file.path(${formal},"events.csv.gz"); utils::read.csv(path) }\nread_events("inputs")`
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each(['::', '<-', '=', '{', 'function'])(
    'rejects an R local-path prefix after cached primitive %s rebinding',
    async (name) => {
      const context = await fileContext('r', [`\`${name}\` <- replacement`])
      const source =
        'read_events <- function(input_dir) { path <- base::file.path(input_dir,"events.csv.gz"); utils::read.csv(base::gzfile(path)) }\nread_events("inputs")'
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('resolves a Python method-chain reader against a prior static path', async () => {
    const context = await fileContext('python', ['matrix_path = "outputs/weights.mtx"'])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'from scipy.io import mmread\ndef reopen_matrix(path):\n    return mmread(path).tocsr()\nweights = reopen_matrix(matrix_path)',
        context
      )
    ).toMatchObject({
      reads: ['outputs/weights.mtx'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not propagate an R composed-reader candidate to a later cell', async () => {
    const definition =
      'read_events <- function(input_dir) { events <- utils::read.csv(base::gzfile(base::file.path(input_dir,"events.csv.gz"))); stopifnot(nrow(events)>0L); events }'
    const source = `${definition}\nread_events("inputs")`
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/events.csv.gz'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const context = await fileContext('r', [source])
    expect(
      (await analyzeNotebookSourceFileAccess('r', 'read_events("later")', context)).reads
    ).toEqual([])
  })

  it('retains a statically named writer after a helper first read', async () => {
    const source = [
      'read_and_export <- function(input_dir) {',
      '  observations <- utils::read.csv(base::file.path(input_dir, "observations.csv"))',
      '  utils::write.csv(observations, base::file.path("outputs", "observations.csv"), row.names=FALSE)',
      '  observations',
      '}',
      'read_and_export("inputs")'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/observations.csv'],
      writes: ['outputs/observations.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    [
      'replays a zero-argument jsonlite writer helper',
      'emit <- function() { jsonlite::write_json(list(value=1), "outputs/result.json") }; emit()',
      { reads: [], writes: ['outputs/result.json'] }
    ],
    [
      'replays a writer helper with an opaque dynamic payload and static file.path output',
      [
        'write_observations <- function() {',
        '  observations <- datasets::faithful',
        '  payload <- list(',
        '    eruptions = unname(observations[, "eruptions"]),',
        '    waiting = unname(observations[, "waiting"])',
        '  )',
        '  jsonlite::write_json(',
        '    payload,',
        '    path=base::file.path("outputs", "observations.json"),',
        '    auto_unbox=TRUE,',
        '    digits=8,',
        '    pretty=FALSE',
        '  )',
        '}',
        'write_observations()'
      ].join('\n'),
      { reads: [], writes: ['outputs/observations.json'] }
    ],
    [
      'replays a zero-argument jsonlite reader helper',
      'load <- function() { jsonlite::read_json("inputs/result.json") }; load()',
      { reads: ['inputs/result.json'], writes: [] }
    ],
    [
      'replays a zero-argument jsonlite fromJSON helper',
      'load <- function() { jsonlite::fromJSON("inputs/result.json") }; load()',
      { reads: ['inputs/result.json'], writes: [] }
    ]
  ])('%s', async (_label, source, expected) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      ...expected,
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    [
      'does not replay a helper with arguments',
      'emit <- function(path) { jsonlite::write_json(list(value=1), path) }; emit()'
    ],
    [
      'does not replay a fromJSON helper with a dynamic path',
      'load <- function(path) { jsonlite::fromJSON(path) }; load()'
    ],
    [
      'does not treat inline JSON as a fromJSON file path',
      'load <- function() { jsonlite::fromJSON("{\\"value\\":1}") }; load()'
    ],
    [
      'does not replay a helper with a dynamic path',
      'emit <- function() { jsonlite::write_json(list(value=1), paste0("outputs", "/result.json")) }; emit()'
    ],
    [
      'does not replay a helper under control flow',
      'emit <- function() { if (TRUE) jsonlite::write_json(list(value=1), "outputs/result.json") }; emit()'
    ],
    [
      'does not replay a helper after rebinding',
      'emit <- function() { jsonlite::write_json(list(value=1), "outputs/result.json") }; emit <- function() NULL; emit()'
    ],
    [
      'does not replay a writer helper with an opaque local payload call',
      'emit <- function() { payload <- make_payload(); jsonlite::write_json(payload, "outputs/result.json") }; emit()'
    ]
  ])('%s', async (_label, source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: []
    })
  })

  it('retains file reads from Python assert messages', async () => {
    const source = 'assert True, open("inputs/assert-message.txt").read()'
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['inputs/assert-message.txt'],
      readState: 'complete'
    })
  })

  it.each(['file.path', 'base::file.path'])(
    'retains a JSON helper local %s output without certifying a write',
    async (constructor) => {
      const source = [
        'observations <- datasets::faithful',
        'export_observations <- function() {',
        `  destination <- ${constructor}("outputs", "observations.json")`,
        '  payload <- list(values=observations)',
        '  jsonlite::write_json(payload, path=destination, auto_unbox=TRUE)',
        '  invisible(destination)',
        '}',
        'export_observations()',
        'jsonlite::read_json("outputs/observations.json")'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['outputs/observations.json'],
        writes: ['outputs/observations.json'],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const parsed = await analyzeRNotebookSource(source)
      expect(parsed.facts.state).toBe('unknown')
      expect(parsed.facts.safeCallNames ?? []).not.toContain('export_observations')
      const context = await fileContext('r', [source])
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'export_observations()', context)).writes
      ).toEqual([])
    }
  )

  it.each(['fromJSON', 'read_json'])(
    'resolves a stable outer JSON path when invoking %s',
    async (reader) => {
      const source = [
        'input_path <- file.path("inputs", "measurements.json")',
        `load_measurements <- function() { jsonlite::${reader}(input_path, simplifyVector=FALSE) }`,
        'measurements <- load_measurements()'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['inputs/measurements.json'],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const context = await fileContext('r', [source])
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'load_measurements()', context)).reads
      ).toEqual([])
    }
  )

  it.each([
    'input_path <- "inputs/old.json"; opaque(); load <- function() jsonlite::fromJSON(input_path); load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); opaque(); load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); input_path <- "inputs/new.json"; load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); input_path[1] <- "inputs/new.json"; load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); rm(load); load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); assign("load", replacement); load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); if (flag) load()',
    'input_path <- "inputs/old.json"; if (flag) load <- function() jsonlite::fromJSON(input_path); load()',
    'input_path <- "inputs/old.json"; load <- function() jsonlite::fromJSON(input_path); alias <- load; alias()',
    'input_path <- "{\\"n\\":1}"; load <- function() jsonlite::fromJSON(input_path); load()',
    'load <- function() { path <- file.path("inputs", "a.json"); path <- dynamic; jsonlite::read_json(path) }; load()',
    'load <- function() { path <- file.path("inputs", "a.json"); opaque(); jsonlite::read_json(path) }; load()',
    'load <- function() { path <- file.path("inputs", "a.json"); jsonlite::read_json(path, simplifyVector={path <- "other"; TRUE}) }; load()',
    'load <- function() { path <- file.path("inputs", "a.json"); jsonlite::read_json(path, ...) }; load()',
    'file.path <- replacement; load <- function() { path <- file.path("inputs", "a.json"); jsonlite::read_json(path) }; load()',
    'load <- function() { file.path <- replacement; path <- file.path("inputs", "a.json"); jsonlite::read_json(path) }; load()',
    'load <- function() { path <- other::file.path("inputs", "a.json"); jsonlite::read_json(path) }; load()',
    'load <- function() { path <- file.path("https://example.invalid", "a.json"); jsonlite::read_json(path) }; load()',
    'load <- function() { path <- file.path("inputs", unknown); jsonlite::read_json(path) }; load()',
    'input_path <- "inputs/old.json"; load <- function() { info <- base::names(data); jsonlite::fromJSON(input_path) }; load()',
    'load <- function() { path <- file.path("inputs", "a.json"); info <- nrow(data); jsonlite::read_json(path) }; load()',
    'load <- function() { path <- file.path("inputs", "a.json"); info <- data$value; jsonlite::read_json(path) }; load()',
    'load <- function() { path <- file.path("inputs", "a.json"); info <- c(data); jsonlite::read_json(path) }; load()',
    'load <- function() { ..1 <- "inputs/a.json"; jsonlite::read_json(..1) }; load()',
    'nrow <- replacement; emit <- function() { path <- file.path("outputs", "a.json"); payload <- list(n=nrow(data)); jsonlite::write_json(payload, path) }; emit()'
  ])('rejects uncertain JSON helper path authority: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: []
    })
  })

  it.each(['fromJSON', 'read_json'])(
    'retains only the first literal %s input before an opaque helper tail',
    async (reader) => {
      const source = [
        'load_centered <- function() {',
        '  obs <- jsonlite::' + reader + '("outputs/observations.json")',
        '  x <- as.numeric(obs$eruptions)',
        '  jsonlite::read_json("inputs/later.json")',
        '  jsonlite::write_json(x, "outputs/later.json")',
        '  x - mean(x)',
        '}',
        'centered <- load_centered()'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['outputs/observations.json'],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const parsed = await analyzeRNotebookSource(source)
      expect(parsed.facts.state).toBe('unknown')
      expect(parsed.facts.safeCallNames ?? []).not.toContain('load_centered')
      const context = await fileContext('r', [source])
      expect(
        (await analyzeNotebookSourceFileAccess('r', 'load_centered()', context)).reads
      ).toEqual([])
    }
  )

  it.each(['"inputs/a.json"', 'file.path("inputs", "a.json")'])(
    'retains a static local path prefix for a %s helper input before an opaque tail',
    async (pathExpression) => {
      const source = [
        'load <- function() {',
        `  path <- ${pathExpression}`,
        '  value <- jsonlite::fromJSON(path)',
        '  opaque(value)',
        '}',
        'load()'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['inputs/a.json'],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each(['TRUE', 'FALSE'])(
    'retains a literal JSON input with simplifyVector=%s before an opaque tail',
    async (simplifyVector) => {
      const source = [
        'load <- function() {',
        `  value <- jsonlite::fromJSON("inputs/a.json", simplifyVector=${simplifyVector})`,
        '  opaque(value)',
        '}',
        'load()'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: ['inputs/a.json'],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('retains multiple stable JSON helper inputs in one cell', async () => {
    const source = [
      'read_obs <- function() {',
      '  value <- jsonlite::fromJSON("outputs/observations.json", simplifyVector=TRUE)',
      '  list(eruptions = as.numeric(value$eruptions))',
      '}',
      'read_reg <- function() {',
      '  value <- jsonlite::fromJSON("outputs/regression.json", simplifyVector=FALSE)',
      '  list(slope = as.numeric(value$slope))',
      '}',
      'observations <- read_obs()',
      'regression <- read_reg()',
      'opaque(observations, regression)'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['outputs/observations.json', 'outputs/regression.json'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('retains JSON helper candidates across known scientific calls', async () => {
    const source = [
      'read_reg <- function() { path <- file.path("outputs", "regression.json"); jsonlite::read_json(path, simplifyVector=TRUE) }',
      'read_obs <- function() { path <- file.path("outputs", "observations.json"); jsonlite::read_json(path, simplifyVector=TRUE) }',
      'data(faithful, envir=environment())',
      'n_obs <- nrow(faithful)',
      'fit <- stats::lm(waiting ~ eruptions, data=faithful)',
      'slope <- unname(stats::coef(fit)["eruptions"])',
      'correlation <- stats::cor(faithful$eruptions, faithful$waiting)',
      'regression <- read_reg()',
      'observations <- read_obs()'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['outputs/observations.json', 'outputs/regression.json'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each(['stats::predict(model)', 'data <- replacement; data(faithful)', 'values["name"]'])(
    'clears JSON helper authority after an uncertain call: %s',
    async (call) => {
      const source = [
        'load <- function() { jsonlite::fromJSON("inputs/result.json") }',
        call,
        'load()'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        reads: [],
        writes: []
      })
    }
  )

  it.each(['jsonlite::fromJSON(txt="inputs/a.json")', 'jsonlite::read_json(path="inputs/a.json")'])(
    'retains an exactly named first JSON input: %s',
    async (reader) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'r',
          'load <- function() { ' + reader + '; opaque() }; load()'
        )
      ).toMatchObject({ reads: ['inputs/a.json'], writes: [], readState: 'partial' })
    }
  )

  it.each([
    'load <- function(p) { jsonlite::fromJSON("inputs/a.json"); opaque() }; load()',
    'load <- function(p=opaque()) { jsonlite::fromJSON("inputs/a.json"); opaque() }; load()',
    'load <- function() { opaque(); jsonlite::fromJSON("inputs/a.json") }; load()',
    'load <- function() { if (flag) jsonlite::fromJSON("inputs/a.json"); opaque() }; load()',
    'load <- function() { path <- dynamic; jsonlite::fromJSON(path); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON(file.path("inputs", "a.json")); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("null"); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("https://example.invalid/a.json"); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON(t="inputs/a.json"); opaque() }; load()',
    'load <- function() { jsonlite::read_json(p="inputs/a.json"); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json", simplifyVector=opaque()); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json", simplifyVector=flag); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json", flatten=TRUE); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json", ...); opaque() }; load()',
    'load <- function() { jsonlite:::fromJSON("inputs/a.json"); opaque() }; load()',
    'load <- function() { jsonlite::write_json(data,"outputs/a.json"); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json"); opaque() }; load <- replacement; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json"); opaque() }; alias <- load; alias()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json"); opaque() }; opaque(); load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json"); opaque() }; if (flag) load()',
    'if (flag) load <- function() { jsonlite::fromJSON("inputs/a.json"); opaque() }; load()',
    'load <- function() { jsonlite::fromJSON("inputs/a.json"); opaque() }; load(unexpected=1)'
  ])('rejects uncertain first JSON read authority: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: []
    })
  })

  it('consumes other JSON helper candidates after an opaque tail', async () => {
    const source = [
      'later <- function() { jsonlite::fromJSON("inputs/later.json"); opaque() }',
      'load <- function() { jsonlite::fromJSON("inputs/first.json"); opaque() }',
      'load()',
      'later()',
      'load()'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/first.json', 'inputs/later.json'],
      writes: [],
      readState: 'partial'
    })
  })

  it.each(['::', 'function', '{', '<-', '='])(
    'rejects a first JSON input with shadowed primitive %s',
    async (primitive) => {
      const source =
        'load <- function() { obs <- jsonlite::fromJSON("inputs/a.json"); as.numeric(obs$x) }; load()'
      const binding =
        String.fromCharCode(96) + primitive + String.fromCharCode(96) + ' <- replacement'
      expect((await analyzeNotebookSourceFileAccess('r', binding + '; ' + source)).reads).toEqual(
        []
      )
      const context = await fileContext('r', [binding])
      expect((await analyzeNotebookSourceFileAccess('r', source, context)).reads).toEqual([])
    }
  )

  it('consumes the old JSON helper before rebinding its result', async () => {
    const source =
      'path <- "inputs/result.json"; load <- function() jsonlite::fromJSON(path); load <- load(); load()'
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/result.json'],
      readState: 'partial'
    })
  })

  it.each(['::', 'function', '{', '<-', '='])(
    'rejects a JSON helper after cached primitive %s shadowing',
    async (primitive) => {
      const context = await fileContext('r', [`\`${primitive}\` <- replacement`])
      const source =
        'input_path <- "inputs/a.json"; load <- function() jsonlite::fromJSON(input_path); load()'
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
        reads: [],
        writes: []
      })
    }
  )

  it.each([
    [
      'does not promote an unreachable writer',
      'if (FALSE) utils::write.csv(observations, "outputs/observations.csv")',
      'read_and_export("inputs")',
      ['inputs/observations.csv']
    ],
    [
      'does not descend into an unforced call argument',
      '(function(unused) NULL)(utils::write.csv(observations, "outputs/observations.csv"))',
      'read_and_export("inputs")',
      ['inputs/observations.csv']
    ],
    [
      'does not retain output when helper arguments do not match',
      'utils::write.csv(observations, "outputs/observations.csv")',
      'read_and_export(unknown="inputs")',
      []
    ],
    [
      'does not trust a writer after a local namespace rebind',
      '`::` <- function(...) NULL; utils::write.csv(observations, "outputs/observations.csv")',
      'read_and_export("inputs")',
      ['inputs/observations.csv']
    ],
    [
      'does not scan writers after an intervening statement',
      'summary <- nrow(observations); utils::write.csv(observations, "outputs/observations.csv")',
      'read_and_export("inputs")',
      ['inputs/observations.csv']
    ]
  ])('%s', async (_label, statement, invocation, reads) => {
    const source = [
      'read_and_export <- function(input_dir) {',
      '  observations <- utils::read.csv(base::file.path(input_dir, "observations.csv"))',
      `  ${statement}`,
      '  observations',
      '}',
      invocation
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads,
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('rejects a composed R reader after a cached namespace operator rebind', async () => {
    const context = await fileContext('r', ['`::` <- function(...) NULL'])
    const source =
      'read_events <- function(input_dir) { events <- utils::read.table(base::file.path(input_dir,"events.csv")); events }\nread_events("inputs")'
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toMatchObject({
      reads: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })
})

describe('R known-empty for semantics across cached cells', () => {
  it.each([
    ...['break', 'next', 'return(NULL)', ''].map((exit) => ({
      label: `unreachable path assignment with ${exit || 'no early exit'}`,
      loop: `for(unused in c()) { path <- "inputs/decoy.csv"; ${exit} }`,
      writes: []
    })),
    {
      label: 'unreachable writer with break',
      loop: 'for(unused in c()) { utils::write.table(1,"outputs/result.csv"); break }',
      writes: []
    },
    {
      label: 'unreachable constructor binding before another empty loop',
      loop: 'for(unused in c()) { c <- function(...) "x"; break }\nfor(other in c()) utils::write.table(1,"outputs/result.csv")',
      writes: []
    }
  ])('preserves $label in complete cold/warm four-cell facts', async ({ loop, writes }) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
    roots.push(storageRoot)
    // Handwritten repository records; the source enum is not model/native evidence.
    const scripts = ['marker <- 1', 'path <- "inputs/observations.csv"', loop, 'read.csv(path)']
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'r',
      kernelEpochId: 'epoch-1',
      environment: 'default-r',
      script,
      status: 'completed',
      startedAt: index,
      endedAt: index,
      executionCount: index,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: []
    }))
    const repository = { readSessionRuns: async () => runs }
    const request = { projectId: 'default-project', sessionId: 'session-1' }
    const parse = vi.spyOn(Parser.prototype, 'parse')
    const coldProjection = await new NotebookDependencyAnalyzer({
      storageRoot,
      repository
    }).project(request)
    expect(parse).toHaveBeenCalledTimes(4)
    const cachePath = join(
      storageRoot,
      'notebooks/default-project/session-1/cache/dependency-analysis.json'
    )
    const cold = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(cold.runs['run-2'].fileAccess.writes).toEqual(writes)
    expect(cold.runs['run-2'].facts.definedNames).toContain('unused')
    expect(cold.runs['run-2'].facts.definedNames).not.toContain('path')
    expect(cold.runs['run-2'].facts.conditionallyDefinedNames ?? []).not.toContain('path')
    expect(cold.runs['run-3'].fileAccess).toMatchObject({
      reads: ['inputs/observations.csv'],
      writes: []
    })
    parse.mockClear()
    const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
    expect(await warm.project(request)).toEqual(coldProjection)
    expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
    const context = await warm.sourceFileAccessContext({
      ...request,
      currentRunId: 'run-3',
      language: 'r',
      environment: 'default-r',
      kernelEpochId: 'epoch-1'
    })
    expect(parse).not.toHaveBeenCalled()
    expect(context?.staticStrings).toContainEqual({
      name: 'path',
      value: 'inputs/observations.csv'
    })
    expect(await analyzeNotebookSourceFileAccess('r', scripts[3], context)).toEqual(
      cold.runs['run-3'].fileAccess
    )
  })
})

describe('R loop target handle invalidation across cached cells', () => {
  const replacement = '`{` <- function(...) NULL'
  const writer = 'for (target in c("outputs/result.csv")) utils::write.table(1,target)'
  const reader = 'for (target in c("inputs/observations.csv")) read.csv(target)'
  const variants = [
    { label: 'trusted', prior: 'n <- 1', prefix: '' },
    { label: 'same-cell conditional', prior: 'n <- 1', prefix: replacement + '\n' },
    { label: 'restored conditional', prior: replacement, prefix: '' }
  ]

  it.each([
    ...variants.map(({ label, prior, prefix }) => ({
      label: `${label} connection target writer`,
      prior,
      source: `target <- file("inputs/observations.csv")\nold <- target\n${prefix}{ ${writer} }\nclose(old)\nread.csv("inputs/observations.csv")`,
      reads: ['inputs/observations.csv'],
      writes: ['outputs/result.csv'],
      partial: true
    })),
    ...variants.map(({ label, prior, prefix }) => ({
      label: `${label} in-memory target reader`,
      prior,
      source: `target <- textConnection("n\\n1")\nold <- target\n${prefix}{ ${reader} }\nclose(old)\nread.csv("inputs/phantom.csv")`,
      reads: ['inputs/observations.csv', 'inputs/phantom.csv'],
      writes: [],
      partial: true
    })),
    {
      label: 'early-exit fallback drops the unrelated old connection',
      prior: 'n <- 1',
      source:
        'target <- file("inputs/decoy.csv")\nold <- target\n' +
        'for (target in c("inputs/observations.csv")) { read.csv(target); break }\n' +
        'close(old)\nread.csv("inputs/phantom.csv")',
      reads: ['inputs/phantom.csv'],
      writes: [],
      partial: true
    },
    {
      label: 'empty loop preserves the other-symbol connection alias',
      prior: 'n <- 1',
      source:
        'target <- file("inputs/observations.csv")\nold <- target\n' +
        'for (target in c()) utils::write.table(1,target)\n' +
        'close(old)\nread.csv("inputs/observations.csv")',
      reads: ['inputs/observations.csv'],
      writes: [],
      partial: true
    },
    {
      label: 'ordinary string target keeps its body destination',
      prior: 'n <- 1',
      source: `target <- "inputs/observations.csv"\n{ ${writer} }\nread.csv("inputs/observations.csv")`,
      reads: ['inputs/observations.csv'],
      writes: ['outputs/result.csv'],
      partial: false
    },
    {
      label: 'next element replaces the connection created by the body',
      prior: 'n <- 1',
      source:
        'for (target in c("outputs/first.csv","outputs/second.csv")) { ' +
        'utils::write.table(1,target); target <- file("inputs/observations.csv") }\n' +
        'read.csv("inputs/observations.csv")',
      reads: ['inputs/observations.csv'],
      writes: ['outputs/first.csv', 'outputs/second.csv'],
      partial: false
    },
    {
      label: 'next element replaces the in-memory input created by the body',
      prior: 'n <- 1',
      source:
        'for (target in c("inputs/observations.csv","inputs/phantom.csv")) { ' +
        'read.csv(target); target <- textConnection("n\\n1") }',
      reads: ['inputs/observations.csv', 'inputs/phantom.csv'],
      writes: [],
      partial: false
    }
  ])(
    'preserves $label in cold and warm four-cell facts',
    async ({ prior, source, reads, writes, partial }) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      // Handwritten analysis records; the source enum does not imply model or native execution.
      const runs: NotebookRunRecord[] = ['marker <- 1', prior, source, 'marker <- 2'].map(
        (script, index) => ({
          runId: `run-${index}`,
          cellId: `cell-${index}`,
          source: 'agent',
          inputKind: 'cell',
          kernelKind: 'r',
          kernelEpochId: 'epoch-1',
          environment: 'default-r',
          script,
          status: 'completed',
          startedAt: index,
          endedAt: index,
          executionCount: index,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: [],
          inputFiles: []
        })
      )
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      expect(parse).toHaveBeenCalledTimes(4)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-2'].fileAccess).toMatchObject({
        reads,
        writes,
        readState: partial ? 'partial' : 'complete',
        writeState: partial ? 'partial' : 'complete',
        externalState: partial ? 'partial' : 'complete'
      })
      if (partial) expect(cold.runs['run-2'].facts.state).toBe('unknown')
      parse.mockClear()
      const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warm.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warm.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-2',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      if (prior === replacement) expect(context?.resolvedKernelNames).toContain('{')
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toEqual(
        cold.runs['run-2'].fileAccess
      )
    }
  )
})

describe('R loop target helper invalidation', () => {
  it.each([
    {
      label: 'namespace-after',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'for (`::` in list(function(pkg,name) function(...) NULL)) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'namespace-before',
      definition: 'n <- 1',
      call: 'for (`::` in list(function(pkg,name) function(...) NULL)) {}\nemit <- function(x,file) utils::write.table(x,file)\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'bare-csv-namespace',
      definition: 'emit <- function(x,file) write.csv(x,file)',
      call: 'for (`::` in list(function(pkg,name) function(...) NULL)) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'helper-loop-target',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'for (emit in list(function(...) NULL)) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'bare-writer-loop-target',
      definition: 'emit <- function(x,file) write.table(x,file)',
      call: 'for (write.table in list(function(...) NULL)) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'qualified-member-control',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'for (write.table in list(function(...) NULL)) {}\nemit(1,"outputs/result.csv")\nread.csv("inputs/observations.csv")',
      writes: ['outputs/result.csv']
    },
    {
      label: 'unrelated-target-control',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'for (unused in list(function(...) NULL)) {}\nemit(1,"outputs/result.csv")\nread.csv("inputs/observations.csv")',
      writes: ['outputs/result.csv']
    },
    {
      label: 'empty-sequence-control',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'for (`::` in c()) {}\nemit(1,"outputs/result.csv")\nread.csv("inputs/observations.csv")',
      writes: ['outputs/result.csv']
    },
    {
      label: 'shadowed-names-empty-proof',
      definition:
        'emit <- function(x,file) utils::write.table(x,file)\nv <- list()\nnames <- function(x) list(function(pkg,name) function(...) NULL)',
      call: 'for (`::` in names(v)) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'shadowed-namespace-empty-proof',
      definition:
        'emit <- function(x,file) utils::write.table(x,file)\n`:::` <- function(pkg,name) function(...) list(function(pkg,name) function(...) NULL)',
      call: 'for (`::` in base:::list()) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'trusted-empty-names-control',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'v <- list()\nfor (`::` in names(v)) {}\nemit(1,"outputs/result.csv")\nread.csv("inputs/observations.csv")',
      writes: ['outputs/result.csv']
    },
    {
      label: 'loop-body-binding',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'for (`::` in list(function(pkg,name) function(...) NULL)) { emit(1,"inputs/observations.csv") }\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'stored-shadowed-names-empty-proof',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'v <- list()\nnames <- function(x) list(function(pkg,name) function(...) NULL)\nitems <- names(v)\nfor (`::` in items) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'stored-shadowed-namespace-empty-proof',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: '`:::` <- function(pkg,name) function(...) list(function(pkg,name) function(...) NULL)\nitems <- base:::list()\nfor (`::` in items) {}\nemit(1,"inputs/observations.csv")\nread.csv("inputs/observations.csv")',
      writes: []
    },
    {
      label: 'stored-trusted-empty-alias-control',
      definition: 'emit <- function(x,file) utils::write.table(x,file)',
      call: 'items <- base:::list()\nitems_alias <- items\n`:::` <- function(pkg,name) function(...) list(function(pkg,name) function(...) NULL)\nfor (`::` in items_alias) {}\nemit(1,"outputs/result.csv")\nread.csv("inputs/observations.csv")',
      writes: ['outputs/result.csv']
    }
  ])('preserves $label in cold and warm four-cell facts', async ({ definition, call, writes }) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
    roots.push(storageRoot)
    // Rebinding and invocation share a cell: prior-cell facts already revoke names.
    const scripts = ['marker <- 1', definition, call, 'n <- 2']
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'r',
      kernelEpochId: 'epoch-1',
      environment: 'default-r',
      script,
      status: 'completed',
      startedAt: index,
      endedAt: index,
      executionCount: index,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: []
    }))
    const repository = { readSessionRuns: async () => runs }
    const request = { projectId: 'default-project', sessionId: 'session-1' }
    const parse = vi.spyOn(Parser.prototype, 'parse')
    const coldProjection = await new NotebookDependencyAnalyzer({
      storageRoot,
      repository
    }).project(request)
    expect(parse).toHaveBeenCalledTimes(4)
    const cachePath = join(
      storageRoot,
      'notebooks/default-project/session-1/cache/dependency-analysis.json'
    )
    const cold = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(cold.runs['run-2'].fileAccess.reads).toEqual(['inputs/observations.csv'])
    expect(cold.runs['run-2'].fileAccess.writes).toEqual(writes)
    parse.mockClear()
    const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
    expect(await warm.project(request)).toEqual(coldProjection)
    expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
    const context = await warm.sourceFileAccessContext({
      ...request,
      currentRunId: 'run-2',
      language: 'r',
      environment: 'default-r',
      kernelEpochId: 'epoch-1'
    })
    expect(parse).not.toHaveBeenCalled()
    expect(await analyzeNotebookSourceFileAccess('r', call, context)).toEqual(
      cold.runs['run-2'].fileAccess
    )
  })
})

describe('R loop sequence helper candidates across cached cells', () => {
  const prefix = 'reader <- function(file) { data <- utils::read.csv(file); file }'
  const alias = 'reader <- function(file="") utils::read.csv(file=file)\nalias <- reader'
  const writer = 'emit <- function(x,file="") utils::write.table(x,file=file)\nalias <- emit'

  it.each([
    {
      label: 'prefix sequence before loop target rebinding',
      source: `${prefix}\nfor (reader in reader("inputs/first.csv")) {}`,
      reads: ['inputs/first.csv'],
      writes: []
    },
    {
      label: 'reader alias sequence before loop target rebinding',
      source: `${alias}\nfor (alias in alias(file="inputs/first.csv")) {}`,
      reads: ['inputs/first.csv'],
      writes: []
    },
    {
      label: 'possible writer sequence retains a later same-path read',
      source: `${writer}\nfor (unused in alias(1,file="outputs/result.csv")) {}\nread.csv("outputs/result.csv")`,
      reads: ['outputs/result.csv'],
      writes: ['outputs/result.csv']
    },
    {
      label: 'shadowed for does not force its prefix sequence',
      source: `\`for\` <- function(...) NULL\n${prefix}\nfor (unused in reader("inputs/decoy.csv")) {}`,
      reads: [],
      writes: []
    },
    {
      label: 'outer consume does not force its reader alias promise',
      source: `${alias}\nconsume <- function(...) NULL\nfor (unused in consume(alias(file="inputs/decoy.csv"))) {}`,
      reads: [],
      writes: []
    },
    {
      label: 'prefix sequence consumes authority before body and later calls',
      source: `${prefix}\nfor (unused in reader("inputs/first.csv")) { reader("inputs/body.csv") }\nreader("inputs/later.csv")`,
      reads: ['inputs/first.csv'],
      writes: []
    },
    {
      label: 'alias sequence consumes authority before body and later calls',
      source: `${alias}\nfor (unused in alias(file="inputs/first.csv")) { alias(file="inputs/body.csv") }\nalias(file="inputs/later.csv")`,
      reads: ['inputs/first.csv'],
      writes: []
    },
    {
      label: 'empty sequence does not restore prefix or alias candidates',
      source:
        'prefix_reader <- function(file) { data <- utils::read.csv(file); file }\n' +
        `${alias}\nfor (unused in NULL) {}\nprefix_reader("inputs/later.csv")\nalias(file="inputs/alias-later.csv")`,
      reads: [],
      writes: []
    }
  ])('preserves $label in cold and warm four-cell facts', async ({ source, reads, writes }) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
    roots.push(storageRoot)
    // Handwritten analysis history: declarations and the first sequence call share cell three.
    const scripts = ['marker <- 1', 'prior <- 2', source, 'n <- 3']
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'r',
      kernelEpochId: 'epoch-1',
      environment: 'default-r',
      script,
      status: 'completed',
      startedAt: index,
      endedAt: index,
      executionCount: index,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: []
    }))
    const repository = { readSessionRuns: async () => runs }
    const request = { projectId: 'default-project', sessionId: 'session-1' }
    const parse = vi.spyOn(Parser.prototype, 'parse')
    const coldProjection = await new NotebookDependencyAnalyzer({
      storageRoot,
      repository
    }).project(request)
    expect(parse).toHaveBeenCalledTimes(4)
    const cachePath = join(
      storageRoot,
      'notebooks/default-project/session-1/cache/dependency-analysis.json'
    )
    const cold = JSON.parse(await readFile(cachePath, 'utf8'))
    const runIds = runs.map(({ runId }) => runId).sort()
    expect(Object.keys(cold.runs).sort()).toEqual(runIds)
    expect(Object.keys(coldProjection.stalenessByRunId).sort()).toEqual(runIds)
    expect(cold.runs['run-2'].fileAccess).toMatchObject({
      reads,
      writes,
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect(cold.runs['run-2'].facts.state).toBe('unknown')
    expect(cold.runs['run-2'].fileContext.localFileWrappers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'alias' })])
    )
    parse.mockClear()
    const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
    expect(await warm.project(request)).toEqual(coldProjection)
    expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
    const context = await warm.sourceFileAccessContext({
      ...request,
      currentRunId: 'run-2',
      language: 'r',
      environment: 'default-r',
      kernelEpochId: 'epoch-1'
    })
    const laterContext = await warm.sourceFileAccessContext({
      ...request,
      currentRunId: 'run-3',
      language: 'r',
      environment: 'default-r',
      kernelEpochId: 'epoch-1'
    })
    expect(laterContext?.localFileWrappers ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'alias' })])
    )
    expect(parse).not.toHaveBeenCalled()
    expect(await analyzeNotebookSourceFileAccess('r', source, context)).toEqual(
      cold.runs['run-2'].fileAccess
    )
  })
})

describe('R untrusted for execution across cached cells', () => {
  const replacement = '`for` <- function(...) NULL'
  const write = 'utils::write.table(1,"inputs/observations.csv")'
  const read = 'read.csv("inputs/observations.csv")'
  const helper = 'emit <- function(x,file) utils::write.table(x,file)'

  it.each([
    {
      label: 'same-cell shadowed direct body retains possible write and input',
      prior: 'prior <- 2',
      source: `${replacement}\nfor (unused in c("x")) ${write}\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'same-cell shadowed helper body retains possible write and input',
      prior: 'prior <- 2',
      source: `${helper}\n${replacement}\nfor (unused in c("x")) emit(1,"inputs/observations.csv")\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'same-cell shadowed helper sequence retains possible write and input',
      prior: 'prior <- 2',
      source: `${helper}\n${replacement}\nfor (unused in emit(1,"inputs/observations.csv")) {}\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'for writer alias does not certify a write inside its complex sequence promise',
      prior: 'prior <- 2',
      source:
        'unused <- 1\nemit <- function(x,sequence,file) utils::write.table(x,file)\n' +
        '`for` <- emit\nfor (unused in utils::write.table(1,"inputs/observations.csv")) "outputs/real.csv"\n' +
        read,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'for writer alias retains its known destination with a literal sequence',
      prior: 'prior <- 2',
      source:
        'unused <- 1\nemit <- function(x,sequence,file) utils::write.table(x,file)\n' +
        '`for` <- emit\nfor (unused in NULL) "outputs/real.csv"\n' +
        read,
      reads: ['inputs/observations.csv'],
      writes: ['outputs/real.csv'],
      partial: true
    },
    {
      label: 'restored shadowed for does not certify its direct body',
      prior: replacement,
      source: `for (unused in c("x")) ${write}\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'restored shadowed for does not certify its direct sequence',
      prior: replacement,
      source: `for (unused in ${write}) {}\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'trusted builtin body still certifies a completed write',
      prior: 'prior <- 2',
      source: `for (unused in c("x")) ${write}\n${read}`,
      reads: [],
      writes: ['inputs/observations.csv'],
      partial: false
    },
    {
      label: 'completed write remains certified before an empty shadowed call',
      prior: 'prior <- 2',
      source: `${write}\n${replacement}\nfor (unused in NULL) {}\n${read}`,
      reads: [],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'shadowed body does not publish a new variable path',
      prior: 'prior <- 2',
      source:
        `path <- "inputs/old.csv"\n${replacement}\n` +
        'for (unused in c("x")) { path <- "inputs/new.csv" }\nread.csv(path)',
      reads: [],
      writes: [],
      partial: true
    }
  ])(
    'preserves $label in cold and warm four-cell facts',
    async ({ prior, source, reads, writes, partial }) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      // Handwritten repository records exercise analysis; the enum is not provider evidence.
      const scripts = ['marker <- 1', prior, source, 'n <- 3']
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: `run-${index}`,
        cellId: `cell-${index}`,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'r',
        kernelEpochId: 'epoch-1',
        environment: 'default-r',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }))
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      expect(parse).toHaveBeenCalledTimes(4)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      const runIds = runs.map(({ runId }) => runId).sort()
      expect(Object.keys(cold.runs).sort()).toEqual(runIds)
      expect(Object.keys(coldProjection.stalenessByRunId).sort()).toEqual(runIds)
      expect(cold.runs['run-2'].fileAccess.reads).toEqual(reads)
      expect(cold.runs['run-2'].fileAccess.writes).toEqual(writes)
      expect(cold.runs['run-2'].fileAccess).toMatchObject({
        readState: partial ? 'partial' : 'complete',
        writeState: partial ? 'partial' : 'complete',
        externalState: partial ? 'partial' : 'complete'
      })
      if (partial) expect(cold.runs['run-2'].facts.state).toBe('unknown')
      parse.mockClear()
      const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warm.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warm.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-2',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      if (prior === replacement) expect(context?.resolvedKernelNames).toContain('for')
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toEqual(
        cold.runs['run-2'].fileAccess
      )
    }
  )
})

describe('R untrusted brace execution across cached cells', () => {
  const replacement = '`{` <- function(...) NULL'
  const write = 'utils::write.table(1,"inputs/observations.csv")'
  const read = 'read.csv("inputs/observations.csv")'
  const helper = 'emit <- function(path) utils::write.table(1,path)'

  it.each([
    {
      label: 'same-cell shadowed direct write remains possible',
      prior: 'n <- 1',
      source: `${replacement}\n{ ${write} }\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'same-cell shadowed helper write remains possible',
      prior: 'n <- 1',
      source: `${helper}\n${replacement}\n{ emit("inputs/observations.csv") }\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'same-cell shadowed brace does not publish a path binding',
      prior: 'n <- 1',
      source:
        `path <- "inputs/decoy.csv"\n${replacement}\n` +
        '{ path <- "inputs/observations.csv" }\nread.csv(path)',
      reads: [],
      writes: [],
      partial: true
    },
    {
      label: 'trusted builtin brace still certifies its completed write',
      prior: 'n <- 1',
      source: `{ ${write} }\n${read}`,
      reads: [],
      writes: ['inputs/observations.csv'],
      partial: false
    },
    {
      label: 'same-cell shadowed brace does not publish a nested loop target',
      prior: 'n <- 1',
      next: 'read.csv(path)',
      source:
        `path <- "inputs/observations.csv"\n${replacement}\n` +
        '{ for (path in c("inputs/decoy.csv")) 1 }\nread.csv(path)',
      reads: [],
      writes: [],
      partial: true
    },
    {
      label: 'restored shadowed brace keeps a nested loop writer possible',
      prior: `path <- "inputs/observations.csv"\n${replacement}`,
      next: 'read.csv(path)',
      source: '{ for (path in c("inputs/decoy.csv")) utils::write.table(1,path) }\nread.csv(path)',
      reads: [],
      writes: ['inputs/decoy.csv'],
      partial: true
    },
    {
      label: 'completed write remains certified before brace replacement',
      prior: 'n <- 1',
      source:
        `${write}\n${replacement}\n` +
        '{ utils::write.table(2,"inputs/observations.csv") }\n' +
        read,
      reads: [],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'builtin brace selected at entry survives a later replacement',
      prior: 'n <- 1',
      source: `{ ${replacement}; ${write} }\n${read}`,
      reads: [],
      writes: ['inputs/observations.csv'],
      partial: false
    },
    {
      label: 'restored shadowed brace does not certify a direct write',
      prior: replacement,
      source: `{ ${write} }\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'restored shadowed brace does not certify a helper write',
      prior: replacement,
      source: `${helper}\n{ emit("inputs/observations.csv") }\n${read}`,
      reads: ['inputs/observations.csv'],
      writes: ['inputs/observations.csv'],
      partial: true
    },
    {
      label: 'restored shadowed brace does not publish a new path binding',
      prior: `path <- "inputs/decoy.csv"\n${replacement}`,
      source: '{ path <- "inputs/observations.csv" }\nread.csv(path)',
      reads: [],
      writes: [],
      partial: true
    }
  ])(
    'preserves $label in cold and warm four-cell facts',
    async ({ prior, source, reads, writes, partial, next }) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      // Handwritten analysis records; their source enum does not imply model or native execution.
      const scripts = ['marker <- 1', prior, source, next ?? 'marker <- 2']
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: `run-${index}`,
        cellId: `cell-${index}`,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'r',
        kernelEpochId: 'epoch-1',
        environment: 'default-r',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }))
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      expect(parse).toHaveBeenCalledTimes(4)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      const runIds = runs.map(({ runId }) => runId).sort()
      expect(Object.keys(cold.runs).sort()).toEqual(runIds)
      expect(Object.keys(coldProjection.stalenessByRunId).sort()).toEqual(runIds)
      expect(cold.runs['run-2'].fileAccess.reads).toEqual(reads)
      expect(cold.runs['run-2'].fileAccess.writes).toEqual(writes)
      if (next) {
        expect(cold.runs['run-3'].fileAccess).toMatchObject({ reads: [], readState: 'partial' })
      }
      if (partial) {
        expect(cold.runs['run-2'].fileAccess).toMatchObject({
          readState: 'partial',
          writeState: 'partial',
          externalState: 'partial'
        })
        expect(cold.runs['run-2'].facts.state).toBe('unknown')
      }
      parse.mockClear()
      const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warm.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warm.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-2',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      if (prior.includes(replacement)) expect(context?.resolvedKernelNames).toContain('{')
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', source, context)).toEqual(
        cold.runs['run-2'].fileAccess
      )
    }
  )
})

it('keeps trusted glue aliases in restored loop collections', async () => {
  const context = await fileContext('r', [
    'library(glue); g <- glue',
    'labels <- c("a","b")',
    'paths <- g("outputs/{labels}.txt")',
    'n <- 1'
  ])
  expect(
    await analyzeNotebookSourceFileAccess('r', 'for (file in paths) writeLines("x",file)', context)
  ).toMatchObject({ writes: ['outputs/a.txt', 'outputs/b.txt'] })
})

describe('R file helper namespace dependencies', () => {
  it.each([
    [
      'secondary device namespace lookup replaced',
      'emit <- function(file) { if(FALSE) grDevices::png(file) else grDevices:::png(file) }',
      '`:::` <- function(pkg,name) function(...) NULL',
      'emit("inputs/observations.csv")',
      []
    ],
    [
      'qualified lookup replaced after declaration',
      'emit <- function(x,file) utils::write.csv(x,file)',
      '`::` <- function(pkg,name) function(...) NULL',
      'emit(1,"inputs/observations.csv")',
      []
    ],
    [
      'qualified lookup replaced before declaration',
      '`::` <- function(pkg,name) function(...) NULL',
      'emit <- function(x,file) utils::write.csv(x,file)',
      'emit(1,"inputs/observations.csv")',
      []
    ],
    [
      'internal CSV lookup replaced',
      'emit <- function(x,file) write.csv(x,file)',
      '`::` <- function(pkg,name) function(...) NULL',
      'emit(1,"inputs/observations.csv")',
      []
    ],
    [
      'internal CSV lookup replaced behind triple colon',
      'emit <- function(x,file) utils:::write.csv(x,file)',
      '`::` <- function(pkg,name) function(...) NULL',
      'emit(1,"inputs/observations.csv")',
      []
    ],
    [
      'triple colon lookup replaced',
      'emit <- function(x,file) utils:::write.table(x,file)',
      '`:::` <- function(pkg,name) function(...) NULL',
      'emit(1,"inputs/observations.csv")',
      []
    ],
    [
      'qualified member replacement control',
      'emit <- function(x,file) utils::write.csv(x,file)',
      'write.csv <- function(...) NULL',
      'emit(1,"outputs/summary.csv")',
      ['outputs/summary.csv']
    ],
    [
      'bare table control',
      'emit <- function(x,file) write.table(x,file)',
      '`::` <- function(pkg,name) function(...) NULL',
      'emit(1,"outputs/summary.csv")',
      ['outputs/summary.csv']
    ]
  ])(
    'preserves %s through cold and warm four-cell facts',
    async (_label, first, second, call, writes) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      const scripts = [first, second, `${call}\nread.csv("inputs/observations.csv")`, 'n <- 1']
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: `run-${index}`,
        cellId: `cell-${index}`,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'r',
        kernelEpochId: 'epoch-1',
        environment: 'default-r',
        script: script as string,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }))
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      expect(parse).toHaveBeenCalledTimes(4)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-2'].fileAccess.reads).toEqual(['inputs/observations.csv'])
      expect(cold.runs['run-2'].fileAccess.writes).toEqual(writes)
      parse.mockClear()
      const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warm.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warm.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-2',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', scripts[2] as string, context)).toEqual(
        cold.runs['run-2'].fileAccess
      )
    }
  )
})

describe('R writer option evaluation', () => {
  it.each([
    'emit <- function(file,x=read_one(file)) utils::write.csv(x,file)\nemit("inputs/observations.csv")',
    'emit <- function(x,file) utils::write.csv(read_one(file),file)\nemit(1,"inputs/observations.csv")',
    'emit <- function(x,file) utils::write.csv(x,file)\nemit(read_one("inputs/observations.csv"),"inputs/observations.csv")'
  ])('retains a restored reader helper inside writer promises: %s', async (source) => {
    const context = await fileContext('r', ['read_one <- function(file) utils::read.csv(file)'])
    const access = await analyzeNotebookSourceFileAccess(
      'r',
      source + '\nutils::read.csv("inputs/observations.csv")',
      context
    )
    expect(access.reads).toEqual(['inputs/observations.csv'])
    expect(access.readState).toBe('partial')
    expect(access.writeState).toBe('partial')
    expect(access.writes).toEqual(
      source.includes('emit(read_one(') ? ['inputs/observations.csv'] : []
    )
  })

  it.each(['write.csv', 'write.csv2'])(
    'does not certify positional %s options before they evaluate',
    async (writer) => {
      const access = await analyzeNotebookSourceFileAccess(
        'r',
        `utils::${writer}(1,"inputs/observations.csv",FALSE,FALSE,"\\n","NA",{utils::read.csv("inputs/observations.csv"); TRUE})`
      )
      expect(access.reads).toEqual(['inputs/observations.csv'])
      expect(access.writes).toEqual([])
      expect(access.writeState).toBe('partial')
    }
  )

  it.each([
    [
      'nested helper argument',
      'emit <- function(x,file) utils::write.csv(x,file)',
      'emit(utils::read.csv("inputs/observations.csv"),"inputs/observations.csv")',
      ['inputs/observations.csv'],
      ['inputs/observations.csv']
    ],
    [
      'hidden helper default',
      'emit <- function(file,x=utils::read.csv(file)) utils::write.csv(x,file)',
      'emit("inputs/observations.csv")\nutils::read.csv("inputs/observations.csv")',
      ['inputs/observations.csv'],
      []
    ],
    [
      'helper option rebinding',
      'emit <- function(x,file) utils::write.table(x,file,row.names={file <- "outputs/actual.csv"; FALSE})',
      'emit(1,"inputs/observations.csv")\nutils::read.csv("inputs/observations.csv")',
      ['inputs/observations.csv'],
      []
    ],
    [
      'pre-open table option',
      'label <- "observations"',
      'utils::write.table(1,"inputs/observations.csv",col.names={utils::read.csv("inputs/observations.csv"); TRUE})',
      ['inputs/observations.csv'],
      []
    ],
    [
      'ignored CSV option',
      'label <- "observations"',
      'utils::write.csv(1,"outputs/summary.csv",col.names=utils::write.csv(1,"inputs/observations.csv"))\nutils::read.csv("inputs/observations.csv")',
      ['inputs/observations.csv'],
      ['outputs/summary.csv']
    ]
  ])(
    'preserves %s through cold and warm persisted facts',
    async (_name, definition, script, reads, writes) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      const runs: NotebookRunRecord[] = [definition, script, 'n <- 1', 'n'].map(
        (source, index) => ({
          runId: `run-${index}`,
          cellId: `cell-${index}`,
          source: 'agent',
          inputKind: 'cell',
          kernelKind: 'r',
          kernelEpochId: 'epoch-1',
          environment: 'default-r',
          script: source as string,
          status: 'completed',
          startedAt: index,
          endedAt: index,
          executionCount: index,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: [],
          inputFiles: []
        })
      )
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-1'].fileAccess.reads).toEqual(reads)
      expect(cold.runs['run-1'].fileAccess.writes).toEqual(writes)
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const warm = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warm.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warm.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-1',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', script as string, context)).toMatchObject({
        reads,
        writes
      })
    }
  )
})

describe('Python helper module definition bindings', () => {
  const reader = `def read_inputs():
    return open("old-input.csv")
def replacement():
    return open("new-input.csv")`
  const reboundReaders = [
    [
      'positional default',
      `${reader}\ndef configure(value=(read_inputs := replacement)):\n    return value`
    ],
    [
      'keyword default',
      `${reader}\ndef configure(*, value=(read_inputs := replacement)):\n    return value`
    ],
    [
      'module block default',
      `${reader}\nif True:\n    def configure(value=(read_inputs := replacement)):\n        return value`
    ],
    [
      'async default',
      `${reader}\nasync def configure(value=(read_inputs := replacement)):\n    return value`
    ],
    [
      'nested lambda default',
      `${reader}\ndef configure(value=lambda nested=(read_inputs := replacement): nested):\n    return value`
    ],
    [
      'comprehension expression',
      `${reader}\ndef configure(value=[(read_inputs := replacement) for item in [1]]):\n    return value`
    ],
    [
      'function decorator',
      `${reader}\n@((read_inputs := replacement) and (lambda fn: fn))\ndef configure():\n    return None`
    ],
    [
      'class base',
      `${reader}\nclass Configure((read_inputs := replacement) and object):\n    pass`
    ],
    [
      'class keyword',
      `${reader}\nclass Configure(metaclass=((read_inputs := replacement) and type)):\n    pass`
    ],
    [
      'class decorator',
      `${reader}\n@((read_inputs := replacement) and (lambda cls: cls))\nclass Configure:\n    pass`
    ]
  ] as const
  const preservedReaders = [
    ['baseline', reader],
    [
      'deferred lambda body',
      `${reader}\ndef configure(value=lambda: (read_inputs := replacement)):\n    return value`
    ],
    [
      'comprehension target',
      `${reader}\ndef configure(value=[0 for read_inputs in [1, 2]]):\n    return value`
    ],
    [
      'unrelated default',
      `${reader}\ndef configure(value=(label := "control")):\n    return value`
    ],
    [
      'own final name',
      `${reader}\ndef read_inputs(value=(read_inputs := replacement)):\n    return open("old-input.csv")`
    ],
    [
      'own keyword final name',
      `${reader}\ndef read_inputs(*, value=(read_inputs := replacement)):\n    return open("old-input.csv")`
    ],
    [
      'later explicit definition',
      `${reader}\ndef configure(value=(read_inputs := replacement)):\n    return value\ndef read_inputs():\n    return open("old-input.csv")`
    ],
    ['class-local binding', `${reader}\nclass Configure:\n    read_inputs = replacement`]
  ] as const
  const accessFor = (source: string): ReturnType<typeof analyzeNotebookSourceFileAccess> =>
    analyzeNotebookSourceFileAccess('python', 'handle = read_inputs()', {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [{ source, exports: ['read_inputs'] }]
    })

  it.each(reboundReaders)(
    'does not borrow obsolete reader I/O after %s',
    async (_label, source) => {
      const access = await accessFor(source)
      expect(access.reads).not.toContain('old-input.csv')
      expect(access.reads).not.toContain('new-input.csv')
      expect(access).toMatchObject({ readState: 'partial', externalState: 'partial' })
    }
  )

  it.each(preservedReaders)('retains stable reader I/O with %s', async (_label, source) => {
    const access = await accessFor(source)
    expect(access.reads).toContain('old-input.csv')
    expect(access.reads).not.toContain('new-input.csv')
  })

  it.each([
    [
      'private default',
      `${reader.replaceAll('read_inputs', '_read_inputs')}\ndef configure(value=(_read_inputs := replacement)):\n    return value\ndef read_inputs():\n    return _read_inputs()`
    ],
    [
      'decorated export',
      `${reader}\n@((read_inputs := replacement) and (lambda fn: fn))\ndef read_inputs():\n    return open("old-input.csv")`
    ],
    [
      'uncertain generator expression',
      `${reader}\ndef configure(value=((read_inputs := replacement) for item in [1])):\n    return value`
    ],
    ['wildcard import', `${reader}\nfrom custom_readers import *`],
    [
      'match capture',
      `${reader}\nmatch {"reader": replacement}:\n    case {"reader": read_inputs}:\n        pass`
    ]
  ])('keeps %s conservatively unresolved', async (_label, source) => {
    const access = await accessFor(source)
    expect(access.reads).not.toContain('old-input.csv')
    expect(access.reads).not.toContain('new-input.csv')
    expect(access).toMatchObject({ readState: 'partial', externalState: 'partial' })
  })

  it.each([
    ...reboundReaders.map(([label, source]) => [label, source, false] as const),
    ...preservedReaders
      .filter(([label]) => ['baseline', 'own final name', 'deferred lambda body'].includes(label))
      .map(([label, source]) => [label, source, true] as const)
  ])('persists conservative four-cell reader I/O for %s', async (_label, source, preserved) => {
    const helper = {
      helperId: 'definition-reader',
      skillIdentity: 'skill://definition-reader',
      packageOrigin: 'test',
      interfaceRevision: '1',
      registeredGeneration: 'generation-1',
      exports: ['read_inputs'],
      source,
      sourceDigest: 'digest-definition-reader'
    }
    const scripts = [
      'label = "measurements"',
      'handle = read_inputs()',
      'artifact_path = "outputs/summary.csv"',
      'with open(artifact_path, "w") as report:\n    report.write(label)'
    ]
    for (const precompute of [false, true]) {
      await fileContext(
        'python',
        scripts,
        scripts.map(() => ({
          helperModules: [helper],
          helperEvidenceStatus: { state: 'complete' }
        })),
        precompute
      )
      const sidecar = JSON.parse(
        await readFile(
          join(roots.at(-1)!, 'notebooks/default-project/session-1/cache/dependency-analysis.json'),
          'utf8'
        )
      )
      const access = sidecar.runs['run-1'].fileAccess
      if (preserved) expect(access.reads).toContain('old-input.csv')
      else {
        expect(access.reads).not.toContain('old-input.csv')
        expect(access).toMatchObject({ readState: 'partial', externalState: 'partial' })
      }
      expect(access.reads).not.toContain('new-input.csv')
      expect(sidecar.runs['run-3'].fileAccess.writes).toContain('outputs/summary.csv')
    }
  })
})

describe('Python helper module annotation-only bindings', () => {
  const copySource = (name: string): string => `def ${name}(input_path, output_path):
    with open(input_path) as source:
        contents = source.read()
    with open(output_path, "w") as target:
        target.write(contents)
    return contents`
  const exported = copySource('summarize')
  const privateHelper = `${copySource('_copy')}
def summarize(input_path, output_path):
    return _copy(input_path, output_path)`
  const unchangedHelpers = [
    ['export', `${exported}\nsummarize: object`],
    ['module block', `${exported}\nif True:\n    summarize: object`],
    ['private helper', `${privateHelper}\n_copy: object`],
    ['both helpers', `${privateHelper}\n_copy: object\nsummarize: object`]
  ] as const

  it.each(unchangedHelpers)('retains known I/O after annotating %s', async (_label, source) => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      'first = summarize("inputs/observations.csv", "outputs/summary.csv")',
      {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [{ source, exports: ['summarize'] }]
      }
    )
    expect(access).toMatchObject({
      reads: ['inputs/observations.csv'],
      writes: ['outputs/summary.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    expect(access.reasonCodes).toContain('source-analysis-unsupported-call')
  })

  it.each([
    'def read_inputs():\n    return open("input.csv")\nread_inputs: object',
    'def _read():\n    return open("input.csv")\n_read: object\ndef read_inputs():\n    return _read()'
  ])('preserves existing literal reader certainty with an annotation: %s', async (source) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', 'read_inputs()', {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [{ source, exports: ['read_inputs'] }]
      })
    ).toMatchObject({ reads: ['input.csv'], readState: 'complete', externalState: 'complete' })
  })

  it.each([
    ...['None', '0', 'False', 'lambda *args: "replacement"'].map(
      (rhs) => `${exported}\nsummarize: object = ${rhs}`
    ),
    ...['None', '0', 'False', 'lambda *args: "replacement"'].map(
      (rhs) => `${privateHelper}\n_copy: object = ${rhs}`
    ),
    `${exported}\nsummarize: (summarize := lambda *args: "replacement")`,
    `${privateHelper}\nmarker: (_copy := lambda *args: "replacement")`,
    `${privateHelper}\nif True:\n    marker: (_copy := lambda *args: "replacement")`,
    `${exported}\nsummarize = lambda *args: "replacement"\nsummarize: object`,
    `${privateHelper}\n_copy = lambda *args: "replacement"\n_copy: object`,
    `${copySource('_copy')}\ndef summarize(input_path, output_path):\n    _copy: object\n    return _copy(input_path, output_path)`
  ])('does not borrow obsolete or unbound annotation helper I/O: %s', async (source) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'summarize("inputs/observations.csv", "outputs/summary.csv")',
        {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          pythonHelperModules: [{ source, exports: ['summarize'] }]
        }
      )
    ).toMatchObject({ reads: [], writes: [], readState: 'partial', externalState: 'partial' })
  })

  it.each(unchangedHelpers)(
    'retains four-cell I/O after annotating %s across cold analysis and cache reload',
    async (_label, source) => {
      const helper = {
        helperId: 'copy-observations',
        skillIdentity: 'skill://copy-observations',
        packageOrigin: 'test',
        interfaceRevision: '1',
        registeredGeneration: 'generation-1',
        exports: ['summarize'],
        source,
        sourceDigest: 'digest-copy-observations'
      }
      const scripts = [
        'label = "observations"',
        'first = summarize("inputs/observations.csv", "outputs/summary.csv")',
        'summarize: object',
        'second = summarize("outputs/summary.csv", "outputs/second.csv")'
      ]
      for (const precompute of [false, true]) {
        const context = await fileContext(
          'python',
          scripts,
          scripts.map(() => ({
            helperModules: [helper],
            helperEvidenceStatus: { state: 'complete' }
          })),
          precompute
        )
        expect(context?.pythonHelperModules).toContainEqual({ source, exports: ['summarize'] })
        expect(await analyzeNotebookSourceFileAccess('python', scripts[3]!, context)).toMatchObject(
          {
            reads: ['outputs/summary.csv'],
            writes: ['outputs/second.csv'],
            readState: 'partial',
            writeState: 'partial',
            externalState: 'partial'
          }
        )
        if (precompute) {
          const sidecar = JSON.parse(
            await readFile(
              join(
                roots.at(-1)!,
                'notebooks/default-project/session-1/cache/dependency-analysis.json'
              ),
              'utf8'
            )
          )
          expect(sidecar.runs['run-1'].fileAccess).toMatchObject({
            reads: ['inputs/observations.csv'],
            writes: ['outputs/summary.csv'],
            externalState: 'partial'
          })
          expect(sidecar.runs['run-3'].fileAccess).toMatchObject({
            reads: ['outputs/summary.csv'],
            writes: ['outputs/second.csv'],
            externalState: 'partial'
          })
        }
      }
    }
  )
})

describe('Python private helper wildcard imports', () => {
  const privateReader = 'def _read_inputs():\n    return open("old.csv")'
  const exportedReader = 'def read_inputs():\n    return _read_inputs()'
  const wildcard = 'from reader_override import *'
  const revokedHelpers = [
    ['module wildcard', `${privateReader}\n${wildcard}\n${exportedReader}`],
    ['conditional wildcard', `${privateReader}\nif True:\n    ${wildcard}\n${exportedReader}`],
    [
      'second wildcard after restoration',
      `${privateReader}\n${wildcard}\n${privateReader}\n${wildcard}\n${exportedReader}`
    ],
    [
      'nested private call chain',
      `${privateReader}\n${wildcard}\ndef _middle():\n    return _read_inputs()\ndef read_inputs():\n    return _middle()`
    ],
    [
      'annotation after wildcard',
      `${privateReader}\n${wildcard}\n_read_inputs: object\n${exportedReader}`
    ],
    [
      'explicit private import',
      `${privateReader}\nfrom reader_override import _read_inputs\n${exportedReader}`
    ],
    ['wildcard after export', `${privateReader}\n${exportedReader}\n${wildcard}`]
  ] as const
  const stableHelpers = [
    ['wildcard before private definition', `${wildcard}\n${privateReader}\n${exportedReader}`],
    [
      'private redefinition after wildcard',
      `${privateReader}\n${wildcard}\n${privateReader}\n${exportedReader}`
    ]
  ] as const
  const accessFor = (source: string): ReturnType<typeof analyzeNotebookSourceFileAccess> =>
    analyzeNotebookSourceFileAccess('python', 'handle = read_inputs()', {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [{ source, exports: ['read_inputs'] }]
    })

  it.each(revokedHelpers)(
    'rejects obsolete private reader I/O after %s',
    async (_label, source) => {
      const access = await accessFor(source)
      expect(access.reads).not.toContain('old.csv')
      expect(access.reads).not.toContain('new.csv')
      expect(access).toMatchObject({ readState: 'partial', externalState: 'partial' })
    }
  )

  it.each(stableHelpers)('retains stable private reader I/O after %s', async (_label, source) => {
    const access = await accessFor(source)
    expect(access.reads).toContain('old.csv')
    expect(access.reads).not.toContain('new.csv')
  })

  it.each([
    ...revokedHelpers.map(([label, source]) => [label, source, false] as const),
    ...stableHelpers.map(([label, source]) => [label, source, true] as const)
  ])('persists private helper wildcard boundaries for %s', async (_label, source, preserved) => {
    const helper = {
      helperId: 'private-wildcard-reader',
      skillIdentity: 'skill://private-wildcard-reader',
      packageOrigin: 'test',
      interfaceRevision: '1',
      registeredGeneration: 'generation-1',
      exports: ['read_inputs'],
      source,
      sourceDigest: 'digest-private-wildcard-reader'
    }
    const scripts = [
      'label = "measurements"',
      'handle = read_inputs()',
      'artifact_path = "outputs/summary.csv"',
      'with open(artifact_path, "w") as report:\n    report.write(label)'
    ]
    const parse = vi.spyOn(Parser.prototype, 'parse')
    for (const precompute of [false, true]) {
      await fileContext(
        'python',
        scripts,
        scripts.map(() => ({
          helperModules: [helper],
          helperEvidenceStatus: { state: 'complete' }
        })),
        precompute,
        undefined,
        'epoch-1',
        undefined,
        () => parse.mockClear()
      )
      if (precompute) expect(parse).not.toHaveBeenCalled()
      else expect(parse).toHaveBeenCalled()
      const sidecar = JSON.parse(
        await readFile(
          join(roots.at(-1)!, 'notebooks/default-project/session-1/cache/dependency-analysis.json'),
          'utf8'
        )
      )
      expect(Object.keys(sidecar.runs)).toHaveLength(4)
      const access = sidecar.runs['run-1'].fileAccess
      if (preserved) expect(access.reads).toContain('old.csv')
      else {
        expect(access.reads).not.toContain('old.csv')
        expect(access).toMatchObject({ readState: 'partial', externalState: 'partial' })
      }
      expect(access.reads).not.toContain('new.csv')
      expect(sidecar.runs['run-3'].fileAccess.writes).toContain('outputs/summary.csv')
    }
  })
})

describe('Python helper import-time path rebinding', () => {
  const reader = '\ndef read_inputs():\n    return open(INPUT_PATH)'
  const staleReaders = [
    ['opaque string', 'INPUT_PATH = "inputs/old.csv"\nINPUT_PATH = str("inputs/new.csv")' + reader],
    [
      'opaque sequence',
      'paths = ["inputs/old.csv"]\npaths = list(["inputs/new.csv"])\ndef read_inputs():\n    return open(paths[0])'
    ],
    [
      'opaque mapping',
      'paths = {"active": "inputs/old.csv"}\npaths = dict(active="inputs/new.csv")\ndef read_inputs():\n    return open(paths["active"])'
    ],
    [
      'starred unpack',
      'INPUT_PATH = "inputs/old.csv"\nINPUT_PATH, *rest = list(["inputs/new.csv", "extra"])' +
        reader
    ],
    [
      'positional eager default',
      'INPUT_PATH = "inputs/old.csv"\ndef configure(value=(INPUT_PATH := "inputs/new.csv")):\n    pass' +
        reader
    ],
    [
      'keyword eager default',
      'INPUT_PATH = "inputs/old.csv"\ndef configure(*, value=(INPUT_PATH := "inputs/new.csv")):\n    pass' +
        reader
    ],
    [
      'lambda eager default',
      'INPUT_PATH = "inputs/old.csv"\nconfigure = lambda value=(INPUT_PATH := str("inputs/new.csv")): None' +
        reader
    ],
    [
      'existing collection alias',
      'paths = ["inputs/old.csv"]\nalias = paths\npaths = list(["inputs/new.csv"])\ndef read_inputs():\n    return open(alias[0])'
    ],
    [
      'mapping receiver mutation',
      'config = {"input": "inputs/old.csv"}\nconfig.update(input="inputs/new.csv")\ndef read_inputs():\n    return open(config["input"])'
    ],
    [
      'aliased mapping receiver mutation',
      'config = {"input": "inputs/old.csv"}\nalias = config\nalias.update(input="inputs/new.csv")\ndef read_inputs():\n    return open(config["input"])'
    ],
    [
      'conditional mapping alias receiver mutation',
      'config = {"input": "inputs/old.csv"}\nif True:\n    alias = config\nalias.update(input="inputs/new.csv")\ndef read_inputs():\n    return open(config["input"])'
    ],
    [
      'sequence receiver mutation',
      'paths = ["inputs/old.csv"]\npaths.__setitem__(0, "inputs/new.csv")\ndef read_inputs():\n    return open(paths[0])'
    ],
    [
      'opaque subscript mutation',
      'paths = ["inputs/old.csv"]\npaths[0] = str("inputs/new.csv")\ndef read_inputs():\n    return open(paths[0])'
    ],
    [
      'aliased opaque subscript mutation',
      'paths = ["inputs/old.csv"]\nalias = paths\nalias[0] = str("inputs/new.csv")\ndef read_inputs():\n    return open(paths[0])'
    ],
    [
      'eager default receiver mutation',
      'config = {"input": "inputs/old.csv"}\ndef configure(value=config.update(input="inputs/new.csv")):\n    pass\ndef read_inputs():\n    return open(config["input"])'
    ],
    [
      'eager comprehension receiver mutation',
      'config = {"input": "inputs/old.csv"}\nconfigure = [config.update(input="inputs/new.csv") for _ in [0]]\ndef read_inputs():\n    return open(config["input"])'
    ],
    [
      'generator first iterable mutation',
      'config = {"input": "inputs/old.csv"}\nconfigure = (item for item in config.pop("input"))\ndef read_inputs():\n    return open(config["input"])'
    ],
    [
      'comprehension iterable before local target',
      'config = {"input": "inputs/old.csv"}\nconfigure = [config for config in [config.pop("input")]]\ndef read_inputs():\n    return open(config["input"])'
    ]
  ] as const
  const stableReaders = [
    [
      'unrelated opaque assignment',
      'INPUT_PATH = "inputs/old.csv"\nlabel = str("calibration")' + reader,
      'inputs/old.csv'
    ],
    [
      'later literal restoration',
      'INPUT_PATH = "inputs/old.csv"\nINPUT_PATH = str("inputs/new.csv")\nINPUT_PATH = "inputs/final.csv"' +
        reader,
      'inputs/final.csv'
    ],
    [
      'annotation without assignment',
      'INPUT_PATH = "inputs/old.csv"\nINPUT_PATH: str("annotation")' + reader,
      'inputs/old.csv'
    ],
    [
      'deferred lambda body',
      'INPUT_PATH = "inputs/old.csv"\ndef configure(value=lambda: (INPUT_PATH := str("inputs/new.csv"))):\n    pass' +
        reader,
      'inputs/old.csv'
    ],
    [
      'comprehension local target',
      'INPUT_PATH = "inputs/old.csv"\ndef configure(value=[0 for INPUT_PATH in ["inputs/new.csv"]]):\n    pass' +
        reader,
      'inputs/old.csv'
    ],
    [
      'stable mapping',
      'config = {"input": "inputs/old.csv"}\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ],
    [
      'unrelated receiver mutation',
      'config = {"input": "inputs/old.csv"}\nunused = ["ignored"]\nunused.__setitem__(0, "updated")\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ],
    [
      'deferred container mutation',
      'config = {"input": "inputs/old.csv"}\ndef configure():\n    config.update(input="inputs/new.csv")\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ],
    [
      'existing literal sequence mutation',
      'paths = ["inputs/old.csv"]\npaths[0] = "inputs/new.csv"\ndef read_inputs():\n    return open(paths[0])',
      undefined
    ],
    [
      'existing literal mapping mutation',
      'config = {"input": "inputs/old.csv"}\nconfig["input"] = "inputs/new.csv"\ndef read_inputs():\n    return open(config["input"])',
      undefined
    ],
    [
      'deferred generator body mutation',
      'config = {"input": "inputs/old.csv"}\ndef configure(value=(config.update(input="inputs/new.csv") for _ in [0])):\n    pass\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ],
    [
      'comprehension-local receiver mutation',
      'config = {"input": "inputs/old.csv"}\nconfigure = [config.update(input="inputs/new.csv") for config in [{"input": "ignored"}]]\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ],
    [
      'deferred lambda container mutation',
      'config = {"input": "inputs/old.csv"}\nconfigure = lambda: config.update(input="inputs/new.csv")\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ],
    [
      'deferred generator filter mutation',
      'config = {"input": "inputs/old.csv"}\nconfigure = (item for item in [0] if config.pop("input"))\ndef read_inputs():\n    return open(config["input"])',
      'inputs/old.csv'
    ]
  ] as const
  const helperContext = (
    source: string,
    exportedName = 'read_inputs'
  ): NotebookSourceFileAccessContext => ({
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    pythonHelperModules: [{ source, exports: [exportedName] }]
  })

  it.each(staleReaders)(
    'revokes an import-time %s path without certifying its replacement',
    async (_label, source) => {
      const access = await analyzeNotebookSourceFileAccess(
        'python',
        'handle = read_inputs()',
        helperContext(source)
      )
      expect(access).toMatchObject({
        reads: [],
        writes: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each(stableReaders)(
    'preserves existing path resolution after %s',
    async (_label, source, path) => {
      const access = await analyzeNotebookSourceFileAccess(
        'python',
        'handle = read_inputs()',
        helperContext(source)
      )
      expect(access.reads).toEqual(path ? [path] : [])
      expect(access.writes).toEqual([])
      if (!path) expect(access).toMatchObject({ readState: 'partial', externalState: 'partial' })
    }
  )

  it('revokes an opaque import-time writer path', async () => {
    const source =
      'OUTPUT_PATH = "outputs/old.csv"\nOUTPUT_PATH = str("outputs/new.csv")\ndef write_result():\n    return open(OUTPUT_PATH, "w")'
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'handle = write_result()',
        helperContext(source, 'write_result')
      )
    ).toMatchObject({
      reads: [],
      writes: [],
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('revokes a mutated import-time output container path', async () => {
    const source =
      'paths = ["outputs/old.csv"]\npaths.__setitem__(0, "outputs/new.csv")\ndef write_result():\n    return open(paths[0], "w")'
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'handle = write_result()',
        helperContext(source, 'write_result')
      )
    ).toMatchObject({
      reads: [],
      writes: [],
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    ...staleReaders.map(([label, source]) => [label, source, undefined, 'partial'] as const),
    [...stableReaders[0], 'partial'] as const,
    [...stableReaders[1], 'partial'] as const,
    ...stableReaders
      .slice(5)
      .map(
        ([label, source, path]) =>
          [
            label,
            source,
            path,
            [
              'stable mapping',
              'deferred container mutation',
              'deferred lambda container mutation'
            ].includes(label)
              ? 'complete'
              : 'partial'
          ] as const
      )
  ])(
    'retains the %s boundary across four cells and warm cache reload',
    async (_label, source, expectedPath, expectedReadState) => {
      const helper = {
        helperId: 'import-time-reader',
        skillIdentity: 'skill://import-time-reader',
        packageOrigin: 'test',
        interfaceRevision: '1',
        registeredGeneration: 'generation-1',
        exports: ['read_inputs'],
        source,
        sourceDigest: 'digest-import-time-reader'
      }
      const scripts = [
        'label = "measurements"',
        'handle = read_inputs()',
        'artifact_path = "outputs/summary.csv"',
        'with open(artifact_path, "w") as report:\n    report.write(label)'
      ]
      const overrides = scripts.map(() => ({
        helperModules: [helper],
        helperEvidenceStatus: { state: 'complete' as const }
      }))
      await fileContext('python', scripts, overrides)
      const storageRoot = roots.at(-1)!
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-1'].fileAccess.reads).toEqual(expectedPath ? [expectedPath] : [])
      expect(cold.runs['run-1'].fileAccess).toMatchObject({
        readState: expectedReadState,
        ...(expectedReadState === 'partial' ? { externalState: 'partial' } : {})
      })
      expect(cold.runs['run-3'].fileAccess.writes).toEqual(['outputs/summary.csv'])
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: 'run-' + index,
        cellId: 'cell-' + index,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'python',
        kernelEpochId: 'epoch-1',
        environment: 'default-python',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: [],
        ...overrides[index]
      }))
      const parse = vi.spyOn(Parser.prototype, 'parse')
      await new NotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => runs }
      }).project({
        projectId: 'default-project',
        sessionId: 'session-1'
      })
      expect(parse).not.toHaveBeenCalled()
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
    }
  )
})

describe('Python prior callable write coverage', () => {
  const writer = `config = {"prefix": "baseline"}
def emit(configuration):
    path = "outputs/" + configuration["prefix"] + ".csv"
    with open(path, "w") as target:
        target.write("value\\n1\\n")`
  // Handwritten historical-analysis fixtures, not provider or native execution evidence.
  const syntheticNotebookRunRecord = (script: string, index: number): NotebookRunRecord => ({
    runId: `run-${index}`,
    cellId: `cell-${index}`,
    source: 'agent',
    inputKind: 'cell',
    kernelKind: 'python',
    kernelEpochId: 'epoch-1',
    environment: 'default-python',
    script,
    status: 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index,
    executionCount: index,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    inputFiles: []
  })

  it.each([
    ['named writer without mutation', '', 'emit(config)', []],
    [
      'prior alias after configuration mutation',
      '\nhandle = emit',
      'config["prefix"] = "hann"\nhandle(config)',
      []
    ],
    [
      'opaque alias with a visible literal write',
      '\nhandle = emit',
      'config["prefix"] = "hann"\nhandle(config)\nwith open("outputs/visible.csv", "w") as target:\n    target.write("value\\n1\\n")',
      ['outputs/visible.csv']
    ]
  ] as const)(
    'keeps %s write coverage partial across cold analysis and warm cache reload',
    async (_label, alias, call, expectedWrites) => {
      const scripts = [
        writer + alias,
        call,
        'audit_label = "handwritten-analysis"',
        'assert audit_label == "handwritten-analysis"'
      ]
      const runs = scripts.map(syntheticNotebookRunRecord)
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-callable-write-'))
      roots.push(storageRoot)
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      const runIds = runs.map(({ runId }) => runId)
      expect(Object.keys(cold.runs).sort()).toEqual(runIds)
      expect(Object.keys(coldProjection.stalenessByRunId).sort()).toEqual(runIds)
      const access = cold.runs['run-1'].fileAccess
      expect(access).toMatchObject({
        writeState: 'partial',
        externalState: 'partial',
        reads: [],
        writes: expectedWrites
      })
      expect(access.reasonCodes).toContain('source-analysis-unsupported-call')
      expect(access.writes).not.toContain('outputs/baseline.csv')
      expect(access.writes).not.toContain('outputs/hann.csv')
      const context = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).sourceFileAccessContext({
        ...request,
        currentRunId: 'run-1',
        language: 'python',
        environment: 'default-python',
        kernelEpochId: 'epoch-1'
      })
      expect(await analyzeNotebookSourceFileAccess('python', call, context)).toEqual(access)

      const parse = vi.spyOn(Parser.prototype, 'parse')
      const warmProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      expect(parse).not.toHaveBeenCalled()
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      expect(warmProjection).toEqual(coldProjection)
    }
  )
})

describe('R wrapper identities across cached cells', () => {
  it.each([
    [
      'rebound-global',
      'write.csv <- base::list',
      'write.csv("payload", "inputs/observations.csv")',
      []
    ],
    [
      'formal-shadow',
      'emit <- function(x, file, write.csv) write.csv(x, file)',
      'emit("payload", "inputs/observations.csv", base::list)',
      []
    ],
    [
      'nested-input',
      'label <- "observations"',
      'utils::write.csv(utils::read.csv("inputs/observations.csv"), "inputs/observations.csv")',
      ['inputs/observations.csv']
    ]
  ])(
    'preserves corrected %s lineage through cold and warm caches',
    async (_name, setup, call, writes) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      const scripts = [setup, `${call}\nutils::read.csv("inputs/observations.csv")`]
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: 'run-' + index,
        cellId: 'cell-' + index,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'r',
        kernelEpochId: 'epoch-1',
        environment: 'default-r',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }))
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-0'].fileContext.localFileWrappers).not.toContainEqual(
        expect.objectContaining({ name: 'emit' })
      )
      expect(cold.runs['run-1'].fileAccess.reads).toEqual(['inputs/observations.csv'])
      expect(cold.runs['run-1'].fileAccess.writes).toEqual(writes)
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const warmAnalyzer = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warmAnalyzer.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warmAnalyzer.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-1',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', scripts[1], context)).toMatchObject({
        reads: ['inputs/observations.csv'],
        writes
      })
    }
  )

  it.each(['write.csv', 'write.csv2', 'write.table'])(
    'preserves reordered %s helper destinations through cold and warm caches',
    async (writer) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      const scripts = [
        `emit <- function(x,file) utils::${writer}(row.names=FALSE,x,file)`,
        'emit("inputs/decoy.csv","outputs/actual.csv")',
        'utils::read.csv("inputs/decoy.csv")',
        'utils::read.csv("outputs/actual.csv")'
      ]
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: 'run-' + index,
        cellId: 'cell-' + index,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'r',
        kernelEpochId: 'epoch-1',
        environment: 'default-r',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }))
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-0'].fileContext.localFileWrappers).toContainEqual(
        expect.objectContaining({ name: 'emit', position: 1, keywords: ['file'] })
      )
      expect(cold.runs['run-1'].fileAccess.writes).toEqual(['outputs/actual.csv'])
      expect(cold.runs['run-2'].fileAccess.reads).toEqual(['inputs/decoy.csv'])
      expect(cold.runs['run-3'].fileAccess.reads).toEqual(['outputs/actual.csv'])
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const warmAnalyzer = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warmAnalyzer.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warmAnalyzer.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-1',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      expect(parse).not.toHaveBeenCalled()
      expect(await analyzeNotebookSourceFileAccess('r', scripts[1], context)).toMatchObject({
        writes: ['outputs/actual.csv']
      })
    }
  )

  it.each([
    [
      'reader <- function(file="") utils::read.csv(file=file)\nalias <- reader\nalias(file="inputs/observations.csv")',
      ['inputs/observations.csv'],
      []
    ],
    [
      'writer <- function(x,file="") utils::write.csv(x,file=file,row.names=FALSE)\nalias <- writer\nalias(1,file="outputs/summary.csv")',
      [],
      ['outputs/summary.csv']
    ]
  ])(
    'retains same-cell alias paths in a warm cache without exporting their authority: %s',
    async (source, reads, writes) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-file-context-'))
      roots.push(storageRoot)
      const scripts = [source, 'alias(file="unproved.csv")']
      const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
        runId: 'run-' + index,
        cellId: 'cell-' + index,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'r',
        kernelEpochId: 'epoch-1',
        environment: 'default-r',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        executionCount: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }))
      const repository = { readSessionRuns: async () => runs }
      const request = { projectId: 'default-project', sessionId: 'session-1' }
      const coldProjection = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository
      }).project(request)
      const cachePath = join(
        storageRoot,
        'notebooks/default-project/session-1/cache/dependency-analysis.json'
      )
      const cold = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(cold.runs['run-0'].fileAccess).toMatchObject({
        reads,
        writes,
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      expect(cold.runs['run-0'].facts.state).toBe('unknown')
      expect(cold.runs['run-0'].fileContext.localFileWrappers).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'alias' })])
      )
      expect(cold.runs['run-1'].fileAccess).toMatchObject({
        reads: [],
        writes: [],
        readState: 'partial',
        writeState: 'partial'
      })
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const warmAnalyzer = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(await warmAnalyzer.project(request)).toEqual(coldProjection)
      expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
      const context = await warmAnalyzer.sourceFileAccessContext({
        ...request,
        currentRunId: 'next-run',
        language: 'r',
        environment: 'default-r',
        kernelEpochId: 'epoch-1'
      })
      expect(context?.localFileWrappers ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'alias' })])
      )
      expect(parse).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['function redefinition', 'reader <- function(path) NULL', 'complete'],
    ['ordinary assignment', 'reader <- identity', 'partial'],
    ['body replacement', 'body(reader) <- quote(NULL)', 'partial'],
    ['formals replacement', 'formals(reader) <- pairlist(path=NULL)', 'partial']
  ])('does not replay a prior reader after %s', async (_label, replacement, readState) => {
    const scripts = [
      'reader <- function(path) utils::read.csv(path)',
      'before <- reader("inputs/obsolete.csv")\n' + replacement,
      'after <- reader("inputs/actual.csv")',
      'base::writeLines("verified", con="outputs/summary.txt")'
    ]
    const context = await fileContext('r', scripts)
    const storageRoot = roots.at(-1)!
    const cachePath = join(
      storageRoot,
      'notebooks/default-project/session-1/cache/dependency-analysis.json'
    )
    const cold = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(cold.runs['run-1'].fileAccess.reads).toEqual(['inputs/obsolete.csv'])
    expect(cold.runs['run-2'].fileAccess.reads).toEqual([])
    expect(cold.runs['run-2'].fileAccess.readState).toBe(readState)
    expect(cold.runs['run-3'].fileAccess.writes).toEqual(['outputs/summary.txt'])
    expect(context?.localFileWrappers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'reader' })])
    )
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: 'run-' + index,
      cellId: 'cell-' + index,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'r',
      kernelEpochId: 'epoch-1',
      environment: 'default-r',
      script,
      status: 'completed',
      startedAt: index,
      endedAt: index,
      executionCount: index,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: []
    }))
    const parse = vi.spyOn(Parser.prototype, 'parse')
    await new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: async () => runs }
    }).project({
      projectId: 'default-project',
      sessionId: 'session-1'
    })
    expect(parse).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(cachePath, 'utf8')).runs).toEqual(cold.runs)
  })

  it('keeps ambiguous cached wrapper arguments partial while retaining exact names', async () => {
    const scripts = [
      'reader <- function(unused, path, last) utils::read.csv(path)',
      'result <- reader(last=0, "inputs/decoy.csv", "inputs/actual.csv")',
      'result <- reader(path="inputs/actual.csv", last=0, unused=0)',
      'base::writeLines("verified", con="outputs/summary.txt")'
    ]
    await fileContext('r', scripts)
    const sidecar = JSON.parse(
      await readFile(
        join(roots.at(-1)!, 'notebooks/default-project/session-1/cache/dependency-analysis.json'),
        'utf8'
      )
    )
    expect(sidecar.runs['run-1'].fileAccess).toMatchObject({ reads: [], readState: 'partial' })
    expect(sidecar.runs['run-2'].fileAccess.reads).toEqual(['inputs/actual.csv'])
    expect(sidecar.runs['run-3'].fileAccess.writes).toEqual(['outputs/summary.txt'])
  })

  it('exports a later stable wrapper after replacement', async () => {
    const context = await fileContext('r', [
      'reader <- function(path) utils::read.csv(path)',
      'reader <- identity',
      'reader <- function(path) utils::read.csv(path)',
      'label <- "measurements"'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('r', 'reader("inputs/restored.csv")', context)
    ).toMatchObject({
      reads: ['inputs/restored.csv']
    })
  })
})

describe('Python lambda creation file access', () => {
  it.each([
    'reader = lambda value, calibration=open("calibration.txt").read(): value',
    'reader = lambda value, *, required, calibration=open("calibration.txt").read(): value',
    'reader = lambda open=open("calibration.txt").read(): open',
    'reader = lambda nested=(lambda value=open("calibration.txt").read(): open("inner-body.csv")): open("outer-body.csv")',
    'from numpy import genfromtxt as reader\nreader = lambda value=reader("calibration.txt"): value',
    'path = "calibration.txt"\npath = lambda value=open(path).read(): value'
  ])('captures ordinary eager defaults before binding lambda parameters: %s', async (source) => {
    const access = await analyzeNotebookSourceFileAccess('python', source)
    expect(access.reads).toEqual(['calibration.txt'])
    expect(access.writes).toEqual([])
  })

  it('does not capture I/O from a lambda body that has not been called', async () => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      'reader = lambda value: open("deferred-input.csv").read() + open("deferred-output.csv", "w").write(value)'
    )
    expect(access.reads).toEqual([])
    expect(access.writes).toEqual([])
  })

  it('retains eager inputs without certifying an invoked reader callback body', async () => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      'import numpy as np\ndata = np.genfromtxt("observations.csv", converters={4: lambda value, calibration=open("calibration.txt").read(): float(open("callback-private.txt").read())})'
    )
    expect(access).toMatchObject({
      reads: ['calibration.txt', 'observations.csv'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    '[open("comprehension.csv") for index in range(2)]',
    '{open("comprehension.csv") for index in range(2)}',
    '{index: open("comprehension.csv") for index in range(2)}',
    '(open("comprehension.csv") for index in range(2))'
  ])('keeps comprehension and generator defaults conservatively partial: %s', async (value) => {
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      `reader = lambda value=${value}: open("deferred-input.csv")`
    )
    expect(access).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('uses restored outer path bindings for an eager default without capturing its body', async () => {
    const context = await fileContext('python', ['calibration_path = "calibration.txt"'])
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      'reader = lambda calibration_path=open(calibration_path).read(): open("deferred-input.csv")',
      context
    )
    expect(access.reads).toEqual(['calibration.txt'])
    expect(access.writes).toEqual([])
  })
})

describe('Python function definition defaults in persisted file context', () => {
  it('retains an eager default input without replaying the function body', async () => {
    const context = await fileContext('python', [
      'def reader(value, calibration=open("calibration.txt").read()):\n    return value'
    ])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      'def later(value):\n    return open("deferred.csv").read()\nresult = 1',
      context
    )
    expect(result.reads).toEqual([])
    expect(result.writes).toEqual([])
  })
})

describe('BFGS same-cell authority after cache reload', () => {
  it.each([
    'objective <- function(beta) beta - FN_ONLY\ngradient <- function(beta) beta - GR_ONLY',
    'objective <- function(beta) { n <<- n + 1L; sum(X %*% beta) + FN_ONLY }\n' +
      'gradient <- function(beta) { m <<- m + 1L; t(X) %*% beta + GR_ONLY }\n' +
      'fit <- stats::optim(0, objective, gradient, method="BFGS")'
  ])('does not restore invocation-local captures from stored summaries: %s', async (producer) => {
    const context = await fileContext('r', [producer])
    const result = await analyzeRNotebookSource(
      'data <- utils::read.csv("inputs/observations.csv")\n' +
        'fit <- stats::optim(0, objective, gradient, method="BFGS")',
      context
    )
    for (const name of ['FN_ONLY', 'GR_ONLY', 'X'])
      expect(result.facts.usedNames ?? []).not.toContain(name)
    expect(result.facts.state).toBe('unknown')
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'data <- utils::read.csv("inputs/observations.csv")\n' +
          'fit <- stats::optim(0, objective, gradient, method="BFGS")',
        context
      )
    ).toMatchObject({
      reads: ['inputs/observations.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })
})

describe('minimize callback file certainty after cache reload', () => {
  it.each([
    ['from scipy.optimize import minimize as solve', 'solve(fun=objective, x0=p0, jac=gradient)'],
    ['import scipy.optimize as opt', 'opt.minimize(objective, p0, (), "BFGS", gradient)']
  ])(
    'retains direct file candidates without certifying callback I/O: %s',
    async (imports, call) => {
      const context = await fileContext('python', [
        `${imports}\np0 = [0.]\nobjective_gain = 0.2\ngradient_gain = 0.4`,
        'def objective(beta):\n    return beta[0] * objective_gain + float(open("callback-input.txt").read())\ndef gradient(beta):\n    open("callback-trace.txt", "w").write(str(beta))\n    return [gradient_gain]'
      ])
      const access = await analyzeNotebookSourceFileAccess(
        'python',
        `with open("direct-input.csv", "r") as handle:\n    observed = handle.read()\nfit = ${call}`,
        context
      )
      expect(access.reads).toContain('direct-input.csv')
      expect(access).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial',
        reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
      })
    }
  )
})

describe('NumPy text converters after cache reload', () => {
  it.each([
    'np.loadtxt("observations.csv", converters=convert)',
    'np.loadtxt("observations.csv", converters={1: convert})',
    'np.loadtxt("observations.csv", float, "#", ",", {1: convert})',
    'np.genfromtxt("observations.csv", converters={1: convert})',
    'np.genfromtxt("observations.csv", float, "#", ",", 0, 0, {1: convert})'
  ])('retains the reader input without certifying converter I/O: %s', async (call) => {
    const context = await fileContext('python', [
      'import numpy as np\ncalibration = 1.0',
      'def convert(value):\n    with open("callback-input.txt") as handle:\n        return float(value) * calibration * float(handle.read())'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('python', `rows = ${call}`, context)
    ).toMatchObject({
      reads: ['observations.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it.each([
    'np.loadtxt("observations.csv")',
    'np.loadtxt("observations.csv", converters=None)',
    'np.loadtxt("observations.csv", converters={})',
    'np.loadtxt("observations.csv", float, "#", ",", None)',
    'np.genfromtxt("observations.csv")',
    'np.genfromtxt("observations.csv", converters=None)',
    'np.genfromtxt("observations.csv", converters={})',
    'np.genfromtxt("observations.csv", float, "#", ",", 0, 0, {})'
  ])('preserves complete ordinary reader coverage: %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', `import numpy as np\nrows = ${call}`)
    ).toMatchObject({
      reads: ['observations.csv'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it.each([
    'np.loadtxt("observations.csv", converters=callbacks)',
    'np.loadtxt("observations.csv", converters={**options})',
    'np.loadtxt("observations.csv", converters=None, **options)',
    'np.loadtxt("observations.csv", float, "#", ",", convert, converters=None)',
    'np.loadtxt("observations.csv", *args)',
    'np.genfromtxt("observations.csv", **options)'
  ])('does not certify unresolved or expanded converters: %s', async (call) => {
    const context = await fileContext('python', [
      'import numpy as np\ndef convert(value):\n    return float(value)',
      'callbacks = {1: convert}\noptions = {}\nargs = []'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('python', `rows = ${call}`, context)
    ).toMatchObject({
      reads: ['observations.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('recognizes an imported reader alias without borrowing complete callback coverage', async () => {
    const context = await fileContext('python', [
      'from numpy import loadtxt as reader',
      'def convert(value):\n    return float(value) * calibration'
    ])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'rows = reader("observations.csv", converters={1: convert})',
        context
      )
    ).toMatchObject({
      reads: ['observations.csv'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    ['from numpy import loadtxt as reader', 'reader = replacement', 'reader'],
    ['import numpy as np', 'np.loadtxt = replacement', 'np.loadtxt']
  ])('does not borrow a rebound reader identity: %s', async (imports, rebind, reader) => {
    const context = await fileContext('python', [
      imports,
      'def replacement(*args, **kwargs):\n    return None\ndef convert(value):\n    return float(value) * calibration',
      rebind
    ])
    const access = await analyzeNotebookSourceFileAccess(
      'python',
      `rows = ${reader}("observations.csv", converters={1: convert})`,
      context
    )
    expect(access.reads).not.toContain('observations.csv')
    // The replacement is a closed helper returning None. Its own evidence can
    // be complete; the displaced NumPy reader must not contribute a file path.
    expect(access.writes).toEqual([])
  })
})

describe('SQLite readonly historical file context', () => {
  const setup = [
    'import sqlite3',
    'conn = sqlite3.connect("file:inputs/co2.sqlite?mode=ro", uri=True)',
    'cur = conn.cursor()'
  ].join('\n')
  const select =
    'cur.execute("SELECT row_id, uptake FROM observations WHERE conc >= ? ORDER BY row_id", (500,))\nrows = cur.fetchall()'
  const cwd = join(tmpdir(), 'sqlite-readonly-owner')

  it('retains the SQLite database input through three trustworthy cells and cache reload', async () => {
    const context = await fileContext(
      'python',
      [setup, select, select],
      Array.from({ length: 3 }, () => ({ cwdBefore: cwd, cwdAfter: cwd })),
      true,
      undefined,
      'epoch-1',
      { cwdBefore: cwd, cwdAfter: cwd }
    )
    expect(context?.pythonBindings).toEqual(
      expect.arrayContaining([
        {
          name: 'conn',
          qualifiedName: 'sqlite3.Connection',
          kind: 'object',
          filePath: 'inputs/co2.sqlite'
        },
        {
          name: 'cur',
          qualifiedName: 'sqlite3.Cursor',
          kind: 'object',
          filePath: 'inputs/co2.sqlite'
        }
      ])
    )
    expect(await analyzeNotebookSourceFileAccess('python', select, context)).toMatchObject({
      reads: ['inputs/co2.sqlite'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('establishes a literal SQLite connection from a still-trusted earlier import', async () => {
    const context = await fileContext(
      'python',
      ['import sqlite3', setup.replace('import sqlite3\n', '')],
      Array.from({ length: 2 }, () => ({ cwdBefore: cwd, cwdAfter: cwd })),
      true,
      undefined,
      'epoch-1',
      { cwdBefore: cwd, cwdAfter: cwd }
    )
    expect(await analyzeNotebookSourceFileAccess('python', select, context)).toMatchObject({
      reads: ['inputs/co2.sqlite'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not retain a SQLite input after a converter rebinds its cursor across cache reload', async () => {
    const converter = [
      'import pandas as pd',
      'def convert(value):',
      '    global cur',
      '    cur = sqlite3.connect("file:inputs/replacement.sqlite?mode=ro", uri=True).cursor()',
      '    return value',
      'pd.read_csv("inputs/values.csv", converters={"value": convert})'
    ].join('\n')
    const context = await fileContext(
      'python',
      [setup, converter, select],
      Array.from({ length: 3 }, () => ({ cwdBefore: cwd, cwdAfter: cwd })),
      true,
      undefined,
      'epoch-1',
      { cwdBefore: cwd, cwdAfter: cwd }
    )
    expect(await analyzeNotebookSourceFileAccess('python', select, context)).toMatchObject({
      reads: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    ['missing current cwd', {}, { cwdBefore: undefined, cwdAfter: undefined }],
    ['missing current run', {}, undefined],
    ['changed current cwd', {}, { cwdBefore: `${cwd}-other`, cwdAfter: `${cwd}-other` }],
    ['missing historical cwd', { cwdBefore: undefined }, { cwdBefore: cwd, cwdAfter: cwd }],
    [
      'changed then restored cwd',
      { script: 'import os\nos.chdir("elsewhere")\nos.chdir("..")' },
      { cwdBefore: cwd, cwdAfter: cwd }
    ],
    [
      'current cwd mutation',
      {},
      { cwdBefore: cwd, cwdAfter: cwd, script: 'import os\nos.chdir("elsewhere")\nos.chdir("..")' }
    ]
  ] as Array<[string, Partial<NotebookRunRecord>, Partial<NotebookRunRecord> | undefined]>)(
    'discards relative SQLite authority after %s',
    async (_label, historical, current) => {
      const context = await fileContext(
        'python',
        [setup, select],
        [
          { cwdBefore: cwd, cwdAfter: cwd },
          { cwdBefore: cwd, cwdAfter: cwd, ...historical }
        ],
        true,
        undefined,
        'epoch-1',
        current
      )
      expect(context?.pythonBindings?.filter(({ filePath }) => filePath !== undefined)).toEqual([])
      expect(await analyzeNotebookSourceFileAccess('python', select, context)).toMatchObject({
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('does not recover SQLite authority across an opaque historical call', async () => {
    const context = await fileContext(
      'python',
      [setup, 'unknown(conn)', select],
      Array.from({ length: 3 }, () => ({ cwdBefore: cwd, cwdAfter: cwd })),
      true,
      undefined,
      'epoch-1',
      { cwdBefore: cwd, cwdAfter: cwd }
    )
    expect(context?.pythonBindings?.some(({ filePath }) => filePath !== undefined)).toBeFalsy()
    expect(await analyzeNotebookSourceFileAccess('python', select, context)).toMatchObject({
      reads: [],
      readState: 'partial'
    })
  })

  it.each([
    'duplicate identity',
    'oversized path',
    'import path',
    'NUL path',
    'backslash path'
  ] as const)('rebuilds a malformed SQLite cache entry with %s', async (kind) => {
    const context = await fileContext(
      'python',
      [setup, select],
      Array.from({ length: 2 }, () => ({ cwdBefore: cwd, cwdAfter: cwd })),
      true,
      (json) => {
        const cache = JSON.parse(json)
        let corruptedEntries = 0
        for (const run of Object.values(cache.runs) as Array<{
          fileContext?: NotebookSourceFileAccessContext
        }>) {
          const bindings = run.fileContext?.pythonBindings
          const binding = bindings?.find(({ name }) => name === 'cur')
          if (!binding) continue
          corruptedEntries++
          if (kind === 'duplicate identity') bindings!.push({ ...binding })
          if (kind === 'oversized path') binding.filePath = 'x'.repeat(4097)
          if (kind === 'import path') {
            binding.kind = 'import'
            binding.filePath = 'inputs/co2.sqlite'
          }
          if (kind === 'NUL path') binding.filePath = 'inputs/invalid\0.sqlite'
          if (kind === 'backslash path') binding.filePath = 'inputs\\co2.sqlite'
        }
        expect(corruptedEntries).toBeGreaterThan(0)
        return JSON.stringify(cache)
      },
      'epoch-1',
      { cwdBefore: cwd, cwdAfter: cwd }
    )
    expect(await analyzeNotebookSourceFileAccess('python', select, context)).toMatchObject({
      reads: ['inputs/co2.sqlite'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  const literalConnection = (path = 'inputs/co2.sqlite'): FileContextEntry => ({
    facts: {
      state: 'available',
      definedNames: ['sqlite3', 'conn'],
      usedNames: ['sqlite3'],
      mutatedNames: [],
      typeBindings: [{ target: 'conn', typeName: 'sqlite3.Connection' }],
      receiverCalls: [
        {
          receiver: 'sqlite3',
          member: 'connect',
          kind: 'receiver',
          argumentNames: [],
          positionalArgumentNames: [[]],
          receiverChain: [],
          keywordArguments: [{ name: 'uri', argumentNames: [], staticBoolean: true }],
          resultNames: ['conn']
        }
      ]
    },
    fileContext: {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonBindings: [
        { name: 'sqlite3', qualifiedName: 'sqlite3', kind: 'import' },
        { name: 'conn', qualifiedName: 'sqlite3.Connection', kind: 'object', filePath: path }
      ]
    }
  })

  it('rejects a cached fresh SQLite cursor whose actual receiver lost its path', () => {
    const initial = literalConnection()
    const barrier: FileContextEntry = {
      ...initial,
      facts: { state: 'available', definedNames: [], usedNames: [], mutatedNames: [] },
      sqliteRelativePathBarrier: true
    }
    const cursor: FileContextEntry = {
      facts: {
        state: 'available',
        definedNames: ['cur2'],
        usedNames: ['conn'],
        mutatedNames: [],
        typeBindings: [{ target: 'cur2', typeName: 'sqlite3.Cursor' }],
        receiverCalls: [
          {
            receiver: 'conn',
            member: 'cursor',
            kind: 'receiver',
            argumentNames: [],
            positionalArgumentNames: [],
            keywordArguments: [],
            receiverChain: [],
            resultNames: ['cur2']
          }
        ]
      },
      fileContext: {
        ...initial.fileContext,
        pythonBindings: [
          ...initial.fileContext.pythonBindings!,
          {
            name: 'cur2',
            qualifiedName: 'sqlite3.Cursor',
            kind: 'object',
            filePath: 'inputs/co2.sqlite'
          }
        ]
      }
    }
    const context = projectNotebookFileContext('python', [initial, barrier, cursor])
    expect(context?.pythonBindings?.find(({ name }) => name === 'cur2')).toEqual({
      name: 'cur2',
      qualifiedName: 'sqlite3.Cursor',
      kind: 'object'
    })
  })

  it('rejects a cached fresh SQLite constructor derived from an inherited URI', () => {
    const constructor = literalConnection()
    constructor.facts.receiverCalls![0]!.argumentNames = ['uri']
    constructor.facts.receiverCalls![0]!.positionalArgumentNames = [['uri']]
    const context = projectNotebookFileContext('python', [
      {
        facts: { state: 'available', definedNames: ['uri'], usedNames: [], mutatedNames: [] },
        fileContext: {
          staticStrings: [{ name: 'uri', value: 'file:inputs/changed.sqlite?mode=ro' }],
          staticCollections: [],
          localFileWrappers: []
        }
      },
      constructor
    ])
    expect(context?.pythonBindings?.find(({ name }) => name === 'conn')).toEqual({
      name: 'conn',
      qualifiedName: 'sqlite3.Connection',
      kind: 'object'
    })
  })

  it.each(['cursor after cwd restoration', 'constructor after URI replacement'] as const)(
    'rejects cached fresh SQLite authority through the public owner: %s',
    async (kind) => {
      const scripts =
        kind === 'cursor after cwd restoration'
          ? [setup, 'print(1)', 'cur2 = conn.cursor()']
          : [
              'import sqlite3\nuri = "file:inputs/co2.sqlite?mode=ro"',
              'conn = sqlite3.connect(uri, uri=True)\ncur = conn.cursor()'
            ]
      const context = await fileContext(
        'python',
        scripts,
        scripts.map(() => ({ cwdBefore: cwd, cwdAfter: cwd })),
        true,
        (json) => {
          const cached = JSON.parse(json).runs[`run-${scripts.length - 1}`]
          expect(cached.fileContext.pythonBindings).toEqual(
            expect.arrayContaining([
              {
                name: kind === 'cursor after cwd restoration' ? 'cur2' : 'conn',
                qualifiedName:
                  kind === 'cursor after cwd restoration' ? 'sqlite3.Cursor' : 'sqlite3.Connection',
                kind: 'object',
                filePath: 'inputs/co2.sqlite'
              }
            ])
          )
          return json
        },
        'epoch-1',
        { cwdBefore: cwd, cwdAfter: cwd },
        (runs) => {
          if (kind === 'cursor after cwd restoration')
            runs[1]!.script = 'import os\nos.chdir("elsewhere")\nos.chdir("..")'
          else runs[0]!.script = 'import sqlite3\nuri = "file:inputs/changed.sqlite?mode=ro"'
        }
      )
      expect(context?.pythonBindings?.some(({ filePath }) => filePath !== undefined)).toBe(false)
      const query =
        kind === 'cursor after cwd restoration' ? select.replaceAll('cur.', 'cur2.') : select
      expect(await analyzeNotebookSourceFileAccess('python', query, context)).toMatchObject({
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  const entry = (path?: string, definedNames = ['sqlite3', 'conn']): FileContextEntry => {
    const value = literalConnection(path)
    value.facts.definedNames = definedNames
    if (path === undefined) delete value.fileContext.pythonBindings![1]!.filePath
    return value
  }

  it('cannot restore a revoked SQLite path from an old binding or type overlay', () => {
    const revoked = entry()
    const context = projectNotebookFileContext('python', [entry('inputs/co2.sqlite'), revoked])
    expect(context?.pythonBindings?.find(({ name }) => name === 'conn')).toEqual({
      name: 'conn',
      qualifiedName: 'sqlite3.Connection',
      kind: 'object'
    })
    expect(revoked.fileContext.pythonBindings?.[1]).not.toHaveProperty('filePath')
  })

  it('does not revive relative SQLite authority from later cached outgoing candidates', () => {
    const barrier = entry('inputs/co2.sqlite')
    barrier.sqliteRelativePathBarrier = true
    const later = entry('inputs/co2.sqlite', [])
    const context = projectNotebookFileContext('python', [
      entry('inputs/co2.sqlite'),
      barrier,
      later
    ])
    expect(context?.pythonBindings?.find(({ name }) => name === 'conn')).toEqual({
      name: 'conn',
      qualifiedName: 'sqlite3.Connection',
      kind: 'object'
    })
  })

  it.each(['entry', 'final'] as const)(
    'keeps absolute SQLite candidates and identities behind a %s cwd barrier',
    (barrier) => {
      const absolute = entry('/science/co2.sqlite')
      const relative = entry('inputs/co2.sqlite')
      relative.fileContext.pythonBindings![1]!.name = 'relative'
      relative.facts.definedNames = ['relative']
      relative.facts.typeBindings = [{ target: 'relative', typeName: 'sqlite3.Connection' }]
      relative.facts.receiverCalls![0]!.resultNames = ['relative']
      if (barrier === 'entry') {
        relative.sqliteRelativePathBarrier = true
      }
      // Each outgoing snapshot carries the still-live candidates, not just new definitions.
      const context = projectNotebookFileContext(
        'python',
        [
          absolute,
          {
            ...relative,
            fileContext: {
              ...relative.fileContext,
              pythonBindings: [
                absolute.fileContext.pythonBindings![1]!,
                ...relative.fileContext.pythonBindings!
              ]
            }
          }
        ],
        { sqliteRelativePathBarrier: barrier === 'final' }
      )
      expect(context?.pythonBindings).toEqual(
        expect.arrayContaining([
          {
            name: 'conn',
            qualifiedName: 'sqlite3.Connection',
            kind: 'object',
            filePath: '/science/co2.sqlite'
          },
          { name: 'relative', qualifiedName: 'sqlite3.Connection', kind: 'object' }
        ])
      )
      expect(absolute.fileContext.pythonBindings?.[1]?.filePath).toBe('/science/co2.sqlite')
      expect(relative.fileContext.pythonBindings?.[1]?.filePath).toBe('inputs/co2.sqlite')
    }
  )

  it.each(['alias', 'close', 'mutation', 'conditional', 'taint'] as const)(
    'does not restore SQLite candidates after %s facts',
    (kind) => {
      const invalid = entry('inputs/co2.sqlite')
      if (kind === 'alias')
        invalid.facts.aliases = [{ target: 'other', source: 'conn', kind: 'reference' }]
      if (kind === 'close') invalid.facts.receiverCalls = [{ receiver: 'conn', member: 'close' }]
      if (kind === 'mutation') invalid.facts.possiblyMutatedNames = ['conn']
      if (kind === 'conditional') invalid.facts.conditionallyDefinedNames = ['conn']
      if (kind === 'taint') invalid.fileContext.pythonTaintedNamespaces = ['sqlite3']
      const context = projectNotebookFileContext('python', [entry('inputs/co2.sqlite'), invalid])
      expect(context?.pythonBindings?.some(({ filePath }) => filePath !== undefined)).toBeFalsy()
    }
  )
})

describe('file context after mutable path collections', () => {
  const withHelper = [
    'import csv',
    'def read_rows(path):',
    '    with open(path, "r", newline="", encoding="utf-8") as handle:',
    '        return list(csv.DictReader(handle))'
  ].join('\n')

  it('captures all literal inputs of a same-cell sole-With helper', async () => {
    const paths = ['inputs/raw.csv', 'inputs/settings.csv', 'outputs/fit.csv', 'outputs/pred.csv']
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [withHelper, ...paths.map((path) => `rows = read_rows("${path}")`)].join('\n')
    )
    expect(result).toMatchObject({
      reads: [...paths].sort(),
      writes: [],
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it('binds keyword paths of a same-cell sole-With helper', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `${withHelper}\nrows = read_rows(path="input.csv")`
      )
    ).toMatchObject({ reads: ['input.csv'] })
  })

  it('retains sole-With inputs beside an unrelated deferred global callback', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        [
          withHelper,
          'rows = read_rows("input.csv")',
          'count = 0',
          'def objective(rate):',
          '    global count',
          '    count += 1',
          '    return rate * rate'
        ].join('\n')
      )
    ).toMatchObject({
      reads: ['input.csv'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not replay a sole-With helper with its own cross-scope write', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        [
          'def read_rows(path):',
          '    with open(path) as handle:',
          '        global data',
          '        data = handle.read()',
          'read_rows("decoy.csv")'
        ].join('\n')
      )
    ).toMatchObject({ reads: [], readState: 'partial' })
  })

  it.each([
    ['path argument', 'PATH', '"new.csv"', withHelper, 'read_rows(PATH)'],
    [
      'captured path',
      'PATH',
      '"new.csv"',
      withHelper.replace('read_rows(path)', 'read_rows()').replace('open(path,', 'open(PATH,'),
      'read_rows()'
    ],
    ['open identity', 'open', 'replacement', withHelper, 'read_rows("old.csv")'],
    ['helper identity', 'read_rows', 'replacement', withHelper, 'read_rows("old.csv")']
  ])(
    'does not retain an old %s after an opaque sibling namespace write',
    async (_label, target, value, helper, call) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          'PATH = "old.csv"',
          helper,
          'def change_binding():',
          `    global ${target}`,
          `    ${target} = ${value}`,
          'writer = change_binding',
          'writer()',
          call
        ].join('\n')
      )
      expect(result).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
    }
  )

  it.each([
    ['uncalled', withHelper],
    ['rebound helper', `${withHelper}\nread_rows = replacement\nread_rows("decoy.csv")`],
    ['aliased helper', `${withHelper}\nreader = read_rows\nreader("decoy.csv")`],
    ['shadowed open', `${withHelper}\nopen = replacement\nread_rows("decoy.csv")`],
    [
      'parameter shadowing',
      `${withHelper.replace('read_rows(path)', 'read_rows(path, open)')}\nread_rows("decoy.csv", replacement)`
    ],
    [
      'decorated',
      `${withHelper.replace('def read_rows', '@decorate\ndef read_rows')}\nread_rows("decoy.csv")`
    ],
    [
      'unawaited async',
      `${withHelper.replace('def read_rows', 'async def read_rows')}\nread_rows("decoy.csv")`
    ],
    [
      'uniterated generator',
      `${withHelper.replace('return list', 'yield list')}\nread_rows("decoy.csv")`
    ],
    [
      'conditional definition',
      `if condition:\n${withHelper
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')}\nread_rows("decoy.csv")`
    ]
  ])('does not infer inputs from a %s sole-With helper', async (_label, source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({ reads: [] })
  })

  it('keeps module pattern captures outside sole-With helper replay', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        withHelper,
        'source_path = "old.csv"',
        'match value:',
        '    case {"path": source_path}:',
        '        pass',
        'read_rows(source_path)'
      ].join('\n')
    )
    expect(result).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
  })

  it.each(['read_rows', 'open', '(read_rows, other)', '(other, *read_rows)'])(
    'revokes a sole-With helper after a context manager binds %s',
    async (target) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `${withHelper}\nwith open("live.csv") as ${target}:\n    read_rows("decoy.csv")`
      )
      expect(result).toMatchObject({ reads: ['live.csv'], readState: 'partial' })
    }
  )

  it('does not replay a later sole-With definition at an earlier call', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'def read_rows():',
        '    with open("first.csv") as handle:',
        '        return handle.read()',
        'read_rows()',
        'def read_rows():',
        '    with open("future.csv") as handle:',
        '        return handle.read()'
      ].join('\n')
    )
    expect(result.reads).not.toContain('future.csv')
    expect(result.readState).toBe('partial')
  })

  it.each([
    ['', '', []],
    ['with open("retained.csv") as handle:\n    prior = handle.read()', '', ['retained.csv']],
    ['', 'read_rows("actual.csv")', ['actual.csv']]
  ] as const)(
    'activates a sole-With helper only at its definition: %s / %s',
    async (prior, later, reads) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          prior,
          'try:',
          '    read_rows("future.csv")',
          'except NameError:',
          '    pass',
          withHelper,
          later
        ]
          .filter(Boolean)
          .join('\n')
      )
      expect(result).toMatchObject({ reads, readState: 'partial', externalState: 'partial' })
    }
  )

  it.each(['numpy import loadtxt', 'pandas import read_csv'])(
    'retains the imported %s reader until a sole-With definition replaces it',
    async (imported) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          `from ${imported} as read_rows`,
          'read_rows("imported.csv")',
          'def read_rows(path):',
          '    with open("helper.csv") as handle:',
          '        return handle.read()',
          'read_rows("unused.csv")'
        ].join('\n')
      )
      expect(result).toMatchObject({
        reads: ['helper.csv', 'imported.csv'],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('does not infer empty complete I/O from an imported reader before a future helper', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'from numpy import loadtxt as read_rows',
        'read_rows("actual.csv")',
        'def read_rows(path):',
        '    with open("future-internal.csv") as handle:',
        '        return handle.read()'
      ].join('\n')
    )
    expect(result.reads).toEqual(['actual.csv'])
    expect(result.reads).not.toContain('future-internal.csv')
  })

  it.each([
    ['read_rows = replacement', []],
    ['with open("retained.csv") as read_rows:\n    pass', ['retained.csv']]
  ] as const)(
    'keeps a helper revoked before its definition conservative: %s',
    async (earlier, reads) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `${earlier}\n${withHelper}\nread_rows("decoy.csv")`
      )
      expect(result).toMatchObject({ reads, readState: 'partial', externalState: 'partial' })
    }
  )

  it.each([
    ['emit = replacement', '', []],
    ['', 'emit = replacement', []],
    ['with open("retained.csv") as emit:\n    pass', '', ['retained.csv']],
    ['try:\n    emit("future.txt")\nexcept NameError:\n    pass', '', []]
  ] as const)(
    'keeps unproven writer helper I/O partial: %s / %s',
    async (earlier, later, reads) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          earlier,
          'def emit(path):',
          '    payload = "value"',
          '    with open(path, "w") as handle:',
          '        handle.write(payload)',
          later,
          ...(earlier.startsWith('try:') ? [] : ['emit("unproven.txt")'])
        ]
          .filter(Boolean)
          .join('\n')
      )
      expect(result).toMatchObject({
        reads,
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each([
    'class read_rows:\n    pass',
    'if condition:\n    def read_rows(path):\n        return []'
  ])(
    'does not replay a sole-With helper replaced by another declaration: %s',
    async (declaration) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          `${withHelper}\n${declaration}\nread_rows("decoy.csv")`
        )
      ).toMatchObject({ reads: [], readState: 'partial' })
    }
  )

  it('forgets a sole-With helper argument rebound by tuple unpacking', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `${withHelper}\nsource_path = "decoy.csv"\nwith opaque_manager as (source_path, other):\n    read_rows(source_path)`
    )
    expect(result).toMatchObject({ reads: [], readState: 'partial' })
  })

  it.each(['np', '(np, other)', '(other, *np)'])(
    'does not recover a reader after a With target rebinds %s',
    async (target) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import numpy as np\nwith open("live.csv") as ${target}:\n    pass\nnp.loadtxt("decoy.csv")`
      )
      expect(result).toMatchObject({ reads: ['live.csv'], readState: 'partial' })
    }
  )

  it.each(['np.loadtxt', 'np.__dict__["loadtxt"]', '(np.loadtxt, other)'])(
    'revokes a reader mutated by a With target %s',
    async (target) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `import numpy as np\nwith open("live.csv") as ${target}:\n    pass\nnp.loadtxt("decoy.csv")`
      )
      expect(result).toMatchObject({ reads: ['live.csv'], readState: 'partial' })
    }
  )

  it.each(['np.loadtxt', 'np.__dict__["loadtxt"]', '(np.loadtxt, other)'])(
    'retains With target mutation %s after helper scope restoration',
    async (target) => {
      const source = [
        'import numpy as np',
        'def read_rows(path):',
        `    with open("live.csv") as ${target}:`,
        '        return np.loadtxt(path)',
        'read_rows("decoy.csv")',
        'import numpy as again',
        'again.loadtxt("after.csv")'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: ['live.csv'],
        readState: 'partial',
        externalState: 'partial'
      })
      const context = await fileContext('python', [source])
      expect(context?.pythonTaintedNamespaces).toContain('numpy')
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          'import numpy as restored\nrestored.loadtxt("cached-decoy.csv")',
          context
        )
      ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
    }
  )

  it('keeps a separate module import after a local With name rebind', async () => {
    const source = [
      'import numpy as np',
      'import numpy as original',
      'with open("live.csv") as np:',
      '    pass',
      'np.loadtxt("decoy.csv")',
      'original.loadtxt("retained.csv")'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['live.csv', 'retained.csv'],
      readState: 'partial'
    })
    const context = await fileContext('python', [source])
    expect(context?.pythonTaintedNamespaces ?? []).not.toContain('numpy')
    expect(
      await analyzeNotebookSourceFileAccess('python', 'original.loadtxt("next.csv")', context)
    ).toMatchObject({ reads: ['next.csv'] })
  })

  it.each([
    ['np.loadtxt', '    np = None'],
    ['np.__dict__["loadtxt"]', '    np = None'],
    ['(np.loadtxt, np)', ''],
    ['np.loadtxt', '    def inner(arg=(np := None)):\n        pass'],
    ['np.loadtxt', '    def inner(*, arg=(np := None)):\n        pass'],
    ['np.loadtxt', '    @((np := None))\n    def inner():\n        pass'],
    ['np.loadtxt', '    class Inner((np := object)):\n        pass'],
    ['np.loadtxt', '    deferred = lambda arg=(np := None): arg']
  ])('does not taint a module borrowed for an unbound helper local: %s', async (target, tail) => {
    const source = [
      'import numpy as np',
      'import numpy as original',
      'def read_rows():',
      `    with open("live.csv") as ${target}:`,
      '        pass',
      tail,
      'try:',
      '    read_rows()',
      'except UnboundLocalError:',
      '    pass',
      'original.loadtxt("retained.csv")'
    ]
      .filter(Boolean)
      .join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['live.csv', 'retained.csv'],
      readState: 'partial'
    })
    const context = await fileContext('python', [source])
    expect(context?.pythonTaintedNamespaces ?? []).not.toContain('numpy')
    expect(
      await analyzeNotebookSourceFileAccess('python', 'original.loadtxt("next.csv")', context)
    ).toMatchObject({ reads: ['next.csv'] })
  })

  it.each([
    '    values = [np for np in (1,)]',
    '    deferred = lambda np: np',
    '    def deferred(np):\n        return np'
  ])('does not borrow comprehension or nested parameters as helper locals: %s', async (tail) => {
    const source = [
      'import numpy as np',
      'import numpy as original',
      'def read_rows():',
      '    with open("live.csv") as np.loadtxt:',
      '        pass',
      tail,
      'read_rows()',
      'original.loadtxt("decoy.csv")'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['live.csv'],
      readState: 'partial'
    })
    const context = await fileContext('python', [source])
    expect(context?.pythonTaintedNamespaces).toContain('numpy')
  })

  it('applies With target rebinding before the next context expression', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import numpy as np\nwith open("live.csv") as np, np.loadtxt("decoy.csv") as handle:\n    pass'
      )
    ).toMatchObject({ reads: ['live.csv'], readState: 'partial' })
  })

  it.each([
    ['before', '    with open("live.csv") as handle:\n        pass', []],
    ['after', '', ['future.csv']]
  ] as const)(
    'checks a nested reader invocation %s its definition statement',
    async (_order, early, reads) => {
      const source = [
        'import pandas as pd',
        'def read_rows():',
        early,
        '    def open(path):',
        '        return pd.read_csv("future.csv")',
        ...(early ? [] : ['    with open("live.csv") as handle:', '        pass']),
        'try:',
        '    read_rows()',
        'except UnboundLocalError:',
        '    pass'
      ]
        .filter(Boolean)
        .join('\n')
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({ reads })
    }
  )

  it.each(['numpy import loadtxt', 'pandas import read_csv'])(
    'uses the actual local reader identity after from %s',
    async (imported) => {
      const source = [
        'def read_rows(path):',
        `    from ${imported} as read_input`,
        '    return read_input(path)',
        'read_rows("input.csv")'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: ['input.csv']
      })
    }
  )

  it.each([
    ['    read_input = None', []],
    ['    with open("live.csv") as read_input:\n        pass', ['live.csv']]
  ] as const)('revokes a local imported reader after %s', async (replacement, reads) => {
    const source = [
      'def read_rows(path):',
      '    from numpy import loadtxt as read_input',
      replacement,
      '    return read_input(path)',
      'read_rows("decoy.csv")'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads,
      readState: 'partial'
    })
  })

  it.each([
    ['(np.loadtxt, np)', ['live.csv'], true],
    ['(np, np.loadtxt)', ['live.csv', 'retained.csv'], false]
  ] as const)('applies mixed With target stores in order: %s', async (target, reads, tainted) => {
    const source = [
      'import numpy as np',
      'import numpy as original',
      `with open("live.csv") as ${target}:`,
      '    pass',
      'original.loadtxt("retained.csv")'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({ reads })
    const context = await fileContext('python', [source])
    expect(context?.pythonTaintedNamespaces?.includes('numpy') ?? false).toBe(tainted)
  })

  it('keeps unknown context manager effects partial around known helper inputs', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pandas as pd',
        'def read_rows(path, manager):',
        '    with manager:',
        '        frame = pd.read_csv(path)',
        'read_rows("input.csv", opaque_manager)'
      ].join('\n')
    )
    expect(result).toMatchObject({
      reads: ['input.csv'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('captures parameterized I/O from multi-statement local file helpers', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'def summarize(input_path, output_path):',
        '    frame = pd.read_csv(input_path)',
        '    frame.groupby("group")["value"].mean().to_csv(output_path, index=False)',
        'summarize("input.csv", "output.csv")'
      ].join('\n'),
      {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonBindings: [{ name: 'pd', qualifiedName: 'pandas', kind: 'import' }]
      }
    )
    expect(result).toMatchObject({
      reads: ['input.csv'],
      writes: ['output.csv'],
      readState: 'complete',
      writeState: 'complete'
    })
    expect(result.externalState).toBe('complete')
  })

  it('replays a stable outer helper that delegates to a sole-return reader helper', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pandas as pd',
        'def load_coordinates(path):',
        '    return pd.read_csv(path)',
        'def main(input_csv):',
        '    frame = load_coordinates(input_csv)',
        '    return frame.shape',
        'main("outputs/coordinates.csv")'
      ].join('\n')
    )
    expect(result).toMatchObject({
      reads: ['outputs/coordinates.csv'],
      readState: 'partial'
    })
  })

  it.each([
    ['an alias', '    reader = load_coordinates\n    frame = reader(input_csv)'],
    [
      'a rebound reader',
      '    load_coordinates = replacement\n    frame = load_coordinates(input_csv)'
    ],
    [
      'a shadowing parameter',
      'def main(load_coordinates):\n    frame = load_coordinates("outputs/coordinates.csv")'
    ]
  ])('does not replay a nested reader helper through %s', async (_label, body) => {
    const source = [
      'import pandas as pd',
      'def load_coordinates(path):',
      '    return pd.read_csv(path)',
      body,
      'main("outputs/coordinates.csv")'
    ].join('\n')
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.reads).not.toContain('outputs/coordinates.csv')
    expect(result.readState).toBe('partial')
  })

  it.each([false, true])(
    'replays a fresh local Path checksum with cached paths=%s',
    async (cached) => {
      const declaration =
        'paths = ["outputs/variance-check.json", "outputs/centered-fit.json", "outputs/residual-audit.json"]'
      const context = cached ? await fileContext('python', [declaration]) : undefined
      const source = [
        'import pathlib, hashlib',
        ...(cached ? [] : [declaration]),
        'def file_meta(p):',
        '    pp = pathlib.Path(p)',
        '    data = pp.read_bytes()',
        '    return {"path": str(pp), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}',
        'files = [file_meta(p) for p in paths]'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        reads: [
          'outputs/centered-fit.json',
          'outputs/residual-audit.json',
          'outputs/variance-check.json'
        ],
        writes: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const after = await fileContext('python', [source])
      expect(
        (
          await analyzeNotebookSourceFileAccess(
            'python',
            'files = [file_meta(p) for p in ["later.json"]]',
            after
          )
        ).reads
      ).toEqual([])
    }
  )

  it.each([
    'def str(value): return mutate(value)',
    'str = replacement',
    'from custom import str',
    'import builtins; builtins.str = replacement',
    'def len(value): return mutate(value)',
    'pathlib.Path.open = replacement',
    'pathlib.Path.__str__ = replacement',
    'hashlib.sha256 = replacement'
  ])('rejects local Path checksums after behavior shadowing: %s', async (binding) => {
    const source = [
      'import pathlib, hashlib',
      binding,
      'def file_meta(p):',
      '    pp = pathlib.Path(p)',
      '    data = pp.read_bytes()',
      '    return {"path": str(pp), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}',
      'files = [file_meta(p) for p in ["inputs/first.csv", "inputs/later.csv"]]'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      readState: 'partial'
    })
  })

  it.each([
    ['parameter overwrite', 'p = pathlib.Path(p)', 'data = p.read_bytes()', '{"bytes": len(data)}'],
    ['data overwrites Path', 'pp = pathlib.Path(p)', 'pp = pp.read_bytes()', '{"bytes": len(pp)}'],
    ['constructor alias', 'pp = Path(p)', 'data = pp.read_bytes()', '{"bytes": len(data)}'],
    [
      'dynamic constructor',
      'pp = pathlib.Path(select(p))',
      'data = pp.read_bytes()',
      '{"bytes": len(data)}'
    ],
    [
      'read arguments',
      'pp = pathlib.Path(p)',
      'data = pp.read_bytes(*mutate())',
      '{"bytes": len(data)}'
    ],
    ['alternate reader', 'pp = pathlib.Path(p)', 'data = pp.read_text()', '{"bytes": len(data)}'],
    ['Path escapes', 'pp = pathlib.Path(p)', 'data = pp.read_bytes()', '{"path": pp}'],
    [
      'opaque str argument',
      'pp = pathlib.Path(p)',
      'data = pp.read_bytes()',
      '{"path": str(pp, *mutate())}'
    ],
    [
      'opaque hash arguments',
      'pp = pathlib.Path(p)',
      'data = pp.read_bytes()',
      '{"sha": hashlib.sha256(data).hexdigest(**mutate())}'
    ],
    ['opaque tail', 'pp = pathlib.Path(p)', 'data = pp.read_bytes()', '{"value": opaque(data)}'],
    [
      'reserved Path name',
      'str = pathlib.Path(p)',
      'data = str.read_bytes()',
      '{"bytes": len(data)}'
    ],
    [
      'reserved data name',
      'pp = pathlib.Path(p)',
      'hashlib = pp.read_bytes()',
      '{"bytes": len(hashlib)}'
    ],
    [
      'multiple targets',
      'pp = alias = pathlib.Path(p)',
      'data = pp.read_bytes()',
      '{"bytes": len(data)}'
    ],
    ['non-dictionary return', 'pp = pathlib.Path(p)', 'data = pp.read_bytes()', 'len(data)']
  ])(
    'rejects unsupported local Path checksum shape: %s',
    async (_label, construct, read, returned) => {
      const source = [
        'import pathlib, hashlib',
        'from pathlib import Path',
        'def file_meta(p):',
        '    ' + construct,
        '    ' + read,
        '    return ' + returned,
        'files = [file_meta(p) for p in ["inputs/first.csv", "inputs/later.csv"]]'
      ].join('\n')
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        reads: [],
        readState: 'partial'
      })
    }
  )

  it.each(['    opaque()\n', '    pp = replacement\n', '    alias = pp\n', '    assert data\n'])(
    'rejects extra local Path helper statements: %s',
    async (extra) => {
      const source =
        'import pathlib, hashlib\ndef file_meta(p):\n    pp = pathlib.Path(p)\n    data = pp.read_bytes()\n' +
        extra +
        '    return {"path": str(pp), "bytes": len(data)}\nfiles = [file_meta(p) for p in ["inputs/a.csv"]]'
      expect((await analyzeNotebookSourceFileAccess('python', source)).reads).toEqual([])
    }
  )

  it.each(['str', 'len'])(
    'rejects inherited %s bindings for local Path checksums',
    async (builtin) => {
      const source = [
        'import pathlib, hashlib',
        'def file_meta(p):',
        '    pp = pathlib.Path(p)',
        '    data = pp.read_bytes()',
        '    return {"path": str(pp), "bytes": len(data)}',
        'files = [file_meta(p) for p in ["inputs/a.csv"]]'
      ].join('\n')
      const context = await fileContext('python', [builtin + ' = replacement'])
      expect((await analyzeNotebookSourceFileAccess('python', source, context)).reads).toEqual([])
    }
  )

  it.each(['pathlib', 'hashlib', 'builtins', '*'])(
    'rejects inherited %s taint for local Path checksums',
    async (namespace) => {
      const source = [
        'import pathlib, hashlib',
        'def file_meta(p):',
        '    pp = pathlib.Path(p)',
        '    data = pp.read_bytes()',
        '    return {"path": str(pp), "bytes": len(data)}',
        'files = [file_meta(p) for p in ["inputs/a.csv"]]'
      ].join('\n')
      expect(
        (
          await analyzeNotebookSourceFileAccess('python', source, {
            staticStrings: [],
            staticCollections: [],
            localFileWrappers: [],
            pythonTaintedNamespaces: [namespace]
          })
        ).reads
      ).toEqual([])
    }
  )

  it('replays bounded checksum helper inputs from a persisted static path collection', async () => {
    const context = await fileContext('python', [
      'paths = ["inputs/quakes.csv", "outputs/shallow.csv", "outputs/deep.csv"]'
    ])
    const source = [
      'import hashlib',
      'import pathlib',
      'def file_meta(p):',
      '    data = pathlib.Path(p).read_bytes()',
      '    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": pathlib.Path(p).stat().st_size}',
      'files = [file_meta(p) for p in paths]'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      reads: ['inputs/quakes.csv', 'outputs/deep.csv', 'outputs/shallow.csv'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('replays bounded open/stat metadata helper inputs from a static path collection', async () => {
    const source = [
      'import hashlib, os',
      'def file_meta(p):',
      '    with open(p, "rb") as fh:',
      '        data = fh.read()',
      '    stat = os.stat(p)',
      '    digest = hashlib.sha256(data).hexdigest()',
      '    return {"path": p, "size_bytes": int(stat.st_size), "sha256": digest,',
      '            "read_bytes": len(data), "size_match": stat.st_size == len(data),',
      '            "mtime_utc": int(stat.st_mtime)}',
      'paths = (os.path.join("outputs", "observations.json"),',
      '         os.path.join("outputs", "regression.json"),',
      '         os.path.join("outputs", "crosscheck.json"))',
      'meta = [file_meta(p) for p in paths]'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['outputs\\crosscheck.json', 'outputs\\observations.json', 'outputs\\regression.json'],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('replays a real metadata helper with an inline digest in a manifest comprehension', async () => {
    const source = [
      'import hashlib, json, os, sys',
      'def file_meta(p):',
      '    with open(p, "rb") as fh:',
      '        data = fh.read()',
      '    stat = os.stat(p)',
      '    return {"path": p, "size_bytes": int(stat.st_size),',
      '            "sha256": hashlib.sha256(data).hexdigest(),',
      '            "read_bytes": len(data), "size_match": stat.st_size == len(data),',
      '            "mtime_utc": int(stat.st_mtime)}',
      'paths = (os.path.join("outputs", "observations.json"),',
      '         os.path.join("outputs", "regression.json"),',
      '         os.path.join("outputs", "crosscheck.json"))',
      'manifest = {"files": [file_meta(p) for p in paths],',
      '            "tolerance_notes": "metadata-only"}',
      'out_path = os.path.join("outputs", "manifest.json")',
      'with open(out_path, "w", encoding="utf-8") as fh:',
      '    json.dump(manifest, fh)',
      'print(sys.version.split()[0])'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['outputs\\crosscheck.json', 'outputs\\observations.json', 'outputs\\regression.json'],
      writes: ['outputs\\manifest.json'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('rejects metadata helpers with effectful inline hexdigest arguments', async () => {
    const source = [
      'import hashlib, os',
      'def file_meta(p):',
      '    with open(p, "rb") as fh:',
      '        data = fh.read()',
      '    stat = os.stat(p)',
      '    return {"path": p, "sha256": hashlib.sha256(data).hexdigest(**mutate())}',
      'paths = ("outputs/never-created.json",)',
      'meta = [file_meta(p) for p in paths]'
    ].join('\n')
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).not.toContain(
      'outputs\\never-created.json'
    )
  })

  it('replays the same metadata helper through a bounded for loop', async () => {
    const source = [
      'import hashlib, os',
      'def file_meta(p):',
      '    with open(p, "rb") as fh:',
      '        data = fh.read()',
      '    stat = os.stat(p)',
      '    digest = hashlib.sha256(data).hexdigest()',
      '    return {"path": p, "bytes": len(data), "sha256": digest}',
      'paths = ("outputs/observations.json", "outputs/regression.json")',
      'for p in paths:',
      '    metadata = file_meta(p)'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['outputs/observations.json', 'outputs/regression.json'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('replays a Path-rebinding metadata helper with guarded for-loop bookkeeping', async () => {
    const source = [
      'import json, hashlib',
      'from pathlib import Path',
      'INPUTS = [Path("outputs/observations.json"), Path("outputs/regression.json")]',
      'def file_meta(p):',
      '    p = Path(p)',
      '    data = p.read_bytes()',
      '    h = hashlib.sha256(data).hexdigest()',
      '    st_size = p.stat().st_size',
      '    assert len(data) == st_size',
      '    assert len(h) == 64 and all(c in "0123456789abcdef" for c in h)',
      '    return {"path": str(p), "size_bytes": st_size, "sha256": h}',
      'entries = []',
      'for p in INPUTS:',
      '    assert p.exists()',
      '    m = file_meta(p)',
      '    assert m["size_bytes"] > 0',
      '    entries.append(m)',
      'with open("outputs/manifest.json", "w", encoding="utf-8") as fh:',
      '    json.dump({"files": entries}, fh)'
    ].join('\n')
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: ['outputs\\observations.json', 'outputs\\regression.json'],
      writes: ['outputs/manifest.json'],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    'open = replacement',
    'os.stat = replacement',
    'hashlib.sha256 = replacement',
    'paths = build_paths()'
  ])('rejects metadata helper inputs after unsafe binding changes: %s', async (mutation) => {
    const source = [
      'import hashlib, os',
      'def file_meta(p):',
      '    with open(p, "rb") as fh:',
      '        data = fh.read()',
      '    stat = os.stat(p)',
      '    digest = hashlib.sha256(data).hexdigest()',
      '    return {"path": p, "bytes": len(data), "sha256": digest}',
      mutation,
      ...(mutation === 'paths = build_paths()' ? [] : ['paths = ("outputs/never-created.json",)']),
      'meta = [file_meta(p) for p in paths]'
    ].join('\n')
    expect((await analyzeNotebookSourceFileAccess('python', source)).reads).not.toContain(
      'outputs/never-created.json'
    )
  })

  it.each([
    'pathlib.Path = replacement',
    'pathlib.Path.read_bytes = replacement',
    'hashlib.sha256 = replacement',
    'opaque(pathlib)',
    'pathlib.Path = replacement\nimport pathlib'
  ])('rejects checksum inputs after namespace mutation or escape: %s', async (mutation) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import hashlib, pathlib',
        'def file_meta(p):',
        '    data = pathlib.Path(p).read_bytes()',
        '    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}',
        mutation,
        'files = [file_meta(p) for p in ["outputs/never-created.json"]]'
      ].join('\n')
    )
    expect(result.reads).not.toContain('outputs/never-created.json')
    expect(result.readState).toBe('partial')
  })

  it.each(['pathlib', 'hashlib', '*'])(
    'rejects checksum inputs with inherited %s namespace taint',
    async (namespace) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          'import hashlib, pathlib',
          'def file_meta(p):',
          '    data = pathlib.Path(p).read_bytes()',
          '    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}',
          'files = [file_meta(p) for p in ["outputs/never-created.json"]]'
        ].join('\n'),
        {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          pythonTaintedNamespaces: [namespace]
        }
      )
      expect(result.reads).not.toContain('outputs/never-created.json')
      expect(result.readState).toBe('partial')
    }
  )

  it.each([
    [
      'pre-read argument effects',
      'def digest(p):\n    data = pathlib.Path(p).read_text(encoding=choose_encoding())\n    return len(data)',
      'files = [digest(p) for p in ["outputs/absent.csv"]]'
    ],
    [
      'unsupported positional read arguments',
      'def digest(p):\n    data = pathlib.Path(p).read_bytes(choose_encoding())\n    return len(data)',
      'files = [digest(p) for p in ["outputs/absent.csv"]]'
    ],
    [
      'a namespace parameter',
      'def digest(pathlib):\n    data = pathlib.Path(pathlib).read_bytes()\n    return len(data)',
      'files = [digest(p) for p in ["outputs/absent.csv"]]'
    ],
    [
      'a local namespace binding',
      'def digest(p):\n    pathlib = pathlib.Path(p).read_bytes()\n    return len(pathlib)',
      'files = [digest(p) for p in ["outputs/absent.csv"]]'
    ],
    [
      'a shadowed comprehension callable',
      'def digest(p):\n    data = pathlib.Path(p).read_bytes()\n    return len(data)',
      'files = [digest(digest) for digest in ["outputs/absent.csv"]]'
    ]
  ])('does not certify checksum inputs with %s', async (_label, helper, invocation) => {
    const source = [
      'import pathlib, hashlib, io',
      'def fake_open(*args, **kwargs):',
      '    return io.StringIO("memory")',
      'def choose_encoding():',
      '    pathlib.Path.open = fake_open',
      '    return "utf-8"',
      helper,
      invocation
    ].join('\n')
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.reads).not.toContain('outputs/absent.csv')
    expect(result.readState).toBe('partial')
  })

  it('does not use a later checksum definition for an earlier invocation', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib',
        'files = [digest(p) for p in ["outputs/absent.csv"]]',
        'def digest(p):',
        '    data = pathlib.Path(p).read_bytes()',
        '    return len(data)'
      ].join('\n')
    )
    expect(result.reads).not.toContain('outputs/absent.csv')
    expect(result.readState).toBe('partial')
  })

  it('keeps checksum globals separate from the comprehension target scope', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib',
        'def digest(p):',
        '    data = pathlib.Path(p).read_bytes()',
        '    return len(data)',
        'files = [digest(pathlib) for pathlib in ["outputs/observations.json"]]'
      ].join('\n')
    )
    expect(result.reads).toEqual(['outputs/observations.json'])
    expect(result.readState).toBe('partial')
  })

  it.each(['*mutate()', '**mutate_keywords()'])(
    'rejects effectful hexdigest arguments before subsequent checksum iterations: %s',
    async (argumentsSource) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          'import pathlib, hashlib, io',
          'def memory_open(*args, **kwargs):',
          '    return io.BytesIO(b"memory")',
          'def mutate():',
          '    pathlib.Path.open = memory_open',
          '    return ()',
          'def mutate_keywords():',
          '    pathlib.Path.open = memory_open',
          '    return {}',
          'def digest(p):',
          '    data = pathlib.Path(p).read_bytes()',
          '    return hashlib.sha256(data).hexdigest(' + argumentsSource + ')',
          'files = [digest(p) for p in ["first.csv", "later.csv"]]'
        ].join('\n')
      )
      expect(result.reads).not.toContain('later.csv')
      expect(result.readState).toBe('partial')
    }
  )

  it.each([
    'def len(data):\n    pathlib.Path.open = memory_open\n    return data.__len__()',
    'len = replacement',
    'from custom import len',
    'import builtins\nbuiltins.len = replacement'
  ])('does not certify later checksum reads with an untrusted len: %s', async (binding) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib, io',
        'def memory_open(*args, **kwargs):',
        '    return io.BytesIO(b"memory")',
        binding,
        'def digest(p):',
        '    data = pathlib.Path(p).read_bytes()',
        '    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}',
        'files = [digest(p) for p in ["first.csv", "later.csv"]]'
      ].join('\n')
    )
    expect(result.reads).not.toContain('later.csv')
    expect(result.readState).toBe('partial')
  })

  it('rejects a checksum helper that resolves len from its local parameter', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib',
        'def digest(len):',
        '    data = pathlib.Path(len).read_bytes()',
        '    return len(data)',
        'files = [digest(p) for p in ["first.csv", "later.csv"]]'
      ].join('\n')
    )
    expect(result.reads).not.toContain('later.csv')
    expect(result.readState).toBe('partial')
  })

  it('retains checksum reads when a shadowed len is never called', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib',
        'len = replacement',
        'def digest(p):',
        '    data = pathlib.Path(p).read_bytes()',
        '    return hashlib.sha256(data).hexdigest()',
        'files = [digest(p) for p in ["first.csv", "later.csv"]]'
      ].join('\n')
    )
    expect(result.reads).toEqual(['first.csv', 'later.csv'])
    expect(result.readState).toBe('partial')
  })

  it('rejects a prior kernel binding for len in checksum helpers', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib',
        'def digest(p):',
        '    data = pathlib.Path(p).read_bytes()',
        '    return len(data)',
        'files = [digest(p) for p in ["first.csv", "later.csv"]]'
      ].join('\n'),
      {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        resolvedKernelNames: ['len']
      }
    )
    expect(result.reads).not.toContain('later.csv')
    expect(result.readState).toBe('partial')
  })

  it('rejects checksum definitions with effectful return annotations', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'import pathlib, hashlib, io',
        'def memory_open(*args, **kwargs):',
        '    return io.BytesIO(b"memory")',
        'def mutate():',
        '    pathlib.Path.open = memory_open',
        '    return bytes',
        'def digest(p) -> mutate():',
        '    data = pathlib.Path(p).read_bytes()',
        '    return hashlib.sha256(data).hexdigest()',
        'files = [digest(p) for p in ["first.csv", "later.csv"]]'
      ].join('\n')
    )
    expect(result.reads).toEqual([])
    expect(result.readState).toBe('partial')
  })

  it('captures a single-cell MEX helper while retaining companion uncertainty', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        'from pathlib import Path',
        'import scanpy as sc',
        'matrix_dir = Path("inputs/pbmc3k/filtered_feature_bc_matrix")',
        'output_dir = Path("outputs/pbmc3k")',
        'def preprocess(matrix_dir, output_dir):',
        '    data = sc.read_10x_mtx(matrix_dir, var_names="gene_symbols")',
        '    sc.pp.normalize_total(data)',
        '    sc.pp.log1p(data)',
        '    data.write_h5ad(output_dir / "processed.h5ad")',
        '    return data',
        'preprocess(matrix_dir, output_dir)'
      ].join('\n')
    )

    expect(result).toMatchObject({
      reads: [analyzedPythonPath('inputs/pbmc3k/filtered_feature_bc_matrix')],
      writes: [analyzedPythonPath('outputs/pbmc3k/processed.h5ad')],
      readState: 'partial',
      writeState: 'complete',
      externalState: 'partial'
    })
  })

  it.each([
    'reader = lambda: None',
    'for reader in [None]:\n        pass',
    'del reader',
    'from custom_reader import read as reader'
  ])('invalidates module helper bindings shadowed inside a callable: %s', async (binding) => {
    const source = `def reader():\n    return open("old.csv")\ndef read_inputs():\n    ${binding}\n    return reader()`
    expect(
      await analyzeNotebookSourceFileAccess('python', 'read_inputs()', {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [{ source, exports: ['read_inputs'] }]
      })
    ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
  })

  it.each(['failed', 'timeout', 'cancelled'] as const)(
    'keeps invalidated helpers unavailable across intervening cells after %s',
    async (status) => {
      const helper = {
        helperId: 'csv-helper',
        skillIdentity: 'skill://csv-helper',
        packageOrigin: 'test',
        interfaceRevision: '1',
        registeredGeneration: 'generation-1',
        exports: ['read_inputs'],
        source: 'def read_inputs():\n    return open("old.csv")',
        sourceDigest: 'digest-csv-helper'
      }
      const context = await fileContext(
        'python',
        ['read_inputs = lambda: None\nraise RuntimeError()', 'value = 1', 'read_inputs()'],
        [
          {
            status,
            kernelDispatched: true,
            helperModules: [helper],
            helperEvidenceStatus: { state: 'complete' }
          },
          {},
          { helperModules: [helper], helperEvidenceStatus: { state: 'complete' } }
        ]
      )
      expect(
        await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)
      ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
    }
  )

  it.each([
    'def _read():\n    return open("old.csv")\n_read = lambda: open("new.csv")\ndef read_inputs():\n    return _read()',
    'def read_inputs():\n    def _read():\n        return open("old.csv")\n    _read = lambda: None\n    return _read()'
  ])('does not replay rebound private or nested helper functions: %s', async (source) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', 'read_inputs()', {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [{ source, exports: ['read_inputs'] }]
      })
    ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
  })

  it('resolves a captured helper function before a same-named module function', async () => {
    const source =
      'def reader():\n    return open("global.csv")\ndef read_inputs():\n    def reader():\n        return open("local.csv")\n    def invoke():\n        return reader()\n    return invoke()'
    expect(
      await analyzeNotebookSourceFileAccess('python', 'read_inputs()', {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [{ source, exports: ['read_inputs'] }]
      })
    ).toMatchObject({ reads: ['local.csv'], readState: 'complete', externalState: 'complete' })
  })

  it.each([true, false])(
    'does not restore a helper rebound in a failed run (precompute=%s)',
    async (precompute) => {
      const helper = {
        helperId: 'csv-helper',
        skillIdentity: 'skill://csv-helper',
        packageOrigin: 'test',
        interfaceRevision: '1',
        registeredGeneration: 'generation-1',
        exports: ['read_inputs'],
        source: 'def read_inputs():\n    return open("old.csv")',
        sourceDigest: 'digest-csv-helper'
      }
      const context = await fileContext(
        'python',
        ['read_inputs = lambda: None\nraise RuntimeError()', 'read_inputs()'],
        [
          {
            status: 'failed',
            kernelDispatched: true,
            helperModules: [helper],
            helperEvidenceStatus: { state: 'complete' }
          },
          { helperModules: [helper], helperEvidenceStatus: { state: 'complete' } }
        ],
        precompute
      )
      expect(
        await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)
      ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
    }
  )

  it('keeps helper analysis partial when the runtime records more modules than the replay budget', async () => {
    const helperModules = Array.from({ length: 33 }, (_, index) => ({
      helperId: `helper-${index}`,
      skillIdentity: 'skill://readers',
      packageOrigin: 'test',
      interfaceRevision: '1',
      registeredGeneration: 'generation-1',
      exports: [`reader_${index}`],
      source: `def reader_${index}():\n    return open("input-${index}.csv")`,
      sourceDigest: `digest-${index}`
    }))
    const context = await fileContext(
      'python',
      ['reader_0()'],
      [{ helperModules, helperEvidenceStatus: { state: 'complete' } }]
    )
    expect(await analyzeNotebookSourceFileAccess('python', 'reader_0()', context)).toMatchObject({
      reads: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    [
      'unreachable statements after return',
      'def read_inputs():\n    return 1\n    open("dead.csv")'
    ],
    ['lazy generator bodies', 'def read_inputs():\n    yield open("lazy.csv")']
  ])('keeps helper replay partial for %s', async (_label, source) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [{ source, exports: ['read_inputs'] }]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it('does not attribute top-level helper import I/O to a later call', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'open("import.csv")\ndef read_inputs():\n    return 1',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it.each([
    'try:\n    raise Exception()\nexcept Exception as read_inputs:\n    pass',
    'match replacement:\n    case read_inputs:\n        pass'
  ])('does not replay helper exports overwritten by capture bindings: %s', async (suffix) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: `def read_inputs():\n    return open("old.csv")\ndef replacement():\n    return open("new.csv")\n${suffix}`,
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it.each(['nonlocal', 'global'])(
    'does not certify stale helper reads after %s rebinding',
    async (scope) => {
      const reader = 'def read():\n    return open("old.csv")'
      const source =
        scope === 'global'
          ? `${reader}\ndef read_inputs():\n    def mutate():\n        global read\n        read = lambda: None\n    mutate()\n    return read()`
          : `def read_inputs():\n    ${reader.replaceAll('\n', '\n    ')}\n    def mutate():\n        nonlocal read\n        read = lambda: None\n    mutate()\n    return read()`
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [{ source, exports: ['read_inputs'] }]
      }
      expect(
        await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)
      ).toMatchObject({
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('invalidates an exception alias before replaying a later notebook call', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        { source: 'def read_inputs():\n    return open("old.csv")', exports: ['read_inputs'] }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'try:\n    raise Exception()\nexcept Exception as read_inputs:\n    pass\nread_inputs()',
        context
      )
    ).toMatchObject({ reads: [], readState: 'partial' })
  })

  it('does not restore module globals on a later exported helper call', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'path = "old.csv"\ndef mutate():\n    global path\n    path = "new.csv"\ndef read_inputs():\n    return open(path)',
          exports: ['mutate', 'read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'mutate()\nread_inputs()', context)
    ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
  })

  it('keeps ordinary exception handling without rebinding a helper analyzable', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def read_inputs():\n    try:\n        return open("input.csv")\n    except Exception:\n        pass',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      { reads: ['input.csv'], readState: 'complete' }
    )
  })

  it('keeps private functions in their defining helper module', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'def _read():\n    return open("first.csv")\ndef first():\n    return _read()',
          exports: ['first']
        },
        {
          source: 'def _read():\n    return open("second.csv")\ndef second():\n    return _read()',
          exports: ['second']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'first()', context)).toMatchObject({
      reads: ['first.csv']
    })
  })

  it('resolves a nested helper reader against its enclosing local bindings', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def read_inputs():\n    path = "nested.csv"\n    def read():\n        return open(path)\n    return read()',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      { reads: ['nested.csv'], readState: 'complete' }
    )
  })

  it('keeps conditional nested helper definitions partial', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def read_inputs():\n    if enabled:\n        def read():\n            return open("first.csv")\n    else:\n        def read():\n            return open("second.csv")\n    return read()',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      { reads: [], readState: 'partial', externalState: 'partial' }
    )
  })

  it.each([
    ['path = "global.csv"', 'path = "local.csv"', 'return open(path)', ['local.csv']],
    [
      'paths = ["global.csv"]',
      'paths = ["local.csv"]',
      'for path in paths:\n            open(path)',
      ['local.csv']
    ]
  ])(
    'preserves captured locals over same-named module bindings: %s',
    async (global, local, body, reads) => {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [
          {
            source: `${global}\ndef read_inputs():\n    ${local}\n    def read():\n        ${body}\n    return read()`,
            exports: ['read_inputs']
          }
        ]
      }
      expect(
        await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)
      ).toMatchObject({
        reads,
        readState: 'complete'
      })
    }
  )

  it('loads globals from a separately recorded helper module during nested calls', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'def first():\n    return second()',
          exports: ['first']
        },
        {
          source: 'INPUT_PATH = "second.csv"\ndef second():\n    return open(INPUT_PATH)',
          exports: ['second']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'first()', context)).toMatchObject({
      reads: ['second.csv'],
      readState: 'complete'
    })
  })

  it('keeps caller namespace taints while replaying recorded helpers', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonTaintedNamespaces: ['pandas'],
      pythonHelperModules: [
        {
          source: 'import pandas as pd\ndef read_inputs():\n    return pd.read_csv("input.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it('does not expand a helper after a loop target rebinds its export', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'def read_inputs():\n    return open("input.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'for read_inputs in [None]:\n    pass\nvalue = read_inputs()',
        context
      )
    ).toMatchObject({ reads: [] })
  })

  it('does not certify an export without a matching callable body', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [{ source: 'value = 1', exports: ['read_inputs'] }]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      { readState: 'partial', externalState: 'partial' }
    )
  })

  it('drops recorded helper evidence after an unsafe entry', () => {
    const context = projectNotebookFileContext('python', [
      {
        facts: { state: 'available', definedNames: [], usedNames: [], mutatedNames: [] },
        fileContext: {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          pythonHelperModules: [{ source: 'def read_inputs(): pass', exports: ['read_inputs'] }]
        }
      },
      {
        facts: { state: 'unknown', reasons: ['opaque-mutation'] },
        fileContext: { staticStrings: [], staticCollections: [], localFileWrappers: [] }
      }
    ])
    expect(context?.pythonHelperModules).toBeUndefined()
  })

  it('keeps prior Python value resolution without certifying pure helper file effects', async () => {
    const context = await fileContext('python', [
      'scale = 2\ndef label(value):\n    return str(value * scale)'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('python', 'text = label(3)', context)
    ).toMatchObject({
      readState: 'complete',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not replay an async helper before it is awaited', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'async def read_inputs():\n    return open("async.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({ reads: [], readState: 'partial' })
  })

  it('keeps helper aliases unresolved when the alias is not replayed', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'def read_inputs():\n    return open("aliased.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'reader = read_inputs\nvalue = reader()',
        context
      )
    ).toMatchObject({ reads: [], readState: 'partial' })
  })

  it('does not certify decorated helper exports from their raw function body', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def decorate(fn):\n    return fn\n@decorate\ndef read_inputs():\n    return open("decorated.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
  })

  it('keeps helper delegation to opaque callables partial', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'def read_inputs():\n    return transform("input.dat")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    ['path="input.csv"', '', ['input.csv']],
    ['unused, path="input.csv"', '1', ['input.csv']],
    ['path="input.csv", /', '', ['input.csv']],
    ['*, path="input.csv"', '', ['input.csv']],
    ['path="input.csv"', '"override.csv"', ['override.csv']],
    ['*, path="input.csv"', 'path="override.csv"', ['override.csv']]
  ])('binds literal helper defaults: %s (%s)', async (parameters, arguments_, reads) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: `def read_inputs(${parameters}):\n    return open(path)`,
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', `read_inputs(${arguments_})`, context)
    ).toMatchObject({
      reads,
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it('does not resolve helper defaults against caller bindings', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [{ name: 'DEFAULT_PATH', value: 'caller.csv' }],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'DEFAULT_PATH = "module.csv"\ndef read_inputs(path=DEFAULT_PATH):\n    return open(path)',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it.each([
    'import custom_loader',
    'from custom_loader import value',
    'import pandas.custom_plugin',
    'from . import custom_loader',
    'if enabled:\n    import custom_loader'
  ])('keeps unknown helper imports partial: %s', async (imports) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: `${imports}\ndef read_inputs():\n    return open("input.csv")`,
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: ['input.csv'],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it.each([
    ['path', '"a.csv", "b.csv"'],
    ['path', 'path="a.csv", extra=1'],
    ['path', '"a.csv", path="b.csv"'],
    ['path', 'path="a.csv", path="b.csv"'],
    ['path', ''],
    ['*, path', '"a.csv"'],
    ['path, /', 'path="a.csv"'],
    ['path', '*["a.csv"]'],
    ['path', '**{"path": "a.csv"}'],
    ['path, *, required', '"a.csv"']
  ])(
    'does not replay invalid or ambiguous helper arguments: %s (%s)',
    async (parameters, arguments_) => {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [
          {
            source: `def read_inputs(${parameters}):\n    return open("body.csv")`,
            exports: ['read_inputs']
          }
        ]
      }
      expect(
        await analyzeNotebookSourceFileAccess('python', `read_inputs(${arguments_})`, context)
      ).toMatchObject({
        reads: [],
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it.each([
    ['path, *args', '"input.csv", 1'],
    ['path, **kwargs', 'path="input.csv", extra=1'],
    ['path, /, **kwargs', '"input.csv", path="other.csv"'],
    ['path="input.csv", /, **kwargs', 'path="other.csv"']
  ])('accepts supported variadic helper arguments: %s (%s)', async (parameters, arguments_) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: `def read_inputs(${parameters}):\n    return open(path)`,
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', `read_inputs(${arguments_})`, context)
    ).toMatchObject({
      reads: ['input.csv'],
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it('keeps recursive helper replay partial', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def read_inputs(path):\n    if path == "done":\n        return open(path)\n    return read_inputs("done")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs("start")', context)
    ).toMatchObject({ readState: 'partial', externalState: 'partial' })
  })

  it('does not leak helper-local possible aliases into caller analysis', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [
        { name: 'paths', values: ['old.txt'] },
        { name: 'alias', values: ['alias.txt'] }
      ],
      staticCollectionAliases: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def read_inputs():\n    if enabled:\n        alias = paths\n    return open("input.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'value = read_inputs()\nalias.append("new.txt")\nfor path in paths:\n    open(path, "w").close()',
        context
      )
    ).toMatchObject({
      reads: ['input.csv'],
      writes: ['old.txt'],
      writeState: 'complete',
      externalState: 'complete'
    })
  })

  it.each([
    'class Loader:\n    source = open("class.csv")',
    'def decorate(fn):\n    open("decorator.csv")\n    return fn\n@decorate\ndef registered():\n    pass',
    'def registered(value=open("default.csv")):\n    pass',
    'def registered(value: factory()):\n    pass',
    'def registered() -> factory():\n    pass'
  ])('keeps unmodeled helper import effects partial: %s', async (definition) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: `${definition}\ndef read_inputs():\n    return open("input.csv")`,
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({
      reads: ['input.csv'],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([
    ['reader', 'reader', 'lambda: open("callback.csv")'],
    ['*, reader', 'reader', 'reader=lambda: open("callback.csv")'],
    ['open', 'open', 'lambda: open("callback.csv")']
  ])(
    'does not dispatch a callable helper parameter to a same-named binding: %s',
    async (signature, name, argument) => {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [
          {
            source: `def reader():\n    return open("private.csv")\ndef read_inputs(${signature}):\n    return ${name}()`,
            exports: ['read_inputs']
          }
        ]
      }
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        `value = read_inputs(${argument})`,
        context
      )
      expect(result).toMatchObject({ readState: 'partial', externalState: 'partial' })
      expect(result?.reads).not.toContain('private.csv')
    }
  )

  it('replays an async helper when its call is awaited', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'async def read_inputs():\n    return open("async.csv")',
          exports: ['read_inputs']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = await read_inputs()', context)
    ).toMatchObject({ reads: ['async.csv'], readState: 'complete', externalState: 'complete' })
  })

  it('does not inherit await status inside an async helper body', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'async def outer():\n    return inner()\nasync def inner():\n    return open("inner.csv")',
          exports: ['outer', 'inner']
        }
      ]
    }
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = await outer()', context)
    ).toMatchObject({ reads: [], readState: 'partial', externalState: 'partial' })
  })

  it('captures fixed input paths inside a recorded Python helper called in a later cell', async () => {
    const helperSource =
      'import pandas as pd\ndef read_inputs():\n    left = pd.read_csv("left.csv")\n    right = pd.read_csv("right.csv")\n    return left'
    const context = await fileContext(
      'python',
      ['data = read_inputs()'],
      [
        {
          helperModules: [
            {
              helperId: 'csv-helper',
              skillIdentity: 'skill://csv-helper',
              packageOrigin: 'test',
              interfaceRevision: '1',
              registeredGeneration: 'generation-1',
              exports: ['read_inputs'],
              source: helperSource,
              sourceDigest: 'digest-csv-helper'
            }
          ],
          helperEvidenceStatus: { state: 'complete' }
        }
      ]
    )
    expect(
      await analyzeNotebookSourceFileAccess('python', 'data = read_inputs()', context)
    ).toMatchObject({
      reads: ['left.csv', 'right.csv'],
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it('keeps pandas groupby input/output complete inside a recorded helper', async () => {
    const helperSource = `import pandas as pd
def summarize(input_path, output_path):
    frame = pd.read_csv(input_path)
    frame.groupby("group", as_index=False)["value"].mean().to_csv(output_path, index=False)`
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'summarize("inputs/patients.csv", "outputs/summary.csv")',
        {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          pythonHelperModules: [{ source: helperSource, exports: ['summarize'] }]
        }
      )
    ).toMatchObject({
      reads: ['inputs/patients.csv'],
      writes: ['outputs/summary.csv'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reasonCodes: []
    })
  })

  it('does not reuse prior helper evidence after an incomplete helper load', async () => {
    const helper = {
      helperId: 'csv-helper',
      skillIdentity: 'skill://csv-helper',
      packageOrigin: 'test',
      interfaceRevision: '1',
      registeredGeneration: 'generation-1',
      exports: ['read_inputs'],
      source: 'def read_inputs():\n    return open("left.csv")',
      sourceDigest: 'digest-csv-helper'
    }
    const context = await fileContext(
      'python',
      ['value = read_inputs()', 'value = read_inputs()\nlabel = "retained"'],
      [
        { helperModules: [helper], helperEvidenceStatus: { state: 'complete' } },
        {
          helperModules: [helper],
          helperEvidenceStatus: { state: 'incomplete', reasons: ['payload-limit'] }
        }
      ]
    )
    const sidecar = JSON.parse(
      await readFile(
        join(roots.at(-1)!, 'notebooks/default-project/session-1/cache/dependency-analysis.json'),
        'utf8'
      )
    )
    expect(sidecar.runs['run-1'].fileContext.pythonHelperModules).toBeUndefined()
    expect(sidecar.runs['run-1'].fileContext.staticStrings).toContainEqual({
      name: 'label',
      value: 'retained'
    })
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      externalState: 'partial'
    })
  })

  it('does not suppress helper evidence recorded by an unsuccessful run', async () => {
    const helper = {
      helperId: 'csv-helper',
      skillIdentity: 'skill://csv-helper',
      packageOrigin: 'test',
      interfaceRevision: '1',
      registeredGeneration: 'generation-1',
      exports: ['read_inputs'],
      source: 'def read_inputs():\n    return open("left.csv")',
      sourceDigest: 'digest-csv-helper'
    }
    const context = await fileContext(
      'python',
      ['value = 1', 'value = read_inputs()'],
      [
        {
          status: 'failed',
          kernelDispatched: true,
          helperModules: [helper],
          helperEvidenceStatus: { state: 'complete' }
        },
        { helperModules: [helper], helperEvidenceStatus: { state: 'complete' } }
      ]
    )
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({
      reads: ['left.csv'],
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it('replays helper module constants and private reader functions', async () => {
    const helperSource = `import pandas as pd
INPUT_PATH = "left.csv"
def _read(path):
    return pd.read_csv(path)
def read_inputs():
    return _read(INPUT_PATH)`
    const context = await fileContext(
      'python',
      ['data = read_inputs()'],
      [
        {
          helperModules: [
            {
              helperId: 'csv-helper',
              skillIdentity: 'skill://csv-helper',
              packageOrigin: 'test',
              interfaceRevision: '1',
              registeredGeneration: 'generation-1',
              exports: ['read_inputs'],
              source: helperSource,
              sourceDigest: 'digest-csv-helper'
            }
          ],
          helperEvidenceStatus: { state: 'complete' }
        }
      ]
    )
    expect(
      await analyzeNotebookSourceFileAccess('python', 'data = read_inputs()', context)
    ).toMatchObject({
      reads: ['left.csv'],
      readState: 'complete',
      externalState: 'complete'
    })
  })

  it('does not expand a recorded helper after its exported name is rebound', async () => {
    const context = await fileContext(
      'python',
      ['read_inputs = lambda: None\nvalue = read_inputs()'],
      [
        {
          helperModules: [
            {
              helperId: 'csv-helper',
              skillIdentity: 'skill://csv-helper',
              packageOrigin: 'test',
              interfaceRevision: '1',
              registeredGeneration: 'generation-1',
              exports: ['read_inputs'],
              source: 'import pandas as pd\ndef read_inputs():\n    return pd.read_csv("left.csv")',
              sourceDigest: 'digest-csv-helper'
            }
          ],
          helperEvidenceStatus: { state: 'complete' }
        }
      ]
    )
    expect(context?.pythonHelperModules).toBeUndefined()
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      { reads: [] }
    )
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'read_inputs = lambda: None\nvalue = read_inputs()',
        context
      )
    ).toMatchObject({ reads: [], writeState: 'complete' })
  })

  it('does not replay a helper whose export is rebound to another callable', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source:
            'def read_inputs():\n    return open("old.csv")\ndef replacement():\n    return open("new.csv")\nread_inputs = replacement',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it('does not replay an exported helper after a class rebind', async () => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: 'def read_inputs():\n    return open("old.csv")\nclass read_inputs:\n    pass',
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      { reads: [], readState: 'partial', externalState: 'partial' }
    )
  })

  it.each([
    'if True:\n    read_inputs = replacement',
    'if enabled:\n    def read_inputs():\n        return open("new.csv")',
    'try:\n    read_inputs = replacement\nexcept Exception:\n    pass',
    'try:\n    pass\nfinally:\n    read_inputs = replacement',
    'while enabled:\n    read_inputs = replacement\n    break',
    'with manager() as resource:\n    read_inputs = replacement',
    'with manager() as read_inputs:\n    pass',
    'match value:\n    case 1:\n        read_inputs = replacement',
    'for item in items:\n    read_inputs = replacement',
    'if enabled:\n    read_inputs, other = replacement, None',
    'if enabled:\n    import custom_reader as read_inputs',
    'if enabled:\n    from custom_reader import reader as read_inputs',
    'if enabled:\n    del read_inputs',
    '@decorate\ndef read_inputs():\n    return open("new.csv")'
  ])('does not replay an export that may be rebound in module control flow: %s', async (rebind) => {
    const context: NotebookSourceFileAccessContext = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      pythonHelperModules: [
        {
          source: `def read_inputs():\n    return open("old.csv")\ndef replacement():\n    return open("new.csv")\n${rebind}`,
          exports: ['read_inputs']
        }
      ]
    }
    expect(await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)).toMatchObject(
      {
        reads: [],
        readState: 'partial',
        externalState: 'partial'
      }
    )
  })

  it.each([
    'def unrelated():\n    read_inputs = None',
    'if enabled:\n    unrelated = None',
    'if enabled:\n    read_inputs = None\ndef read_inputs():\n    return open("old.csv")'
  ])(
    'preserves a proven final export after unrelated or overwritten bindings: %s',
    async (suffix) => {
      const context: NotebookSourceFileAccessContext = {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        pythonHelperModules: [
          {
            source: `def read_inputs():\n    return open("old.csv")\n${suffix}`,
            exports: ['read_inputs']
          }
        ]
      }
      expect(
        await analyzeNotebookSourceFileAccess('python', 'read_inputs()', context)
      ).toMatchObject({
        reads: ['old.csv'],
        readState: 'complete'
      })
    }
  )

  it('drops helper evidence after a cross-cell export rebind', async () => {
    const context = await fileContext(
      'python',
      ['value = 1', 'read_inputs = lambda: None'],
      [
        {
          helperModules: [
            {
              helperId: 'csv-helper',
              skillIdentity: 'skill://csv-helper',
              packageOrigin: 'test',
              interfaceRevision: '1',
              registeredGeneration: 'generation-1',
              exports: ['read_inputs'],
              source: 'import pandas as pd\ndef read_inputs():\n    return pd.read_csv("left.csv")',
              sourceDigest: 'digest-csv-helper'
            }
          ],
          helperEvidenceStatus: { state: 'complete' }
        },
        {}
      ]
    )
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({ reads: [] })
  })

  it('does not restore invalidated helper evidence from sticky run metadata', async () => {
    const helperModules = [
      {
        helperId: 'csv-helper',
        skillIdentity: 'skill://csv-helper',
        packageOrigin: 'test',
        interfaceRevision: '1',
        registeredGeneration: 'generation-1',
        exports: ['read_inputs'],
        source: 'import pandas as pd\ndef read_inputs():\n    return pd.read_csv("left.csv")',
        sourceDigest: 'digest-csv-helper'
      }
    ]
    const context = await fileContext(
      'python',
      ['value = 1', 'read_inputs = lambda: None', 'value = read_inputs()'],
      [
        { helperModules, helperEvidenceStatus: { state: 'complete' } },
        { helperModules, helperEvidenceStatus: { state: 'complete' } },
        { helperModules, helperEvidenceStatus: { state: 'complete' } }
      ]
    )
    expect(context?.pythonHelperModules).toBeUndefined()
    expect(
      await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
    ).toMatchObject({
      reads: []
    })
  })

  it.each(['python', 'r'] as const)(
    'restores %s diagnostic path bindings after cache reload',
    async (language) => {
      const context = await fileContext(language, [
        language === 'python'
          ? 'import os\nfrom pathlib import Path\nfolder="out"\npath=Path(folder)/"plot.png"'
          : 'folder <- "out"; path <- file.path(folder,"plot.png")'
      ])
      const diagnostic =
        language === 'python'
          ? 'print(f"Saved: {path} ({os.path.getsize(path)} bytes)")'
          : 'cat(sprintf("Saved: %s (%s bytes)",path,file.size(path)))'
      expect(await analyzeNotebookSourceFileAccess(language, diagnostic, context)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete'
      })
      const rebind = language === 'python' ? 'path=custom_path()\n' : 'path <- custom_path(); '
      expect(
        (await analyzeNotebookSourceFileAccess(language, rebind + diagnostic, context))
          .externalState
      ).toBe('partial')
    }
  )

  it('retains Python console observation identities after cache reload', async () => {
    const context = await fileContext('python', ['import os as fs\nfrom pathlib import Path'])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'print(fs.getcwd())\nprint(Path("plot.png").stat().st_size)',
        context
      )
    ).toMatchObject({ readState: 'complete', writeState: 'complete', externalState: 'complete' })
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'open("report.txt","w").write(fs.getcwd())',
        context
      )
    ).toMatchObject({ externalState: 'partial' })
  })

  it('retains R logical subsets across blocks and cache reloads', async () => {
    const context = await fileContext('r', [
      'paths <- c("keep.txt", "skip.txt", "last.txt")',
      'selected <- paths[c(TRUE,FALSE)]',
      'paths <- c("replacement.txt")'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('r', 'for (path in selected) readLines(path)', context)
    ).toMatchObject({
      reads: ['keep.txt', 'last.txt'],
      readState: 'complete'
    })
  })

  it('retains shadowed R sequence identity across cache reloads', async () => {
    const context = await fileContext('r', [
      'paths <- c("keep.txt", "skip.txt")',
      'seq_along <- function(x) c(2L)'
    ])
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'r',
          'for (path in paths[seq_along(paths)]) readLines(path)',
          context
        )
      ).readState
    ).toBe('partial')
  })

  it.each(['python', 'r'] as const)(
    'retains independent %s subsets after the original changes and the cache reopens',
    async (language) => {
      const scripts =
        language === 'python'
          ? ['paths = ["keep.txt", "other.txt"]', 'selected = paths[:]', 'paths[0] = "changed.txt"']
          : [
              'paths <- c("keep.txt", "other.txt")',
              'selected <- paths[c(1,2)]',
              'paths[1] <- "changed.txt"'
            ]
      const context = await fileContext(language, scripts)
      const code = language === 'python' ? 'open(selected[0]).read()' : 'readLines(selected[[1]])'
      expect(await analyzeNotebookSourceFileAccess(language, code, context)).toMatchObject({
        reads: ['keep.txt'],
        readState: 'complete'
      })
      expect(context?.staticCollections.some(({ name }) => name === 'paths')).toBe(false)
    }
  )
  it.each(['python', 'r'] as const)(
    'shares parsing when projecting %s dependency and path context',
    async (language) => {
      const source =
        language === 'python' ? 'path = "inputs/counts.csv"' : 'path <- "inputs/counts.csv"'
      await analyzeNotebookSourceFileAccess(language, source)
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const context = await fileContext(language, [source])
      expect(context?.staticStrings).toContainEqual({ name: 'path', value: 'inputs/counts.csv' })
      expect(parse).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    [
      'python',
      'import xarray as xr\ndef read_inputs(paths):\n    return xr.open_mfdataset(paths)',
      'read_inputs(["inputs/a.nc", "inputs/b.nc"])',
      'paths',
      ['inputs/a.nc', 'inputs/b.nc']
    ],
    [
      'python',
      'import numpy as np\ndef read_inputs(lines):\n    return np.loadtxt(lines)',
      'read_inputs(["1 2", "3 4"])',
      'lines',
      []
    ],
    [
      'r',
      'read_inputs <- function(paths) Biostrings::readDNAStringSet(paths)',
      'read_inputs(c("inputs/a.fa", "inputs/b.fa"))',
      'paths',
      ['inputs/a.fa', 'inputs/b.fa']
    ]
  ] as const)(
    'retains %s wrapper input forms after cache reload',
    async (language, setup, call, inputForm, reads) => {
      const context = await fileContext(language, [setup])
      expect(context?.localFileWrappers).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'read_inputs', inputForm })])
      )
      expect(await analyzeNotebookSourceFileAccess(language, call, context)).toMatchObject({
        readState: 'complete',
        reads
      })
    }
  )

  it('does not reuse a builtin callback after same-run replacement and reopening', async () => {
    const context = await fileContext('r', [
      'formatter <- function(x) round(x)\nround <- function(x) readRDS("hidden.rds")'
    ])
    expect(context?.rFunctions?.map(({ name }) => name) ?? []).not.toContain('formatter')
    for (const fn of ['formatter', 'round', 'function(x) round(x)']) {
      expect(
        await analyzeNotebookSourceFileAccess('r', `result <- lapply(1:3, ${fn})`, context)
      ).toMatchObject({ readState: 'partial' })
    }
  })

  it('rebuilds R callable summaries after reopening and records invocation-time closure reads', async () => {
    const context = await fileContext('r', [
      'factor <- 2\nformatter <- function(x) round(x * factor)',
      'factor <- 3'
    ])
    expect(context?.rFunctions?.map(({ name }) => name)).toContain('formatter')
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'result <- lapply(1:3, formatter)\nwrite.csv(result, "result.csv")',
        context
      )
    ).toMatchObject({ readState: 'complete', writeState: 'complete', writes: ['result.csv'] })
    const sidecar = await readFile(
      join(roots.at(-1)!, 'notebooks/default-project/session-1/cache/dependency-analysis.json'),
      'utf8'
    )
    expect(sidecar).toContain('r-function')
    expect(sidecar).not.toContain('"rFunctions"')
  })

  it.each([
    ['formatter <- function(x) round(x)', 'formatter <- function(x) readRDS("hidden.rds")'],
    ['formatter <- function(x) round(x)', 'round <- function(x) readRDS("hidden.rds")']
  ])('discards unsafe R callable knowledge after replacement: %s', async (...scripts) => {
    const context = await fileContext('r', scripts)
    // An opaque replacement can retain its identity, but never the old read-only contract.
    expect(
      context?.rFunctions
        ?.filter(({ summary }) => summary.methods.every((method) => method.effect === 'read'))
        .map(({ name }) => name) ?? []
    ).not.toContain('formatter')
    expect(
      await analyzeNotebookSourceFileAccess('r', 'result <- lapply(1:3, formatter)', context)
    ).toMatchObject({ readState: 'partial' })
  })

  const cases = [
    {
      language: 'python',
      name: 'append',
      scripts: ["paths = ['old.txt']", "paths.append('new.txt')"]
    },
    {
      language: 'python',
      name: 'subscript',
      scripts: ["paths = ['old.txt']", "paths[0] = 'new.txt'"]
    },
    {
      language: 'python',
      name: 'alias',
      scripts: ["paths = ['old.txt']", 'alias = paths', "alias[0] = 'new.txt'"]
    },
    {
      language: 'python',
      name: 'conditional alias',
      scripts: ["paths = ['old.txt']", 'if enabled:\n    alias = paths', "alias.append('new.txt')"]
    },
    {
      language: 'python',
      name: 'augmented assignment',
      scripts: ["paths = ['old.txt']", "paths += ['new.txt']"]
    },
    { language: 'python', name: 'deletion', scripts: ["paths = ['old.txt']", 'del paths[0]'] },
    {
      language: 'python',
      name: 'explicit setitem',
      scripts: ["paths = ['old.txt']", "paths.__setitem__(0, 'new.txt')"]
    },
    {
      language: 'python',
      name: 'explicit in-place addition',
      scripts: ["paths = ['old.txt']", "paths.__iadd__(['new.txt'])"]
    },
    {
      language: 'python',
      name: 'conditional rebind',
      scripts: [
        "paths = ['old.txt']",
        'alias = paths',
        "if enabled:\n    alias = ['other.txt']",
        "alias.append('new.txt')"
      ]
    },
    {
      language: 'r',
      name: 'replacement',
      scripts: ["paths <- c('old.txt', 'other.txt')", "paths[1] <- 'new.txt'"]
    }
  ] as const

  it.each(cases)(
    'does not reuse stale $language paths after $name across runs',
    async ({ language, scripts }) => {
      const context = await fileContext(language, [...scripts])
      const result = await analyzeNotebookSourceFileAccess(
        language,
        language === 'python'
          ? "for path in paths:\n    open(path, 'w').close()"
          : "for (path in paths) writeLines('data', path)",
        context
      )
      expect(result.writeState).toBe('partial')
      expect(result.writes).toEqual([])
    }
  )

  it.each(cases)(
    'does not enumerate stale $language paths after $name in one run',
    async ({ language, scripts }) => {
      const result = await analyzeNotebookSourceFileAccess(
        language,
        [
          ...scripts,
          language === 'python'
            ? "for path in paths:\n    open(path, 'w').close()"
            : "for (path in paths) writeLines('data', path)"
        ].join('\n')
      )
      expect(result.writeState).toBe('partial')
      expect(result.writes).toEqual([])
    }
  )

  it('invalidates persisted Python aliases during the current run', async () => {
    const context = await fileContext('python', ["paths = ['old.txt']", 'alias = paths'])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      ["alias.append('new.txt')", 'for path in paths:', "    open(path, 'w').close()"].join('\n'),
      context
    )
    expect(result.writeState).toBe('partial')
    expect(result.writes).toEqual([])
  })

  it('rebuilds alias identities without persisting transient context fields', async () => {
    const context = await fileContext('python', ["paths = ['old.txt']", 'alias = paths'])
    expect(context?.staticCollectionAliases).toHaveLength(1)
    const sidecar = await readFile(
      join(
        roots.at(-1)!,
        'notebooks',
        'default-project',
        'session-1',
        'cache',
        'dependency-analysis.json'
      ),
      'utf8'
    )
    expect(sidecar).not.toContain('staticCollectionAliases')
    expect(sidecar).not.toContain('resolvedKernelNames')
  })

  it('invalidates stale read paths as well as writes', async () => {
    const context = await fileContext('python', ["paths = ['old.txt']", "paths.append('new.txt')"])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      'for path in paths:\n    open(path).read()',
      context
    )
    expect(result.readState).toBe('partial')
    expect(result.reads).toEqual([])
  })

  it('does not enumerate a Python iterable that the loop body mutates', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      [
        "paths = ['old.txt']",
        'for path in paths:',
        "    if path == 'old.txt':",
        "        paths.append('new.txt')",
        "    open(path, 'w').close()"
      ].join('\n')
    )
    expect(result.writeState).toBe('partial')
    expect(result.writes).toEqual([])
  })

  it.each([false, true])(
    'invalidates live Python iteration through an alias (%s)',
    async (viaAlias) => {
      const result = await analyzeNotebookSourceFileAccess(
        'python',
        [
          "paths = ['first.txt', 'old.txt']",
          'alias = paths',
          'for path in paths:',
          `    ${viaAlias ? 'alias' : 'paths'}[1] = 'new.txt'`,
          "    open(path, 'w').close()"
        ].join('\n')
      )
      expect(result.writeState).toBe('partial')
      expect(result.writes).toEqual([])
    }
  )

  it('updates a static Python collection after a walrus assignment', async () => {
    const source = [
      "paths = ['old.txt']",
      "(paths := ['new.txt'])",
      "for path in paths:\n    open(path, 'w').close()"
    ].join('\n')
    const result = await analyzeNotebookSourceFileAccess('python', source)
    expect(result.writeState).toBe('complete')
    expect(result.writes).toEqual(['new.txt'])
  })

  it('does not persist values derived from invalidated Python iteration', async () => {
    const context = await fileContext('python', [
      "paths = ['first.txt', 'old.txt']",
      "for path in paths:\n    paths[1] = 'new.txt'\n    last = path"
    ])
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      "open(last, 'w').close()",
      context
    )
    expect(result.writeState).toBe('partial')
    expect(result.writes).toEqual([])
  })

  it('preserves independent collections after a mutation', async () => {
    const context = await fileContext('python', [
      "paths = ['old.txt']\nindependent = ['keep.txt']",
      "paths.append('new.txt')"
    ])
    expect(context?.staticCollections).toEqual([{ name: 'independent', values: ['keep.txt'] }])
  })

  it('detaches a rebound Python alias before later mutation', async () => {
    const context = await fileContext('python', [
      "paths = ['keep.txt']",
      'alias = paths',
      "alias = ['other.txt']",
      "alias.append('new.txt')"
    ])
    expect(context?.staticCollections).toEqual([{ name: 'paths', values: ['keep.txt'] }])
  })

  it('retains possible references through a conditional alias rebind', async () => {
    const context = await fileContext('python', [
      "paths = ['old.txt']",
      'alias = paths',
      "if enabled:\n    alias = ['other.txt']",
      "alias.append('new.txt')"
    ])
    expect(context?.staticCollections).toEqual([])
  })

  it('preserves an R copy when its source vector is replaced', async () => {
    const context = await fileContext('r', [
      "paths <- c('keep.txt', 'other.txt')",
      'copied <- paths',
      "paths[1] <- 'new.txt'"
    ])
    expect(context?.staticCollections).toEqual([
      { name: 'copied', values: ['keep.txt', 'other.txt'], rKind: 'vector' }
    ])
  })

  it('preserves the R iteration snapshot when its original vector is replaced', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      [
        "paths <- c('first.txt', 'old.txt')",
        'for (path in paths) {',
        "  paths[2] <- 'new.txt'",
        "  writeLines('data', path)",
        '}'
      ].join('\n')
    )
    expect(result.writeState).toBe('complete')
    expect(result.writes).toEqual(['first.txt', 'old.txt'])
  })

  it.each(['python', 'r'] as const)(
    'recovers %s paths defined after a failed run without reviving prior values',
    async (language) => {
      const scripts =
        language === 'python'
          ? ["old_path = 'old.txt'", "raise RuntimeError('failed')", "new_path = 'new.txt'"]
          : ["old_path <- 'old.txt'", "stop('failed')", "new_path <- 'new.txt'"]
      const context = await fileContext(
        language,
        scripts,
        [{}, { status: 'failed', kernelDispatched: true }],
        false
      )
      expect(context?.staticStrings).toEqual([{ name: 'new_path', value: 'new.txt' }])
      expect(context?.resolvedKernelNames ?? []).not.toContain('old_path')
    }
  )

  it('retains prior values when the failed run never reached the kernel', async () => {
    const context = await fileContext(
      'python',
      ["path = 'keep.txt'", "path = 'other.txt'"],
      [{}, { status: 'failed', kernelDispatched: false }]
    )
    expect(context?.staticStrings).toEqual([{ name: 'path', value: 'keep.txt' }])
  })

  it('recovers a fresh collection after mutation and explicit reassignment', async () => {
    const context = await fileContext('python', [
      "paths = ['old.txt']",
      "paths.append('extra.txt')\npaths = ['fresh.txt']"
    ])
    expect(context?.staticCollections).toEqual([{ name: 'paths', values: ['fresh.txt'] }])
  })
})

describe('cross-cell biomedical readers', () => {
  it('retains a static MGF writer mode through persisted context', async () => {
    const context = await fileContext('python', ['from pyteomics import mgf', 'mode = "a"'])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'mgf.write([], output="out.mgf", file_mode=mode)',
        context
      )
    ).toMatchObject({ reads: ['out.mgf'], writes: ['out.mgf'], externalState: 'complete' })
  })

  it('retains a proteomics reader alias through persisted context', async () => {
    const context = await fileContext('python', [
      'from pyteomics.mgf import MGF as read_spectra',
      'path = "inputs/spectra.mgf"'
    ])
    expect(
      await analyzeNotebookSourceFileAccess('python', 'reader = read_spectra(path)', context)
    ).toMatchObject({ reads: ['inputs/spectra.mgf'], externalState: 'complete' })
  })

  it('retains a named sample file vector across R cells and cache reload', async () => {
    const context = await fileContext('r', [
      'library(tximport)',
      'files <- c(A="inputs/A/quant.sf", B="inputs/B/quant.sf")'
    ])
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'txi <- tximport(files, type="salmon", txOut=TRUE, dropInfReps=TRUE)',
        context
      )
    ).toMatchObject({
      reads: ['inputs/A/quant.sf', 'inputs/B/quant.sf'],
      externalState: 'complete'
    })
  })
  it.each([
    [
      'import SimpleITK as sitk',
      'image = sitk.ReadImage("inputs/ct.nii.gz")',
      ['inputs/ct.nii.gz'],
      'complete'
    ],
    [
      'from SimpleITK import ReadImage as read_image',
      'image = read_image("inputs/ct.nii.gz")',
      ['inputs/ct.nii.gz'],
      'complete'
    ],
    [
      'from radiomics import featureextractor\nextractor = featureextractor.RadiomicsFeatureExtractor()',
      'features = extractor.execute("inputs/ct.nii.gz", "inputs/mask.nii.gz")',
      ['inputs/ct.nii.gz', 'inputs/mask.nii.gz'],
      'partial'
    ]
  ])(
    'retains the reader identity after cache reload: %s',
    async (setup, source, reads, externalState) => {
      const context = await fileContext('python', [setup])
      expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
        reads,
        externalState
      })
    }
  )
})

it('retains a file object constructed in a later cell and then aliased', async () => {
  const context = await fileContext('python', [
    'from radiomics import featureextractor',
    'extractor = featureextractor.RadiomicsFeatureExtractor()',
    'alias = extractor'
  ])
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'alias.loadParams("inputs/settings.yaml")',
      context
    )
  ).toMatchObject({ reads: ['inputs/settings.yaml'], externalState: 'partial' })
})

it.each([
  'sitk = object()',
  'if flag:\n    sitk = object()',
  'del sitk',
  'def sitk():\n    return 1'
])('forgets a previous reader after rebinding or mutation: %s', async (replacement) => {
  const context = await fileContext('python', ['import SimpleITK as sitk', replacement])
  expect(context?.pythonBindings?.some((binding) => binding.name === 'sitk') ?? false).toBe(false)
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("unused.nii.gz")', context)
  ).toMatchObject({ reads: [] })
})

it('rebuilds helper evidence after a kernel epoch restart', async () => {
  const helperModules = [
    {
      helperId: 'csv-helper',
      skillIdentity: 'skill://csv-helper',
      packageOrigin: 'test',
      interfaceRevision: '1',
      registeredGeneration: 'generation-1',
      exports: ['read_inputs'],
      source: 'def read_inputs():\n    return open("restarted.csv")',
      sourceDigest: 'digest-csv-helper'
    }
  ]
  const context = await fileContext(
    'python',
    ['value = 1', 'value = read_inputs()'],
    [
      {
        kernelEpochId: 'epoch-old',
        helperModules,
        helperEvidenceStatus: { state: 'complete' }
      },
      {
        kernelEpochId: 'epoch-new',
        helperModules,
        helperEvidenceStatus: { state: 'complete' }
      }
    ],
    true,
    undefined,
    'epoch-new'
  )
  expect(context?.pythonHelperModules).toEqual([
    { source: helperModules[0]!.source, exports: ['read_inputs'] }
  ])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'value = read_inputs()', context)
  ).toMatchObject({ reads: ['restarted.csv'], readState: 'complete' })
})

it('keeps a read before same-cell reassignment, but does not apply it after reassignment', async () => {
  const context = await fileContext('python', ['import SimpleITK as sitk'])
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'first = sitk.ReadImage("inputs/first.nii.gz")\nsitk = object()\nsecond = sitk.ReadImage("unused.nii.gz")',
      context
    )
  ).toMatchObject({ reads: ['inputs/first.nii.gz'] })
})

it('invalidates a mutated library through an alias', async () => {
  const context = await fileContext('python', [
    'import SimpleITK as sitk\nalias = sitk',
    'alias.ReadImage = replacement'
  ])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("unused.nii.gz")', context)
  ).toMatchObject({ reads: [], externalState: 'partial' })
})

it.each([
  { status: 'failed' as const },
  { kernelEpochId: 'other-epoch' },
  { environment: 'other-python' }
])('does not borrow identities from an invalid execution boundary: %j', async (override) => {
  const context = await fileContext('python', ['import SimpleITK as sitk'], [override])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("unused.nii.gz")', context)
  ).toMatchObject({ reads: [] })
})

it('preserves imported readers after an operation rejected before kernel dispatch', async () => {
  const context = await fileContext(
    'python',
    ['import SimpleITK as sitk', 'sitk = object()'],
    [{}, { status: 'failed', kernelDispatched: false }]
  )
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("inputs/ct.nii.gz")', context)
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it.each(['sitk.ReadImage = replacement', 'alias = sitk\nalias.ReadImage = replacement'])(
  'does not certify a patched library in the current cell: %s',
  async (patch) => {
    const context = await fileContext('python', [
      'import SimpleITK as sitk\nreplacement = lambda path: 1'
    ])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `${patch}\nsitk.ReadImage("unused.nii.gz")`,
        context
      )
    ).toMatchObject({ reads: [], externalState: 'partial' })
  }
)

it('does not treat re-importing a monkeypatched module as recovery', async () => {
  const context = await fileContext('python', [
    'import SimpleITK as sitk\nreplacement = lambda path: 1',
    'sitk.ReadImage = replacement',
    'import SimpleITK as recovered'
  ])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'recovered.ReadImage("unused.nii.gz")', context)
  ).toMatchObject({ reads: [], externalState: 'partial' })
})

it.each([true, false])(
  'retains module modifications before a dispatched failure (precompute=%s)',
  async (precompute) => {
    const context = await fileContext(
      'python',
      [
        'import SimpleITK as sitk\nreplacement = lambda path: 1',
        'sitk.ReadImage = replacement\nraise RuntimeError()',
        'import SimpleITK as recovered'
      ],
      [{}, { status: 'failed', kernelDispatched: true }, {}],
      precompute
    )
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'recovered.ReadImage("unused.nii.gz")',
        context
      )
    ).toMatchObject({ reads: [], externalState: 'partial' })
  }
)

it('can re-import an unmodified reader after an ordinary execution failure', async () => {
  const context = await fileContext(
    'python',
    ['import SimpleITK as sitk', 'import missing_package', 'import SimpleITK as recovered'],
    [{}, { status: 'failed', kernelDispatched: true }, {}]
  )
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'recovered.ReadImage("inputs/ct.nii.gz")',
      context
    )
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it.each(['mutate(sitk)', 'mutate(module=sitk)', 'setattr(sitk, "ReadImage", replacement)'])(
  'does not revive a module exposed to an opaque mutation: %s',
  async (mutation) => {
    const context = await fileContext('python', [
      'import SimpleITK as sitk',
      mutation,
      'import SimpleITK as recovered'
    ])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'recovered.ReadImage("unused.nii.gz")',
        context
      )
    ).toMatchObject({ reads: [], externalState: 'partial' })
  }
)

it('clears observed module modifications at the kernel epoch boundary', async () => {
  const context = await fileContext(
    'python',
    ['import SimpleITK as sitk\nsitk.ReadImage = replacement', 'import SimpleITK as sitk'],
    [{ kernelEpochId: 'old-epoch' }, {}]
  )
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("inputs/ct.nii.gz")', context)
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it('rebuilds malformed cached reader identities from saved code', async () => {
  const context = await fileContext('python', ['import SimpleITK as sitk'], [], true, (json) => {
    expect(json).toMatch(/"kind":\s*"import"/)
    return json.replace(/"kind":\s*"import"/g, '"kind":"invalid"')
  })
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("inputs/ct.nii.gz")', context)
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it.each(['bindings', 'taints'] as const)(
  'bounds accumulated Python %s without reviving trusted effects',
  async (kind) => {
    const entries: FileContextEntry[] = Array.from({ length: 514 }, (_, index) => ({
      facts: { state: 'available', definedNames: [`lib${index}`], usedNames: [], mutatedNames: [] },
      fileContext: {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        ...(kind === 'bindings'
          ? {
              pythonBindings: [
                { name: `lib${index}`, qualifiedName: `module${index}`, kind: 'import' as const }
              ]
            }
          : { pythonTaintedNamespaces: [`module${index}`] })
      }
    }))
    const context = projectNotebookFileContext('python', entries)
    expect(context?.pythonTaintedNamespaces).toEqual(['*'])
    expect(context?.pythonBindings ?? []).toEqual([])
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import SimpleITK as sitk\nsitk.ReadImage("unused.nii.gz")',
        context
      )
    ).toMatchObject({ reads: [], externalState: 'partial' })
  }
)

it('keeps network readers external when imported in an earlier cell', async () => {
  const context = await fileContext('python', ['import requests as client'])
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'response = client.get("https://example.org/data")',
      context
    )
  ).toMatchObject({ reads: [], externalState: 'partial' })
})

it('does not invalidate a module merely printed for inspection', async () => {
  const context = await fileContext('python', ['import SimpleITK as sitk', 'print(sitk)'])
  expect(
    await analyzeNotebookSourceFileAccess('python', 'sitk.ReadImage("inputs/ct.nii.gz")', context)
  ).toMatchObject({ reads: ['inputs/ct.nii.gz'], externalState: 'complete' })
})

it('restores sliced R map inputs after loading the dependency cache', async () => {
  const context = await fileContext('r', [
    'paths <- c("a.csv","skip.csv","b.csv")',
    'selected <- paths[-2]',
    'paths <- c("replacement.csv")'
  ])
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'result <- purrr::map(selected,readr::read_csv)',
      context
    )
  ).toMatchObject({ reads: ['a.csv', 'b.csv'], readState: 'complete', externalState: 'complete' })
})

it('does not reuse static R paths constructed by a replaced builtin', async () => {
  const context = await fileContext('r', ['c <- custom_builder', 'paths <- c("wrong.csv")'])
  const result = await analyzeNotebookSourceFileAccess(
    'r',
    'result <- purrr::map(paths,utils::read.csv)',
    context
  )
  expect(result.readState).toBe('partial')
  expect(result.reads).not.toContain('wrong.csv')
})

it('captures matrix chord output while its input remains on the prior DataFrame run', async () => {
  const source = await readFile(join(__dirname, 'reported-python-matrix-chord.fixture.py'), 'utf8')
  const context = await fileContext('python', [
    "import pandas as pd\ndf = pd.read_excel('inputs/edge-weights-222222222222.xlsx')"
  ])
  const access = await analyzeNotebookSourceFileAccess('python', source, context)
  expect(access).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    writes: ['chord_diagram.png']
  })
})

it('reports missing DataFrame context for the matrix chord rather than inventing an input file', async () => {
  const source = await readFile(join(__dirname, 'reported-python-matrix-chord.fixture.py'), 'utf8')
  const access = await analyzeNotebookSourceFileAccess('python', source)
  expect(access.readState).toBe('partial')
  expect(access.reads).toEqual([])
})

it('restores bounded R atomic value knowledge from the analysis cache', async () => {
  const context = await fileContext('r', ['source <- 0.5'])
  expect(context?.rAtomicValueNames).toContain('source')
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'value <- sin(source); if (value > 0) value <- value - 1; write.csv(data.frame(value), "out.csv")',
      context
    )
  ).toMatchObject({ readState: 'complete', writeState: 'complete', writes: ['out.csv'] })
})

it('drops R atomic knowledge across an interrupted kernel operation', async () => {
  const context = await fileContext(
    'r',
    ['source <- 0.5', 'stop("interrupted")'],
    [{}, { status: 'failed' }]
  )
  expect(context?.rAtomicValueNames ?? []).not.toContain('source')
})
