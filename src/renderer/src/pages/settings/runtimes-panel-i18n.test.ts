import { describe, expect, it } from 'vitest'

import { i18next } from '@/i18n'
import { envReadyLine, managedLine, providerType } from './runtimes-panel-view'
import type { DiscoveredInterpreter } from '../../../../shared/notebook-runtime'

// The runtimes panel renders its badge and status lines through these describers. A literal left behind
// in one of them would look correct in English and stay English in every other language, which catalog
// parity cannot detect — only asserting the translated output can.
describe('runtimes panel describers', () => {
  const en = i18next.getFixedT('en')
  const zh = i18next.getFixedT('zh-Hans')

  const env = (over: Partial<DiscoveredInterpreter> = {}): DiscoveredInterpreter =>
    ({
      language: 'python',
      path: '/usr/bin/python3',
      runnable: true,
      provenance: 'user-own',
      ...over
    }) as DiscoveredInterpreter

  it('localizes every provenance branch', () => {
    expect(providerType(env({ provenance: 'app-managed' }), en)).toBe('App-managed')
    expect(providerType(env({ provenance: 'app-managed' }), zh)).toBe('应用托管')
    expect(providerType(env({ provenance: 'agent-created' }), zh)).toBe('智能体创建')
    // 'System' is the fallback for a user-own interpreter with no conda env.
    expect(providerType(env(), zh)).toBe('系统')
  })

  it("keeps the user's conda env name verbatim across languages", () => {
    const conda = env({ provenance: 'user-own', condaEnv: 'bio' })
    expect(providerType(conda, en)).toBe('Conda: bio')
    expect(providerType(conda, zh)).toBe('Conda：bio')
  })

  it('localizes readiness while passing probe detail through untouched', () => {
    expect(envReadyLine(env({ version: '3.12.1' }), zh)).toBe('就绪 · 3.12.1')
    // `detail` comes from the main-process probe, not the catalog, so it must survive as-is.
    expect(envReadyLine(env({ runnable: false, detail: 'missing libffi' }), zh)).toBe(
      'missing libffi'
    )
    expect(envReadyLine(env({ runnable: false }), zh)).toBe('无法运行')
  })

  it('localizes managed-runtime status but prefers a live progress message', () => {
    expect(managedLine(true, false, zh)).toBe('已安装并就绪')
    expect(managedLine(false, false, zh)).toBe('托管运行时尚未设置')
    expect(managedLine(false, true, zh)).toBe('正在下载托管运行时…')
    // A streamed progress message wins over the generic preparing copy.
    expect(managedLine(false, true, zh, 'Unpacking 40%')).toBe('Unpacking 40%')
  })
})
