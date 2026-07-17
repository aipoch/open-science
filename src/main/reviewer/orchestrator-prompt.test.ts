// Unit test for buildReviewerPrompt: the host client handed to the reviewer must come from the single
// source of truth (buildReviewerHostPythonBootstrap), not a second hand-written copy that can drift
// from the server's actual method set.

import { describe, expect, it } from 'vitest'

import { buildReviewerPrompt } from './orchestrator'
import { buildReviewerHostPythonBootstrap } from './host-sdk'
import type { TurnScope } from '../../shared/reviewer'

const scope: TurnScope = {
  turnMessageId: 'msg-1',
  blocks: [
    { id: 'message:msg-1', kind: 'message', sourceId: 'msg-1', blockIndex: 0, contentHash: 'h' }
  ],
  artifactVersionIds: []
}

describe('buildReviewerPrompt — single-source host client', () => {
  it('embeds the exact bootstrap client (no independent hand-written copy)', () => {
    const endpoint = 'http://127.0.0.1:5555'
    const token = 'tok-xyz'

    const prompt = buildReviewerPrompt(scope, endpoint, token)

    // The prompt must contain the bootstrap verbatim — this is what guarantees there is only one
    // definition of the client and its method set.
    expect(prompt).toContain(buildReviewerHostPythonBootstrap(endpoint, token))
    expect(prompt).toContain(endpoint)
    expect(prompt).toContain(token)
  })

  it('tells the reviewer to re-run setup per process rather than assuming a pre-loaded host', () => {
    const prompt = buildReviewerPrompt(scope, 'http://x', 't')

    // The reviewer runs Python via Bash (fresh process each time); the prompt must make that explicit
    // so the model does not skip setup assuming a persistent pre-injected `host`.
    expect(prompt).toContain('fresh process')
    expect(prompt).toContain('no pre-loaded `host`')
  })
})
