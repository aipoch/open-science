'use strict'
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const splitEvalSet = (queries, trainRatio = 0.6) => {
  if (!Array.isArray(queries) || queries.length < 2) {
    throw new Error('splitEvalSet requires at least two trigger cases.')
  }
  const trainSize = Math.max(
    1,
    Math.min(queries.length - 1, Math.round(queries.length * trainRatio))
  )
  return { train: queries.slice(0, trainSize), test: queries.slice(trainSize) }
}

const runLoop = async ({ hostSkills, evalId }) => {
  if (typeof hostSkills?.evals?.run !== 'function') {
    throw new Error('host.skills.evals.run is unavailable in this runtime.')
  }
  if (!evalId) throw new Error('evalId is required.')
  return hostSkills.evals.run(evalId)
}

module.exports = { runLoop, splitEvalSet }
