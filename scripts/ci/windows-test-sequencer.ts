import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

// Keep each module together. Group 5 owns all remaining application, renderer and tooling tests,
// including new directories, so this routing never limits Vitest's discovery.
export const WINDOWS_TEST_MODULE_GROUPS = [
  // 1: Session packages and file versions.
  ['src/main/session-package/', 'src/main/managed-file-versions/', 'src/main/archive/'],
  // 2: Storage and persistence.
  [
    'src/main/database/',
    'src/main/session-persistence/',
    'src/main/session-deletion/',
    'src/main/storage/',
    'src/main/project-files/',
    'src/main/projects/',
    'src/main/uploads/',
    'src/main/local-fs/',
    'packages/safe-file-publisher-native/'
  ],
  // 3: Agent and Notebook runtimes.
  [
    'src/main/acp/',
    'src/main/agent-framework/',
    'src/main/agents/',
    'src/main/delegation/',
    'src/main/reviewer/',
    'src/main/notebook/',
    'src/main/compute/',
    'src/main/skills/',
    'src/main/specialist/',
    'src/main/side-chat/',
    'src/main/session-plan/',
    'src/main/permission-grants/',
    'src/main/background-result-delivery/',
    'packages/notebook-network-sandbox/',
    'packages/process-tree-native/'
  ],
  // 4: Research content.
  [
    'src/main/literature/',
    'src/main/artifacts/',
    'src/main/memory/',
    'src/main/tags/',
    'src/main/bookmarks/'
  ]
] as const

export function windowsTestShard(path: string): number {
  const normalized = path.replaceAll('\\', '/')
  const group = WINDOWS_TEST_MODULE_GROUPS.findIndex((prefixes) =>
    prefixes.some((prefix) => normalized.startsWith(prefix))
  )
  return group < 0 ? 5 : group + 1
}

export default class WindowsTestSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard
    if (!shard) return files
    if (shard.count !== 5) throw new Error('Windows module sharding requires five shards')
    return files.filter(
      (file) => windowsTestShard(relative(this.ctx.config.root, file.moduleId)) === shard.index
    )
  }
}
