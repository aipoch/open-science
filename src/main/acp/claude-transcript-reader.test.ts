import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createClaudeTranscriptReader,
  type GetSessionMessages,
  type ClaudeSessionKey
} from './claude-transcript-reader'

const sessionId = '11111111-1111-4111-8111-111111111111'

describe('Claude transcript reader', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('reads the provider Session through the SDK transcript boundary', async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-claude-transcript-'))
    const configDir = join(root, 'claude')
    const cwd = join(root, 'workspace')
    const resolvedKey: ClaudeSessionKey = {
      projectKey: 'workspace-key',
      sessionId
    }

    const projectDir = join(configDir, 'projects', resolvedKey.projectKey)
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, `${sessionId}.jsonl`),
      [
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          sessionId,
          message: { role: 'user', content: 'hello' }
        },
        {
          type: 'assistant',
          uuid: 'assistant-1',
          parentUuid: 'user-1',
          sessionId,
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            id: 'minimax-call-1',
            content: [{ type: 'text', text: 'done' }],
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 2,
              cache_creation_input_tokens: 0,
              output_tokens: 1
            }
          }
        }
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
      'utf8'
    )

    const getSessionMessages: GetSessionMessages = async (_providerSessionId, options) =>
      (await options.sessionStore.load(resolvedKey)) ?? []
    const messages = await createClaudeTranscriptReader(
      configDir,
      getSessionMessages
    )({
      providerSessionId: sessionId,
      cwd
    })

    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'minimax-call-1',
        usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 1 }
      }
    })
  })

  it('returns no messages when Claude has no transcript for the Session', async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-claude-transcript-'))

    const getSessionMessages: GetSessionMessages = async (_providerSessionId, options) =>
      (await options.sessionStore.load({ projectKey: 'missing', sessionId })) ?? []
    await expect(
      createClaudeTranscriptReader(
        join(root, 'claude'),
        getSessionMessages
      )({
        providerSessionId: sessionId,
        cwd: join(root, 'workspace')
      })
    ).resolves.toEqual([])
  })
})
