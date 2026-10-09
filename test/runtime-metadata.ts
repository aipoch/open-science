import { afterAll, afterEach } from 'vitest'
import {
  RuntimeDirectoryOwnership,
  configureRuntimeDirectoryOwnership
} from '../src/main/runtime-ownership'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { configureRuntimeMetadata, type RuntimeMetadata } from '../src/main/runtime-metadata'

// Owner tests construct services without an entry point. Bind their host explicitly; production
// still fails closed when an entry forgets to install a capability. Each test file is isolated.
export function configureTestRuntimeMetadata(
  overrides: () => Partial<RuntimeMetadata> = () => ({})
): () => Promise<void> {
  let ownership = new RuntimeDirectoryOwnership()
  configureRuntimeDirectoryOwnership({
    acquireSync: (directory) => ownership.acquireSync(directory),
    acquire: (directory) => ownership.acquire(directory)
  })
  // Release real file handles before owner-test temporary-directory cleanup, including Windows.
  const resetOwnership = async (): Promise<void> => {
    await ownership.close()
    ownership = new RuntimeDirectoryOwnership()
  }
  afterEach(resetOwnership)
  afterAll(() => ownership.close())
  configureRuntimeMetadata(() => ({
    version: '0.0.0-test',
    locale: 'en-US',
    packaged: false,
    applicationPath: process.cwd(),
    homePath: homedir(),
    downloadsPath: resolve('Downloads'),
    resourcesPath: process.resourcesPath ?? resolve('resources'),
    ...overrides()
  }))
  return resetOwnership
}
