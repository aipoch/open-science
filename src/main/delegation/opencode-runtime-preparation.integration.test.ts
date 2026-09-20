import { cp, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'
import { expect, it } from 'vitest'

import { createOpencodeFramework } from '../agent-framework/opencode'
import type { ResolvedAgentBackend } from '../agent-framework'
import { fetchOpenCodeUsageSnapshot } from '../acp/opencode-turn-usage'
import {
  prepareOpenCodeRuntime,
  type PreparedOpenCodeRuntime
} from './opencode-runtime-preparation'

const executable = process.env.OPENCODE_ACP_PATH

const bootstrapRoot = process.env.OPENCODE_BOOTSTRAP_CONFIG_PATH

for (const withPlugins of [false, true])
  it.runIf(executable && (!withPlugins || bootstrapRoot))(
    `runs concurrent real OpenCode ACP prompts and usage (${withPlugins ? 'warm plugins' : 'transport only'})`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'opencode-delegated-native-'))
      const processes: ChildProcessWithoutNullStreams[] = []
      const runtimes: PreparedOpenCodeRuntime[] = []
      let calls = 0
      const pluginSessions: string[] = []
      const upstream = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          calls += 1
          if (typeof request.headers['x-opencode-session'] === 'string')
            pluginSessions.push(request.headers['x-opencode-session'])
          const model = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string })
            .model
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(
            [
              `data: ${JSON.stringify({ id: `probe-${calls}`, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}`,
              `data: ${JSON.stringify({ id: `probe-${calls}`, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })}`,
              'data: [DONE]',
              ''
            ].join('\n\n')
          )
        })
      })
      try {
        await new Promise<void>((resolve, reject) => {
          upstream.once('error', reject)
          upstream.listen(0, '127.0.0.1', resolve)
        })
        const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
        const framework = createOpencodeFramework({
          sourceEnv: { PATH: process.env.PATH, HOME: root },
          spawnProcess: (command, args, options) => spawn(command, args, { ...options, cwd: root })
        })
        const modelConfig = framework.prepareModelConfig(
          {
            type: 'official',
            vendorId: 'opencode-go',
            agentProviderId: 'open-science-concurrency-probe',
            baseUrl,
            openaiBaseUrl: `${baseUrl}/v1`,
            apiEndpoints: ['openai'],
            model: 'probe-model',
            key: 'synthetic-probe-key'
          },
          { storageRoot: root, executablePath: executable! }
        )
        const admitted: ResolvedAgentBackend = {
          framework,
          executablePath: executable!,
          env: {
            ...modelConfig.env,
            OPENCODE_PURE: withPlugins ? 'false' : 'true',
            OPENCODE_DISABLE_MODELS_FETCH: 'true',
            OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
            OPENCODE_DISABLE_AUTOUPDATE: 'true'
          },
          opencodeConfigFiles: modelConfig.configFiles,
          args: ['--print-logs', '--log-level', 'DEBUG', '--port', '1', '--hostname', '127.0.0.1'],
          opencodeUsageApi: { baseUrl: 'http://127.0.0.1:1', authorization: 'Basic unused' }
        }
        if (withPlugins) {
          // Opt-in fixture: reuse only the installed dependency files, never account config or auth.
          const target = join(admitted.env.XDG_CONFIG_HOME, 'opencode')
          await mkdir(target, { recursive: true })
          for (const entry of [
            'package.json',
            'package-lock.json',
            'bun.lock',
            'bun.lockb',
            'node_modules'
          ]) {
            const source = join(bootstrapRoot!, entry)
            try {
              await lstat(source)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              continue
            }
            await cp(source, join(target, entry), { recursive: true, dereference: true })
          }
        }
        runtimes.push(
          ...(await Promise.all(
            [0, 1, 2].map((index) =>
              prepareOpenCodeRuntime(admitted, join(root, `attempt-${index}`))
            )
          ))
        )
        let ready = 0
        let allReady!: () => void
        const barrier = new Promise<void>((resolve) => {
          allReady = resolve
        })
        const sessionIds: string[] = []
        await Promise.all(
          runtimes.map(async ({ backend }, index) => {
            const cwd = join(root, `workspace-${index}`)
            await mkdir(cwd)
            const child = framework.spawn({
              executablePath: executable!,
              args: backend.args ?? [],
              env: backend.env
            })
            processes.push(child)
            let stderr = ''
            let stage = 'connect'
            let timer: ReturnType<typeof setTimeout> | undefined
            child.stderr.on('data', (chunk: Buffer) => {
              stderr = (stderr + chunk.toString('utf8')).slice(-2000)
            })
            try {
              const operation = acp
                .client({ name: 'delegated-opencode-isolation-test' })
                .onRequest(acp.methods.client.session.requestPermission, (ctx) => ({
                  outcome: { outcome: 'selected', optionId: ctx.params.options[0].optionId }
                }))
                .connectWith(
                  acp.ndJsonStream(
                    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
                    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
                  ),
                  async (ctx) => {
                    stage = 'initialize'
                    await ctx.request(acp.methods.agent.initialize, {
                      protocolVersion: acp.PROTOCOL_VERSION,
                      clientInfo: { name: 'delegated-opencode-isolation-test', version: '1.0.0' },
                      clientCapabilities: {}
                    })
                    stage = 'session/new'
                    await ctx.buildSession({ cwd, mcpServers: [] }).withSession(async (session) => {
                      sessionIds[index] = session.sessionId
                      ready += 1
                      if (ready === runtimes.length) allReady()
                      stage = 'barrier'
                      await barrier
                      stage = 'prompt'
                      session.prompt('Reply with ok.')
                      for (;;) {
                        const update = await session.nextUpdate()
                        if (update.kind === 'stop') break
                      }
                      stage = 'usage'
                      const usage = await fetchOpenCodeUsageSnapshot(
                        backend.opencodeUsageApi!,
                        session.sessionId,
                        cwd
                      )
                      expect(usage?.assistantMessageIds.size).toBeGreaterThan(0)
                      expect([...usage!.usageByMessageId.values()]).toContainEqual(
                        expect.objectContaining({ inputTokens: 11, outputTokens: 3 })
                      )
                      // A sibling's authenticated API must not contain this process's native session.
                      const sibling = runtimes[(index + 1) % runtimes.length].backend
                      const foreign = await fetchOpenCodeUsageSnapshot(
                        sibling.opencodeUsageApi!,
                        session.sessionId,
                        cwd
                      )
                      expect(foreign).toBeUndefined()
                    })
                  }
                )
              await Promise.race([
                operation,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () =>
                      reject(
                        new Error(
                          `Timed out at ${stage}; ready=${ready}; calls=${calls}; exit=${child.exitCode}`
                        )
                      ),
                    20_000
                  )
                })
              ])
            } catch (error) {
              throw new Error(`${String(error)}\nOpenCode stderr: ${stderr}`)
            } finally {
              clearTimeout(timer)
            }
          })
        )
        expect(new Set(sessionIds).size).toBe(3)
        expect(calls).toBeGreaterThanOrEqual(3)
        if (withPlugins) expect(new Set(pluginSessions)).toEqual(new Set(sessionIds))
      } finally {
        await Promise.all(
          processes.map(async (child) => {
            if (child.exitCode !== null) return
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(() => {
                child.kill('SIGKILL')
                resolve()
              }, 2000)
              child.once('exit', () => {
                clearTimeout(timeout)
                resolve()
              })
              child.kill('SIGTERM')
            })
          })
        )
        runtimes.forEach((runtime) => runtime.dispose())
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
    45_000
  )
