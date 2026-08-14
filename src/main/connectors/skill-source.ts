import { join } from 'node:path'

// Live Connector discovery produces rebuildable Skill documents here. This source is deliberately
// separate from every framework profile so refreshing or cleaning it cannot mutate rollback state.
const connectorSkillSourceRoot = (configRoot: string): string =>
  join(configRoot, 'runtime-support', 'connector-skills-v1')

export { connectorSkillSourceRoot }
