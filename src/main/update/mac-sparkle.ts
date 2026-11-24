import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { z } from 'zod'
import { APP } from '../../shared/app-config'

const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/)
const stable = z.string().regex(/^\d+\.\d+\.\d+$/)
const build = z.string().regex(/^\d+(?:\.\d+){0,3}$/)
const patchSchema = z.object({
  from: stable,
  sourceBuild: build,
  targetBuild: build,
  size: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 ** 2),
  signature,
  zipSignature: signature,
  sha512: signature,
  pairSignature: signature
})
const fileSchema = z.object({
  url: z.string(),
  size: z.number().int().positive().safe(),
  sha512: signature,
  sparkleDelta: patchSchema
})
type Offer = z.infer<typeof fileSchema> & { version: string }
type Driver = {
  begin(url: string, relaunch: boolean): Promise<void>
  commit(): void
  abandon(): void
}

export class MacSparkleUpdate {
  private offer?: Offer
  private staged?: Offer
  private readonly key
  constructor(
    publicKey: string,
    private readonly directory: string,
    private readonly arch: string,
    private readonly driver: () => Driver,
    private readonly request: typeof fetch = fetch
  ) {
    this.key = createPublicKey({
      format: 'jwk',
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey, 'base64').toString('base64url') }
    })
  }

  select(current: string, version: string | undefined, files: unknown[]): void {
    this.offer = undefined
    if (!stable.safeParse(version).success || !version) return
    const url = `releases/${version}/aipoch-open-science-${version}-mac-${this.arch}.zip`
    for (const entry of files) {
      const result = fileSchema.safeParse(entry)
      if (!result.success) continue
      const file = result.data
      const p = file.sparkleDelta
      if (file.url !== url || p.from !== current || p.size >= file.size) continue
      const pair = JSON.stringify([
        current,
        version,
        this.arch,
        p.sourceBuild,
        p.targetBuild,
        file.sha512,
        p.sha512
      ])
      if (verify(null, Buffer.from(pair), this.key, Buffer.from(p.pairSignature, 'base64')))
        this.offer = { ...file, version }
    }
  }

  get artifact(): { patchSize: number; zipSize: number; zipSha512: string } | undefined {
    if (!this.offer) return undefined
    return {
      patchSize: this.offer.sparkleDelta.size,
      zipSize: this.offer.size,
      zipSha512: this.offer.sha512
    }
  }

  isReady(version?: string): boolean {
    return (
      !!this.staged &&
      this.staged.version === version &&
      this.offer?.sha512 === this.staged.sha512 &&
      this.offer?.sparkleDelta.sha512 === this.staged.sparkleDelta.sha512
    )
  }

  private verified(bytes: Buffer, offer: Offer): boolean {
    const p = offer.sparkleDelta
    return (
      bytes.length === p.size &&
      createHash('sha512').update(bytes).digest('base64') === p.sha512 &&
      verify(null, bytes, this.key, Buffer.from(p.signature, 'base64'))
    )
  }

  private async cached(offer: Offer): Promise<Buffer | undefined> {
    const path = join(this.directory, 'update.delta')
    if ((await stat(path).catch(() => undefined))?.size !== offer.sparkleDelta.size) return
    const bytes = await readFile(path)
    return this.verified(bytes, offer) ? bytes : undefined
  }

  async prepare(
    version: string | undefined,
    signal: AbortSignal,
    progress?: (bytes: number) => void
  ): Promise<boolean> {
    this.staged = undefined
    const offer = this.offer
    if (!offer || offer.version !== version) return false
    const patch = offer.sparkleDelta
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // Interrupted writes are never used as update inputs. Leave other live downloads alone.
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.partial$/.test(name)) continue
      const path = join(this.directory, name)
      const file = await stat(path).catch(() => undefined)
      if (file && Date.now() - file.mtimeMs > 86_400_000) await rm(path, { force: true })
    }
    if ((await readFile(join(this.directory, 'rejected'), 'utf8').catch(() => '')) === patch.sha512)
      return false
    if (!(await this.cached(offer))) {
      const url = new URL(offer.url + '.from-' + patch.from + '.delta', APP.update.manifestUrl)
      const response = await this.request(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        redirect: 'error'
      })
      if (!response.ok || !response.body) throw new Error('Sparkle patch HTTP ' + response.status)
      const reader = response.body.getReader()
      const bytes = Buffer.alloc(patch.size)
      let lastProgress = 0
      let offset = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (offset + value.length > bytes.length) throw new Error('Oversized Sparkle patch')
          bytes.set(value, offset)
          offset += value.length
          if (performance.now() - lastProgress >= 200) {
            progress?.(offset)
            lastProgress = performance.now()
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      if (offset !== bytes.length || !this.verified(bytes, offer))
        throw new Error('Invalid Sparkle patch')
      const tmp = join(this.directory, randomUUID() + '.partial')
      try {
        await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx', signal })
        await rename(tmp, join(this.directory, 'update.delta'))
      } finally {
        await rm(tmp, { force: true })
      }
    }
    signal.throwIfAborted()
    if (this.offer !== offer) return false
    this.staged = offer
    return true
  }

  async install(version: string, relaunch: boolean): Promise<void> {
    const offer = this.staged
    if (!offer || !this.isReady(version)) throw new Error('Sparkle update was superseded')
    this.staged = undefined
    this.offer = undefined
    const patch = offer.sparkleDelta
    // Persist before arming the installer. A crash, failed swap or timeout must try the ZIP next time.
    await writeFile(join(this.directory, 'rejected'), patch.sha512, { mode: 0o600 })
    const bytes = await this.cached(offer)
    if (!bytes) throw new Error('Cached Sparkle patch is missing or invalid')
    await rm(join(this.directory, 'update.delta'), { force: true })
    const prefix = '/' + randomUUID() + '/'
    let xml = ''
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === prefix + 'appcast.xml')
        res.writeHead(200, { 'Content-Type': 'application/xml' }).end(xml)
      else if (req.method === 'GET' && req.url === prefix + 'update.delta')
        res.writeHead(200, { 'Content-Length': bytes.length }).end(bytes)
      else res.writeHead(404).end()
    })
    const driver = this.driver()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Cannot open local Sparkle feed')
      const base = 'http://127.0.0.1:' + address.port + prefix
      xml = `<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Open-Science</title><item><title>${version}</title><sparkle:version>${patch.targetBuild}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString><enclosure url="${base}update.zip" length="${offer.size}" type="application/octet-stream" sparkle:edSignature="${patch.zipSignature}"/><sparkle:deltas><enclosure url="${base}update.delta" length="${patch.size}" type="application/octet-stream" sparkle:deltaFrom="${patch.sourceBuild}" sparkle:edSignature="${patch.signature}"/></sparkle:deltas></item></channel></rss>`
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          driver.begin(base + 'appcast.xml', relaunch),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Sparkle installation preparation timed out')),
              55000
            )
          })
        ])
      } finally {
        clearTimeout(timeout)
      }
      driver.commit()
    } catch (error) {
      this.staged = undefined
      driver.abandon()
      throw error
    } finally {
      server.close()
      server.closeAllConnections()
    }
  }
}

export function loadMacSparkle(
  resources: string,
  cache: string,
  request: typeof fetch = fetch
): MacSparkleUpdate | undefined {
  try {
    const key = readFileSync(join(resources, 'mac-sparkle.pub'), 'utf8').trim()
    return new MacSparkleUpdate(
      key,
      join(
        cache,
        'com.aipoch.open-science.sparkle',
        createHash('sha256').update(resources).digest('hex')
      ),
      process.arch,
      () => createRequire(process.execPath)(join(resources, 'mac-sparkle.node')) as Driver,
      request
    )
  } catch {
    return undefined
  }
}
