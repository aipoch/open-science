import { describe, expect, it } from 'vitest'

import { proxyEnvironment } from '../runtime/src/platform/proxy-environment.js'
import { checkLinuxTools } from '../runtime/src/platform/linux-isolation.js'

describe('Notebook network proxy environment', () => {
  const credentials = { username: 'command id', password: 'random/secret' }

  it('forces every destination through the policy gateway', () => {
    const env = proxyEnvironment(4100, credentials)

    expect(env).toMatchObject({
      NO_PROXY: '',
      no_proxy: '',
      HTTP_PROXY: 'http://command%20id:random%2Fsecret@127.0.0.1:4100',
      HTTPS_PROXY: 'http://command%20id:random%2Fsecret@127.0.0.1:4100',
      ALL_PROXY: 'http://command%20id:random%2Fsecret@127.0.0.1:4100',
      FTP_PROXY: 'socks5h://command%20id:random%2Fsecret@127.0.0.1:4100',
      CLOUDSDK_PROXY_USERNAME: 'command id',
      CLOUDSDK_PROXY_PASSWORD: 'random/secret'
    })
    expect(env).not.toHaveProperty('RSYNC_PROXY')
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
