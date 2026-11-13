import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { ClaudeCodeSkillMaterializer } from '@aipoch/skills/projection'
import { expect, it } from 'vitest'

import { createOpencodeFramework, opencodeConfigDir } from './opencode'

const executable = process.env.OPENCODE_V2_ACP_PATH

// The model is local and deterministic; only the actual OpenCode 2.x tool executes.
it.runIf(executable)(
  'loads an imported skill by its public name through OpenCode 2.x',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-v2-skill-'))
    const workspace = join(root, 'workspace')
    const sourceDir = join(root, 'source')
    await mkdir(workspace)
    await mkdir(sourceDir)
    await writeFile(
      join(sourceDir, 'SKILL.md'),
      '---\nname: abstract-summarizer\ndescription: Summarize academic abstracts.\n---\nABSTRACT_SKILL_BODY_MARKER\n'
    )
    await new ClaudeCodeSkillMaterializer().sync(
      opencodeConfigDir(root),
      [
        {
          id: 'imported-abstract-summarizer',
          name: 'abstract-summarizer',
          displayName: 'Abstract Summarizer',
          description: 'Summarize academic abstracts.',
          source: 'imported',
          updatedAt: '',
          sourceDir
        }
      ],
      { directoryLayout: 'agent-facing-shared' }
    )
    const results: string[] = []
    let called = false
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        for (const message of body.messages ?? []) {
          if (message.role === 'tool') results.push(JSON.stringify(message.content))
        }
        const call = Boolean(body.tools?.length) && !called
        if (call) {
          called = true
        }
        const delta = call
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'load_abstract_skill',
                  type: 'function',
                  function: {
                    name: 'skill',
                    arguments: JSON.stringify({ id: 'abstract-summarizer' })
                  }
                }
              ]
            }
          : { role: 'assistant', content: 'done' }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          [
            `data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}`,
            `data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}`,
            'data: [DONE]',
            ''
          ].join('\n\n')
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const config = createOpencodeFramework().prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['chat-completions'],
        model: 'probe-model',
        key: 'test-key',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
      },
      {
        storageRoot: root,
        executablePath: executable!,
        nativeVersion: '2.2.7',
        skillDiscovery: {
          allowedNames: ['abstract-summarizer'],
          allowedPaths: [join(opencodeConfigDir(root), 'skills', 'abstract-summarizer', 'SKILL.md')]
        }
      }
    )
    for (const file of config.configFiles ?? []) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.content)
    }
    const child = spawn(executable!, ['acp'], {
      cwd: workspace,
      env: { ...process.env, ...config.env },
      stdio: 'pipe'
    })
    const stderr: string[] = []
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
    try {
      await acp
        .client({ name: 'v2-skill-identity-regression' })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
          const once = ctx.params.options.find((option) => option.kind === 'allow_once')
          return once
            ? { outcome: { outcome: 'selected', optionId: once.optionId } }
            : { outcome: { outcome: 'cancelled' } }
        })
        .connectWith(
          acp.ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
          ),
          async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {}
            })
            await ctx
              .buildSession({ cwd: workspace, mcpServers: [] })
              .withSession(async (session) => {
                session.prompt('Use abstract-summarizer to explain its workflow.')
                while ((await session.nextUpdate()).kind !== 'stop') {
                  /* Drain updates. */
                }
              })
          }
        )
      expect(called, stderr.join('')).toBe(true)
      expect(results.join('\n'), stderr.join('')).toContain('ABSTRACT_SKILL_BODY_MARKER')
      expect(results.join('\n')).not.toContain('Unable to load skill')
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        child.kill()
        await exited
      }
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await new ClaudeCodeSkillMaterializer().sync(opencodeConfigDir(root), [], {
        directoryLayout: 'agent-facing-shared'
      })
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  60_000
)
