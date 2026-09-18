import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

export const WINDOWS_TEST_SHARD_COUNT = 8

// Keep each module together. The last group owns all remaining application, renderer and tooling
// tests, including new directories, so this routing never limits Vitest's discovery. Groups are
// sized from measured scheduled-run durations so each serial shard stays inside the job timeout.
export const WINDOWS_TEST_MODULE_GROUPS = [
  // 1: Session packages.
  ['src/main/session-package/', 'src/main/archive/'],
  // 2: Database and storage.
  ['src/main/database/', 'src/main/storage/', 'src/main/session-deletion/', 'src/main/local-fs/'],
  // 3: Session persistence, file versions and project files.
  [
    'src/main/session-persistence/',
    'src/main/managed-file-versions/',
    'src/main/project-files/',
    'src/main/projects/',
    'src/main/uploads/',
    'packages/safe-file-publisher-native/'
  ],
  // 4: Research content.
  ['src/main/literature/', 'src/main/memory/', 'src/main/tags/', 'src/main/bookmarks/'],
  // 5: Artifacts, review and skills.
  [
    'src/main/artifacts/',
    'src/main/reviewer/',
    'src/main/permission-grants/',
    'src/main/skills/',
    'src/main/specialist/',
    'src/main/agents/'
  ],
  // 6: Agent and compute runtimes.
  [
    'src/main/acp/',
    'src/main/agent-framework/',
    'src/main/delegation/',
    'src/main/side-chat/',
    'src/main/session-plan/',
    'src/main/background-result-delivery/',
    'src/main/compute/'
  ],
  // 7: Notebook runtime and sandbox.
  ['src/main/notebook/', 'packages/notebook-network-sandbox/', 'packages/process-tree-native/']
] as const

export function windowsTestShard(path: string): number {
  const normalized = path.replaceAll('\\', '/')
  const group = WINDOWS_TEST_MODULE_GROUPS.findIndex((prefixes) =>
    prefixes.some((prefix) => normalized.startsWith(prefix))
  )
  return group < 0 ? WINDOWS_TEST_SHARD_COUNT : group + 1
}

export default class WindowsTestSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard
    if (!shard) return files
    if (shard.count !== WINDOWS_TEST_SHARD_COUNT) {
      throw new Error(`Windows module sharding requires ${WINDOWS_TEST_SHARD_COUNT} shards`)
    }
    return files.filter(
      (file) => windowsTestShard(relative(this.ctx.config.root, file.moduleId)) === shard.index
    )
  }
}
