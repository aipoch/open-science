import { describe, expect, it } from 'vitest'
import { releaseManifests } from './stage-npm-release.mjs'
import { runtimeTargets, runtimePackageName } from '../packages/open-science/runtime-package.mjs'

describe('native npm release manifests', () => {
  it.each(runtimeTargets)('pins the entry package and native payload for $id', (target) => {
    const { main, native } = releaseManifests(
      { name: '@aipoch/open-science', version: '0.1.0', bin: { 'open-science': 'cli.mjs' } },
      {
        version: '0.36.0',
        os: [target.os],
        cpu: [target.cpu],
        engines: { node: '>=22.13.0' },
        bundledDependencies: ['native'],
        bin: {}
      },
      target
    )
    expect(main.version).toBe(native.version)
    expect(Object.keys(main.optionalDependencies)).toHaveLength(5)
    expect(main.optionalDependencies[runtimePackageName(target)]).toBe('0.36.0')
    expect(native.name).toBe(runtimePackageName(target))
    expect(native.bin).toBeUndefined()
    expect(native.bundledDependencies).toEqual(['native'])
    expect(native.libc).toEqual(target.os === 'linux' ? ['glibc'] : undefined)
  })
  it('rejects mixed architecture inputs and prerelease versions', () => {
    expect(() =>
      releaseManifests({}, { version: '1.2.3', os: ['linux'], cpu: ['arm64'] }, runtimeTargets[0])
    ).toThrow('does not match')
    expect(() => releaseManifests({}, { version: '1.2.3-beta.1' }, runtimeTargets[0])).toThrow(
      'stable release'
    )
  })
})
