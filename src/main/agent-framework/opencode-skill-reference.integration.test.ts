import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { expect, it } from 'vitest'

import { readWorkspaceTextFile } from '../acp/filesystem'
import { createOpencodeFramework, opencodeConfigDir, opencodeStorageDir } from './opencode'

const executable = process.env.OPENCODE_ACP_PATH

// Drive native Skill -> Read using deterministic local model responses; no paid model or account.
it.runIf(executable)(
  'reads an enabled Skill root file and nested reference through native OpenCode',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'os skill-reference-'))
    const workspace = join(root, 'workspace')
    const skillDir = join(opencodeConfigDir(root), 'skills', 'os-personal-sci-article-workflow')
    await mkdir(workspace, { recursive: true })
    await mkdir(join(skillDir, 'references'), { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: sci-article-workflow\ndescription: Scientific article workflow.\n---\nRead common-rules.md and references/workbench.md before writing.\n'
    )
    await writeFile(join(skillDir, 'common-rules.md'), 'ROOT_REFERENCE_MARKER')
    await writeFile(join(skillDir, 'references', 'workbench.md'), 'NESTED_REFERENCE_MARKER')
    await writeFile(join(root, 'private.txt'), 'UNRELATED_PRIVATE_MARKER')
    const sibling = join(opencodeConfigDir(root), 'skills-backup', 'private.txt')
    const auth = join(root, 'opencode', 'data', 'opencode', 'auth.json')
    const disabledSource = join(root, 'skills', 'personal', 'disabled', 'references', 'note.md')
    for (const file of [sibling, auth, disabledSource]) {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, 'UNRELATED_PRIVATE_MARKER')
    }
    const deniedPaths = [
      join(root, 'private.txt'),
      join(opencodeConfigDir(root), 'opencode.json'),
      sibling,
      auth,
      disabledSource,
      // Preserve literal traversal in the tool input rather than normalizing it in the fixture.
      `${skillDir}/../../opencode.json`
    ]
    const calls = [
      { name: 'skill', arguments: { name: 'sci-article-workflow' } },
      { name: 'read', arguments: { filePath: join(skillDir, 'common-rules.md') } },
      { name: 'read', arguments: { filePath: join(skillDir, 'references', 'workbench.md') } },
      ...deniedPaths.map((filePath) => ({ name: 'read', arguments: { filePath } }))
    ]
    let step = 0
    const results: string[] = []
    const permissionRequests: string[] = []
    const fileRequests: string[] = []
    const updates: string[] = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        for (const message of body.messages ?? []) {
          if (message.role === 'tool') results.push(JSON.stringify(message.content))
        }
        const call = body.tools?.length ? calls[step++] : undefined
        const delta = call
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${step}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) }
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
        apiEndpoints: ['openai'],
        model: 'probe-model',
        key: 'test-key',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
      },
      { storageRoot: root, executablePath: executable! }
    )
    for (const file of config.configFiles ?? []) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.content)
    }
    const child = spawn(executable!, ['acp'], {
      cwd: workspace,
      env: { ...process.env, ...config.env },
      stdio: 'pipe',
      windowsHide: true
    })
    const stderr: string[] = []
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
    try {
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      )
      await acp
        .client({ name: 'skill-reference-regression' })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
          permissionRequests.push(JSON.stringify(ctx.params))
          return { outcome: { outcome: 'cancelled' } }
        })
        .onRequest(acp.methods.client.fs.readTextFile, (ctx) => {
          fileRequests.push(ctx.params.path)
          return readWorkspaceTextFile(workspace, ctx.params, [opencodeStorageDir(root)])
        })
        .connectWith(stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } }
          })
          await ctx
            .buildSession({ cwd: workspace, mcpServers: [] })
            .withSession(async (session) => {
              session.prompt('Load sci-article-workflow and read its two reference documents.')
              for (;;) {
                const update = await session.nextUpdate()
                updates.push(JSON.stringify(update))
                if (update.kind === 'stop') break
              }
            })
        })
      expect(step, stderr.join('')).toBe(calls.length + 1)
      expect(updates.join('\n')).toContain('Read common-rules.md')
      expect(permissionRequests).toEqual([])
      expect
        .soft(results.join('\n'), `ACP file reads: ${JSON.stringify(fileRequests)}`)
        .toContain('ROOT_REFERENCE_MARKER')
      expect.soft(results.join('\n')).toContain('NESTED_REFERENCE_MARKER')
      expect(results.join('\n')).not.toContain('UNRELATED_PRIVATE_MARKER')
      expect(results.join('\n')).not.toContain('OPENCODE_APP_API_KEY')
      const failedUpdates = updates.filter((update) => update.includes('"status":"failed"'))
      for (let index = 0; index < deniedPaths.length; index++) {
        expect(
          failedUpdates.some((update) => update.includes(`"toolCallId":"call_${index + 4}"`)),
          deniedPaths[index]
        ).toBe(true)
      }
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        child.kill()
        await exited
      }
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  60_000
)
