import * as acp from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  CLAUDE_HANDOFF_ORDER,
  INTERLEAVED_FOLLOW_UP_ORDER,
  attributeByAdoptAfterStop,
  attributeBySingleCurrent
} from './native-send-now-follow-up'

const promptText = (params: {
  prompt?: ReadonlyArray<{ type?: string; text?: string }>
}): string => {
  const block = params.prompt?.find((entry) => entry.type === 'text')
  return typeof block?.text === 'string' ? block.text : ''
}

const chunk = (sessionId: string, text: string): acp.SessionNotification => ({
  sessionId,
  update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text }
  }
})

const initializeAgent = (name: string): ReturnType<typeof acp.agent> =>
  acp
    .agent({ name })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
      authMethods: []
    }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'sess-1' }))

const connectSpike = async (
  agent: ReturnType<typeof acp.agent>,
  op: (ctx: acp.ClientContext) => Promise<void>,
  onUpdate?: (text: string) => void
): Promise<void> => {
  let client = acp.client({ name: 'spike' })
  if (onUpdate) {
    client = client.onNotification(acp.methods.client.session.update, (ctx) => {
      const update = ctx.params.update
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        onUpdate(update.content.text)
      }
    })
  }
  await client.connectWith(agent, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'spike', version: '0' },
      clientCapabilities: {}
    })
    await op(ctx)
  })
}

describe('host follow-up attribution spike', () => {
  it('adopts the next turn at each stop for Claude-ordered handoff', () => {
    expect(attributeByAdoptAfterStop(CLAUDE_HANDOFF_ORDER)).toEqual([
      { texts: ['one'], stopped: true },
      { texts: ['two'], stopped: true }
    ])
  })

  it('stamps every chunk onto the first prompt when the host keeps a single current', () => {
    expect(attributeBySingleCurrent(CLAUDE_HANDOFF_ORDER)).toEqual(['one', 'two'])
  })

  it('mis-attributes follow-up chunks that arrive before the previous stop', () => {
    expect(attributeByAdoptAfterStop(INTERLEAVED_FOLLOW_UP_ORDER)).toEqual([
      { texts: ['one', 'two'], stopped: true },
      { texts: [], stopped: true }
    ])
  })
})

describe('overlapping session/prompt protocol spike', () => {
  it('lets a Claude-like agent settle the first prompt when the second arrives', async () => {
    let pending: { resolve: (response: acp.PromptResponse) => void } | undefined
    const seen: string[] = []
    const agent = initializeAgent('claude-queue-fake').onRequest(
      acp.methods.agent.session.prompt,
      async (ctx) => {
        const text = promptText(ctx.params)
        pending?.resolve({ stopReason: 'end_turn' })
        await ctx.client.notify(
          acp.methods.client.session.update,
          chunk(ctx.params.sessionId, text)
        )
        if (text === 'two') return { stopReason: 'end_turn' }
        return await new Promise<acp.PromptResponse>((resolve) => {
          pending = { resolve }
        })
      }
    )

    await connectSpike(
      agent,
      async (ctx) => {
        const created = await ctx.request(acp.methods.agent.session.new, {
          cwd: '/tmp',
          mcpServers: []
        })
        const first = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'one' }]
        })
        await vi.waitFor(() => expect(seen).toEqual(['one']))
        const second = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'two' }]
        })
        await expect(first).resolves.toEqual({ stopReason: 'end_turn' })
        await expect(second).resolves.toEqual({ stopReason: 'end_turn' })
        await vi.waitFor(() => expect(seen).toEqual(['one', 'two']))
      },
      (text) => seen.push(text)
    )
  })

  it('does not treat OpenCode-like serialization as Send now', async () => {
    const order: string[] = []
    let gate!: () => void
    const firstTurn = new Promise<void>((resolve) => {
      gate = resolve
    })
    let chain = Promise.resolve()
    const agent = initializeAgent('opencode-serial-fake').onRequest(
      acp.methods.agent.session.prompt,
      (ctx) => {
        const text = promptText(ctx.params)
        const run = chain.then(async () => {
          order.push(`start:${text}`)
          if (text === 'one') await firstTurn
          order.push(`end:${text}`)
          return { stopReason: 'end_turn' as const }
        })
        chain = run.then(() => undefined)
        return run
      }
    )

    await connectSpike(agent, async (ctx) => {
      const created = await ctx.request(acp.methods.agent.session.new, {
        cwd: '/tmp',
        mcpServers: []
      })
      const first = ctx.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'one' }]
      })
      const second = ctx.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'two' }]
      })
      await vi.waitFor(() => expect(order).toEqual(['start:one']))
      gate()
      await expect(first).resolves.toEqual({ stopReason: 'end_turn' })
      await expect(second).resolves.toEqual({ stopReason: 'end_turn' })
      expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two'])
    })
  })

  it('rejects a Codex-like busy second prompt without cancelling the first', async () => {
    let busy = false
    let releaseFirst!: () => void
    const firstTurn = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let enteredFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const agent = initializeAgent('codex-busy-fake').onRequest(
      acp.methods.agent.session.prompt,
      async () => {
        if (busy) throw RequestError.invalidRequest({ reason: 'session_busy' }, 'Session is busy')
        busy = true
        enteredFirst()
        try {
          await firstTurn
          return { stopReason: 'end_turn' as const }
        } finally {
          busy = false
        }
      }
    )

    await connectSpike(agent, async (ctx) => {
      const created = await ctx.request(acp.methods.agent.session.new, {
        cwd: '/tmp',
        mcpServers: []
      })
      const first = ctx.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'one' }]
      })
      await firstEntered
      const second = ctx.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'two' }]
      })
      await expect(second).rejects.toThrow(/busy/i)
      releaseFirst()
      await expect(first).resolves.toEqual({ stopReason: 'end_turn' })
    })
  })
})
