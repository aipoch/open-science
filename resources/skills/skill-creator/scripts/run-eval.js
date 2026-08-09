'use strict'
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const runEval = async ({ hostSkills, evalId }) => {
  if (typeof hostSkills?.evals?.run !== 'function') {
    throw new Error('host.skills.evals.run is unavailable in this runtime.')
  }
  if (!evalId) throw new Error('evalId is required.')
  return hostSkills.evals.run(evalId)
}

module.exports = { runEval }
