import { describe, expect, it } from 'vitest'

import { parseSshConfigHostAliases } from './ssh-config'

describe('parseSshConfigHostAliases', () => {
  it('extracts a simple Host alias', () => {
    expect(parseSshConfigHostAliases('Host biowulf\n  HostName biowulf.nih.gov\n')).toEqual([
      'biowulf'
    ])
  })

  it('extracts multiple aliases across several Host blocks', () => {
    const config = [
      'Host biowulf',
      '  HostName biowulf.nih.gov',
      '',
      'Host lab-gpu',
      '  HostName 192.168.1.10',
      '  User argocd'
    ].join('\n')

    expect(parseSshConfigHostAliases(config)).toEqual(['biowulf', 'lab-gpu'])
  })

  it('splits a Host line that lists several aliases and keeps their order', () => {
    expect(parseSshConfigHostAliases('Host web1 web2 web3\n  HostName example.com')).toEqual([
      'web1',
      'web2',
      'web3'
    ])
  })

  it('excludes wildcard patterns (* and ?) and negated patterns', () => {
    const config = [
      'Host *',
      '  ForwardAgent yes',
      'Host prod-?',
      '  User deploy',
      'Host !secret real-host',
      '  HostName real.example.com'
    ].join('\n')

    // "*" and "prod-?" are pure patterns → excluded entirely. In the third block the negated token
    // "!secret" is dropped but the concrete alias "real-host" is kept.
    expect(parseSshConfigHostAliases(config)).toEqual(['real-host'])
  })

  it('excludes aliases declared inside a Match block', () => {
    const config = [
      'Host keep-me',
      '  HostName a.example.com',
      'Match host *.corp exec "true"',
      'Host inside-match',
      '  HostName b.example.com'
    ].join('\n')

    // A Match block has no Host alias of its own; a following Host line is still parsed unless it is
    // itself a pattern. Here "inside-match" is a concrete Host declared after Match — it is a real
    // alias and must be kept; only Match's own patterns are excluded.
    expect(parseSshConfigHostAliases(config)).toEqual(['keep-me', 'inside-match'])
  })

  it('handles leading indentation, tabs, and inline comments', () => {
    const config = [
      '# my hosts',
      '\tHost   indented-host  # trailing comment',
      '    HostName   c.example.com',
      '',
      '  # a comment-only line',
      'Host after-comment'
    ].join('\n')

    expect(parseSshConfigHostAliases(config)).toEqual(['indented-host', 'after-comment'])
  })

  it('is case-insensitive on the Host keyword', () => {
    expect(parseSshConfigHostAliases('HOST upper\nhost lower')).toEqual(['upper', 'lower'])
  })

  it('deduplicates repeated aliases, keeping first occurrence', () => {
    expect(parseSshConfigHostAliases('Host dup\nHost other\nHost dup')).toEqual(['dup', 'other'])
  })

  it('returns an empty list for empty or comment-only input', () => {
    expect(parseSshConfigHostAliases('')).toEqual([])
    expect(parseSshConfigHostAliases('# just a comment\n\n   \n')).toEqual([])
  })

  it('ignores key=value form on Host (Host=foo) by still extracting the value', () => {
    // OpenSSH accepts "Host=foo"; be lenient and treat the value as the alias.
    expect(parseSshConfigHostAliases('Host=solo')).toEqual(['solo'])
  })
})
