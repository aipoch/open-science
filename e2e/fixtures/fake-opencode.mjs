import * as acp from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'

const VERSION = '1.0.0'
const PERMISSION_PROMPT = 'Request fixture permission.'

if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`)
} else {
  let nextMessageId = 1
  let nextSessionId = 1

  const app = acp
    .agent({ name: 'open-science-e2e-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {}, resume: {} }
      },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.authenticate, () => ({}))
    .onRequest(acp.methods.agent.session.new, () => ({
      sessionId: `e2e-session-${nextSessionId++}`
    }))
    .onRequest(acp.methods.agent.session.resume, () => ({}))
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
      const prompt = context.params.prompt
        .map((content) => (content.type === 'text' ? content.text : ''))
        .join('')

      let reply = 'Deterministic reply: Summarize the deterministic fixture.'
      if (prompt.includes(PERMISSION_PROMPT)) {
        const permission = await context.client.request(
          acp.methods.client.session.requestPermission,
          {
            sessionId: context.params.sessionId,
            toolCall: {
              toolCallId: 'e2e-permission-tool',
              title: 'Write fixture output'
            },
            options: [
              { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
              { kind: 'reject_once', name: 'Deny', optionId: 'deny-once' }
            ]
          }
        )
        reply =
          permission.outcome.outcome === 'selected' && permission.outcome.optionId === 'allow-once'
            ? 'Fixture permission allowed.'
            : 'Fixture permission denied.'
      }

      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `e2e-message-${nextMessageId++}`,
          content: { type: 'text', text: reply }
        }
      })

      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, () => undefined)
    .onRequest(acp.methods.agent.session.close, () => ({}))

  const connection = app.connect(
    acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
  )
  await connection.closed
}
