import { describe, expect, it } from 'vitest'

import { i18next } from '@/i18n'
import { uninstallDisabledHint } from './runtime-uninstall-hint'

describe('uninstallDisabledHint', () => {
  const base = { managed: true, active: false }
  // Pinned to English so the copy assertions below stay readable; the Chinese wiring is covered by
  // the locale-parameterized case at the end.
  const t = i18next.getFixedT('en')

  it('returns null for an actionable non-active managed runtime', () => {
    expect(uninstallDisabledHint('Codex', 'npm rm -g codex', base, t)).toBeNull()
  })

  it('explains that an unmanaged runtime cannot be uninstalled from the app', () => {
    const hint = uninstallDisabledHint('Codex', 'npm rm -g codex', { ...base, managed: false }, t)
    expect(hint).toContain("isn't managed by the app")
    expect(hint).toContain('npm rm -g codex')
  })

  it('explains that the active framework must be switched away first', () => {
    expect(uninstallDisabledHint('Claude', 'x', { ...base, active: true }, t)).toContain(
      'active agent framework'
    )
  })

  it('blocks uninstall with a wait-for-task hint while a prompt is in flight', () => {
    expect(uninstallDisabledHint('Codex', 'x', { ...base, promptInFlight: true }, t)).toBe(
      'A task is running — wait for it to finish before uninstalling.'
    )
  })

  it('prioritizes the unmanaged and active reasons over the prompt-in-flight reason', () => {
    // Precedence matters: an unmanaged or active runtime has a standing reason (gets a tooltip),
    // whereas prompt-in-flight is only a transient block.
    expect(
      uninstallDisabledHint(
        'Codex',
        'x',
        { managed: false, active: false, promptInFlight: true },
        t
      )
    ).toContain("isn't managed by the app")
    expect(
      uninstallDisabledHint('Claude', 'x', { managed: true, active: true, promptInFlight: true }, t)
    ).toContain('active agent framework')
  })

  it('localizes each reason while keeping the name and shell command verbatim', () => {
    const zh = i18next.getFixedT('zh-Hans')

    const unmanaged = uninstallDisabledHint(
      'Codex',
      'npm rm -g codex',
      { ...base, managed: false },
      zh
    )
    expect(unmanaged).toContain('不由本应用管理')
    // Caller-supplied data must survive the language change untouched.
    expect(unmanaged).toContain('Codex')
    expect(unmanaged).toContain('npm rm -g codex')

    expect(uninstallDisabledHint('Claude', 'x', { ...base, active: true }, zh)).toContain(
      '当前使用中的智能体框架'
    )
    expect(uninstallDisabledHint('Codex', 'x', { ...base, promptInFlight: true }, zh)).toBe(
      '有任务正在运行 —— 请等它结束后再卸载。'
    )
  })
})
