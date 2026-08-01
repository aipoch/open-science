export type SettingsIdSequence = () => number

// Provider and runtime-install identifiers historically share one process-local monotonic suffix.
// Keep that ephemeral state in its own owner so the SettingsService compatibility façade only holds
// capability references and forwards operations.
const createSettingsIdSequence = (): SettingsIdSequence => {
  let sequence = 0
  return () => {
    sequence += 1
    return sequence
  }
}

export { createSettingsIdSequence }
