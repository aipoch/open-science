/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone JavaScript benchmark */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Run from an installed candidate checkout. The baseline is an isolated source export, sharing
// only unchanged installed dependencies. Never reset a checkout or touch application user data.
const candidate = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}
const baselineRef = option('--baseline', '488b8f520935278958335399ca92c83d9f8eda54')
const repeats = Number(option('--repeats', '3'))
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('Invalid repeat count')
const output = resolve(option('--output', '/tmp/open-science-realistic-session-benchmarks.json'))
const logs = `${output}.logs`
const sandbox = await mkdtemp(join(tmpdir(), 'open-science-realistic-source-'))
const baseline = join(sandbox, 'baseline')
const testFile = 'src/main/session-persistence/realistic-session-storage.benchmark.test.ts'
const fixtureFile = 'scripts/performance/realistic-session-workload.ts'
const ownedDataRoots = new Set()
await mkdir(logs, { recursive: true })

const removeOwnedData = async (root) => {
  if (!basename(root).startsWith('open-science-realistic-data-'))
    throw new Error('Unexpected cleanup path')
  await rm(root, { recursive: true, force: true })
}

const command = (args) => execFileSync('git', args, { cwd: candidate, encoding: 'utf8' }).trim()
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
            OPEN_SCIENCE_REALISTIC_BENCHMARK_PHASE: phase,
            OPEN_SCIENCE_REALISTIC_BENCHMARK_REPORT: report,
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

try {
  await mkdir(baseline)
  const archive = join(sandbox, 'baseline.tar')
  execFileSync('git', ['archive', '--output', archive, baselineRef], { cwd: candidate })
  execFileSync('tar', ['-xf', archive, '-C', baseline])
  await symlink(join(candidate, 'node_modules'), join(baseline, 'node_modules'), 'dir')
  for (const file of [testFile, fixtureFile]) await cp(join(candidate, file), join(baseline, file))
  const dependencyChanges = command([
    'diff',
    baselineRef,
    '--',
    'package.json',
    'package-lock.json',
    'packages',
    'prisma/schema.prisma'
  ])
  if (dependencyChanges) throw new Error('Shared dependency/schema sources differ from baseline')
  const sha256 = async (file) =>
    createHash('sha256')
      .update(await readFile(join(candidate, file)))
      .digest('hex')
  const changedSourcePaths = command(['ls-files', '--modified', '--others', '--exclude-standard'])
    .split('\n')
    .filter((file) => file.startsWith('src/') || file.startsWith('scripts/'))
  const candidateSourceSha256 = Object.fromEntries(
    await Promise.all(
      [...new Set(changedSourcePaths)].sort().map(async (file) => [file, await sha256(file)])
    )
  )
  const result = {
    description:
      'Deterministic 15-turn tool-heavy workload, real repository and SQLite. Save samples include fsync and automatic checkpoints. Each history read uses a new process, without clearing OS page cache. Network/model latency, renderer/IPC, DB initialization and process startup excluded.',
    baselineCommit: command(['rev-parse', baselineRef]),
    candidateHead: command(['rev-parse', 'HEAD']),
    candidateBranch: command(['branch', '--show-current']),
    candidateTrackedDiffSha256: createHash('sha256')
      .update(command(['diff', baselineRef]))
      .digest('hex'),
    fixtureSha256: await sha256(fixtureFile),
    harnessSha256: await sha256(testFile),
    candidateSourceSha256,
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
    runs: []
  }
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const order = repeat % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
    for (const variant of order) {
      const cwd = variant === 'baseline' ? baseline : candidate
      console.log(`Starting ${variant} ${repeat}/${repeats}: two workloads, 495 saves each.`)
      const written = await run(cwd, 'write', `${variant}-${repeat}-write`)
      for (const scenario of written.value.results) ownedDataRoots.add(scenario.root)
      for (const scenario of written.value.results) {
        const expectedCheckpoints = variant === 'candidate' ? 3 : 0
        if (scenario.checkpointPublications !== expectedCheckpoints) {
          throw new Error(
            `Unexpected checkpoint count for ${variant}: ${scenario.checkpointPublications}`
          )
        }
      }
      const reads = []
      for (const scenario of written.value.results) {
        const read = await run(cwd, 'read', `${variant}-${repeat}-${scenario.name}-read`, {
          OPEN_SCIENCE_REALISTIC_BENCHMARK_INPUT: written.report,
          OPEN_SCIENCE_REALISTIC_BENCHMARK_SCENARIO: scenario.name
        })
        reads.push(...read.value.results)
      }
      result.runs.push({
        variant,
        repeat,
        writes: written.value.results.map((scenario) => {
          const published = { ...scenario }
          delete published.root
          return published
        }),
        reads
      })
      await writeFile(output, JSON.stringify(result, null, 2) + '\n')
      for (const scenario of written.value.results) {
        await removeOwnedData(scenario.root)
        ownedDataRoots.delete(scenario.root)
      }
      console.log(`Finished ${variant} ${repeat}/${repeats}: complete history hashes verified.`)
    }
  }
  for (const name of ['long-replies', 'large-tool-results']) {
    const scenarios = result.runs.map((run) => run.writes.find((item) => item.name === name))
    if (new Set(scenarios.map((scenario) => scenario.finalCanonicalDigest)).size !== 1) {
      throw new Error(`Old/new canonical histories differ for ${name}; results are not equivalent`)
    }
    if (new Set(scenarios.map((scenario) => JSON.stringify(scenario.metadata))).size !== 1) {
      throw new Error(`Old/new workload metadata differ for ${name}`)
    }
  }
  console.log(`Equivalent old/new histories verified. Results: ${output}`)
} finally {
  for (const root of ownedDataRoots) {
    await removeOwnedData(root)
  }
  await rm(sandbox, { recursive: true, force: true })
}
