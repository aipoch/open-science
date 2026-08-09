'use strict'
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const runEval = async ({ queries, probe, runs = 3 }) => {
  if (typeof probe !== 'function') {
    throw new Error('runEval requires an app-owned Skill trigger probe.')
  }
  if (!Number.isInteger(runs) || runs < 1) throw new Error('runs must be a positive integer.')

  const results = await Promise.all(
    queries.map(async ({ query, should_trigger }) => {
      const attempts = await Promise.all(
        Array.from({ length: runs }, () => probe({ query, should_trigger }))
      )
      const triggers = attempts.filter(Boolean).length
      const pass = should_trigger ? triggers === runs : triggers === 0
      return { query, should_trigger, runs, triggers, pass }
    })
  )
  const passed = results.filter((result) => result.pass).length
  return { results, summary: { passed, failed: results.length - passed, total: results.length } }
}

module.exports = { runEval }
