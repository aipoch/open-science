import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  HOST_CAPABILITY_KEYS,
  projectHostCapabilities,
  type HostCapabilityProjection
} from './capability-projection'

const allServices = {
  mcp: true,
  compute: true,
  agents: true,
  skills: true,
  artifacts: true,
  lineage: true,
  frames: true,
  sessions: true,
  llm: true,
  currentModel: true,
  listModels: true,
  viewImage: true,
  delegate: true,
  children: true,
  collect: true,
  stopChild: true,
  sendFrameMessage: true,
  messageReceipt: true,
  resolveMessage: true,
  submitOutput: true
} as const

const project = (
  overrides: Partial<Parameters<typeof projectHostCapabilities>[0]> = {}
): HostCapabilityProjection =>
  projectHostCapabilities({
    callerRole: 'main',
    isControl: true,
    hasActiveControlInvocation: true,
    hasWorkspace: true,
    allowsMethod: () => true,
    delegatedWorkReady: true,
    delegationAllowed: true,
    services: allServices,
    ...overrides
  })

describe('Host capability projection', () => {
  it('owns the complete 20-key project-native catalog', () => {
    expect(HOST_CAPABILITY_KEYS).toEqual([
      'mcp',
      'compute',
      'agents',
      'skills',
      'artifacts',
      'lineage',
      'frames',
      'sessions',
      'llm',
      'currentModel',
      'listModels',
      'viewImage',
      'children',
      'collect',
      'delegate',
      'messageReceipt',
      'resolveMessage',
      'sendFrameMessage',
      'stopChild',
      'submitOutput'
    ])
  })

  it('projects root-only, bidirectional, and delegate-only operations from trusted route readiness', () => {
    expect(project()).toMatchObject({
      delegate: true,
      children: true,
      collect: true,
      stopChild: true,
      sendFrameMessage: true,
      messageReceipt: true,
      resolveMessage: true,
      submitOutput: false
    })
    expect(project({ callerRole: 'delegate' })).toMatchObject({
      sessions: false,
      delegate: false,
      children: false,
      collect: false,
      stopChild: false,
      sendFrameMessage: true,
      messageReceipt: true,
      resolveMessage: false,
      submitOutput: true
    })
    expect(project({ delegatedWorkReady: false })).toMatchObject({
      delegate: false,
      children: false,
      collect: false,
      stopChild: false,
      sendFrameMessage: false,
      messageReceipt: false,
      resolveMessage: false,
      submitOutput: false
    })
  })

  it('advertises Session diagnostics only through the Main control route', () => {
    expect(project()).toMatchObject({ sessions: true })
    expect(project({ callerRole: 'delegate' })).toMatchObject({ sessions: false })
    expect(project({ isControl: false })).toMatchObject({ sessions: false })
    expect(project({ allowsMethod: (method) => method !== 'sessionsCall' })).toMatchObject({
      sessions: false
    })
    expect(project({ services: { ...allServices, sessions: false } })).toMatchObject({
      sessions: false
    })
  })

  it.each(['claude-code', 'opencode', 'codex-response', 'codex-bridge'])(
    'keeps the shared Main projection stable for %s',
    () => {
      expect(project()).toMatchObject({
        delegate: true,
        children: true,
        collect: true,
        stopChild: true,
        sendFrameMessage: true,
        messageReceipt: true,
        resolveMessage: true,
        submitOutput: false
      })
    }
  )

  it('requires each operation route and service instead of advertising an uncallable method', () => {
    expect(
      project({
        allowsMethod: (method) => method !== 'delegatedWorkCall' && method !== 'delegatedOutputCall'
      })
    ).toMatchObject({
      delegate: false,
      sendFrameMessage: false,
      submitOutput: false
    })
    expect(project({ services: { ...allServices, sendFrameMessage: false } })).toMatchObject({
      sendFrameMessage: false,
      messageReceipt: true
    })
  })

  it('keeps the bundled JavaScript known catalog aligned without a runtime cross-layer import', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../resources/notebook/repl_loop.js'),
      'utf8'
    )
    const match = source.match(
      /const HOST_CAPABILITY_KNOWN_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/
    )
    expect(match?.[1].match(/'[^']+'/g)?.map((key) => key.slice(1, -1))).toEqual(
      HOST_CAPABILITY_KEYS
    )
  })
})
