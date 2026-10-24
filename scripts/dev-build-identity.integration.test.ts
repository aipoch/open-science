import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { createBackendBuilder } from './build-backend.mjs'

it('publishes successful dev builds, rejects failed rebuilds, and leaves release builds disabled', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dev-build-identity-')))
  const put = async (file: string, value: string): Promise<void> => {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), value)
  }
  await put('package.json', '{"dependencies":{}}')
  await put(
    'packages/open-science/installation-startup.cjs',
    'module.exports.protectInstallationStartup = () => {};'
  )
  await put('src/main/dev-build-identity.ts', 'export const devBuildIdentity = undefined')
  await mkdir(join(root, 'src/shared/i18n/locales'), { recursive: true })
  const source =
    "export { devBuildIdentity } from './dev-build-identity'; export const revision = 1;"
  await put('src/main/node-entry.ts', source)
  const output = join(root, 'out/backend/index.cjs')
  const manifest = join(root, 'out/backend/dev-build.json')
  const load = (): {
    devBuildIdentity?: { buildId: string; workspaceRoot: string }
    revision: number
  } =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['-e', `console.log(JSON.stringify(require(${JSON.stringify(output)})))`],
        { encoding: 'utf8' }
      )
    )
  const builder = await createBackendBuilder({ root, development: true })
  try {
    await builder.rebuild()
    const initial = load()
    expect(initial.devBuildIdentity).toEqual(JSON.parse(await readFile(manifest, 'utf8')))
    expect(initial.devBuildIdentity?.workspaceRoot).toBe(root)
    await put('src/main/node-entry.ts', source.replace('revision = 1', 'revision = 2'))
    await builder.rebuild()
    const updated = load()
    expect(updated.revision).toBe(2)
    expect(updated.devBuildIdentity?.buildId).not.toBe(initial.devBuildIdentity?.buildId)
    expect(updated.devBuildIdentity).toEqual(JSON.parse(await readFile(manifest, 'utf8')))
    await put('src/main/node-entry.ts', 'export invalid syntax')
    await expect(builder.rebuild()).rejects.toThrow()
    await expect(readFile(manifest)).rejects.toMatchObject({ code: 'ENOENT' })
    await put('src/main/node-entry.ts', source)
  } finally {
    await builder.dispose()
  }
  const release = await createBackendBuilder({ root, development: false })
  try {
    await release.rebuild()
    expect(load().devBuildIdentity).toBeUndefined()
    await expect(readFile(manifest)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await release.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
