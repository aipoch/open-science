import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  inspectApplicationPackage,
  productionBuildEnvironment,
  verifyPreparedSource
} from './production-package.mjs'

const asar = createRequire(import.meta.url)('@electron/asar')
const roots: string[] = []
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
async function temporary(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'production-boundary-')))
  roots.push(root)
  return root
}
async function put(path: string, text: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function application(entries: Record<string, string> = {}): Promise<string> {
  const root = await temporary()
  const source = join(root, 'archive-input')
  await put(join(source, 'package.json'), JSON.stringify({ version: '0.0.1' }))
  await put(join(source, 'out/main/index.js'), 'console.log("ordinary production application")')
  for (const [name, content] of Object.entries(entries)) await put(join(source, name), content)
  const app = join(root, 'Open-Science.app')
  const resources = join(app, 'Contents/Resources')
  await mkdir(resources, { recursive: true })
  await asar.createPackage(source, join(resources, 'app.asar'))
  await put(join(resources, 'backend/package.json'), JSON.stringify({ version: '0.0.1' }))
  await put(join(resources, 'backend/index.js'), 'console.log("ordinary backend")')
  await put(join(app, 'Contents/Frameworks/Example.framework/Versions/A/Example'), 'framework')
  await symlink('A', join(app, 'Contents/Frameworks/Example.framework/Versions/Current'))
  await symlink(
    'Versions/Current/Example',
    join(app, 'Contents/Frameworks/Example.framework/Example')
  )
  return app
}

describe('complete application package boundaries', () => {
  it('inventories packed files, backend and relative framework links and binds content changes to identity', async () => {
    const app = await application()
    const first = await inspectApplicationPackage(app, { production: true, asar })
    expect(first).toMatchObject({
      version: '0.0.1',
      externalProgramExcluded: true,
      testAdapterExcluded: true,
      runtimeActivationInputExcluded: true
    })
    expect(first.archives).toEqual([
      expect.objectContaining({ path: 'Contents/Resources/app.asar', entries: expect.any(Number) })
    ])
    expect(first.files).toContainEqual({
      path: 'Contents/Frameworks/Example.framework/Versions/Current',
      kind: 'symlink',
      target: 'A'
    })
    expect(
      first.files.some(
        (file: { path: string }) => file.path === 'Contents/Resources/backend/index.js'
      )
    ).toBe(true)
    await put(join(app, 'Contents/Resources/backend/index.js'), 'changed backend')
    const second = await inspectApplicationPackage(app, { production: true, asar })
    expect(second.treeSha256).not.toBe(first.treeSha256)
  })

  it.each(['scripts/local-update-validation/server.mjs', 'docs/local-update-validation.md'])(
    'rejects external tooling ASAR paths even when their contents are empty: %s',
    async (name) => {
      const app = await application({ [name]: '' })
      await expect(inspectApplicationPackage(app, { production: false, asar })).rejects.toThrow(
        'External validation tooling'
      )
    }
  )

  it.each(['backend', 'app.asar.unpacked', 'extra-resources'])(
    'rejects external runner contents outside the ASAR in %s',
    async (directory) => {
      const app = await application()
      await put(
        join(app, 'Contents/Resources', directory, 'renamed.js'),
        'const receipt = ".local-update-validation-owner.json"'
      )
      await expect(inspectApplicationPackage(app, { production: false, asar })).rejects.toThrow(
        'Forbidden validation code'
      )
    }
  )

  it('allows the test adapter in A/B but rejects it in the ordinary package', async () => {
    const app = await application({ 'out/main/adapter-123.js': 'class LocalMacDownloadUpdater {}' })
    await expect(
      inspectApplicationPackage(app, { production: false, asar })
    ).resolves.toMatchObject({ externalProgramExcluded: true })
    await expect(inspectApplicationPackage(app, { production: true, asar })).rejects.toThrow(
      'LocalMacDownloadUpdater'
    )
  })

  it('rejects runtime activation code split across file-stream chunks', async () => {
    const app = await application()
    await put(
      join(app, 'Contents/Resources/backend/renamed.js'),
      Buffer.concat([
        Buffer.alloc(65530, 32),
        Buffer.from('OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CONFIG')
      ])
    )
    await expect(inspectApplicationPackage(app, { production: true, asar })).rejects.toThrow(
      'OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CONFIG'
    )
  })

  it('rejects source-backed application symlinks instead of certifying an incomplete copy', async () => {
    const app = await application()
    const outside = join(dirname(app), 'outside.txt')
    await put(outside, 'external')
    await symlink(outside, join(app, 'Contents/external'))
    await expect(inspectApplicationPackage(app, { production: true, asar })).rejects.toThrow(
      'symlink escapes'
    )
  })

  it('rejects mismatched backend versions', async () => {
    const app = await application()
    await put(
      join(app, 'Contents/Resources/backend/package.json'),
      JSON.stringify({ version: '0.0.2' })
    )
    await expect(inspectApplicationPackage(app, { production: true, asar })).rejects.toThrow(
      'versions must agree'
    )
  })
})

describe('same-snapshot preparation reuse', () => {
  it('permits only the recorded version changes and detects changed prepared inputs', async () => {
    const root = await temporary()
    const directory = join(root, 'builds/a')
    const packageText = JSON.stringify({ name: 'fixture', version: '1.0.0' })
    const sourceText = 'fixed source code'
    const files = [
      { path: 'package.json', kind: 'file', executable: false, sha256: digest(packageText) },
      { path: 'source.js', kind: 'file', executable: false, sha256: digest(sourceText) }
    ]
    const snapshotId = digest(JSON.stringify(files))
    await put(join(root, 'source.json'), JSON.stringify({ schema: 1, snapshotId, files }))
    await put(join(root, 'source/package.json'), packageText)
    await put(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '0.0.1' })
    )
    await put(join(directory, 'source.js'), sourceText)
    await expect(verifyPreparedSource(root, directory, snapshotId, '0.0.1')).resolves.toMatchObject(
      { snapshotId, filesCompared: 2 }
    )
    await put(join(directory, 'source.js'), 'edited after capture')
    await expect(verifyPreparedSource(root, directory, snapshotId, '0.0.1')).rejects.toThrow(
      'Prepared source changed'
    )
    expect(await readFile(join(root, 'source/package.json'), 'utf8')).toBe(packageText)
  })

  it('removes inherited test activation and signing credentials while explicitly disabling the define', () => {
    const environment = productionBuildEnvironment({
      PATH: '/usr/bin',
      OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION: '1',
      OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CONFIG: '/old/run.json',
      OPEN_SCIENCE_CONFIG_ROOT: '/real/config',
      CSC_LINK: '/secret',
      APPLE_ID: 'secret'
    })
    expect(environment).toEqual({
      PATH: '/usr/bin',
      OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION: '0',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      MACOSX_DEPLOYMENT_TARGET: '12.0'
    })
  })
})
