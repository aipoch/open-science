#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node CLI validates captured JSON. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CAPTURE_SCHEMA_VERSION = 2
const EXECUTABLE_REGRESSION_GATE = 'src/main/reviewer/reviewer-regression-gate.integration.test.ts'
export const REVIEWER_REGRESSION_SCENARIOS = [
  ['image-trace-only', 'execution log + artifact trace', [EXECUTABLE_REGRESSION_GATE]],
  ['rendered-image-contradiction', 'artifact image content', [EXECUTABLE_REGRESSION_GATE]],
  [
    'targeted-source-pages',
    'trusted source role + targeted page content',
    [EXECUTABLE_REGRESSION_GATE]
  ],
  ['earlier-turn-abstention', 'frozen turn scope only', [EXECUTABLE_REGRESSION_GATE]],
  [
    'fabricated-current-turn-reference',
    'current-turn concrete identifier trace',
    [EXECUTABLE_REGRESSION_GATE]
  ],
  ['user-stop', 'routed cancellation evidence', [EXECUTABLE_REGRESSION_GATE]],
  ['plan-completion', 'effective current-turn Plan', [EXECUTABLE_REGRESSION_GATE]],
  ['tabular-values', 'bounded columns and row targets', [EXECUTABLE_REGRESSION_GATE]],
  [
    'opaque-binary-generation',
    'artifact trace; byte-free limitation if content is attempted',
    [EXECUTABLE_REGRESSION_GATE]
  ]
].map(([id, evidenceRoute, testFiles]) => ({ id, evidenceRoute, testFiles }))

const text = (checks) => JSON.stringify(checks).toLowerCase()
const negatives = (checks) => checks.filter(({ status }) => status === 'warn' || status === 'fail')
const contains = (checks, terms) => terms.every((term) => text(checks).includes(term))
const pass = (checks) => checks.some(({ status }) => status === 'pass')
const viewCount = (calls, view) =>
  calls.filter((call) => call.name === 'read_artifact' && call.args?.view === view).length
const view = (calls, expected) => viewCount(calls, expected) > 0
export const MODEL_SCENARIOS = {
  'image-method-result': {
    allowed: 1,
    note: 'Trace is sufficient; bounded image content reads are disclosed as extra.',
    semantic: (checks) =>
      pass(checks) && contains(checks, ['welch', '0.031']) && negatives(checks).length === 0,
    route: (calls) => view(calls, 'trace'),
    extra: (calls) => viewCount(calls, 'content')
  },
  'image-label-mismatch': {
    allowed: 0,
    note: 'Image content must expose the rendered g/mg contradiction.',
    semantic: (checks) =>
      negatives(checks).length > 0 &&
      contains(negatives(checks), ['concentration (g)', 'mg', 'label']),
    route: (calls) => view(calls, 'content'),
    extra: () => 0
  },
  'targeted-source': {
    allowed: 0,
    note: 'Only requested source pages are sufficient for the asserted values.',
    semantic: (checks) =>
      pass(checks) && contains(checks, ['page', '0.42']) && negatives(checks).length === 0,
    route: (calls) =>
      calls.some(
        (call) =>
          call.name === 'read_artifact' &&
          call.args?.view === 'content' &&
          JSON.stringify(call.args.pages) === '[4,5]'
      ),
    extra: () => 0
  },
  'csv-regression': {
    allowed: 0,
    note: 'Trace or bounded tabular content is valid for the asserted values.',
    semantic: (checks) =>
      pass(checks) && contains(checks, ['three', '12']) && negatives(checks).length === 0,
    route: (calls) => view(calls, 'trace') || view(calls, 'content'),
    extra: () => 0
  },
  'unsupported-binary': {
    allowed: 0,
    note: 'Generation is verified by trace without requesting opaque bytes.',
    semantic: (checks) =>
      pass(checks) &&
      contains(checks, ['generated', 'completed']) &&
      negatives(checks).length === 0,
    route: (calls) => view(calls, 'trace') && !view(calls, 'content'),
    extra: (calls) => viewCount(calls, 'content')
  }
}

