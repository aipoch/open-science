/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { packageTestRegistrationViolations } from './package-test-policy.mjs'

function fixture() {
  const module = (name: string) => ({
    ownerPaths: [`packages/${name}/src/index.ts`, `packages/${name}/src/index.test.ts`],
    interfacePaths: [],
    consumerModules: [] as string[],
    testFiles: {
      owner: [`packages/${name}/src/index.test.ts`],
      contract: [] as string[],
      consumer: [] as string[]
    },
    capabilityOverlays: [],
    fallbackCapability: 'main_runtime',
    fullTestReason: undefined as string | undefined
  })
  const registry = {
    schemaVersion: 1,
    packages: [
      { root: 'packages/core', dependencies: [] },
      { root: 'packages/client', dependencies: ['packages/core'] },
      { root: 'packages/other', dependencies: [] }
    ]
  }
  const before = {
    schemaVersion: 1,
    modules: { core: module('core'), client: module('client'), other: module('other') }
  }
  before.modules.core.testFiles.consumer.push('packages/client/src/index.test.ts')
  before.modules.client.testFiles.contract.push('packages/core/src/index.test.ts')
  before.modules.client.testFiles.consumer.push('packages/other/src/index.test.ts')
  return { registry, before }
}

it('rejects upstream and unrelated package tests but preserves real downstream coverage', () => {
  const { registry, before } = fixture()
  expect(packageTestRegistrationViolations(before, registry)).toEqual([
    { id: 'client', kind: 'contract', test: 'packages/core/src/index.test.ts' },
    { id: 'client', kind: 'consumer', test: 'packages/other/src/index.test.ts' }
  ])
  before.modules.client.consumerModules.push('core')
  expect(packageTestRegistrationViolations(before, registry)).toContainEqual({
    id: 'client',
    kind: 'consumerModules',
    test: 'core'
  })
})
