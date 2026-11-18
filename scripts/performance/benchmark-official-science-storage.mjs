/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone JavaScript benchmark */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const candidate = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}
const baselineRef = option('--baseline', '488b8f520935278958335399ca92c83d9f8eda54')
const fieldPatchRoot = option('--field-patch-root')
if (!fieldPatchRoot) throw new Error('Provide the frozen pre-business-record --field-patch-root')
const repeats = Number(option('--repeats', '3'))
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('Invalid repeat count')
const sourcesPath = resolve(option('--sources', 'sources.json'))
const output = resolve(option('--output', '/tmp/open-science-official-benchmarks.json'))
const logs = `${output}.logs`
const sandbox = await mkdtemp(join(tmpdir(), 'open-science-official-source-'))
const baseline = join(sandbox, 'baseline')
const fieldPatch = join(sandbox, 'field-patch')
const businessRecord = join(sandbox, 'business-record')
const retain = process.argv.includes('--retain')
const variants = ['original-json', 'field-patch', 'business-record']
const rootsByVariant = {
  'original-json': baseline,
  'field-patch': fieldPatch,
  'business-record': businessRecord
}
const testFile = 'src/main/session-persistence/official-science-storage.benchmark.test.ts'
const fixtureFiles = [
  'scripts/performance/official-science-seed.ts',
  'scripts/performance/official-science-continuation.ts'
]
const ownedDataRoots = new Set()
await mkdir(logs, { recursive: true })
const removeOwnedData = async (root) => {
  if (!/^open-science-official-(seed|run)-/.test(basename(root)))
    throw new Error('Unexpected cleanup path')
  await rm(root, { recursive: true, force: true })
}
const command = (args) =>
  execFileSync('git', args, {
    cwd: candidate,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  }).trim()
