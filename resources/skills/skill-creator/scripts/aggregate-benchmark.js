'use strict'
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

const { summarize } = require('./utils')

const METRICS = ['pass_rate', 'time_seconds', 'tokens', 'tool_calls', 'errors']

const summarizeConfiguration = (runs) =>
  Object.fromEntries(
    METRICS.map((metric) => [
      metric,
      summarize(runs.map((run) => Number(run.result?.[metric] ?? 0)).filter(Number.isFinite))
    ])
  )

const aggregateBenchmark = ({ metadata = {}, runs = [], notes = [] }) => {
  const configurations = [...new Set(runs.map((run) => run.configuration))]
  const runSummary = Object.fromEntries(
    configurations.map((configuration) => [
      configuration,
      summarizeConfiguration(runs.filter((run) => run.configuration === configuration))
    ])
  )

  const baseline = runSummary.without_skill ?? runSummary.old_skill
  if (runSummary.with_skill && baseline) {
    runSummary.delta = Object.fromEntries(
      METRICS.map((metric) => [metric, runSummary.with_skill[metric].mean - baseline[metric].mean])
    )
  } else {
    runSummary.delta = {}
  }

  return { schema_version: 1, metadata, runs, run_summary: runSummary, notes }
}

module.exports = { aggregateBenchmark, summarizeConfiguration }
