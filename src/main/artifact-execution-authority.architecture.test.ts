import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const projectRoot = resolve(__dirname, '../..')
const source = (path: string): string => readFileSync(resolve(projectRoot, path), 'utf8')

describe('Artifact execution write authority architecture', () => {
  it('keeps Session-current lookup and routing out of the production Artifact owner contract', () => {
    const owner = source('src/main/acp/artifact-turn-owner.ts')

    expect(owner).not.toMatch(
      /\b(?:activeTurnsBySession|handoffRouting|OpenArtifactTurnRequest|promptMessageIdFor|writeForActiveTurn)\b/
    )
    expect(owner).not.toMatch(/\basync\s+open\s*\(/)
  })

  it('routes root and child production writers through explicit execution entrances', () => {
    const root = source('src/main/acp/runtime-prompt-composition.ts')
    const child = source('src/main/delegation/delegated-artifact-evidence.ts')
    const plan = source('src/main/session-plan/production-plan-service.ts')

    expect(root).toContain('.openRootExecution({')
    expect(root).not.toContain('handoffRouting')
    expect(child).toContain('.openExecution({')
    expect(plan).toContain('handleForExecution(executionId)')
    expect(plan).not.toContain('artifactTurnForSession')
  })
})
