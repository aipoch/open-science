/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const usage = `Usage: node scripts/performance/compare-runtime-profile.mjs <baseline.json> <candidate.json> [options]

Options:
  --metric=<name,...>                 Timing names to compare (required)
  --max-relative-regression=<percent> Maximum allowed median/p95 regression (default: 20)
  --json                              Print the comparison as JSON
  --help                              Show this help

The summaries must come from the same platform, architecture, Electron version, and profile
schema. Missing metrics, incomplete samples, and non-finite timing values fail the comparison.`

const parsePercent = (value) => {
  const percent = Number(value)
  if (!Number.isFinite(percent) || percent < 0 || percent > 1_000) {
    throw new Error('--max-relative-regression must be a percentage between 0 and 1000.')
  }
  return percent / 100
}

const parseArguments = (arguments_) => {
  const options = {
    json: false,
    maxRelativeRegression: 0.2,
    metrics: []
  }
  const positional = []
  for (const argument of arguments_) {
    if (argument === '--help') {
      console.log(usage)
      process.exit(0)
    }
    if (argument === '--json') {
      options.json = true
      continue
    }
    if (argument.startsWith('--metric=')) {
      options.metrics.push(
        ...argument
          .slice('--metric='.length)
          .split(',')
          .map((metric) => metric.trim())
          .filter(Boolean)
      )
      continue
    }
    if (argument.startsWith('--max-relative-regression=')) {
      options.maxRelativeRegression = parsePercent(
        argument.slice('--max-relative-regression='.length)
      )
      continue
    }
    if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}\n\n${usage}`)
    positional.push(argument)
  }
  if (positional.length !== 2)
    throw new Error(`Expected baseline and candidate JSON paths.\n\n${usage}`)
  options.metrics = [...new Set(options.metrics)]
  if (options.metrics.length === 0)
    throw new Error(`At least one --metric is required.\n\n${usage}`)
  return { ...options, baselinePath: positional[0], candidatePath: positional[1] }
}

const readSummary = async (path) => JSON.parse(await readFile(resolve(path), 'utf8'))

const metadataKeys = ['schemaVersion', 'platform', 'architecture', 'electronVersion']

const isValidMetadataValue = (key, value) =>
  key === 'schemaVersion'
    ? Number.isInteger(value) && value > 0
    : typeof value === 'string' && value.trim().length > 0

const compareRuntimeProfiles = ({ baseline, candidate, metrics, maxRelativeRegression }) => {
  const metadataMismatches = metadataKeys.flatMap((key) => {
    const baselineValue = baseline[key]
    const candidateValue = candidate[key]
    if (!isValidMetadataValue(key, baselineValue) || !isValidMetadataValue(key, candidateValue)) {
      return [
        {
          key,
          baseline: baselineValue ?? null,
          candidate: candidateValue ?? null,
          reason: 'invalid-metadata'
        }
      ]
    }
    return baselineValue === candidateValue
      ? []
      : [{ key, baseline: baselineValue, candidate: candidateValue, reason: 'mismatch' }]
  })
  const incompleteSamples = [
    ['baseline', baseline.incompleteSampleCount],
    ['candidate', candidate.incompleteSampleCount]
  ].filter(([, count]) => !Number.isInteger(count) || count !== 0)
  const comparisons = []
  const failures = []
  for (const name of metrics) {
    const baselineMetric = baseline.timings?.[name]
    const candidateMetric = candidate.timings?.[name]
    if (!baselineMetric || !candidateMetric) {
      failures.push({ name, reason: 'missing-metric' })
      continue
    }
    if (
      !Number.isInteger(baselineMetric.count) ||
      baselineMetric.count <= 0 ||
      !Number.isInteger(candidateMetric.count) ||
      candidateMetric.count <= 0
    ) {
      failures.push({
        name,
        reason: 'invalid-sample-count',
        baselineCount: baselineMetric.count ?? null,
        candidateCount: candidateMetric.count ?? null
      })
      continue
    }
    for (const field of ['median', 'p95']) {
      const baselineValue = baselineMetric[field]
      const candidateValue = candidateMetric[field]
      if (
        !Number.isFinite(baselineValue) ||
        !Number.isFinite(candidateValue) ||
        baselineValue < 0 ||
        candidateValue < 0
      ) {
        failures.push({ name, field, reason: 'invalid-timing' })
        continue
      }
      const relativeRegression =
        baselineValue === 0
          ? candidateValue === 0
            ? 0
            : Number.POSITIVE_INFINITY
          : (candidateValue - baselineValue) / baselineValue
      comparisons.push({
        name,
        field,
        baseline: baselineValue,
        candidate: candidateValue,
        relativeRegression
      })
      if (relativeRegression > maxRelativeRegression) {
        failures.push({
          name,
          field,
          reason: 'regression',
          relativeRegression,
          baseline: baselineValue,
          candidate: candidateValue
        })
      }
    }
  }
  return {
    ok: metadataMismatches.length === 0 && incompleteSamples.length === 0 && failures.length === 0,
    metadataMismatches,
    incompleteSamples,
    comparisons,
    failures,
    maxRelativeRegression
  }
}

const formatPercent = (value) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'infinite'

const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  const [baseline, candidate] = await Promise.all([
    readSummary(options.baselinePath),
    readSummary(options.candidatePath)
  ])
  const result = compareRuntimeProfiles({
    baseline,
    candidate,
    metrics: options.metrics,
    maxRelativeRegression: options.maxRelativeRegression
  })
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`Runtime profile comparison: ${result.ok ? 'PASS' : 'FAIL'}`)
    for (const mismatch of result.metadataMismatches) {
      console.log(
        `  metadata ${mismatch.key}: ${String(mismatch.baseline)} -> ${String(mismatch.candidate)}`
      )
    }
    for (const [name, count] of result.incompleteSamples) {
      console.log(`  incomplete samples: ${name}=${String(count)}`)
    }
    for (const comparison of result.comparisons) {
      console.log(
        `  ${comparison.name} ${comparison.field}: ${comparison.baseline.toFixed(1)} -> ${comparison.candidate.toFixed(1)} ms (${formatPercent(comparison.relativeRegression)})`
      )
    }
    for (const failure of result.failures) {
      console.log(
        `  failure ${failure.name}${failure.field ? ` ${failure.field}` : ''}: ${failure.reason}`
      )
    }
  }
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export { compareRuntimeProfiles, parseArguments }
