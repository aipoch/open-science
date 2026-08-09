'use strict'
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const buildImprovementPrompt = ({
  skillName,
  skillContent,
  currentDescription,
  evalResults,
  history = []
}) => {
  const failedPositive = evalResults.results.filter(
    (result) => result.should_trigger && !result.pass
  )
  const failedNegative = evalResults.results.filter(
    (result) => !result.should_trigger && !result.pass
  )
  return `Improve the trigger description for the Skill "${skillName}".

Current description:
<current_description>${currentDescription}</current_description>

Should have triggered but did not:
${failedPositive.map((result) => `- ${result.query}`).join('\n') || '- none'}

Should not have triggered but did:
${failedNegative.map((result) => `- ${result.query}`).join('\n') || '- none'}

Previous attempts:
${history.map((attempt) => `- ${attempt.description}`).join('\n') || '- none'}

Skill content:
<skill_content>${skillContent}</skill_content>

Generalize from the failures. Describe user intent, not implementation. Stay under 1024 characters.
Return only <new_description>...</new_description>.`
}

const parseImprovedDescription = (response) => {
  const match = /<new_description>([\s\S]*?)<\/new_description>/i.exec(response)
  const description = (match?.[1] ?? response).trim().replace(/^['"]|['"]$/g, '')
  if (!description) throw new Error('Description improvement returned empty text.')
  if (description.length > 1024) throw new Error('Description improvement exceeds 1024 characters.')
  return description
}

module.exports = { buildImprovementPrompt, parseImprovedDescription }
