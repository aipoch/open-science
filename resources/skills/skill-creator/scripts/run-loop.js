'use strict'
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const splitEvalSet = (queries, trainRatio = 0.6) => {
  const trainSize = Math.max(1, Math.min(queries.length, Math.round(queries.length * trainRatio)))
  return { train: queries.slice(0, trainSize), test: queries.slice(trainSize) }
}

const runLoop = async ({ queries, initialDescription, evaluate, improve, maxIterations = 5 }) => {
  if (typeof evaluate !== 'function' || typeof improve !== 'function') {
    throw new Error('runLoop requires evaluate and improve callbacks.')
  }
  const sets = splitEvalSet(queries)
  const history = []
  let candidate = initialDescription
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const train = await evaluate(sets.train, candidate)
    const test = await evaluate(sets.test, candidate)
    history.push({ iteration, candidate, train, test })
    if (test.summary.failed === 0) break
    if (iteration === maxIterations - 1) break
    candidate = await improve({ candidate, train, test, history })
  }
  return { best_description: candidate, history }
}

module.exports = { runLoop, splitEvalSet }
