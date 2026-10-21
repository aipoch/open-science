import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertLocalUpdateUrl,
  readLocalUpdateValidationConfig,
  type LocalUpdateValidationConfig
} from './config'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(): {
  root: string
  config: LocalUpdateValidationConfig
  read(): LocalUpdateValidationConfig
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-update-config-')))
  roots.push(root)
  const config: LocalUpdateValidationConfig = {
    schema: 1,
    runId: 'test',
    scenario: 'boundary',
    runRoot: root,
    homeRoot: join(root, 'home'),
    keychainPath: join(root, 'validation.keychain-db'),
    configRoot: join(root, 'config'),
    dataRoot: join(root, 'data'),
    userDataRoot: join(root, 'profile'),
    updateCacheRoot: join(root, 'cache'),
    eventsPath: join(root, 'events.jsonl'),
    feedUrl: 'http://127.0.0.1:4567/',
    manifestUrl: 'http://127.0.0.1:4567/version.json',
    installBehavior: 'boundary',
    targetArtifact: {
      version: '0.0.2',
      arch: 'arm64',
      size: 10,
      sha512: Buffer.alloc(64).toString('base64')
    }
  }
  for (const key of [
    'homeRoot',
    'configRoot',
    'dataRoot',
    'userDataRoot',
    'updateCacheRoot'
  ] as const)
    mkdirSync(config[key])
  writeFileSync(config.keychainPath, 'test Keychain placeholder')
  const path = join(root, 'config.json')
  const read = (): LocalUpdateValidationConfig => {
    writeFileSync(path, JSON.stringify(config))
    return readLocalUpdateValidationConfig(path)
  }
  return { root, config, read }
}
describe('isolated local update configuration', () => {
  it('accepts only explicit loopback source and isolated canonical directories', () => {
    const { config, read } = fixture()
    expect(read()).toEqual(config)
  })
  it.each([
    'https://example.com/',
    'http://localhost:4567/',
    'http://127.0.0.2:4567/',
    'http://127.0.0.1/',
    'http://user@127.0.0.1:4567/',
    'http://[::1]:4567/'
  ])('rejects a non-approved origin %s', (url) => {
    expect(() => assertLocalUpdateUrl(url)).toThrow()
  })
  it('rejects another loopback port and directory overlap', () => {
    const { config, read } = fixture()
    config.manifestUrl = 'http://127.0.0.1:4568/version.json'
    expect(read).toThrow()
    config.manifestUrl = 'http://127.0.0.1:4567/version.json'
    config.dataRoot = config.configRoot
    expect(read).toThrow()
  })
  it('rejects paths outside the run, symlinked directories and journal symlinks', () => {
    const { root, config, read } = fixture()
    config.dataRoot = tmpdir()
    expect(read).toThrow()
    config.dataRoot = join(root, 'alias')
    symlinkSync(join(root, 'data'), config.dataRoot)
    expect(read).toThrow()
    config.dataRoot = join(root, 'data')
    symlinkSync(join(root, 'outside.jsonl'), config.eventsPath)
    expect(read).toThrow()
  })
})
