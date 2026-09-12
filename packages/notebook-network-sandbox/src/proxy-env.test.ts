import { describe, expect, it } from 'vitest'

import { proxyEnvironment } from '../runtime/src/platform/proxy-environment.js'
import { checkLinuxTools } from '../runtime/src/platform/linux-isolation.js'

describe('Notebook network proxy environment', () => {
  const credentials = { username: 'command id', password: 'random/secret' }

  it('forces every destination through the policy gateway', () => {
    const env = proxyEnvironment(4100, credentials)
    // macOS seatbelt `(remote ip ...)` accepts only `localhost` or `*`. A 127.0.0.1 proxy URL is
    // denied with EPERM, which curl reports as connection refused.
    const gatewayHost = process.platform === 'darwin' ? 'localhost' : '127.0.0.1'
    const http = `http://command%20id:random%2Fsecret@${gatewayHost}:4100`

    expect(env).toMatchObject({
      NO_PROXY: '',
      no_proxy: '',
      HTTP_PROXY: http,
      HTTPS_PROXY: http,
      ALL_PROXY: http,
      FTP_PROXY: `socks5h://command%20id:random%2Fsecret@${gatewayHost}:4100`,
      CLOUDSDK_PROXY_ADDRESS: gatewayHost,
      CLOUDSDK_PROXY_USERNAME: 'command id',
      CLOUDSDK_PROXY_PASSWORD: 'random/secret'
    })
    expect(env).not.toHaveProperty('RSYNC_PROXY')
  })

  it('keeps an explicit gateway host independent of the test machine', () => {
    const env = proxyEnvironment(4100, credentials, '127.0.0.1')

    expect(env.HTTP_PROXY).toBe('http://command%20id:random%2Fsecret@127.0.0.1:4100')
    expect(env.CLOUDSDK_PROXY_ADDRESS).toBe('127.0.0.1')
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
