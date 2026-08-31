import type { GatewayCredentials } from '../gateway/command-gateway.js'

const proxyEnvironment = (port: number, credentials: GatewayCredentials): NodeJS.ProcessEnv => {
  const gatewayHost = '127.0.0.1'
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
