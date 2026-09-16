import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'
import baseline from './windows-test-durations.json'

const durations: Readonly<Record<string, number>> = baseline.durationsMs

// Short/unseen files still incur worker/setup costs. Timings affect assignment only: discovery
// remains Vitest's responsibility, so removed baseline entries never resurrect obsolete tests.
export function assignWindowsTestShards(
  files: readonly { key: string; path: string }[],
  count: number,
  timings: Readonly<Record<string, number>> = durations
): Map<string, number> {
  if (!Number.isInteger(count) || count < 1) throw new Error('Invalid Windows test shard count')
  const weighted = files.map((file) => ({
    ...file,
    weight:
      (Number.isFinite(timings[file.path]) && timings[file.path] >= 0
        ? timings[file.path]
        : baseline.fallbackDurationMs) + baseline.perFileOverheadMs
  }))
  weighted.sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const loads = Array<number>(count).fill(0)
  const assignments = new Map<string, number>()
  for (const file of weighted) {
    if (assignments.has(file.key)) throw new Error(`Duplicate test specification: ${file.key}`)
    const shard = loads.indexOf(Math.min(...loads))
    assignments.set(file.key, shard + 1)
    loads[shard] += file.weight
  }
  return assignments
}

export default class WindowsTestSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard
    if (!shard) return files
    const entries = files.map((file) => {
      const path = relative(this.ctx.config.root, file.moduleId).replaceAll('\\', '/')
      return { key: `${file.project.name}:${path}`, path }
    })
    const assignments = assignWindowsTestShards(entries, shard.count)
    return files.filter((_, index) => assignments.get(entries[index].key) === shard.index)
  }
}
