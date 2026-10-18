import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { join, resolve } from 'node:path'
import vm from 'node:vm'

const source = await readFile(resolve(process.argv[2], 'scripts/pr3599-upgrade-certification.mjs'), 'utf8')
const observationSource = source.slice(source.indexOf('const assertDifferentialObservation ='), source.indexOf('const runTransition ='))
const assertionEnd = observationSource.indexOf('\n}\n') + 3
assert.ok(assertionEnd > 3)
const verify = vm.runInNewContext(observationSource.slice(0, assertionEnd) + '\nassertDifferentialObservation')
const observation = { feedRequests: 1, blockmapRequests: 2, rangeRequests: 1, fullInstallerRequests: 0, downloadedInstallerBytes: 16, installerBytes: 100, versionedFeed: true, previousInstallerCacheVerified: true, previousVersion: '1.0.1', currentVersion: '1.0.2' }
verify(observation)
verify({ ...observation, blockmapRequests: 1, previousBlockmapCacheVerified: true })
assert.throws(() => verify({ ...observation, blockmapRequests: 1 }), /complete differential path/)
assert.throws(() => verify({ ...observation, fullInstallerRequests: 1 }), /complete differential path/)
console.log('PASS: uncached/cached old blockmap accepted with evidence; missing old map and full fallback rejected (4 cases).')
const parser = source.slice(source.indexOf('const parseSingleRange ='), source.indexOf('const rewriteFeedPaths ='))
const serverSource = source.slice(source.indexOf('let sharedAssetServer'), source.indexOf('const withTimeout ='))
const create = vm.runInNewContext(parser + serverSource + '\nstartAssetServer', { createServer, stat, createReadStream, pipeline, randomUUID, Buffer, URL, downloadFault: { mode: 'none' } })
const root = await mkdtemp(resolve('tmp/direct-source-'))
let server
try {
  const file = join(root, 'installer.exe')
  const content = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ')
  await writeFile(file, content)
  server = await create({ assets: [{ route: '/installer.exe', path: file }], currentInstallerRoute: '/installer.exe' })
  const request = async range => fetch(server.url + '/installer.exe', { headers: { Range: range } })
  const multi = await request('bytes=0-3, 10-15, 30-35')
  assert.equal(multi.status, 206, 'multipart must not trigger a 416/full-download fallback')
  const boundary = multi.headers.get('content-type').match(/boundary=([^;]+)/)[1]
  const body = await multi.text()
  const expected = [[0,3],[10,15],[30,35]].map(([start,end]) => `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${start}-${end}/${content.length}\r\n\r\n${content.subarray(start,end+1)}\r\n`).join('') + `--${boundary}--\r\n`
  assert.equal(body, expected)
  assert.equal(Number(multi.headers.get('content-length')), Buffer.byteLength(expected))
  assert.equal(server.metrics.rangeRequests, 1)
  assert.equal(server.metrics.fullInstallerRequests, 0)
  assert.equal(server.metrics.downloadedInstallerBytes, 16)
  const invalid = await request('bytes=0-3, 999-1000')
  assert.equal(invalid.status, 416)
  await invalid.arrayBuffer()
  const single = await request('bytes=5-8')
  assert.equal(single.status, 206)
  assert.equal(await single.text(), '5678')
  console.log('PASS: actual generated HTTP source serves multipart bytes/headers, rejects invalid ranges, preserves single ranges and records differential-only transfers (3 cases).')
} finally {
  if (server) await server.close()
  await rm(root, { recursive: true })
}
