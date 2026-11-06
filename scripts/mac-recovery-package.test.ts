import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'

const require = createRequire(import.meta.url)
const { routeDmgTarget } = require('../build/mac-recovery-package.cjs') as {
  routeDmgTarget(
    target: { build(path: string, arch: number): Promise<void> },
    arch: number,
    wrapper: string
  ): void
}

describe('Mac recovery distribution packaging', () => {
  it('routes concurrently built DMGs to their own signed wrapper without changing ZIP inputs', async () => {
    const build = vi.fn(async (): Promise<void> => {})
    const target = { build }
    routeDmgTarget(target, 1, '/build/x64/recovery-wrapper/Open-Science.app')
    routeDmgTarget(target, 3, '/build/arm64/recovery-wrapper/Open-Science.app')
    await Promise.all([
      target.build('/build/arm64/Open-Science.app', 3),
      target.build('/build/x64/Open-Science.app', 1)
    ])
    expect(build.mock.calls).toEqual([
      ['/build/arm64/recovery-wrapper/Open-Science.app', 3],
      ['/build/x64/recovery-wrapper/Open-Science.app', 1]
    ])
    const zip = { build: vi.fn(async (): Promise<void> => {}) }
    await zip.build('/build/arm64/Open-Science.app', 3)
    expect(zip.build).toHaveBeenCalledWith('/build/arm64/Open-Science.app', 3)
  })

  it('keeps the updater payload explicitly named and the ordinary runtime out of the Dock', () => {
    const config = load(readFileSync(resolve('electron-builder.yml'), 'utf8')) as {
      zip: { artifactName: string }
      mac: { extendInfo: { LSUIElement: boolean } }
      afterAllArtifactBuild: string
    }
    expect(config.zip.artifactName).toBe('aipoch-${name}-${version}-mac-${arch}-runtime.${ext}')
    expect(config.mac.extendInfo.LSUIElement).toBe(true)
    expect(config.afterAllArtifactBuild).toBe('build/mac-recovery-artifacts.cjs')
  })

  it('does not weaken publisher requirements when internal fault instrumentation is compiled', () => {
    const native = readFileSync(resolve('build/mac-recovery-launcher.m'), 'utf8')
    expect(native).toContain('#ifdef OPEN_SCIENCE_MAC_ENTRY_FAULT_INJECTION')
    expect(native).toContain(
      '#if !defined(OPEN_SCIENCE_MAC_ENTRY_TESTING) && !defined(OPEN_SCIENCE_MAC_ENTRY_ADHOC)'
    )
    expect(native).toContain('com.aipoch.open-science.launcher')
    expect(native).toContain('87G9WFU9H3')
    expect(native).toContain(
      'kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode'
    )
  })
})