const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])])
        )
      : value
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
export const digestReviewerModelRun = (run) => {
  const payload = { ...run }
  delete payload.sha256
  return digest(payload)
}
export const sealReviewerModelCapture = (capture) => ({
  ...capture,
  runs: capture.runs.map((run) => ({ ...run, sha256: digestReviewerModelRun(run) }))
})
const integer = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative safe integer.`)
  return value
}
const validateChecks = (checks, prefix) => {
  if (!Array.isArray(checks) || checks.length === 0)
    throw new Error(`${prefix} must be a non-empty array.`)
  checks.forEach((check, index) => {
    if (
      !['pass', 'warn', 'fail'].includes(check?.status) ||
      typeof check.claim !== 'string' ||
      !check.claim ||
      typeof check.evidence !== 'string' ||
      !check.evidence
    )
      throw new Error(`${prefix}[${index}] must contain a valid status, claim, and evidence.`)
  })
}

export const evaluateReviewerModelCapture = (capture) => {
  if (capture?.schemaVersion !== CAPTURE_SCHEMA_VERSION)
    throw new Error(`schemaVersion must be ${CAPTURE_SCHEMA_VERSION}.`)
  if (!Array.isArray(capture.runs) || !capture.runs.length)
    throw new Error('runs must contain per-run captures.')
  if (typeof capture.model !== 'string' || !capture.model)
    throw new Error('model must be recorded.')
  if (
    typeof capture.runner?.name !== 'string' ||
    !capture.runner.name ||
    typeof capture.runner?.version !== 'string' ||
    !capture.runner.version
  )
    throw new Error('runner name and version must be recorded.')
  const seen = new Set(),
    rows = new Map(),
    usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }
  let totalLatencyMs = 0
  capture.runs.forEach((run, index) => {
    const prefix = `runs[${index}]`,
      scenario = MODEL_SCENARIOS[run.scenarioId]
    if (typeof run.runId !== 'string' || !run.runId || seen.has(run.runId))
      throw new Error(`${prefix}.runId must be unique.`)
    seen.add(run.runId)
    if (!scenario) throw new Error(`${prefix}.scenarioId is unknown.`)
    integer(run.repetition, `${prefix}.repetition`)
    validateChecks(run.raw?.checks, `${prefix}.raw.checks`)
    if (
      !Array.isArray(run.raw?.toolCalls) ||
      run.raw.toolCalls.some(
        (call) =>
          typeof call?.name !== 'string' ||
          !call.name ||
          !call.args ||
          typeof call.args !== 'object'
      )
    )
      throw new Error(`${prefix}.raw.toolCalls must preserve names and arguments.`)
    for (const key of Object.keys(usage))
      usage[key] += integer(run.providerUsage?.[key], `${prefix}.providerUsage.${key}`)
    totalLatencyMs += integer(run.latencyMs, `${prefix}.latencyMs`)
    if (run.sha256 !== digestReviewerModelRun(run))
      throw new Error(`${prefix}.sha256 does not match the captured run.`)
    const row = rows.get(run.scenarioId) ?? {
      fixtureId: run.scenarioId,
      runs: 0,
      semanticPasses: 0,
      evidenceRoutePasses: 0,
      extraContentReads: 0,
      allowedExtraContentReads: scenario.allowed,
      note: scenario.note
    }
    row.runs++
    row.semanticPasses += Number(scenario.semantic(run.raw.checks))
    row.evidenceRoutePasses += Number(scenario.route(run.raw.toolCalls))
    row.extraContentReads += scenario.extra(run.raw.toolCalls)
    rows.set(run.scenarioId, row)
  })
  const values = [...rows.values()],
    totalRuns = capture.runs.length
  const observed = values.reduce((sum, row) => sum + row.extraContentReads, 0),
    allowed = values.reduce((sum, row) => sum + row.allowedExtraContentReads, 0)
  return {
    totalRuns,
    semanticAccuracy: values.reduce((sum, row) => sum + row.semanticPasses, 0) / totalRuns,
    evidenceRouteAccuracy:
      values.reduce((sum, row) => sum + row.evidenceRoutePasses, 0) / totalRuns,
    providerUsage: usage,
    totalLatencyMs,
    averageLatencyMs: totalLatencyMs / totalRuns,
    extraContentReads: { observed, allowed, withinBound: observed <= allowed },
    rows: values
  }
}

const pct = (value) => `${(value * 100).toFixed(1)}%`,
  num = (value) => value.toLocaleString('en-US')
export const renderReviewerModelEvaluation = (capture, result) => {
  const modelRows = result.rows
    .map(
      (row) =>
        `| ${row.fixtureId} | ${row.semanticPasses}/${row.runs} | ${row.evidenceRoutePasses}/${row.runs} | ${row.extraContentReads} / ${row.allowedExtraContentReads} | ${row.note} |`
    )
    .join('\n')
  const regressionRows = REVIEWER_REGRESSION_SCENARIOS.map(
    (scenario) =>
      `| ${scenario.id} | ${scenario.evidenceRoute} | ${scenario.testFiles.map((file) => `\`${file}\``).join('<br>')} |`
  ).join('\n')
  return `# Reviewer enhancement model evaluation\n\nGenerated by \`npm run eval:reviewer\` from the tracked versioned capture \`${capture.source}\`. Every score and measurement is recomputed from per-run raw checks, tool-call arguments, provider usage, and latency. SHA-256 seals make edits fail closed.\n\n- Capture: \`${capture.captureId}\` (${capture.recordedAt})\n- Runner: \`${capture.runner.name}@${capture.runner.version}\`\n- Model: \`${capture.model}\`\n- Strategy: \`${capture.strategy}\`\n- Runs: ${result.totalRuns}\n- Semantic accuracy: ${pct(result.semanticAccuracy)}\n- Evidence-route accuracy: ${pct(result.evidenceRouteAccuracy)}\n- Provider-reported usage: ${num(result.providerUsage.inputTokens)} input (${num(result.providerUsage.cachedTokens)} cached) + ${num(result.providerUsage.outputTokens)} output = ${num(result.providerUsage.inputTokens + result.providerUsage.outputTokens)} tokens\n- Latency: ${num(result.totalLatencyMs)} ms total; ${num(Math.round(result.averageLatencyMs))} ms/run average\n- Extra bounded content reads: ${result.extraContentReads.observed} / ${result.extraContentReads.allowed} allowed; ${result.extraContentReads.withinBound ? 'within bound' : 'gate failed'}\n\n| Model fixture | Semantic | Evidence route | Extra reads | Disclosure |\n| --- | ---: | ---: | ---: | --- |\n${modelRows}\n\n## Reproduction\n\n\`npm run eval:reviewer\` deterministically verifies and replays the committed capture. To execute the configured provider and replace a capture, run \`npm run eval:reviewer:live -- --runs=3 --output=test/fixtures/reviewer-model-evaluation.json\`, then rerun the deterministic command. The live runner reads the development provider configuration through Electron safeStorage; it never prints or persists credentials and does not write application data.\n\n## Product regression matrix\n\nThe deterministic product suite covers the full shipping matrix; the model sample covers the five core routing fixtures. Deferred cross-Turn and format-specific execution capabilities are intentionally absent.\n\n| Scenario | Required evidence route | Executable regression files |\n| --- | --- | --- |\n${regressionRows}\n`
}

const runCli = async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    at = (flag, fallback) => {
      const index = process.argv.indexOf(flag)
      return resolve(root, index >= 0 ? process.argv[index + 1] : fallback)
    }
  const capture = JSON.parse(
      await readFile(at('--input', 'test/fixtures/reviewer-model-evaluation.json'), 'utf8')
    ),
    result = evaluateReviewerModelCapture(capture),
    output = at('--output', 'docs/reviewer-model-evaluation.md')
  await writeFile(output, renderReviewerModelEvaluation(capture, result), 'utf8')
  process.stdout.write(`${output}\n`)
  if (
    result.semanticAccuracy !== 1 ||
    result.evidenceRouteAccuracy !== 1 ||
    !result.extraContentReads.withinBound
  )
    process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runCli()
