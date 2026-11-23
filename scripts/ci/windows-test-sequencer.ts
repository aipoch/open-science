import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

export const WINDOWS_TEST_SHARD_COUNT = 8

// Keep each module together by default. A small measured exact-file table spreads the slowest
// files across the existing serial shards. The last group owns all remaining application and
// tooling tests, including new directories, so this routing never limits Vitest's discovery.
// Groups are sized from measured scheduled-run durations so each serial shard stays inside the
// job timeout.
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

// Run 44954000512 showed two slow groups at roughly 55 minutes and two spare groups
// below 25 minutes. Move only the measured outliers, keeping their complete files and project
// identities together while reducing the maximum shard wall time.
export const WINDOWS_TEST_EXACT_SHARDS: Readonly<Record<string, number>> = {
  'src/main/database/migration-service.test.ts': 5,
  'src/main/session-package/service.test.ts': 5,
  'src/main/session-package/deletion.test.ts': 7,
  'src/main/session-package/literature.test.ts': 6,
  'src/main/session-package/fork.test.ts': 6,
  'src/main/session-package/export-validation.test.ts': 7,
  'src/main/session-package/ro-crate.integration.test.ts': 7,
  'src/main/session-package/web-evidence.integration.test.ts': 6,
  'src/main/session-package/desktop.test.ts': 6,
  'src/main/schedules/dispatcher.test.ts': 5,
  'scripts/ci/host-owner-split.test.ts': 7,
  'scripts/ci/module-graph/retirement.test.ts': 6,
  'src/main/pdf-annotations/sharing.integration.test.ts': 2,
  'src/main/pdf-annotations/repository.integration.test.ts': 2,
  'src/main/notifications/notification-inbox-repository.test.ts': 3,
  'scripts/ci/package-host-test-impact.test.ts': 3,
  'scripts/ci/module-graph/consumer-coverage.test.ts': 3,
  'scripts/ci/package-boundaries.test.ts': 3,
  'scripts/ci/module-graph/derived-consumers.test.ts': 3,
  'src/main/settings/service.test.ts': 3,
  'src/main/session-replay/service.test.ts': 2,
  'scripts/ci/e2e-execution-ownership.test.ts': 2,
  'scripts/ci/full-owner-split.test.ts': 7,
  'packages/agent-harness/src/long-session-benchmark.test.ts': 7,
  'scripts/ci/audit-module-ownership.test.ts': 7,
  'scripts/ci/pr-gate-workflow.test.ts': 7,
  'scripts/ci/host-test-impact.test.ts': 7,
  'scripts/windows-data-reset.test.ts': 2,
  'scripts/database-migration-ledger-smoke.test.ts': 2,
  'src/main/host-layer-dependencies.architecture.test.ts': 2,
  'scripts/ci/module-impact-inputs.test.ts': 2,
  'scripts/ci/windows-e2e-regression.test.ts': 7,
  'scripts/ci/module-test-impact.test.ts': 3,
  'src/main/settings/classification-usage.test.ts': 3
}

export function windowsTestShard(path: string): number {
  const normalized = path.replaceAll('\\', '/')
  const exactShard = WINDOWS_TEST_EXACT_SHARDS[normalized]
  if (exactShard) return exactShard
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
