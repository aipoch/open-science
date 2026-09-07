import { describe, expect, it } from 'vitest'
import { downloadFullText, fullTextUrl, isPublicFullTextAddress } from './full-text-download'

describe('full-text download boundary', () => {
  it('rejects local, credential-bearing, non-HTTPS, and alternate-port links', async () => {
    for (const url of [
      'file:///etc/passwd',
      'http://journal.example/paper.pdf',
      'https://localhost/paper.pdf',
      'https://127.0.0.1/paper.pdf',
      'https://[::1]/paper.pdf',
      'https://user:secret@journal.example/paper.pdf',
      'https://journal.example:8080/paper.pdf'
    ]) {
      await expect(downloadFullText(url, 100)).rejects.toThrow()
    }
    expect(fullTextUrl('https://journal.example/paper.pdf').hostname).toBe('journal.example')
  })
  it('rejects private and reserved DNS addresses', () => {
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '127.0.0.1',
      '172.16.1.2',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.1.2',
      '224.0.0.1',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1'
    ])
      expect(isPublicFullTextAddress(address)).toBe(false)
    expect(isPublicFullTextAddress('8.8.8.8')).toBe(true)
    expect(isPublicFullTextAddress('2606:4700:4700::1111')).toBe(true)
  })
})
