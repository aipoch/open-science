import type { GatewayCredentials } from '../gateway/command-gateway.js'

const proxyEnvironment = (
  port: number,
  credentials: GatewayCredentials,
  gatewayHost = process.platform === 'darwin' ? 'localhost' : '127.0.0.1'
): NodeJS.ProcessEnv => {
  // macOS seatbelt `(remote ip ...)` accepts only `localhost` or `*`. A 127.0.0.1 proxy URL is a
  // different remote address and is denied with EPERM; curl reports that as connection refused.
  // Windows and Linux isolation bind 127.0.0.1 and must pass that host even when tests run on Darwin.
  const authority = `${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${gatewayHost}:${port}`
  const http = `http://${authority}`
  const socks = `socks5h://${authority}`
  return {
    NO_PROXY: '',
    no_proxy: '',
    HTTP_PROXY: http,
    HTTPS_PROXY: http,
    http_proxy: http,
    https_proxy: http,
    ALL_PROXY: http,
    all_proxy: http,
    GRPC_PROXY: http,
    grpc_proxy: http,
    FTP_PROXY: socks,
    ftp_proxy: socks,
    DOCKER_HTTP_PROXY: http,
    DOCKER_HTTPS_PROXY: http,
    CLOUDSDK_PROXY_TYPE: 'http',
    CLOUDSDK_PROXY_ADDRESS: gatewayHost,
    CLOUDSDK_PROXY_PORT: String(port),
    CLOUDSDK_PROXY_USERNAME: credentials.username,
    CLOUDSDK_PROXY_PASSWORD: credentials.password
  }
}

export { proxyEnvironment }
