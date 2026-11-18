import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { hasWorkBuddyProfile, sharedCodeBuddySiteMatches } from './codebuddy-profile'
import { runCodeBuddyAuth } from './codebuddy-auth'

vi.mock('node:child_process', async (original) => {
  const cp = await original<typeof import('node:child_process')>()
  return {
    ...cp,
    spawn: (
      executable: string,
      args: string[],
      options: import('node:child_process').SpawnOptions
    ) => {
      if (executable !== 'codebuddy-auth-fixture') return cp.spawn(executable, args, options)
      return cp.spawn(
        process.execPath,
        [
          '-e',
          `
          const fs = require('node:fs')
          const marker = 'local-test-session'
          const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
          const lines = require('node:readline').createInterface({ input: process.stdin })
          lines.on('line', (line) => {
            const request = JSON.parse(line)
            if (request.type === 'control_request') {
              if (request.request.subtype !== 'logout') process.exit(2)
              fs.unlinkSync(marker)
              send({
                type: 'control_response',
                response: { request_id: request.request_id, subtype: 'success', response: { success: true } }
              })
              return
            }

            let result
            switch (request.method) {
              case 'initialize':
                result = { protocolVersion: 1, authMethods: [{ id: 'internal' }] }
                break
              case '_codebuddy.ai/getUserInfo':
                result = fs.existsSync(marker) ? { userInfo: { userId: 'fixture', token: 'private' } } : {}
                break
              case 'authenticate':
                if (fs.existsSync(marker) || request.params.methodId !== 'internal') process.exit(2)
                fs.writeFileSync(marker, '')
                result = {}
                break
              case 'session/new':
                if (fs.existsSync('catalog-mode')) {
                  const mode = fs.readFileSync('catalog-mode', 'utf8')
                  if (mode === 'error') {
                    send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'unavailable' } })
                    return
                  }
                  result = mode === 'partial'
                    ? { sessionId: 'fixture', models: { currentModelId: 'current-only' } }
                    : { sessionId: 'fixture', configOptions: [{ id: 'model', type: 'select', currentValue: 'new',
                        options: [{ group: 'account', options: [{ value: 'new', name: 'New' }] }] }] }
                  break
                }
                result = {
                  sessionId: 'fixture',
                  models: { currentModelId: 'model', availableModels: [{ modelId: 'model' }, { modelId: 'other' }] }
                }
                break
              default:
                process.exit(3)
            }
            send({ jsonrpc: '2.0', id: request.id, result })
          })
    `
        ],
        { ...options, shell: false }
      )
    }
  }
})

it('keeps a login in its site profile, reuses it on restart and clears it on logout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'os-codebuddy-auth-'))
  const run = (
    action: 'login' | 'logout' | 'status' | 'refresh'
  ): ReturnType<typeof runCodeBuddyAuth> =>
    runCodeBuddyAuth('codebuddy-auth-fixture', root, 'internal', action)
  try {
    expect(await run('refresh')).toEqual({ authenticated: false })
    const account = await run('login')
    expect(account).toEqual({ authenticated: true, model: 'model', models: ['model', 'other'] })
    const modePath = join(root, 'codebuddy-cn', 'catalog-mode')
    for (const mode of ['partial', 'error']) {
      await writeFile(modePath, mode)
      expect(await run('login')).toEqual({ authenticated: true })
    }
    await writeFile(modePath, 'standard')
    expect(await run('refresh')).toEqual({ authenticated: true, model: 'new', models: ['new'] })
    expect(await runCodeBuddyAuth('codebuddy-auth-fixture', root, 'external', 'status')).toEqual({
      authenticated: false
    })
    await run('logout')
    expect(await run('status')).toEqual({ authenticated: false })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  ['darwin', ['Library', 'Application Support']],
  ['win32', ['AppData', 'Local']],
  ['linux', ['.local', 'share']]
] as const)('routes shared logins by product and site on %s', async (platform, data) => {
  const home = await mkdtemp(join(tmpdir(), 'os-codebuddy-shared-'))
  try {
    const dir = join(home, ...data, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workbuddy-desktop.info'), 'unreadable as JSON')
    expect(hasWorkBuddyProfile(home, platform)).toBe(true)
    expect(sharedCodeBuddySiteMatches('internal', home, platform)).toBe(false)
    for (const [domain, site] of [
      ['www.codebuddy.cn', 'internal'],
      ['www.codebuddy.ai', 'external']
    ] as const) {
      await writeFile(
        join(dir, 'Tencent-Cloud.coding-copilot.info'),
        JSON.stringify({ auth: { domain } })
      )
      expect(sharedCodeBuddySiteMatches('internal', home, platform)).toBe(site === 'internal')
      expect(sharedCodeBuddySiteMatches('external', home, platform)).toBe(site === 'external')
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
