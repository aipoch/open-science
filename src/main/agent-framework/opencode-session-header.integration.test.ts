import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'
import { expect, it } from 'vitest'

import { OpenAiProviderBridge } from '../settings/openai-provider-bridge'
import { createOpencodeFramework } from './opencode'

const opencodePath = process.env.OPENCODE_ACP_PATH

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

const close = async (server: Server): Promise<void> => {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

const completePrompt = async (session: acp.ActiveSession): Promise<void> => {
  session.prompt('Reply with ok.')
  for (;;) {
    const update = await session.nextUpdate()
    if (update.kind === 'stop') return
  }
}

const terminate = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
      resolve()
    }, 2_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

it.runIf(opencodePath)(
  'sends a stable, conversation-specific x-opencode-session through a real OpenCode ACP process',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-opencode-go-header-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const requests: Array<{
      affinity?: string
      nativeSession?: string
      opencodeSession?: string
    }> = []
    const sessionIds: string[] = []
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        requests.push({
          ...(typeof request.headers['x-session-affinity'] === 'string'
            ? { affinity: request.headers['x-session-affinity'] }
            : {}),
          ...(typeof request.headers['x-session-id'] === 'string'
            ? { nativeSession: request.headers['x-session-id'] }
            : {}),
          ...(typeof request.headers['x-opencode-session'] === 'string'
            ? { opencodeSession: request.headers['x-opencode-session'] }
            : {})
        })
        const model = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string })
          .model
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          [
            `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}`,
            `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
            'data: [DONE]',
            ''
          ].join('\n\n')
        )
      })
    })
    const upstreamBaseUrl = `${await listen(upstream)}/v1`
    const bridge = new OpenAiProviderBridge(
      [
        {
          id: 'opencode-go/probe-model',
          wire: 'chat-completions',
          endpoint: `${upstreamBaseUrl}/chat/completions`,
          key: 'upstream-key',
          model: 'probe-model'
        }
      ],
      'opencode-go/probe-model'
    )
    const connection = await bridge.start()
    const framework = createOpencodeFramework()
    const modelConfig = framework.prepareModelConfig(
      {
        type: 'official',
        vendorId: 'opencode-go',
        agentProviderId: 'open-science-opencode-go-probe',
        baseUrl: connection.baseUrl,
        openaiBaseUrl: `${connection.baseUrl}/v1`,
        apiEndpoints: ['openai'],
        model: 'probe-model',
        key: connection.token
      },
      { storageRoot: root, executablePath: opencodePath! }
    )
    for (const file of modelConfig.configFiles ?? []) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.content, 'utf8')
    }

    const child: ChildProcessWithoutNullStreams = spawn(opencodePath!, ['acp'], {
      cwd: workspace,
      env: { ...process.env, ...modelConfig.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stderr: string[] = []
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

    try {
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      )
      await acp
        .client({ name: 'open-science-opencode-go-header-contract' })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => ({
          outcome: { outcome: 'selected', optionId: ctx.params.options[0].optionId }
        }))
        .onRequest(acp.methods.client.fs.readTextFile, () => ({ content: '' }))
        .onRequest(acp.methods.client.fs.writeTextFile, () => ({}))
        .connectWith(stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo: { name: 'open-science-opencode-go-header-contract', version: '1.0.0' },
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
          })
          await ctx
            .buildSession({ cwd: workspace, mcpServers: [] })
            .withSession(async (session) => {
              sessionIds.push(session.sessionId)
              await completePrompt(session)
              await completePrompt(session)
            })
          await ctx
            .buildSession({ cwd: workspace, mcpServers: [] })
            .withSession(async (session) => {
              sessionIds.push(session.sessionId)
              await completePrompt(session)
            })
        })

      expect(sessionIds).toHaveLength(2)
      expect(sessionIds[0]).not.toBe(sessionIds[1])
      expect(requests.every((request) => request.opencodeSession !== undefined)).toBe(true)
      expect(
        requests.every(
          (request) =>
            request.opencodeSession === request.nativeSession &&
            request.opencodeSession === request.affinity
        )
      ).toBe(true)
      expect(
        requests.filter((request) => request.opencodeSession === sessionIds[0]).length
      ).toBeGreaterThanOrEqual(2)
      expect(
        requests.filter((request) => request.opencodeSession === sessionIds[1]).length
      ).toBeGreaterThanOrEqual(1)
      expect(new Set(requests.map((request) => request.opencodeSession))).toEqual(
        new Set(sessionIds)
      )
    } catch (error) {
      throw new Error(`${String(error)}\n${stderr.join('')}`)
    } finally {
      await terminate(child)
      await bridge.close()
      await close(upstream)
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  30_000
)
