'use strict'
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const validateSkillDocument = (content, expectedName) => {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content.replace(/\r\n?/g, '\n'))
  if (!match) return { valid: false, error: 'SKILL.md requires YAML frontmatter.' }
  const fields = [...match[1].matchAll(/^([a-zA-Z0-9_-]+):\s*(.*)$/gm)].map((entry) => [
    entry[1].toLowerCase(),
    entry[2].trim().replace(/^['"]|['"]$/g, '')
  ])
  const names = fields.map(([name]) => name).sort()
  if (names.join(',') !== 'description,name') {
    return { valid: false, error: 'Frontmatter must contain exactly name and description.' }
  }
  const values = Object.fromEntries(fields)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.name) || values.name.length > 64) {
    return {
      valid: false,
      error: 'Skill name must be a lowercase hyphenated slug up to 64 characters.'
    }
  }
  if (expectedName && values.name !== expectedName) {
    return { valid: false, error: 'Skill name must match the draft slug.' }
  }
  if (!values.description || values.description.length > 1024 || /[<>]/.test(values.description)) {
    return { valid: false, error: 'Description must be 1-1024 characters without angle brackets.' }
  }
  return { valid: true, name: values.name, description: values.description }
}

const quickValidate = async (hostSkills, name) => {
  if (typeof hostSkills?.validate === 'function') return hostSkills.validate(name)
  if (typeof hostSkills?.read !== 'function') throw new Error('host.skills.read is unavailable.')
  const { content } = await hostSkills.read(name, 'SKILL.md')
  return validateSkillDocument(content, name)
}

module.exports = { quickValidate, validateSkillDocument }
