import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

export const WINDOWS_TEST_SHARD_COUNT = 8

// Keep each module together. The last group owns all remaining application and tooling
// tests, including new directories, so this routing never limits Vitest's discovery. Groups are
// sized from measured scheduled-run durations so each serial shard stays inside the job timeout.
export const WINDOWS_TEST_MODULE_GROUPS = [
  // 1: Session packages and PDF packages. Run 38471659827 left this shard at 18 minutes
  // while the catch-all exceeded 60; PDF writer alone used over six minutes there.
  [
    'src/main/session-package/',
    'src/main/archive/',
    'packages/pdf-structure/',
    'packages/pdf-translation/'
  ],
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
  // 4: Research content (17 minutes) and renderer pages (26 minutes).
  [
    'src/main/literature/',
    'src/main/memory/',
    'src/main/tags/',
    'src/main/bookmarks/',
    'src/renderer/src/pages/'
  ],
  // 5: Artifacts, review and skills.
  [
    'src/main/artifacts/',
    'src/main/reviewer/',
    'src/main/permission-grants/',
    'src/main/skills/',
    'src/main/specialist/',
    'src/main/agents/'
  ],
  // 6: Agent and compute runtimes (18 minutes), plus other renderer tests (6 minutes).
  // First match wins: the more specific renderer pages prefix above stays in group 4.
  [
    'src/main/acp/',
    'src/main/agent-framework/',
    'src/main/delegation/',
    'src/main/side-chat/',
    'src/main/session-plan/',
    'src/main/background-result-delivery/',
    'src/main/compute/',
    'src/renderer/'
  ],
  // 7: Notebook runtime and sandbox.
  [
    'src/main/notebook/',
    'packages/notebook-syntax/',
    'packages/notebook-code-risk/',
    'packages/notebook-analysis/',
    'packages/notebook-network-sandbox/',
    'packages/process-tree-native/'
  ]
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