const run = async (cwd, phase, stem, extra = {}) => {
  const report = join(logs, `${stem}.json`)
  const log = join(logs, `${stem}.log`)
  const fd = openSync(log, 'w')
  try {
    const code = await new Promise((resolveExit, reject) => {
      const child = spawn(
        process.execPath,
        ['node_modules/vitest/vitest.mjs', 'run', testFile, '--project=default', '--maxWorkers=1'],
        {
          cwd,
          env: {
            ...process.env,
            OPEN_SCIENCE_OFFICIAL_PHASE: phase,
            OPEN_SCIENCE_OFFICIAL_REPORT: report,
            ...extra
          },
          stdio: ['ignore', fd, fd]
        }
      )
      child.on('error', reject)
      child.on('exit', resolveExit)
    })
    if (code !== 0) throw new Error(`Benchmark failed (${code}); inspect ${log}`)
  } finally {
    closeSync(fd)
  }
  return { report, value: JSON.parse(await readFile(report, 'utf8')) }
}
const ensure = (condition, message) => {
  if (!condition) throw new Error(message)
}
const sourceInventory = async (root) => {
  const result = {}
  const visit = async (directory) => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile())
        result[file] = createHash('sha256')
          .update(await readFile(join(root, file)))
          .digest('hex')
      else throw new Error(`Unexpected source symlink: ${file}`)
    }
  }
  for (const directory of ['src', 'scripts', 'e2e']) await visit(directory)
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}
const statistics = (values) => {
  ensure(values.length > 0 && values.every(Number.isFinite), 'Invalid measured sample')
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return {
    count: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1)
  }
}
const summarize = (result) => ({
  status: result.status,
  equivalenceVerified: result.equivalenceVerified,
  frozenSourceReverified: result.frozenSourceReverified,
  saveCount: result.runs.reduce(
    (sum, run) =>
      sum + run.writes.reduce((count, scenario) => count + 1 + scenario.fork.samples.length, 0),
    0
  ),
  freshReadCount: result.runs.reduce((sum, run) => sum + run.reads.length, 0),
  compatibility: result.compatibility,
  cases: result.sources.cases.map(({ id }) => {
    const compared = Object.fromEntries(
      variants.map((variant) => {
        const runs = result.runs.filter((run) => run.variant === variant)
        const scenarios = runs.map((run) => run.writes.find((scenario) => scenario.id === id))
        const laterSaves = scenarios.flatMap((scenario) => scenario.fork.samples.slice(1))
        // Use identical logical positions across formats, including original JSON. Index 0
        // migrates; index 129 is the established journal checkpoint position.
        const ordinary = scenarios.flatMap((scenario) =>
          scenario.fork.samples.filter((_sample, index) => index !== 0 && index !== 129)
        )
        const reads = (stage) =>
          statistics(
            runs.flatMap((run) =>
              run.reads
                .filter((read) => read.id === id && read.stage === stage)
                .map((read) => read.restoreMs)
            )
          )
        return [
          variant,
          {
            postMigrationSaveMs: statistics(laterSaves.map((sample) => sample.saveMs)),
            ordinarySaveMs: statistics(ordinary.map((sample) => sample.saveMs)),
            totalSaveMsPerRun: statistics(
              scenarios.map((scenario) =>
                scenario.fork.samples.slice(1).reduce((sum, sample) => sum + sample.saveMs, 0)
              )
            ),
            postMigrationBytesPerRun: statistics(
              scenarios.map((scenario) =>
                scenario.fork.samples.slice(1).reduce((sum, sample) => sum + sample.bytes, 0)
              )
            ),
            migrationMs: statistics(scenarios.map((scenario) => scenario.fork.samples[0].saveMs)),
            checkpointPositionMs: statistics(
              scenarios.map((scenario) => scenario.fork.samples[129].saveMs)
            ),
            importedTitleSaveMs: statistics(
              scenarios.map((scenario) => scenario.imported.sample.saveMs)
            ),
            legacyReadMs: reads('legacy'),
            importedReadMs: reads('imported'),
            fullReadMs: reads('fork'),
            storage: scenarios[0].fork.storage
          }
        ]
      })
    )
    const change = (reference) =>
      Object.fromEntries(
        [
          'postMigrationSaveMs',
          'ordinarySaveMs',
          'totalSaveMsPerRun',
          'postMigrationBytesPerRun',
          'fullReadMs'
        ].map((key) => [
          key,
          100 * (compared['business-record'][key].median / compared[reference][key].median - 1)
        ])
      )
    return {
      id,
      variants: compared,
      percentChangeVsOriginalJson: change('original-json'),
      percentChangeVsFieldPatch: change('field-patch')
    }
  })
})
try {
  await mkdir(baseline)
  const archive = join(sandbox, 'baseline.tar')
  execFileSync('git', ['archive', '--output', archive, baselineRef], { cwd: candidate })
  execFileSync('tar', ['-xf', archive, '-C', baseline])
  await symlink(join(candidate, 'node_modules'), join(baseline, 'node_modules'), 'dir')
  await cp(resolve(fieldPatchRoot), fieldPatch, { recursive: true, verbatimSymlinks: true })
  await cp(baseline, businessRecord, { recursive: true, verbatimSymlinks: true })
  // Freeze production inputs before starting any process. The three versions share only
  // dependencies and the explicit benchmark fixture; no live source tree is timed.
  for (const file of [
    ...new Set([
      ...command(['diff', '--name-only', baselineRef]).split('\n'),
      ...command(['ls-files', '--others', '--exclude-standard']).split('\n')
    ])
  ].filter((file) => /^(src|scripts|e2e)\//.test(file))) {
    try {
      await cp(join(candidate, file), join(businessRecord, file), { recursive: true })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await rm(join(businessRecord, file), { recursive: true, force: true })
    }
  }
  for (const root of Object.values(rootsByVariant))
    for (const file of [testFile, ...fixtureFiles])
      await cp(join(candidate, file), join(root, file))
  ensure(
    !command([
      'diff',
      baselineRef,
      '--',
      'package.json',
      'package-lock.json',
      'packages',
      'prisma/schema.prisma'
    ]),
    'Shared dependency/schema sources differ'
  )
  const sha256 = async (file) =>
    createHash('sha256')
      .update(await readFile(join(businessRecord, file)))
      .digest('hex')
  const sourcePaths = () =>
    [
      ...new Set([
        ...command(['diff', '--name-only', baselineRef]).split('\n'),
        ...command(['ls-files', '--others', '--exclude-standard']).split('\n')
      ])
    ]
      .filter(
        (file) => file.startsWith('src/') || file.startsWith('scripts/') || file.startsWith('e2e/')
      )
      .sort()
  const paths = sourcePaths()
  const candidateSourceSha256 = Object.fromEntries(
    await Promise.all(paths.map(async (file) => [file, await sha256(file)]))
  )
  const frozenSourceHashes = Object.fromEntries(
    await Promise.all(
      variants.map(async (variant) => [variant, await sourceInventory(rootsByVariant[variant])])
    )
  )
  const result = {
    status: 'running',
    description:
      'Three frozen sources: original JSON, field-patch JSONL and business-record JSONL. Official static .science exports validated/imported/forked by original JSON once, then identical legacy roots cloned. One allowed imported title edit; one controlled 32 KiB reply on fork in exactly 194 saves for every version. Real repository, SQLite and fsync. Fresh-process complete history reads; OS cache not cleared. Complete history and business SQL values verified outside timing. Not replaying the original model event timeline. No archive code execution, model/network, renderer/IPC or process startup in measured saves/reads.',
    baselineCommit: command(['rev-parse', baselineRef]),
    candidateHead: command(['rev-parse', 'HEAD']),
    candidateBranch: command(['branch', '--show-current']),
    candidateTrackedDiffSha256: createHash('sha256')
      .update(command(['diff', baselineRef]))
      .digest('hex'),
    candidateSourceSha256,
    fieldPatchSourceRoot: resolve(fieldPatchRoot),
    frozenSourceRoots: rootsByVariant,
    frozenSourceHashes,
    retainedArtifacts: retain,
    sources: JSON.parse(await readFile(sourcesPath, 'utf8')),
    environment: {
      timestamp: new Date().toISOString(),
      node: process.version,
      platform: platform(),
      release: release(),
      arch: process.arch,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryAtStartBytes: freemem()
    },
    preparation: [],
    runs: [],
    compatibility: []
  }
  console.log(
    'Preparing three official archives through the real import/fork service on the baseline.'
  )
  const prepared = await run(baseline, 'prepare', 'prepare', {
    OPEN_SCIENCE_OFFICIAL_SOURCES: sourcesPath
  })
  for (const seed of prepared.value.seeds) ownedDataRoots.add(seed.root)
  result.preparation = prepared.value.seeds.map((item) => {
    const seed = { ...item }
    delete seed.root
    delete seed.databasePath
    return seed
  })
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const offset = (variants.length - ((repeat - 1) % variants.length)) % variants.length
    const order = [...variants.slice(offset), ...variants.slice(0, offset)]
    for (const variant of order) {
      const cwd = rootsByVariant[variant]
      console.log(
        `Starting ${variant} ${repeat}/${repeats}: legacy reads, migration and 194 continuation saves per case.`
      )
      const reads = []
      for (const source of result.sources.cases) {
        const read = await run(cwd, 'read', `${variant}-${repeat}-${source.id}-legacy`, {
          OPEN_SCIENCE_OFFICIAL_INPUT: prepared.report,
          OPEN_SCIENCE_OFFICIAL_CASE: source.id,
          OPEN_SCIENCE_OFFICIAL_STAGE: 'legacy'
        })
        reads.push(read.value)
      }
      const written = await run(cwd, 'write', `${variant}-${repeat}-write`, {
        OPEN_SCIENCE_OFFICIAL_INPUT: prepared.report
      })
      for (const scenario of written.value.results) ownedDataRoots.add(scenario.root)
      for (const scenario of written.value.results) {
        const isJournal = variant !== 'original-json'
        const journalVersion = variant === 'field-patch' ? 1 : 2
        for (const stage of ['imported', 'fork']) {
          const storage = scenario[stage].storage
          ensure(storage.format === (isJournal ? 'journal' : 'json'), 'Storage format mismatch')
          if (isJournal) {
            ensure(storage.version === 3, 'Journal manifest version mismatch')
            ensure(storage.journalVersion === journalVersion, 'Journal generation mismatch')
            ensure(storage.checkpointVersion === journalVersion, 'Checkpoint version mismatch')
            ensure(
              storage.recordVersions.every((version) => version === journalVersion),
              'Mixed current log record versions'
            )
          }
        }
        ensure(
          scenario.imported.sample.checkpoints === (isJournal ? 1 : 0),
          'Imported migration checkpoint mismatch'
        )
        ensure(
          scenario.imported.sample.backups === (isJournal ? 1 : 0),
          'Imported migration backup mismatch'
        )
        ensure(scenario.fork.samples.length === 194, 'Continuation count mismatch')
        ensure(
          scenario.fork.samples[0].checkpoints === (isJournal ? 1 : 0),
          'Fork migration checkpoint mismatch'
        )
        ensure(
          scenario.fork.samples.reduce((sum, item) => sum + item.checkpoints, 0) ===
            (isJournal ? 2 : 0),
          'Automatic checkpoint count mismatch'
        )
        ensure(
          scenario.fork.samples.reduce((sum, item) => sum + item.backups, 0) ===
            (isJournal ? 1 : 0),
          'Fork migration backup count mismatch'
        )
        if (isJournal) {
          ensure(
            JSON.stringify(
              scenario.fork.samples.flatMap((sample, index) => (sample.checkpoints ? [index] : []))
            ) === '[0,129]',
            'Checkpoint policy changed between journal versions'
          )
          ensure(scenario.fork.storage.records === 65, 'Unexpected final log replay length')
        }
        for (const sample of [scenario.imported.sample, ...scenario.fork.samples])
          ensure(
            Object.values(sample.byteKinds).reduce((sum, value) => sum + value, 0) === sample.bytes,
            'Byte counters disagree'
          )
        for (const stage of ['imported', 'fork']) {
          const read = await run(cwd, 'read', `${variant}-${repeat}-${scenario.id}-${stage}`, {
            OPEN_SCIENCE_OFFICIAL_INPUT: written.report,
            OPEN_SCIENCE_OFFICIAL_CASE: scenario.id,
            OPEN_SCIENCE_OFFICIAL_STAGE: stage
          })
          reads.push(read.value)
        }
        if (repeat === 1 && variant === 'field-patch') {
          const read = await run(
            businessRecord,
            'read',
            `compatibility-field-patch-to-business-record-${scenario.id}`,
            {
              OPEN_SCIENCE_OFFICIAL_INPUT: written.report,
              OPEN_SCIENCE_OFFICIAL_CASE: scenario.id,
              OPEN_SCIENCE_OFFICIAL_STAGE: 'fork'
            }
          )
          ensure(read.value.storage.journalVersion === 1, 'Read-only compatibility migrated data')
          result.compatibility.push({
            writer: variant,
            reader: 'business-record',
            ...read.value
          })
        }
        if (repeat === 1 && variant === 'business-record') {
          const refusal = await run(
            fieldPatch,
            'refuse-new',
            `compatibility-business-record-to-field-patch-${scenario.id}`,
            {
              OPEN_SCIENCE_OFFICIAL_INPUT: written.report,
              OPEN_SCIENCE_OFFICIAL_CASE: scenario.id
            }
          )
          result.compatibility.push({ writer: variant, reader: 'field-patch', ...refusal.value })
        }
      }
      result.runs.push({
        variant,
        repeat,
        writeReport: written.report,
        writes: written.value.results.map((item) => {
          const scenario = { ...item }
          if (!retain) delete scenario.root
          return scenario
        }),
        reads
      })
      await writeFile(output, JSON.stringify(result, null, 2) + '\n')
      if (!retain)
        for (const scenario of written.value.results) {
          await removeOwnedData(scenario.root)
          ownedDataRoots.delete(scenario.root)
        }
      console.log(`Finished ${variant} ${repeat}/${repeats}: all complete history hashes verified.`)
    }
  }
  for (const source of result.sources.cases) {
    const scenarios = result.runs.map((item) =>
      item.writes.find((scenario) => scenario.id === source.id)
    )
    for (const stage of ['imported', 'fork'])
      ensure(
        new Set(scenarios.map((item) => item[stage].digest)).size === 1,
        `Old/new histories differ: ${source.id}/${stage}`
      )
    for (const stage of ['imported', 'fork'])
      ensure(
        new Set(scenarios.map((item) => item[stage].sqliteDigest)).size === 1,
        `Business SQL differs: ${source.id}/${stage}`
      )
    ensure(
      new Set(scenarios.map((item) => JSON.stringify(item.fork.metadata))).size === 1,
      'Continuation metadata differs'
    )
  }
  for (const [file, hash] of Object.entries(candidateSourceSha256))
    ensure((await sha256(file)) === hash, `Source changed during measurement: ${file}`)
  // The running source is the isolated snapshot, not the live worktree. Concurrent additions
  // to unrelated tests cannot affect these processes; verify the complete frozen inventories.
  for (const variant of variants)
    ensure(
      JSON.stringify(await sourceInventory(rootsByVariant[variant])) ===
        JSON.stringify(frozenSourceHashes[variant]),
      `Frozen source changed during measurement: ${variant}`
    )
  result.frozenSourceReverified = true
  result.status = 'complete'
  result.equivalenceVerified = true
  await writeFile(output, JSON.stringify(result, null, 2) + '\n')
  const summary = output.endsWith('.json')
    ? output.replace(/\.json$/, '.summary.json')
    : `${output}.summary.json`
  await writeFile(summary, JSON.stringify(summarize(result), null, 2) + '\n')
  console.log(`All ${repeats * 3} runs verified; evidence: ${output}`)
} finally {
  if (retain) {
    await writeFile(join(logs, 'owned-roots.json'), JSON.stringify([...ownedDataRoots], null, 2))
    console.log(`Retained isolated source snapshots: ${sandbox}`)
  } else {
    for (const root of ownedDataRoots) await removeOwnedData(root)
    await rm(sandbox, { recursive: true, force: true })
  }
}
