import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TestSpecification, Vitest } from 'vitest/node'
import baseline from './windows-test-durations.json'
import WindowsTestSequencer, { assignWindowsTestShards } from './windows-test-sequencer'

describe('Windows duration-based test sharding', () => {
  const files = ['slow', 'medium', 'fast', 'new'].map((path) => ({ key: `default:${path}`, path }))

  it('assigns every discovered file once and deterministically, regardless of input ordering', () => {
    const timings = { slow: 90_000, medium: 40_000, fast: 20_000, removed: 999_999 }
    const assignments = assignWindowsTestShards(files, 3, timings)
    expect([...assignments.keys()].sort()).toEqual(files.map((file) => file.key).sort())
    expect(assignments).toEqual(assignWindowsTestShards([...files].reverse(), 3, timings))
    expect(assignments.get('default:slow')).toBe(1)
    expect(assignments.get('default:medium')).toBe(2)
    expect(assignments.get('default:fast')).toBe(3)
    expect(assignments.get('default:new')).toBe(3)
  })

  it('retains new files and treats invalid measurements as unknown', () => {
    expect(assignWindowsTestShards(files, 5, { slow: NaN, medium: -1, fast: Infinity })).toEqual(
      assignWindowsTestShards(files, 5, {})
    )
    expect(assignWindowsTestShards([], 5)).toEqual(new Map())
    expect(() => assignWindowsTestShards(files, 0)).toThrow('Invalid')
    expect(() => assignWindowsTestShards([...files, files[0]], 2)).toThrow('Duplicate')
  })

  it('balances the captured slow suites instead of concentrating them in one shard', () => {
    const measured = Object.keys(baseline.durationsMs).map((path) => ({ key: path, path }))
    const assignments = assignWindowsTestShards(measured, 5)
    const loads = Array<number>(5).fill(0)
    for (const [path, ms] of Object.entries(baseline.durationsMs)) {
      expect(Number.isFinite(ms) && ms >= baseline.minimumRecordedDurationMs).toBe(true)
      expect(path).not.toContain('\\')
      loads[assignments.get(path)! - 1] += ms + baseline.perFileOverheadMs
    }
    expect(Math.max(...loads) / Math.min(...loads)).toBeLessThan(1.02)
  })

  it('keeps project identities separate and returns an exhaustive, disjoint partition', async () => {
    const root = resolve('fixture-root')
    const specs = ['default', 'process', 'database'].flatMap((name) =>
      ['shared.test.ts', 'new.test.ts'].map(
        (path) => ({ moduleId: resolve(root, path), project: { name } }) as TestSpecification
      )
    )
    const partitions = await Promise.all(
      [1, 2, 3, 4, 5].map((index) =>
        new WindowsTestSequencer({ config: { root, shard: { index, count: 5 } } } as Vitest).shard(
          specs
        )
      )
    )
    expect(partitions.flat()).toHaveLength(specs.length)
    expect(new Set(partitions.flat())).toEqual(new Set(specs))
    expect(await new WindowsTestSequencer({ config: { root } } as Vitest).shard(specs)).toEqual(
      specs
    )
  })
})
