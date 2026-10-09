import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SkillRegistry } from './registry'

const skillsRoot = join(__dirname, '..', '..', '..', 'resources', 'skills')

describe('self-awareness bundled Skill', () => {
  it('is an internal runtime Skill with host.capabilities trigger metadata', async () => {
    const skill = (await new SkillRegistry(skillsRoot).list()).find(
      (entry) => entry.id === 'self-awareness'
    )

    expect(skill).toMatchObject({
      id: 'self-awareness',
      name: 'self-awareness',
      displayName: 'Self-awareness',
      source: 'featured',
      exposure: 'internal'
    })
    expect(skill?.description).toContain('host.capabilities()')
    expect(skill?.description).toMatch(/JavaScript control REPL/i)
  })

  it('documents the shipped 21-key JavaScript contract and read limits', async () => {
    const body = await new SkillRegistry(skillsRoot).body('self-awareness')

    for (const phrase of [
      'repl_execute',
      'await host.capabilities()',
      '21 known boolean keys',
      '`managedExecution`',
      'caps.managedExecution === true',
      "await host.help('managedExecution')",
      'host.managedExecution.inspectMaterials',
      'host.managedExecution.execute',
      'host.managedExecution.requestConfiguration',
      'host.managedExecution.getConfiguration',
      'pendingCollection.collectionId',
      'host.managedExecution.collectOutputs',
      'host.managedExecution.discardOutputs',
      'without rerunning',
      '`releaseEnvironment` preserves',
      'finish or recover that turn',
      'ordinary Artifact catalog remains published-only',
      'cleanup completes automatically',
      '`mcp`',
      '`compute`',
      '`agents`',
      '`skills`',
      '`artifacts`',
      '`lineage`',
      '`frames`',
      '`sessions`',
      '`llm`',
      '`currentModel`',
      '`listModels`',
      '`viewImage`',
      '`delegate`',
      '`children`',
      '`collect`',
      '`stopChild`',
      '`sendFrameMessage`',
      '`messageReceipt`',
      '`resolveMessage`',
      '`submitOutput`',
      '`host.mcp(server, method, args?)`',
      '`host.artifacts(options?)`',
      '`host.artifactPath(versionId)`',
      '`host.sessions.list(options?)`',
      '`host.sessions.inspect(sessionId)`',
      '`host.llm(request, options?)`',
      '`host.currentModel()`',
      '`host.listModels()`',
      '`host.viewImage(source, options?)`',
      'caps.compute === true',
      'caps.artifacts === true',
      'caps.frames === true',
      'caps.sessions === true',
      'await host.artifacts(options)',
      'await host.artifactPath',
      'await host.frames.list(options)',
      'await host.frames.get(frameId, options)',
      'await host.sessions.list(options)',
      'await host.sessions.inspect(sessionId)',
      'current Project',
      'producer Frame',
      'Uploads without trusted Frame',
      'provenance are excluded',
      'exact full Frame ID',
      'active Branch',
      'private reasoning',
      'Version ID',
      'collisions',
      'never content',
      'fresh frozen projection',
      'caps.lineage === true',
      'caps.llm === true',
      'caps.currentModel === true',
      'caps.listModels === true',
      'caps.viewImage === true',
      'await host.viewImage',
      'await host.llm',
      'await host.currentModel()',
      'await host.listModels()',
      'await host.lineage.graph(versionId)',
      'await host.lineage.get(versionId)',
      '`versionId`',
      '`frameId`',
      '`sessionId`',
      '`contentType`',
      'latestVersionId',
      'agentFrameId',
      'latestVersionCreatedAt',
      '`count` is the total number of matches',
      '`not_found` does not override `host.capabilities()`',
      '`maxDepth`',
      '`maxNodes`',
      '`rootsOnly`',
      '`branchId`',
      '`activeConversation`',
      'graph discovery',
      'session-bound control token',
      'another Session',
      'cross-Project edges',
      'storage keys',
      'Python/R `host`',
      'same feature change'
    ]) {
      expect(body).toContain(phrase)
    }
    expect(body).not.toMatch(
      /host\.artifact_path|`(?:version_id|session_id|content_type|latest_version_id|root_frame_id|agent_frame_id|latest_version_created_at|max_depth|max_nodes|roots_only|branch_id)`/
    )
    expect(body).not.toMatch(/Optional camelCase fields are[^.]*`sessionId`/)
    expect(body).not.toMatch(/host\.(query|artifact_read)/)
  })
  it('distinguishes read-only Replay from explicitly requested offline execution in the current Session', async () => {
    const body = (await new SkillRegistry(skillsRoot).body('self-awareness')).replace(/\s+/g, ' ')
    for (const phrase of [
      'Read-only Replay never starts an environment or program.',
      'Offline plans may run in an ordinary Session as a separate execution',
      'host.managedExecution.inspectOfflinePlans({ sourceSessionId })',
      'host.managedExecution.executeOfflinePlan',
      'prepares the fixed materials and executes in this current writable Session/turn; no hidden Session is created.',
      'Do not pass commands, profiles, credentials or network overrides.',
      'new run under declared substitutions, never historical playback or an implicit fallback for real research.',
      'Historical Replay only reads saved records.'
    ]) {
      expect(body).toContain(phrase)
    }
  })
})
