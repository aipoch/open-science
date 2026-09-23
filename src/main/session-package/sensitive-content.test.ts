import { describe, expect, it } from 'vitest'
import { findSensitivePackageText, isPrivatePackageValue } from './sensitive-content'

describe('package text policy', () => {
  it.each([
    'Authorization: Bearer [redacted]',
    '--authorization Bearer [redacted]',
    '{"authorization":"\\u005bredacted]"}',
    'password=[redacted]',
    '{"password":""}',
    "password = ''",
    'https://example.org/?token=',
    'https://example.org/?token=%5Bredacted%5D',
    'https://[example]',
    'file:///tmp/results.csv',
    '{"inputTokens":"1024"}'
  ])('accepts empty, redacted or noncredential text: %s', (value) => {
    expect(findSensitivePackageText(value)).toBeUndefined()
  })
  it.each([
    'Authorization: Bearer synthetic-private-value',
    'password:\n actual-secret',
    '--token\n actual-secret',
    'Bearer\n actual-secret',
    'Cookie: ; session=actual-secret',
    'password=synthetic-private-value',
    '{"password":"synthetic-private-value"}',
    'https://example.org/?token=synthetic-private-value',
    'https://[example]/?token=synthetic-private-value',
    'Authorization: Bearer [redacted]extra',
    'password=[redacted]extra',
    'https://example.org/?key=temperature',
    '{"token":"word"}',
    '{"pass\\u0077ord":"synthetic-private-value"}',
    'password = os.environ["PASSWORD"]',
    'curl --token synthetic-private-value',
    'https://user:synthetic-private-value@example.org/',
    'Bearer synthetic-private-value',
    'ghp_syntheticprivatevalue',
    'Authorization: [redacted]\npassword=synthetic-private-value'
  ])('retains credential and ambiguous-value blocking: %s', (value) => {
    expect(findSensitivePackageText(value)).toBeDefined()
  })
  it('defers values at an unfinished chunk boundary', () => {
    expect(findSensitivePackageText('Authorization: Bearer [red', false)).toBeUndefined()
    expect(findSensitivePackageText('Authorization: Bearer [redacted]', true)).toBeUndefined()
    expect(findSensitivePackageText('Authorization: Bearer actual-value\n', false)).toBeDefined()
  })
  it('treats object-field values consistently', () => {
    expect(isPrivatePackageValue('')).toBe(false)
    expect(isPrivatePackageValue(' [redacted] ')).toBe(false)
    expect(isPrivatePackageValue('Bearer [redacted]')).toBe(false)
    expect(isPrivatePackageValue('[redacted]extra')).toBe(true)
  })
})

it('keeps matched values out of location errors', async () => {
  const { PackageSensitiveContentError } = await import('./sensitive-content')
  const error = new PackageSensitiveContentError('file?token=synthetic-private-value', 'url')
  expect(error.message).not.toContain('synthetic-private-value')
  expect(error.location).toContain('[redacted]')
})

it.each([
  'Authorization: Bearer [redacted]',
  '--authorization Bearer [redacted]',
  'password="\\u005bredacted]"',
  'https://example.org/?token=%5Bredacted%5D',
  'password=%5Bredacted%5D'
])('does not reject any incomplete safe prefix: %s', (value) => {
  for (let length = 1; length < value.length; length++)
    expect(
      findSensitivePackageText(value.slice(0, length), false),
      `prefix length ${length}`
    ).toBeUndefined()
  expect(findSensitivePackageText(value)).toBeUndefined()
})

it('bounds scanning of malformed CLI quotes with long escape sequences', async () => {
  const { buildSync } = await import('esbuild')
  const { execFileSync } = await import('node:child_process')
  const { resolve } = await import('node:path')
  const bundled = buildSync({
    entryPoints: [resolve('src/main/session-package/sensitive-content.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false
  }).outputFiles[0].text
  // Exercise the real detector in a killable process: a synchronous regex can prevent a
  // Vitest timeout from firing. Include the CodeQL witness and actual credential flags.
  const probe = `${bundled}\n
const suffix = '\\\\!'.repeat(2000);
const inputs = ['-a="' + suffix + '\\n', '--password="' + suffix + '\\n', '--token "' + suffix + '"'];
process.stdout.write(JSON.stringify(inputs.map(value => Boolean(module.exports.findSensitivePackageText(value)))));
`
  expect(
    execFileSync(process.execPath, [], { input: probe, encoding: 'utf8', timeout: 5000 }).trim()
  ).toBe('[false,false,true]')
}, 15000)
