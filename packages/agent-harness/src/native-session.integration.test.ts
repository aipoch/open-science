import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJournalAgentStore } from './journal-store'
import { createMessagesModel } from './messages'
import { createResponsesModel } from './responses'
import { openAgentSession, type AgentSession } from './session'
import type { AgentModel, AgentTool, ContentBlock, Json, ModelRequest } from './session-types'

it.each(['messages', 'responses'] as const)(
  '%s preserves native parallel results through compaction, durable reopen, cancellation and identity change',
  async (protocol) => {
    const directory = await mkdtemp(join(tmpdir(), 'native-session-'))
    const summary =
      '## Goal\nSum two records.\n## Progress\nReady.\n## Evidence\nRetain 3 and 5.\n## Next\nRead both records.'
    const media: ContentBlock[] = [
      { type: 'file', mimeType: 'application/pdf', source: 'data:application/pdf;base64,JVBERg==' },
      { type: 'video', mimeType: 'video/mp4', source: 'data:video/mp4;base64,AA==' }
    ]
    const failures: unknown[] = []
    const bodies: Record<string, Json>[] = []
    const effects: string[] = []
    let phase: 'seed' | 'tools' | 'reopen' | 'cancel' | 'changed' | 'denied' | 'granted' = 'seed'
    let authorized = true
    let summaries = 0
    const started = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    const parallelStarted = Promise.withResolvers<void>()
    const server = createServer((request, response) => {
      void (async () => {
        try {
          expect(request.headers.authorization ?? request.headers['x-api-key']).toMatch(
            /fixture-key$/
          )
          let raw = ''
          for await (const part of request) raw += String(part)
          const body = JSON.parse(raw)
          bodies.push(body)
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.flushHeaders()
          const emit = (event: unknown): void => {
            response.write(`data: ${JSON.stringify(event)}\n\n`)
          }
          if (phase === 'cancel') {
            response.once('close', () => closed.resolve())
            started.resolve()
            return
          }
          const isSummary = JSON.stringify((body.messages ?? body.input).at(-1)).includes(
            'Create a compact continuation checkpoint'
          )
          const hasResults =
            JSON.stringify(body).includes('VALUE_3') && JSON.stringify(body).includes('VALUE_5')
          const calls =
            !isSummary &&
            ((phase === 'tools' && !hasResults) || phase === 'denied' || phase === 'granted')
          const callPrefix = phase === 'denied' || phase === 'granted' ? phase : 'native'
          if (calls && (phase === 'denied' || phase === 'granted')) phase = 'changed'
          const text = isSummary ? summary : phase === 'seed' ? 'ready' : '8'
          if (isSummary) summaries++
          if (protocol === 'messages') {
            emit({
              type: 'message_start',
              message: { usage: { input_tokens: 12, cache_read_input_tokens: 8 } }
            })
            const blocks = calls
              ? [
                  { type: 'thinking', thinking: 'read both', signature: 'signed-fixture' },
                  ...['3', '5'].map((id) => ({
                    type: 'tool_use',
                    id: `${callPrefix}-${id}`,
                    name: 'read',
                    input: { id }
                  }))
                ]
              : [{ type: 'text', text: '' }]
            for (const [index, content_block] of blocks.entries()) {
              emit({ type: 'content_block_start', index, content_block })
              if (content_block.type === 'text')
                emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
              emit({ type: 'content_block_stop', index })
            }
            emit({
              type: 'message_delta',
              delta: { stop_reason: calls ? 'tool_use' : 'end_turn' },
              usage: { output_tokens: 4 }
            })
            emit({ type: 'message_stop' })
          } else {
            if (calls) {
              emit({
                type: 'response.output_item.done',
                item: {
                  type: 'reasoning',
                  id: 'rs_fixture',
                  summary: [],
                  encrypted_content: 'signed-fixture'
                }
              })
              for (const id of ['3', '5'])
                emit({
                  type: 'response.output_item.done',
                  item: {
                    type: 'function_call',
                    id: `fc-${callPrefix}-${id}`,
                    call_id: `${callPrefix}-${id}`,
                    name: 'read',
                    arguments: JSON.stringify({ id })
                  }
                })
            } else emit({ type: 'response.output_text.delta', delta: text })
            emit({
              type: 'response.completed',
              response: {
                usage: {
                  input_tokens: 20,
                  output_tokens: 4,
                  input_tokens_details: { cached_tokens: 8 }
                }
              }
            })
          }
          response.end()
        } catch (error) {
          failures.push(error)
          response.destroy()
        }
      })()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/${protocol}`
    const factory = protocol === 'messages' ? createMessagesModel : createResponsesModel
    const model = (id: string): AgentModel =>
      factory({
        endpoint,
        model: 'fixture',
        id,
        apiKey: () => 'fixture-key',
        inputCapabilities: { video: true }
      })
    const options = {
      sessionId: 'native',
      model: model('original'),
      maxSteps: 4,
      maxOutputTokens: 100,
      instructions: 'Read both records, then sum.',
      tools: [
        {
          name: 'read',
          version: '1',
          description: 'Read a record',
          parameters: { type: 'object' },
          scheduling: 'parallel',
          validate: (args) => args,
          authorize: async () => authorized,
          execute: async (args) => {
            const id = (args as { id: string }).id
            effects.push(id)
            if (effects.length === 2) parallelStarted.resolve()
            await parallelStarted.promise
            return { content: [{ type: 'text', text: `VALUE_${id}` }, ...media] }
          }
        } satisfies AgentTool
      ]
    }
    const reopen = (id = 'original', compact = true): Promise<AgentSession> =>
      openAgentSession({
        ...options,
        model: model(id),
        store: createJournalAgentStore({ directory }),
        ...(compact
          ? {
              compaction: {
                inputBudget: 5000,
                keepRecentItems: 1,
                maxOutputTokens: 100,
                measure: (r: ModelRequest) => JSON.stringify(r.messages).length + r.maxOutputTokens
              }
            }
          : {})
      })
    let session: AgentSession | undefined
    try {
      session = await reopen('original', false)
      expect(
        await session.prompt([{ type: 'text', text: 'Old evidence. '.repeat(1000) }, ...media])
      ).toBe('complete')
      await session.dispose()
      session = await reopen()
      phase = 'tools'
      expect(await session.prompt([{ type: 'text', text: 'Read both records.' }])).toBe('complete')
      expect(summaries).toBe(1)
      // The summarizer receives native media; the durable transcript retains the original bytes.
      expect(JSON.stringify(bodies[1])).toContain(
        protocol === 'messages' ? 'document' : 'input_file'
      )
      expect(JSON.stringify(bodies[1])).toContain(
        protocol === 'messages' ? '"type":"video"' : 'input_video'
      )
      expect((await session.snapshot()).messages[0].content.slice(1)).toEqual(media)
      expect(effects).toEqual(['3', '5'])
      const finalBody = bodies.at(-1)!
      expect(JSON.stringify(finalBody)).toContain('signed-fixture')
      if (protocol === 'messages') {
        const messages = finalBody.messages as {
          content: { type: string; tool_use_id?: string }[]
        }[]
        expect(messages.at(-1)!.content.map((block) => block.tool_use_id)).toEqual([
          'native-3',
          'native-5'
        ])
      } else {
        const items = finalBody.input as { type: string; call_id?: string }[]
        expect(
          items.filter((item) => item.type === 'function_call_output').map((item) => item.call_id)
        ).toEqual(['native-3', 'native-5'])
      }
      await session.dispose()
      session = await reopen()
      phase = 'reopen'
      expect(await session.prompt([{ type: 'text', text: 'Confirm the total.' }])).toBe('complete')
      expect(JSON.stringify(bodies.at(-1))).toContain('signed-fixture')
      expect(JSON.stringify(bodies.at(-1))).toContain('JVBERg==')
      expect(JSON.stringify(bodies.at(-1))).toContain(
        protocol === 'messages' ? '"type":"video"' : 'input_video'
      )
      expect(effects).toHaveLength(2)
      const completed = await session.snapshot()
      expect(completed.compactions).toHaveLength(1)
      expect(completed.requests).toHaveLength(5)
      expect(
        completed.requests.every(
          (r) =>
            r.usage?.inputTokens === 20 &&
            r.usage.outputTokens === 4 &&
            r.usage.cacheReadTokens === 8
        )
      ).toBe(true)
      phase = 'cancel'
      const running = session.prompt([{ type: 'text', text: 'Wait for more evidence.' }])
      await started.promise
      session.cancel()
      expect(await running).toBe('cancelled')
      await closed.promise
      expect((await session.snapshot()).requests.at(-1)?.status).toBe('interrupted')
      await session.dispose()
      session = await reopen('new-account-model')
      phase = 'changed'
      expect(
        await session.prompt([{ type: 'text', text: 'Continue with the saved records.' }])
      ).toBe('complete')
      expect(JSON.stringify(bodies.at(-1))).not.toContain('signed-fixture')
      expect(JSON.stringify(bodies.at(-1))).toContain('VALUE_3')
      expect(effects).toHaveLength(2)
      // A host-owned phase rule must hold even when the model calls a tool too early.
      authorized = false
      phase = 'denied'
      expect(await session.prompt([{ type: 'text', text: 'Wait for authorization.' }])).toBe(
        'complete'
      )
      expect(effects).toHaveLength(2)
      expect(
        (await session.snapshot()).messages.filter((m) => m.role === 'tool').slice(-2)
      ).toEqual([
        expect.objectContaining({ isError: true }),
        expect.objectContaining({ isError: true })
      ])
      authorized = true
      phase = 'granted'
      expect(await session.prompt([{ type: 'text', text: 'The next phase is authorized.' }])).toBe(
        'complete'
      )
      expect(effects).toEqual(['3', '5', '3', '5'])
      expect(failures).toEqual([])
      expect(JSON.stringify(await session.snapshot())).not.toContain('fixture-key')
    } finally {
      await session?.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
      await rm(directory, { recursive: true, force: true })
    }
  }
)
