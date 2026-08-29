const DEFAULT_WEB_PORT = 44100

export type WebModeOptions = {
  enabled: boolean
  headless: boolean
  port: number
}

const parseWebPort = (value: string): number => {
  const normalized = value.trim()
  const port = Number(normalized)
  if (!/^\d+$/.test(normalized) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid Open Science web port: ${value}`)
  }
  return port
}

const parseWebModeOptions = (
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): WebModeOptions => {
  // Deliberately NOT `--headless`: Chromium interprets that switch itself, which on Windows makes
  // native menus (e.g. the tray context menu) render invisibly (electron/electron#48982).
  const headless = argv.includes('--open-science-headless')
  const serveArg = argv.find((arg) => arg === '--serve' || arg.startsWith('--serve='))
  const envPort = env.OPEN_SCIENCE_WEB_PORT?.trim() || undefined
  const enabled = headless || Boolean(serveArg) || Boolean(envPort)
  const requestedPort = serveArg?.startsWith('--serve=')
    ? serveArg.slice('--serve='.length)
    : envPort
  const parsedPort = requestedPort === undefined ? DEFAULT_WEB_PORT : parseWebPort(requestedPort)
  return { enabled, headless, port: parsedPort }
}

export { DEFAULT_WEB_PORT, parseWebModeOptions }
