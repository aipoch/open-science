import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveWindowsNotebookRuntime,
  resolveWindowsNotebookNodeRuntime,
  windowsNotebookNodeEnvironment,
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
const installNodeRuntime = (root: string): void => {
  for (const file of ['node.exe', 'npm.cmd', 'npx.cmd', 'node_modules/npm/package.json']) {
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
    const nodeRoot = join(resources, 'node-runtime')
    install(runtimeRoot)
    installNodeRuntime(nodeRoot)
    expect(resolveWindowsNotebookRuntime(resources, root, 'x64')).toEqual({
      root: runtimeRoot,
      node: join(runtimeRoot, 'node/node.exe'),
      powershell: join(runtimeRoot, 'powershell/pwsh.exe')
    })
    expect(resolveWindowsNotebookNodeRuntime(resources, root, 'x64')).toEqual({
      root: nodeRoot,
      node: join(nodeRoot, 'node.exe')
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
  it('resolves the staged development Node/npm runtime separately from protected components', () => {
    const { root, resources } = fixture()
    const nodeRoot = join(root, 'out/node-runtime/win32-x64')
    installNodeRuntime(nodeRoot)
    expect(resolveWindowsNotebookNodeRuntime(resources, join(root, 'out/main'), 'x64')).toEqual({
      root: nodeRoot,
      node: join(nodeRoot, 'node.exe')
    })
  })
  it('resolves the packaged Node runtime from the inherited host resources path', () => {
    const { root, resources } = fixture()
    const nodeRoot = join(resources, 'node-runtime')
    installNodeRuntime(nodeRoot)
    writeFileSync(join(resources, 'app.asar'), '')
    const previous = process.env.OPEN_SCIENCE_RESOURCES_PATH
    process.env.OPEN_SCIENCE_RESOURCES_PATH = resources
    try {
      expect(
        resolveWindowsNotebookNodeRuntime(
          join(root, 'resources/backend/resources'),
          join(root, 'resources/backend/out/backend'),
          'x64'
        )
      ).toEqual({ root: nodeRoot, node: join(nodeRoot, 'node.exe') })
    } finally {
      if (previous === undefined) delete process.env.OPEN_SCIENCE_RESOURCES_PATH
      else process.env.OPEN_SCIENCE_RESOURCES_PATH = previous
    }
  })
  it('resolves the standalone archive Node runtime beside the backend tree', () => {
    const { root } = fixture()
    const nodeRoot = join(root, 'node-runtime')
    installNodeRuntime(nodeRoot)
    expect(
      resolveWindowsNotebookNodeRuntime(
        join(root, 'backend/resources'),
        join(root, 'backend/out/backend'),
        'x64'
      )
    ).toEqual({ root: nodeRoot, node: join(nodeRoot, 'node.exe') })
  })
  it('resolves the prepared source fixture when the standalone development runtime is absent', () => {
    const { root, resources } = fixture()
    const nodeRoot = join(root, 'packages/notebook-network-sandbox/vendor/windows-runtime/x64/node')
    installNodeRuntime(nodeRoot)
    expect(resolveWindowsNotebookNodeRuntime(resources, join(root, 'out/main'), 'x64')).toEqual({
      root: nodeRoot,
      node: join(nodeRoot, 'node.exe')
    })
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
  it('prepends the bundled Node directory without changing PowerShell 5.1 variables', () => {
    const original = {
      Path: 'C:\\host',
      PSModulePath: 'C:\\WindowsPowerShell\\Modules',
      OTHER: 'kept'
    }
    const env = windowsNotebookNodeEnvironment(original, {
      root: 'D:\\runtime',
      node: 'D:\\runtime\\node\\node.exe'
    })
    expect(env).toEqual({
      Path: 'D:\\runtime\\node;C:\\host',
      PSModulePath: 'C:\\WindowsPowerShell\\Modules',
      OTHER: 'kept'
    })
    expect(original.Path).toBe('C:\\host')
  })
})
