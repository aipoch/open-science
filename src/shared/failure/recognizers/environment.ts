import type { Recognizer } from '../contract'

export const recognizeEnvironment: Recognizer = ({ origin, code, text = '' }) => {
  if (origin === 'provider') return undefined
  if (
    ['EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(String(code)) ||
    /\b(?:EACCES|EPERM|ENOSPC|EROFS)\b/.test(text)
  )
    return { category: 'environment', reason: 'environment/filesystem', diagnostics: {} }
  if (
    text === 'The Specialist Skills or Connectors could not be loaded. Try sending again.' ||
    text.endsWith(
      'Error: The Specialist Skills or Connectors could not be loaded. Try sending again.'
    )
  )
    return {
      category: 'environment',
      reason: 'environment/specialist-capabilities',
      diagnostics: {}
    }
  if (
    origin === 'environment' ||
    /(?:python|conda) (?:environment )?(?:is )?(?:missing|not found|corrupt|unavailable)|(?:Notebook )?kernel (?:failed to start|startup failed)|No module named (?:ipykernel|ipykernel_launcher)|(?:WSL|sandbox) (?:is )?(?:not ready|unavailable|not installed)/i.test(
      text
    )
  )
    return { category: 'environment', reason: 'environment/runtime-unavailable', diagnostics: {} }
  return undefined
}
