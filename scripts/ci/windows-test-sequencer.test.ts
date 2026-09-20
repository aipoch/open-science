import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TestSpecification, Vitest } from 'vitest/node'
import WindowsTestSequencer, {
  WINDOWS_TEST_MODULE_GROUPS,
  WINDOWS_TEST_SHARD_COUNT,
  windowsTestShard
} from './windows-test-sequencer'

describe('Windows module-based test sharding', () => {
  it.each([
    ['src/main/session-package/service.test.ts', 1],
    ['src/main/database/migration-service.test.ts', 2],
    ['src/main/storage/ipc.test.ts', 2],
    ['src/main/session-persistence/coordinator.test.ts', 3],
    ['src/main/managed-file-versions/service.integration.test.ts', 3],
    ['src/main/literature/catalog.test.ts', 4],
    ['src/main/artifacts/provenance-repository.test.ts', 5],
    ['src/main/reviewer/reviewer-orchestrator.test.ts', 5],
    ['src/main/acp/context-usage-static-context.test.ts', 6],
    ['src/main/compute/compute-service.test.ts', 6],
    ['src/main/delegation/opencode-runtime-preparation.test.ts', 6],
    ['src/main/notebook/runtime-service.test.ts', 7],
    ['packages/notebook-network-sandbox/src/gateway.test.ts', 7],
    ['src/renderer/src/new.test.tsx', 8],
    ['scripts/new.test.ts', 8],
    ['src/main/new-module/new.test.ts', 8],
    ['src/main/database-other/new.test.ts', 8]
  ])('routes %s to group %i on either path separator', (path, group) => {
    expect(windowsTestShard(path)).toBe(group)
    expect(windowsTestShard(path.replaceAll('/', '\\'))).toBe(group)
  })

  it('keeps new tests with their module and has no overlapping module prefixes', () => {
    const prefixes = WINDOWS_TEST_MODULE_GROUPS.flat()
    expect(WINDOWS_TEST_MODULE_GROUPS).toHaveLength(WINDOWS_TEST_SHARD_COUNT - 1)
    for (const [index, group] of WINDOWS_TEST_MODULE_GROUPS.entries()) {
      for (const prefix of group) {
        expect(windowsTestShard(`${prefix}nested/new.integration.test.ts`)).toBe(index + 1)
        expect(prefixes.filter((other) => prefix.startsWith(other))).toEqual([prefix])
      }
    }
  })

  it('partitions all discovered specifications once, preserving project identities and order', async () => {
    const root = resolve('fixture-root')
    const paths = [
      ...WINDOWS_TEST_MODULE_GROUPS.flat().map((prefix) => `${prefix}new.test.ts`),
      'src/main/new-module/new.test.ts'
    ]
    const specs = ['default', 'process', 'database'].flatMap((name) =>
      paths.map(
        (path) => ({ moduleId: resolve(root, path), project: { name } }) as TestSpecification
      )
    )
    const indexes = Array.from({ length: WINDOWS_TEST_SHARD_COUNT }, (_, offset) => offset + 1)
    const partitions = await Promise.all(
      indexes.map((index) =>
        new WindowsTestSequencer({
          config: { root, shard: { index, count: WINDOWS_TEST_SHARD_COUNT } }
        } as Vitest).shard(specs)
      )
    )
    expect(partitions.flat()).toHaveLength(specs.length)
    expect(new Set(partitions.flat())).toEqual(new Set(specs))
    for (const partition of partitions) {
      expect(partition.length).toBeGreaterThan(0)
      expect(partition).toEqual(specs.filter((spec) => partition.includes(spec)))
    }
    expect(await new WindowsTestSequencer({ config: { root } } as Vitest).shard(specs)).toEqual(
      specs
    )
    await expect(
      new WindowsTestSequencer({ config: { root, shard: { index: 1, count: 5 } } } as Vitest).shard(
        specs
      )
    ).rejects.toThrow('requires 8 shards')
  })
})
