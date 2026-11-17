import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
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
  const run = (action: 'login' | 'logout' | 'status'): ReturnType<typeof runCodeBuddyAuth> =>
    runCodeBuddyAuth('codebuddy-auth-fixture', root, 'internal', action)
  try {
    const account = await run('login')
    expect(account).toEqual({ authenticated: true, model: 'model', models: ['model', 'other'] })
    expect(await run('login')).toEqual(account)
    expect(await runCodeBuddyAuth('codebuddy-auth-fixture', root, 'external', 'status')).toEqual({
      authenticated: false
    })
    await run('logout')
    expect(await run('status')).toEqual({ authenticated: false })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
