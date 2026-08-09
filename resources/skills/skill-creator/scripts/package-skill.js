'use strict'
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const packageSkill = async (hostSkills, name) => {
  if (typeof hostSkills?.export !== 'function') {
    throw new Error('host.skills.export is unavailable in this runtime.')
  }
  return hostSkills.export(name)
}

module.exports = { packageSkill }
