import { describe, expect, it } from 'vitest'

import { uninstallDisabledHint } from './runtime-uninstall-hint'

describe('uninstallDisabledHint', () => {
  const base = { managed: true, active: false }

  it('returns null for an actionable non-active managed runtime', () => {
    expect(uninstallDisabledHint('Codex', 'npm rm -g codex', base)).toBeNull()
  })

  it('explains that an unmanaged runtime cannot be uninstalled from the app', () => {
    const hint = uninstallDisabledHint('Codex', 'npm rm -g codex', { ...base, managed: false })
    expect(hint).toContain("isn't managed by the app")
    expect(hint).toContain('npm rm -g codex')
  })

  it('explains that the active framework must be switched away first', () => {
    expect(uninstallDisabledHint('Claude', 'x', { ...base, active: true })).toContain(
      'active agent framework'
    )
  })

  it('blocks uninstall with a wait-for-task hint while a prompt is in flight', () => {
    expect(uninstallDisabledHint('Codex', 'x', { ...base, promptInFlight: true })).toBe(
      'A task is running — wait for it to finish before uninstalling.'
    )
  })

  it('prioritizes the unmanaged and active reasons over the prompt-in-flight reason', () => {
    // Precedence matters: an unmanaged or active runtime has a standing reason (gets a tooltip),
    // whereas prompt-in-flight is only a transient block.
    expect(
      uninstallDisabledHint('Codex', 'x', { managed: false, active: false, promptInFlight: true })
    ).toContain("isn't managed by the app")
    expect(
      uninstallDisabledHint('Claude', 'x', { managed: true, active: true, promptInFlight: true })
    ).toContain('active agent framework')
  })
})
