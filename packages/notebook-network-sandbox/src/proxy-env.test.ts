import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { proxyEnvironment } from '../runtime/src/platform/proxy-environment.js'
import { checkLinuxTools, probeLinuxIsolation } from '../runtime/src/platform/linux-isolation.js'

describe('Notebook network proxy environment', () => {
  const credentials = { username: 'command id', password: 'random/secret' }

  it('forces every destination through the policy gateway', () => {
    const env = proxyEnvironment(4100, credentials)
    const http = 'http://command%20id:random%2Fsecret@127.0.0.1:4100'

    expect(env).toMatchObject({
      NO_PROXY: '',
      no_proxy: '',
      HTTP_PROXY: http,
      HTTPS_PROXY: http,
      NODE_USE_ENV_PROXY: '1',
      ALL_PROXY: http,
      FTP_PROXY: 'socks5h://command%20id:random%2Fsecret@127.0.0.1:4100',
      CLOUDSDK_PROXY_ADDRESS: '127.0.0.1',
      CLOUDSDK_PROXY_USERNAME: 'command id',
      CLOUDSDK_PROXY_PASSWORD: 'random/secret'
    })
    expect(env).not.toHaveProperty('RSYNC_PROXY')
  })

  it('accepts localhost when the caller matches a macOS seatbelt allow rule', () => {
    const env = proxyEnvironment(4100, credentials, 'localhost')

    expect(env.HTTP_PROXY).toBe('http://command%20id:random%2Fsecret@localhost:4100')
    expect(env.CLOUDSDK_PROXY_ADDRESS).toBe('localhost')
  })

  it('does not inject unrelated language or certificate settings', () => {
    const env = proxyEnvironment(4100, credentials)

    expect(env).not.toHaveProperty('JAVA_TOOL_OPTIONS')
    expect(env).not.toHaveProperty('NODE_EXTRA_CA_CERTS')
    expect(env).not.toHaveProperty('SSL_CERT_FILE')
    expect(env).not.toHaveProperty('REQUESTS_CA_BUNDLE')
    expect(env).not.toHaveProperty('CURL_CA_BUNDLE')
  })

  it('does not require an external TCP-to-Unix bridge', () => {
    expect(checkLinuxTools().errors.join('\n')).not.toContain('socat')
  })
})

it.runIf(process.platform !== 'win32')('distinguishes Linux isolation failures through the sandbox executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'open-science-isolation-check-'))
  vi.stubEnv('PATH', directory)
  try {
    for (const [diagnostic, expected] of [
      ['', 'ready'],
      ['bwrap: Creating new namespace failed: Operation not permitted', 'namespaces-unavailable'],
      ["bwrap: Can't mount proc on /newroot/proc: Operation not permitted", 'procfs-unavailable'],
      ['bwrap: unrecognized host failure', 'unconfirmed']
    ]) {
      await writeFile(
        join(directory, 'bwrap'),
        `#!/bin/sh\n[ "$*" = '--die-with-parent --new-session --unshare-all --cap-drop ALL --ro-bind / / --proc /proc --dev /dev -- /bin/true' ] || exit 2\n${diagnostic ? `printf '%s\\n' "${diagnostic}" >&2\nexit 1` : 'exit 0'}\n`,
        { mode: 0o700 }
      )
      await expect(probeLinuxIsolation()).resolves.toBe(expected)
    }
  } finally {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
})
