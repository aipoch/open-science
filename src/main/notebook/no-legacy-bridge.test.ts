import { describe, expect, expectTypeOf, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRootNotebookLane, type NotebookLaneIdentity } from './lane-identity'
import type { NotebookLocalRpcServer } from './local-rpc-server'
import type { NotebookRunRepository } from './repository'
import type { NotebookSessionAggregateInit } from './session-aggregate'
import type { NotebookSessionRegistry } from './session-registry'

// Guards against reintroducing any retired kernel bridge now that NotebookKernelExecutor
// (kernel-executor.ts) driving the Python/R exec-loops is the sole executor. The old
// direct-python-process bridge, the retired Jupyter host executor + its output mapper, and the
// retired Jupyter host script must all stay gone.
//
// The retired filenames are assembled from fragments so this guard file itself does not contain the
// legacy identifiers the repo-wide grep gate forbids, while still asserting the real paths are gone.
const notebookDir = __dirname
const resourcesNotebookDir = join(__dirname, '../../../resources/notebook')

const retiredNotebookFiles = [
  'python-executor.ts',
  'jupyter' + '-executor.ts',
  'kernel-output' + '-mapper.ts'
]
const retiredResourceFile = 'kernel' + '-host.py'

describe('legacy kernel bridges retired', () => {
  it.each(retiredNotebookFiles)('src/main/notebook/%s no longer exists', (file) => {
    expect(existsSync(join(notebookDir, file))).toBe(false)
  })

  it('the retired Jupyter host script no longer exists', () => {
    expect(existsSync(join(resourcesNotebookDir, retiredResourceFile))).toBe(false)
  })
})

describe('Notebook Frame lane architecture', () => {
  it('requires explicit lanes at every production owner interface', () => {
    type RegistryIdentity = Parameters<NotebookSessionRegistry<never>['getOrCreate']>[0]
    type LoadRequest = Parameters<NotebookRunRepository['loadOrCreate']>[0]
    type RootFrameId = Parameters<typeof createRootNotebookLane>[2]
    type RpcFrameId = Parameters<NotebookLocalRpcServer['issueSessionConnection']>[2]

    expectTypeOf<RegistryIdentity>().toEqualTypeOf<NotebookLaneIdentity>()
    expectTypeOf<LoadRequest>().toMatchTypeOf<{ lane: NotebookLaneIdentity }>()
    expectTypeOf<RootFrameId>().toEqualTypeOf<string>()
    expectTypeOf<RpcFrameId>().toEqualTypeOf<string>()
    expectTypeOf<NotebookSessionAggregateInit>().toMatchTypeOf<{
      lane: NotebookLaneIdentity
    }>()
  })

  it('prevents Session-only Kernel keys and owner fallbacks from returning', () => {
    const sources = [
      'session-registry.ts',
      'session-aggregate.ts',
      'repository.ts',
      'run-terminalization.ts',
      'runtime-binding.ts',
      'runtime-service.ts',
      'local-rpc-server.ts'
    ].map((file) => [file, readFileSync(join(notebookDir, file), 'utf8')] as const)
    const forbidden = [
      /string\s*\|\s*NotebookLaneIdentity/,
      /NotebookLaneIdentity\s*\|\s*string/,
      /laneOrSessionId/,
      /lane\s*\?\?\s*createRootNotebookLane/,
      /agentFrameId\s*=\s*`root-frame-/
    ]

    for (const [file, source] of sources) {
      for (const pattern of forbidden) {
        expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern)
      }
    }
  })
})
