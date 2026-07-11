import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveLocalClaudeAuth } from './local-claude-auth'

let root: string | undefined

const setup = async (): Promise<{ userClaudeDir: string; appConfigDir: string }> => {
  root = await mkdtemp(join(tmpdir(), 'os-local-auth-'))
  const userClaudeDir = join(root, 'user-claude')
  const appConfigDir = join(root, 'app-claude')
  await mkdir(userClaudeDir, { recursive: true })
  await mkdir(appConfigDir, { recursive: true })
  return { userClaudeDir, appConfigDir }
}

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

describe('resolveLocalClaudeAuth', () => {
  it('returns the token + base URL from ~/.claude/settings.json env', async () => {
    const { userClaudeDir, appConfigDir } = await setup()
    await writeFile(
      join(userClaudeDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-user', ANTHROPIC_BASE_URL: 'https://gw' } })
    )

    await expect(resolveLocalClaudeAuth({ userClaudeDir, appConfigDir })).resolves.toEqual({
      ANTHROPIC_AUTH_TOKEN: 'sk-user',
      ANTHROPIC_BASE_URL: 'https://gw'
    })
  })

  it('copies OAuth credentials into the app dir when there is no token', async () => {
    const { userClaudeDir, appConfigDir } = await setup()
    await writeFile(join(userClaudeDir, 'settings.json'), JSON.stringify({ env: {} }))
    await writeFile(join(userClaudeDir, '.credentials.json'), '{"oauth":"secret"}')

    const env = await resolveLocalClaudeAuth({ userClaudeDir, appConfigDir })

    expect(env).toEqual({})
    // The OAuth credentials were copied into the app config dir for claude to use.
    await expect(readFile(join(appConfigDir, '.credentials.json'), 'utf8')).resolves.toContain(
      'oauth'
    )
  })

  it('returns no overrides and does not throw when ~/.claude has neither', async () => {
    const { userClaudeDir, appConfigDir } = await setup()

    await expect(resolveLocalClaudeAuth({ userClaudeDir, appConfigDir })).resolves.toEqual({})
  })
})
