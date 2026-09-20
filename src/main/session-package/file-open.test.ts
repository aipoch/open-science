import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { PackageFileOpenRelay, packagePathsFromArgv } from './file-open'

describe('OS package file handoff', () => {
  it('retains early file events, deduplicates them, and delivers later events immediately', () => {
    const open = vi.fn()
    const overflow = vi.fn()
    const relay = new PackageFileOpenRelay(overflow)
    relay.receive('/research.science')
    relay.receive('/research.science')
    relay.receive('/unrelated.txt')
    expect(open).not.toHaveBeenCalled()
    relay.bind(open)
    relay.receive('/next.science')
    expect(open.mock.calls).toEqual([['/research.science'], ['/next.science']])
    expect(overflow).not.toHaveBeenCalled()
  })

  it('bounds startup requests and reports overflow when the UI becomes available', () => {
    const open = vi.fn()
    const overflow = vi.fn()
    const relay = new PackageFileOpenRelay(overflow)
    for (let i = 0; i < 30; i++) relay.receive(`/research-${i}.science`)
    expect(overflow).not.toHaveBeenCalled()
    relay.bind(open)
    expect(open).toHaveBeenCalledTimes(16)
    expect(overflow).toHaveBeenCalledOnce()
  })

  it('ignores package arguments when the environment enables web mode', () => {
    vi.stubEnv('OPEN_SCIENCE_WEB_PORT', '44100')
    try {
      expect(packagePathsFromArgv(['open-science', 'study.science'], '/sender')).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('uses the launching working directory and preserves spaces and Unicode without shell parsing', () => {
    expect(
      packagePathsFromArgv(
        [
          'open-science',
          'study results.science',
          '研究.SCIENCE',
          '--flag.science',
          'https://example.com/file.science'
        ],
        '/sender'
      )
    ).toEqual([resolve('/sender', 'study results.science'), resolve('/sender', '研究.SCIENCE')])
    expect(packagePathsFromArgv(['open-science', '--serve', 'study.science'], '/sender')).toEqual(
      []
    )
  })
})
