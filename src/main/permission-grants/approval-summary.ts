import type { PermissionCapability } from '../../shared/permission-grants'
import { commandPrefixPermissionCategory } from './capability'

// Exact, reviewed prefixes only. Never accept display text from a provider or persist arbitrary
// argv. Matching the complete digest prevents a path/argument variant from inheriting a misleading
// description. New summaries do not change matching authority or backfill historical grants.
const REVIEWED_PREFIXES: ReadonlyArray<readonly [readonly string[], string]> = [
  [['git', 'status'], 'Git: working tree status'],
  [['git', 'diff'], 'Git: changes'],
  [['git', 'log'], 'Git: commit history'],
  [['git', 'show'], 'Git: object details'],
  [['git', 'add'], 'Git: stage changes'],
  [['git', 'commit'], 'Git: create commits'],
  [['npm', 'test'], 'npm: run tests'],
  [['npm', 'run'], 'npm: run scripts'],
  [['python'], 'Python commands'],
  [['python3'], 'Python 3 commands'],
  [['node'], 'Node.js commands'],
  [['Rscript'], 'R scripts']
]
const summaries = new Map(
  REVIEWED_PREFIXES.map(([prefix, summary]) => [
    commandPrefixPermissionCategory(prefix)!.slice('shell-group:'.length),
    summary
  ])
)

export const approvalSummaryFor = (capability: PermissionCapability): string | undefined =>
  capability.kind === 'execution' &&
  capability.key === 'exec:agent/shell' &&
  capability.qualifier?.mode === 'category'
    ? summaries.get(capability.qualifier.value)
    : undefined
