import * as acp from '@agentclientprotocol/sdk'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { setTimeout } from 'node:timers/promises'
import { expect, it } from 'vitest'

it('keeps the updater fixture turn active until shutdown cancels it', async () => {
  const child = spawn(process.execPath, [resolve('e2e/fixtures/fake-opencode.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const exited = once(child, 'exit')
  let reply = ''
  const connection = acp
    .client({ name: 'updater-fixture-test' })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (params.update.sessionUpdate === 'agent_message_chunk') {
        const content = params.update.content
        if (content.type === 'text') reply += content.text
      }
    })
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      )
    )
  try {
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {}
    })
    const { sessionId } = await connection.agent.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: []
    })
    const prompt = connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'Verify owned process update.' }]
    })
    await expect.poll(() => reply).toContain('Deterministic reply:')
    expect(await Promise.race([prompt.then(() => 'completed'), setTimeout(100, 'pending')])).toBe(
      'pending'
    )
    await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
    await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' })
  } finally {
    child.kill()
    await exited
    await connection.closed
  }
}, 15_000)
