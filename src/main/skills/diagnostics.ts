import { subscribeSkillDiagnostics } from '@aipoch/skills'
import { createLogger } from '@aipoch/diagnostics/node'

let subscribers = 0
let unsubscribe: (() => void) | undefined

// Several SettingsService instances may coexist, but package diagnostics have one host sink.
export const attachSkillDiagnostics = (): (() => void) => {
  if (subscribers++ === 0) {
    unsubscribe = subscribeSkillDiagnostics(({ scope, level, message, fields }) => {
      createLogger(scope)[level](message, fields)
    })
  }
  let attached = true
  return () => {
    if (!attached) return
    attached = false
    if (--subscribers === 0) {
      unsubscribe?.()
      unsubscribe = undefined
    }
  }
}
