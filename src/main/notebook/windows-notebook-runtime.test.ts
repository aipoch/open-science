import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveWindowsNotebookRuntime,
  windowsNotebookRuntimeEnvironment
} from './windows-notebook-runtime'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const fixture = (): { root: string; resources: string } => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-runtime-'))
  roots.push(root)
  const resources = join(root, 'resources')
  mkdirSync(resources)
  return { root, resources }
}
const install = (root: string): void => {
  for (const file of ['node/node.exe', 'powershell/pwsh.exe', 'build.json']) {
    const target = join(root, file)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, '{}')
  }
}

describe('bundled Windows Notebook runtime', () => {
  it('preserves the shared npm environment supplied by its owner', () => {
    const runtime = {
      root: 'D:\\runtime',
      node: 'D:\\runtime\\node\\node.exe',
      powershell: 'D:\\runtime\\powershell\\pwsh.exe'
    }
    const environment = {
      NPM_CONFIG_PREFIX: 'D:\\data\\runtime\\npm\\win32-x64',
      NPM_CONFIG_CACHE: 'D:\\data\\runtime\\cache\\notebook\\npm\\win32-x64'
    }
    expect(windowsNotebookRuntimeEnvironment(environment, runtime)).toMatchObject(environment)
  })
  it('resolves packaged resources without a system PATH fallback', () => {
    const { root, resources } = fixture()
    const runtimeRoot = join(resources, 'notebook-runtime/x64')
    install(runtimeRoot)
    expect(resolveWindowsNotebookRuntime(resources, root, 'x64')).toEqual({
      root: runtimeRoot,
      node: join(runtimeRoot, 'node/node.exe'),
      powershell: join(runtimeRoot, 'powershell/pwsh.exe')
    })
  })
  it('fails closed for an incomplete packaged runtime even when a dev copy exists', () => {
    const { root, resources } = fixture()
    writeFileSync(join(resources, 'app.asar'), '')
    install(join(root, 'packages/notebook-network-sandbox/vendor/windows-runtime/x64'))
    expect(() => resolveWindowsNotebookRuntime(resources, join(root, 'out/main'), 'x64')).toThrow(
      'runtime is missing'
    )
  })
  it('resolves the development copy relative to the bundled main module', () => {
    const { root, resources } = fixture()
    const runtimeRoot = join(root, 'packages/notebook-network-sandbox/vendor/windows-runtime/x64')
    install(runtimeRoot)
    expect(resolveWindowsNotebookRuntime(resources, join(root, 'out/main'), 'x64').root).toBe(
      runtimeRoot
    )
  })
  it('selects the repaired Node/npm before host tools without mutating the captured environment', () => {
    const original = {
      Path: 'C:\\host',
      PSModulePath: 'C:\\legacy-modules',
      OTHER: 'kept',
      NODE_OPTIONS: '--require C:\\host\\preload.js',
      OPEN_SCIENCE_NOTEBOOK_CACHE_DIR: 'D:\\cache'
    }
    const env = windowsNotebookRuntimeEnvironment(original, {
      root: 'D:\\runtime',
      node: 'D:\\runtime\\node\\node.exe',
      powershell: 'D:\\runtime\\powershell\\pwsh.exe'
    })
    expect(env).toEqual({
      Path: 'D:\\runtime\\node;C:\\host',
      PSModulePath: 'D:\\runtime\\powershell\\Modules',
      OPEN_SCIENCE_PSMODULEPATH: 'D:\\runtime\\powershell\\Modules',
      NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main',
      OPEN_SCIENCE_NOTEBOOK_CACHE_DIR: 'D:\\cache',
      OTHER: 'kept'
    })
    expect(original.Path).toBe('C:\\host')
  })
})
