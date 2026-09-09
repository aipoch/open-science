import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { expect, it } from 'vitest'
import { buildSync } from 'esbuild'

import { createCodexFramework } from '../agent-framework/codex'
import { terminateProcessTree } from '../process-tree'
import { NativeResponsesCompatibilityProxy } from './native-responses-compatibility'
import { ResponsesBridge } from './responses-bridge'

const adapter = process.env.CODEX_ACP_PATH
const native = process.env.CODEX_NATIVE_PATH

it.runIf(Boolean(adapter && native)).each([
  { route: 'responses', explicit: true },
  { route: 'responses', explicit: false },
  { route: 'bridge', explicit: true },
  { route: 'bridge', explicit: false }
])(
  'makes a Connector document reachable on $route with native Skill input = $explicit',
  async ({ route, explicit }) => {
    const root = await mkdtemp(join(tmpdir(), 'codex-skill-loading-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const marker = 'GENOMES_DOCUMENT_BODY_73c6'
    const path = join(root, 'codex', 'skills', 'mcp-genomes', 'SKILL.md')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      `---\nname: mcp-genomes\ndescription: Query genomes through a Connector.\n---\n${marker}\n`
    )
    const regulationPath = join(root, 'codex', 'skills', 'mcp-regulation', 'SKILL.md')
    await mkdir(dirname(regulationPath), { recursive: true })
    await writeFile(
      regulationPath,
      '---\nname: mcp-regulation\ndescription: Query regulation.\n---\nREGULATION_DOCUMENT_BODY\n'
    )
    const loaderEntry = join(root, 'skill-loader.cjs')
    buildSync({
      stdin: {
        contents:
          "import { runSkillRuntimeMcpServer } from './src/main/skills/runtime-mcp-server'; runSkillRuntimeMcpServer().catch(error => { console.error(error); process.exitCode = 1 })",
        resolveDir: resolve('.')
      },
      outfile: loaderEntry,
      bundle: true,
      platform: 'node',
      format: 'cjs'
    })
    const requests: Record<string, unknown>[] = []
    let phaseRequests = 0
    let requestedSkill = 'mcp-genomes'
    const upstream: typeof fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      const load =
        !explicit &&
        ++phaseRequests === 1 &&
        JSON.stringify(requests.at(-1)!.tools).includes('load_skill')
      if (route === 'bridge') {
        if (load)
          return new Response(
            [
              {
                id: 'load',
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      tool_calls: [
                        {
                          index: 0,
                          id: `call-load-${requests.length}`,
                          type: 'function',
                          function: {
                            name: 'mcp__skills__load_skill',
                            arguments: JSON.stringify({ skill: requestedSkill })
                          }
                        }
                      ]
                    },
                    finish_reason: null
                  }
                ]
              },
              { id: 'load', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join('') + 'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } }
          )
        const chunks = [
          {
            id: 'skill-probe',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'PROBE_COMPLETE' },
                finish_reason: null
              }
            ]
          },
          {
            id: 'skill-probe',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
          }
        ]
        return new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
          {
            headers: { 'content-type': 'text/event-stream' }
          }
        )
      }
      const events = load
        ? [
            { type: 'response.created', response: { id: 'load' } },
            {
              type: 'response.output_item.done',
              item: {
                type: 'function_call',
                call_id: `call-load-${requests.length}`,
                name: 'mcp__skills__load_skill',
                arguments: JSON.stringify({ skill: requestedSkill })
              }
            },
            {
              type: 'response.completed',
              response: {
                id: 'load',
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
              }
            }
          ]
        : [
            { type: 'response.created', response: { id: 'skill-probe' } },
            {
              type: 'response.output_item.done',
              item: {
                type: 'message',
                id: 'probe-message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'PROBE_COMPLETE' }]
              }
            },
            {
              type: 'response.completed',
              response: {
                id: 'skill-probe',
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
              }
            }
          ]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' }
      })
    }
    const target = { baseUrl: 'https://vendor.invalid/v1', model: 'probe-native-model' }
    const proxy =
      route === 'bridge'
        ? new ResponsesBridge(target, upstream)
        : new NativeResponsesCompatibilityProxy(target, upstream)
    const connection = await proxy.start()
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: route === 'bridge' ? ['openai'] : ['responses'],
        baseUrl: 'https://vendor.invalid/v1',
        model: 'probe-native-model',
        contextWindow: 128_000
      },
      { storageRoot: root, executablePath: adapter!, responsesBridge: connection }
    )
    const setup = framework.buildSessionSetup({
      systemPromptAppends: [],
      skillRuntimeScope: 'all',
      sessionOptions: {
        openScienceSkillRuntime: {
          command: process.execPath,
          entryPath: loaderEntry,
          root: join(root, 'codex'),
          skillsDirectory: join(root, 'codex', 'skills')
        }
      }
    })
    for (const file of config.configFiles ?? []) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.content)
    }
    const child = spawn(
      adapter!.endsWith('.js') ? process.execPath : adapter!,
      adapter!.endsWith('.js') ? [adapter!] : [],
      {
        cwd: workspace,
        env: { ...process.env, ...config.env, CODEX_PATH: native! },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    const stderr: string[] = []
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
    try {
      await acp
        .client({ name: 'skill-loading-probe' })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => ({
          outcome: {
            outcome: 'selected',
            optionId: ctx.params.options.find((option) => option.kind === 'allow_once')!.optionId
          }
        }))
        .onRequest(acp.methods.client.fs.readTextFile, () => {
          throw new Error('No workspace read needed')
        })
        .connectWith(
          acp.ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
          ),
          async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientInfo: { name: 'skill-loading-probe', version: '1.0.0' },
              clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } }
            })
            await ctx.request(acp.methods.agent.providers.set, config.providerConfiguration!)
            await ctx
              .buildSession({ cwd: workspace, mcpServers: setup.mcpServers ?? [] })
              .withSession(async (session) => {
                session.prompt({
                  type: 'text',
                  text: `${setup.promptPrefix ?? ''}\nUse the genomes Connector to look up a gene.`,
                  ...(explicit
                    ? { _meta: { 'open-science/skill-inputs': [{ name: 'mcp-genomes', path }] } }
                    : {})
                })
                while ((await session.nextUpdate()).kind !== 'stop') {
                  /* Drain notifications. */
                }
                const firstRequest = requests.at(-1)!
                expect(
                  JSON.stringify(firstRequest.input ?? firstRequest.messages),
                  stderr.join('')
                ).toContain(marker)
                expect(requests).toHaveLength(explicit ? 1 : 2)
                expect(JSON.stringify(requests[0].tools)).not.toMatch(
                  /"name":"(?:shell_command|exec_command)"/
                )
                if (explicit) return

                // Resume the same native thread: change A -> B, reject A, remove the loader, then
                // restore A. Check actual tool results, since prior documents remain in history.
                for (const scope of [['mcp-regulation'], [], ['mcp-genomes']]) {
                  const nextSetup = framework.buildSessionSetup({
                    systemPromptAppends: [],
                    skillRuntimeScope: scope,
                    sessionOptions: {
                      openScienceSkillRuntime: {
                        command: process.execPath,
                        entryPath: loaderEntry,
                        root: join(root, 'codex'),
                        skillsDirectory: join(root, 'codex', 'skills')
                      }
                    }
                  })
                  await ctx.request(acp.methods.agent.session.close, {
                    sessionId: session.sessionId
                  })
                  // A detached retry can encounter an already closed native thread.
                  await ctx.request(acp.methods.agent.session.close, {
                    sessionId: session.sessionId
                  })
                  await ctx.request(acp.methods.agent.session.resume, {
                    sessionId: session.sessionId,
                    cwd: workspace,
                    mcpServers: nextSetup.mcpServers ?? []
                  })
                  for (const skill of scope[0] === 'mcp-regulation'
                    ? ['mcp-regulation', 'mcp-genomes']
                    : [scope[0] ?? 'mcp-genomes']) {
                    requestedSkill = skill
                    phaseRequests = 0
                    const requestStart = requests.length
                    session.prompt({
                      type: 'text',
                      text: `Load ${skill} again for the current Specialist.`
                    })
                    while ((await session.nextUpdate()).kind !== 'stop') {
                      /* Drain notifications. */
                    }
                    const latest = requests.at(-1)!
                    const tools = JSON.stringify(requests[requestStart].tools)
                    if (scope.length === 0) {
                      expect(tools).not.toContain('load_skill')
                      expect(requests.length - requestStart).toBe(1)
                    } else {
                      expect(tools).toContain(scope[0])
                      expect(tools).not.toContain(
                        scope[0] === 'mcp-genomes' ? 'mcp-regulation' : 'mcp-genomes'
                      )
                      const items = (latest.input ?? latest.messages) as Record<string, unknown>[]
                      const output = JSON.stringify(
                        items
                          .filter(
                            (item) => item.type === 'function_call_output' || item.role === 'tool'
                          )
                          .at(-1)
                      )
                      expect(output).toContain(
                        skill === scope[0]
                          ? skill === 'mcp-genomes'
                            ? marker
                            : 'REGULATION_DOCUMENT_BODY'
                          : 'Unknown skill'
                      )
                    }
                  }
                }
              })
          }
        )
      expect(requests.length).toBeGreaterThan(0)
    } finally {
      await terminateProcessTree(child)
      await proxy.close()
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  30_000
)
