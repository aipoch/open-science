import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type PinggyRegion = 'auto' | 'ap' | 'us' | 'eu'

export const pinggyHost = (region: PinggyRegion, pro: boolean): string =>
  `${region === 'auto' ? '' : `${region}.`}${pro ? 'pro' : 'free'}.pinggy.io`

export const parsePinggyUrl = (output: string, pro = false): string | undefined => {
  for (const match of output.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/, ''))
      const host = url.hostname.toLowerCase()
      if (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash &&
        (host.endsWith('.pinggy-free.link') || (pro && host.endsWith('.pinggy.link')))
      )
        return url.origin
    } catch {
      // Ignore unrelated terminal output.
    }
  }
  return undefined
}

const waitForExit = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve) => {
    child.once('close', (code) => resolve(code))
  })

export const ensurePinggyKey = async (
  configRoot: string
): Promise<{ key: string; knownHosts: string }> => {
  const directory = join(configRoot, 'remote-access')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const key = join(directory, 'pinggy_ed25519')
  const knownHosts = join(directory, 'pinggy_known_hosts')
  try {
    await stat(key)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const child = spawn('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], {
      stdio: 'ignore'
    })
    const code = await waitForExit(child)
    if (code !== 0) throw new Error('Could not create the Pinggy SSH key.')
  }
  await chmod(key, 0o600)
  return { key, knownHosts }
}

export class PinggyTunnel {
  private child?: ChildProcess
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private stopped = false
  private failures = 0
  private generation = 0

  constructor(
    private readonly configRoot: string,
    private readonly port: number,
    private readonly region: PinggyRegion,
    private readonly token: string | undefined,
    private readonly onUrl: (url: string) => void,
    private readonly onDisconnect: (retrying: boolean, error?: string) => void
  ) {}

  async start(): Promise<void> {
    const { key, knownHosts } = await ensurePinggyKey(this.configRoot)
    await this.connect(key, knownHosts)
  }

  private async connect(key: string, knownHosts: string): Promise<void> {
    if (this.stopped) return
    const generation = ++this.generation
    const host = pinggyHost(this.region, Boolean(this.token))
    const args = [
      '-p',
      '443',
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile=${knownHosts}`,
      '-o',
      'IdentitiesOnly=yes',
      '-i',
      key,
      `-R0:127.0.0.1:${this.port}`,
      `${this.token ? `${this.token}@` : ''}${host}`,
      'x:xff'
    ]
    const child = spawn('ssh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
    })
    this.child = child
    let output = ''
    let ready = false
    const timeout = setTimeout(() => this.stopChild(child), 30_000)
    const accept = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-4096)
      const url = parsePinggyUrl(output, Boolean(this.token))
      if (!ready && url && generation === this.generation && !this.stopped) {
        ready = true
        clearTimeout(timeout)
        this.failures = 0
        this.onUrl(url)
      }
    }
    child.stdout?.on('data', accept)
    child.stderr?.on('data', accept)
    child.once('error', () => this.stopChild(child))
    child.once('close', () => {
      clearTimeout(timeout)
      if (this.child === child) this.child = undefined
      if (this.stopped || generation !== this.generation) return
      this.failures += 1
      const retrying = this.failures < 5
      this.onDisconnect(
        retrying,
        retrying ? undefined : 'Could not establish the Pinggy tunnel. Check the network and token.'
      )
      if (retrying) {
        const delay = Math.min(60_000, 1_000 * 2 ** (this.failures - 1))
        this.reconnectTimer = setTimeout(() => void this.connect(key, knownHosts), delay)
      }
    })
  }

  private stopChild(child: ChildProcess): void {
    if (!child.pid) return
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
      } else {
        process.kill(-child.pid, 'SIGTERM')
      }
    } catch {
      child.kill()
    }
  }

  stop(): void {
    this.stopped = true
    this.generation += 1
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.child) this.stopChild(this.child)
    this.child = undefined
  }
}
