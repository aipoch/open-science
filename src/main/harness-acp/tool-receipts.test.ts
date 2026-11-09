import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { HarnessToolReceipts } from './tool-receipts'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const query = { invocationId: 'invocation', name: 'repl_execute', arguments: { code: 'return 1' } }
const result = { content: [{ type: 'text' as const, text: 'completed effect' }] }
async function fixture(): Promise<{ root: string; receipts: HarnessToolReceipts }> {
  const root = await mkdtemp(join(tmpdir(), 'harness-receipts-'))
  roots.push(root)
  return { root, receipts: new HarnessToolReceipts(root) }
}
it('reopens completed evidence and isolates session, invocation and argument identities', async () => {
  const { root, receipts } = await fixture()
  await receipts.begin('session', query)
  expect(await receipts.read('session', query)).toEqual({ status: 'unknown' })
  await receipts.complete('session', query, result)
  expect(await new HarnessToolReceipts(root).read('session', query)).toEqual({
    status: 'completed',
    result
  })
  expect(await receipts.read('other', query)).toEqual({ status: 'unknown' })
  expect(await receipts.read('session', { ...query, invocationId: 'other' })).toEqual({
    status: 'unknown'
  })
  await expect(
    receipts.read('session', { ...query, arguments: { code: 'return 2' } })
  ).rejects.toThrow('identity mismatch')
  await expect(receipts.begin('session', query)).rejects.toThrow()
})
it('admits a concurrent invocation once and fails closed on damaged evidence', async () => {
  const { root, receipts } = await fixture()
  const results = await Promise.allSettled([
    receipts.begin('session', query),
    new HarnessToolReceipts(root).begin('session', query)
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  await receipts.complete('session', query, result)
  const scope = (await readdir(root))[0],
    invocation = (await readdir(join(root, scope)))[0]
  await writeFile(join(root, scope, invocation, 'result.json'), '{')
  await expect(receipts.read('session', query)).rejects.toThrow()
  await expect(receipts.begin('session', query)).rejects.toThrow()
})
it('rejects unclaimed or mismatched completion and invalid metadata', async () => {
  const { receipts } = await fixture()
  await expect(receipts.complete('session', query, result)).rejects.toThrow()
  await receipts.begin('session', query)
  await expect(
    receipts.complete('session', { ...query, name: 'another_tool' }, result)
  ).rejects.toThrow('identity mismatch')
  await expect(receipts.begin('session', { ...query, invocationId: '' })).rejects.toThrow()
})
