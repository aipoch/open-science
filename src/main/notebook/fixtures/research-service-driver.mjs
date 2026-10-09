// Stage-one engineering fixture. This is not a scientific experiment or a public execution API.
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Executed directly as JavaScript by independent Node. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const [mode, portText, output, source] = process.argv.slice(2)
const port = Number(portText)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid probe port')
if (process.versions.electron || Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error('The probe requires independent Node >=22')
}
const self = fileURLToPath(import.meta.url)
const socketPath = process.env.OPEN_SCIENCE_SERVICE_SOCKET
if (!socketPath) throw new Error('Missing main-owned service socket')
const minimalEnvironment = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: process.env.HOME,
  LANG: 'en_US.UTF-8',
  OPEN_SCIENCE_SERVICE_SOCKET: socketPath,
  OPEN_SCIENCE_SERVICE_PORT: portText
}

function request(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        socketPath,
        path,
        method: 'GET',
        timeout: 3000,
        headers: { host: `127.0.0.1:${port}`, ...headers }
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
          if (Buffer.byteLength(body) > 1024 * 1024)
            outgoing.destroy(new Error('Probe response exceeded limit'))
        })
        response.on('error', reject)
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, body })
        )
      }
    )
    outgoing.on('error', reject)
    outgoing.on('timeout', () => outgoing.destroy(new Error('Probe request timed out')))
    outgoing.end()
  })
}

if (mode === 'child') {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: minimalEnvironment,
    stdio: 'ignore'
  })
  const generation = randomUUID()
  const server = http.createServer((request, response) => {
    if (request.url !== '/health' || request.method !== 'GET') {
      response.writeHead(404).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ generation, child: process.pid, descendant: descendant.pid }))
  })
  server.listen(socketPath, () => console.log('PROBE_READY'))
  server.on('error', (error) => {
    console.error(error.code)
    process.exitCode = 1
    descendant.kill()
  })
  process.on('SIGTERM', () => {
    descendant.kill('SIGTERM')
    server.closeAllConnections()
    server.close()
  })
} else {
  await mkdir(output, { recursive: true })
  if (mode === 'tuanzi' && (!source || existsSync(join(source, '.env')))) {
    throw new Error('Tuanzi must be restored from the pinned snapshot without .env')
  }
  const child = spawn(
    process.execPath,
    mode === 'tuanzi'
      ? ['--import', join(dirname(self), 'preload.mjs'), join(source, 'server.mjs')]
      : [self, 'child', portText],
    {
      cwd: mode === 'tuanzi' ? source : output,
      env: {
        ...minimalEnvironment,
        PORT: portText,
        MAX_SERVER_CALLS: '1',
        GS_LAB_OUTPUT_DIR: join(output, 'exports')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const closed = once(child, 'close')
  let startup = ''
  let childError
  child.on('error', (error) => {
    childError = error
  })
  child.stdout.on('data', (chunk) => {
    startup = (startup + chunk.toString()).slice(-8192)
  })
  // Readiness failures expose only a bounded diagnostic; status bodies/tokens are never logged.
  let diagnostics = ''
  child.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-1024)
  })
  try {
    const deadline = Date.now() + 10_000
    while (
      !(mode === 'tuanzi'
        ? startup.includes(`127.0.0.1:${port}/lab`)
        : startup.includes('PROBE_READY'))
    ) {
      if (childError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Probe service exited before readiness: ${childError?.code ?? diagnostics}`)
      }
      if (Date.now() >= deadline) throw new Error('Probe service readiness timed out')
      await delay(20)
    }
    let result
    if (mode === 'tuanzi') {
      const statusResponse = await request('/api/status')
      if (statusResponse.status !== 200) throw new Error('Status request failed')
      const status = JSON.parse(statusResponse.body)
      if (
        status.version !== '0.5.6' ||
        status.providerCalls !== 0 ||
        status.jevReady ||
        status.llmReady
      ) {
        throw new Error('Unexpected project version, model configuration or provider call count')
      }
      const capabilitiesResponse = await request('/api/lab/capabilities', {
        'x-gs-token': status.token
      })
      if (capabilitiesResponse.status !== 200) throw new Error('Capabilities request failed')
      const capabilities = JSON.parse(capabilitiesResponse.body)
      const page = await request('/lab')
      result = {
        kind: 'engineering-startup-only',
        version: status.version,
        providerCalls: status.providerCalls,
        jevReady: status.jevReady,
        llmReady: status.llmReady,
        capabilityVersion: capabilities.version,
        deadlockPolicy: capabilities.deadlockReferee?.policy,
        iframeEmbeddingForbidden:
          page.headers['content-security-policy']?.includes("frame-ancestors 'none'") ?? false,
        experimentsStarted: 0,
        child: child.pid
      }
    } else {
      const response = await request('/health')
      if (response.status !== 200) throw new Error('Fixture service health failed')
      result = { kind: 'synthetic-engineering-fixture', ...JSON.parse(response.body) }
    }
    result = { ...result, node: process.version, arch: process.arch, platform: process.platform }
    await writeFile(join(output, 'ready.json'), JSON.stringify(result))
    if (mode === 'hold')
      await new Promise(() => {
        setInterval(() => {}, 1000)
      })
    if (mode === 'orphan') {
      // Deliberately leave this owned fixture descendant for Notebook terminalization to reap.
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      await writeFile(join(output, 'result.json'), JSON.stringify(result))
      process.exit(0)
    }
    await writeFile(join(output, 'result.json'), JSON.stringify(result))
    console.log(JSON.stringify(result))
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    let escalation
    try {
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 4000)
      await closed
    } finally {
      clearTimeout(escalation)
    }
  }
}
