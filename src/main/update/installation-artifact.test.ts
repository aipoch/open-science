import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readPackagedVersion,
  validateZipArchivePaths,
  verifyArtifactChecksum
} from './installation-artifact'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it('checks the offered artifact checksum before trusting payload bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-verification-'))
  roots.push(root)
  const file = join(root, 'update.exe')
  await writeFile(file, 'trusted bytes')
  const hash = createHash('sha512').update('trusted bytes').digest('base64')
  await verifyArtifactChecksum(file, hash)
  await writeFile(file, 'changed bytes')
  await expect(verifyArtifactChecksum(file, hash)).rejects.toThrow('checksum has changed')
  await expect(verifyArtifactChecksum(file, 'untrusted')).rejects.toThrow(
    'trusted update artifact checksum'
  )
})
it('reads packaged version without executing code from app.asar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-asar-'))
  roots.push(root)
  await mkdir(join(root, 'resources'))
  const content = Buffer.from(JSON.stringify({ version: '9.1.0', main: 'do-not-execute.js' }))
  const json = Buffer.from(
    JSON.stringify({ files: { 'package.json': { size: content.length, offset: '0' } } })
  )
  const headerSize = 8 + json.length + ((4 - (json.length % 4)) % 4)
  const header = Buffer.alloc(8 + headerSize)
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(headerSize, 4)
  header.writeUInt32LE(headerSize - 4, 8)
  header.writeUInt32LE(json.length, 12)
  json.copy(header, 16)
  await writeFile(join(root, 'resources/app.asar'), Buffer.concat([header, content]))
  expect(await readPackagedVersion(root)).toBe('9.1.0')
})
it('rejects a ZIP symlink escaping extraction before any extractor runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-zip-link-'))
  roots.push(root)
  const name = Buffer.from('link'),
    target = Buffer.from('../escape')
  const local = Buffer.alloc(30 + name.length + target.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt32LE(target.length, 18)
  local.writeUInt32LE(target.length, 22)
  local.writeUInt16LE(name.length, 26)
  name.copy(local, 30)
  target.copy(local, 30 + name.length)
  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt32LE(target.length, 20)
  central.writeUInt32LE(target.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE((0o120777 << 16) >>> 0, 38)
  name.copy(central, 46)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(local.length, 16)
  const archive = join(root, 'unsafe.zip')
  await writeFile(archive, Buffer.concat([local, central, end]))
  await expect(validateZipArchivePaths(archive)).rejects.toThrow('unsafe or unsupported paths')
})
