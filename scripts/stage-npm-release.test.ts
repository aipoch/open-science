import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { releaseManifests, stageNpmRelease } from './stage-npm-release.mjs'
import {
  runtimeTargets,
  runtimePackageName,
  currentRuntimeTarget
} from '../packages/open-science/runtime-package.mjs'

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

it('ships the MCP entry and its dependencies in the npm entry package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'osci-mcp-stage-'))
  try {
    const put = async (file: string, value: string): Promise<void> => {
      const path = join(root, file)
      await mkdir(resolve(path, '..'), { recursive: true })
      await writeFile(path, value)
    }
    const target = currentRuntimeTarget()
    await put('package.json', JSON.stringify({ version: '1.0.3' }))
    await put(
      'packages/open-science/package.json',
      await readFile('packages/open-science/package.json', 'utf8')
    )
    for (const file of ['mcp.mjs', 'cli.mjs'])
      await put(
        `packages/open-science/${file}`,
        await readFile(`packages/open-science/${file}`, 'utf8')
      )
    await put(
      'out/standalone/package.json',
      JSON.stringify({
        version: '1.0.3',
        os: [target.os],
        cpu: [target.cpu],
        engines: { node: '>=22.13.0' }
      })
    )
    await stageNpmRelease(root)
    expect(await readFile(join(root, 'out/npm-release/main/mcp.mjs'), 'utf8')).toContain(
      'createResearchMcpServer'
    )
    const manifest = JSON.parse(
      await readFile(join(root, 'out/npm-release/main/package.json'), 'utf8')
    )
    expect(manifest.dependencies).toMatchObject({
      '@modelcontextprotocol/sdk': expect.any(String),
      zod: expect.any(String)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
