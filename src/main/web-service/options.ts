const DEFAULT_WEB_PORT = 44100

export type WebModeOptions = {
  enabled: boolean
  headless: boolean
  port: number
}

const parseWebModeOptions = (
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): WebModeOptions => {
  // Deliberately NOT `--headless`: Chromium interprets that switch itself, which on Windows makes
  // native menus (e.g. the tray context menu) render invisibly (electron/electron#48982).
  const headless = argv.includes('--open-science-headless')
  const serveArg = argv.find((arg) => arg === '--serve' || arg.startsWith('--serve='))
  const envPort = env.OPEN_SCIENCE_WEB_PORT?.trim()
  const enabled = headless || Boolean(serveArg) || Boolean(envPort)
  const requestedPort = serveArg?.startsWith('--serve=')
    ? serveArg.slice('--serve='.length)
    : envPort
  const parsedPort = requestedPort ? Number.parseInt(requestedPort, 10) : DEFAULT_WEB_PORT
  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    throw new Error(`Invalid Open Science web port: ${requestedPort}`)
  }
  return { enabled, headless, port: parsedPort }
}

export { parseWebModeOptions }
