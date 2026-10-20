import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  buildSensitiveContentEvidence,
  findSensitivePackageText,
  isPrivatePackageValue,
  PackageTextScanner
} from './sensitive-content'

describe('quoted punctuation in parser diagnostics', () => {
  const diagnostic = "SyntaxError: Unexpected token ':' while parsing 'LDHA'"

  it.each([
    diagnostic,
    "SyntaxError: Unexpected token '=' while parsing 'LDHA'",
    'SyntaxError: Unexpected token ":" while parsing "LDHA"',
    ...Array.from({ length: 4 }, (_, depth) => {
      let text = JSON.stringify([
        "SyntaxError: Unexpected token ':'",
        "Let's inspect protein_annotation",
        'const r = await host.mcp("protein_annotation", "hpa_tissue_expression_summary", { gene: "LDHA" });'
      ])
      for (let layer = 0; layer < depth; layer++) text = JSON.stringify({ result: text })
      return text
    })
  ])('does not interpret a quoted colon as an assignment: %s', (text) => {
    expect(findSensitivePackageText(text)).toBeUndefined()
    for (let split = 0; split <= text.length; split++) {
      const scanner = new PackageTextScanner()
      scanner.write(text.slice(0, split))
      scanner.write(text.slice(split))
      expect(scanner.finish(), `split ${split}`).toBeUndefined()
    }
  })

  it.each([
    "'token': 'synthetic-private-value'",
    '"token": "synthetic-private-value"',
    "token: ':'",
    "token':synthetic-private-value",
    `${diagnostic}\ntoken=synthetic-private-value`,
    `${diagnostic}\n'password': 'synthetic-private-value'`
  ])('continues scanning actual assignments: %s', (text) => {
    expect(findSensitivePackageText(text)).toBeDefined()
    for (let split = 0; split <= text.length; split++) {
      const scanner = new PackageTextScanner()
      scanner.write(text.slice(0, split))
      scanner.write(text.slice(split))
      expect(scanner.finish(), `split ${split}`).toBeDefined()
    }
  })

  it('preserves diagnostic handling at every retained-overlap alignment', () => {
    for (let shift = -5; shift <= 1; shift++) {
      const text =
        ' '.repeat(65536 - 8192 - diagnostic.indexOf('token') + shift) +
        diagnostic +
        ' '.repeat(8192)
      const scanner = new PackageTextScanner()
      scanner.write(text.slice(0, 65536))
      scanner.write(text.slice(65536))
      expect(scanner.finish(), `overlap shift ${shift}`).toBeUndefined()
    }
  })
})

describe('package text policy', () => {
  it.each([
    'noCredentials',
    'hasCredentials',
    'authentication',
    'authorization',
    'cookie',
    'apiKey',
    'no-authorization',
    'has-cookie',
    'no-api-key'
  ])('accepts boolean member types without allowlisting the %s key', (key) => {
    for (const value of ['true', 'false']) {
      for (const text of [
        `{"${key}":${value}}`,
        `{"nested":[{"${key}" : ${value},"result":"ok"}]}`,
        `{\n "${key}"\t:\r\n ${value} \t\r\n}`,
        `{"${key}":${value}}\n{"${key}":${value},"result":"ok"}\n`
      ]) {
        expect(findSensitivePackageText(text), text).toBeUndefined()
        for (let end = 1; end < text.length; end++)
          expect(
            findSensitivePackageText(text.slice(0, end), false),
            `prefix ${end}: ${text}`
          ).toBeUndefined()
      }
    }
    for (const value of [
      '"true"',
      '"false"',
      '"synthetic-private-value"',
      '123456',
      'trueSecret',
      'falseSecret',
      'true || secret',
      'False'
    ])
      expect(findSensitivePackageText(`{"${key}":${value}}`), value).toBeDefined()
    for (const text of [
      `${key}=true`,
      `${key}: false`,
      `'${key}': true`,
      `--${key} true`,
      `{"${key}":true`,
      `{"${key}":false `,
      `{"${key}":true,"password":"synthetic-private-value"}`,
      `{"${key}":false}\npassword=synthetic-private-value`,
      `{"${key}":true,"token":123456}`,
      `{"${key}":false,"note":"Bearer synthetic-private-value"}`,
      `"${key}": true, actual-secret`,
      `{\\"${key}":true}`,
      `{"${key}":os.environ["VALUE"]}`,
      `{"${key}"=true}`,
      `{"${key}":true\u00a0}`,
      `{"${key}":true${' '.repeat(9000)}secret}`
    ])
      expect(findSensitivePackageText(text), text.slice(0, 100)).toBeDefined()
  })

  it.each([
    '{"noCredentials":true}',
    '{"noCredentials":false,"result":"ok"}',
    '{"metadata":{"noCredentials":true},"result":"ok"}',
    '{"noCredentials":true}\n{"noCredentials":false}\n'
  ])('does not classify boolean research metadata as a credential: %s', (text) => {
    expect(findSensitivePackageText(text)).toBeUndefined()
  })
  it.each(['true', 'false'])('defers incomplete boolean metadata %s', (value) => {
    const text = `{"noCredentials":${value},"result":"ok"}`
    for (let length = 1; length < text.length; length++)
      expect(
        findSensitivePackageText(text.slice(0, length), false),
        `prefix length ${length}`
      ).toBeUndefined()
    expect(findSensitivePackageText(text)).toBeUndefined()
  })
  it.each([
    '{"noCredentials":"true"}',
    '{"noCredentials":"false"}',
    '{"noCredentials":"synthetic-private-value"}',
    '{"noCredentials":123456}',
    '{"noCredentials":true,"apiKey":"synthetic-private-value"}',
    '{"noCredentials":true}\n{"apiKey":"synthetic-private-value"}\n'
  ])('still blocks credentials alongside or in place of boolean metadata: %s', (text) => {
    expect(findSensitivePackageText(text)).toBeDefined()
  })
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
    '{"inputTokens":"1024"}',
    '{"estimatedTokens":71862,"difference":16335}',
    '{"tokens":0,"estimated":true}',
    '{"tokens" : 88197 }',
    '{"cacheTokens":123456}',
    '{"cachedReadTokens":123456}',
    '{"cachedWriteTokens":0}',
    'one-token bluffs. A hyphenated phrase is not a command-line flag.',
    'prefix--token value is not a standalone command-line flag.',
    'café-token valeur is not a standalone command-line flag.',
    'cafe\u0301-token valeur is not a standalone command-line flag.',
    '研究-token 内容 is not a standalone command-line flag.',
    'naïve--token example is not a standalone command-line flag.'
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
    '{"token":123456}',
    '{"apiKey":123456}',
    '{"estimatedTokens":"synthetic-private-value"}',
    '{"tokens":"123456"}',
    '{"tokens":123456secret}',
    '{"tokens":-1}',
    '{"tokens":1.5}',
    '{"tokens":123',
    'tokens=123456',
    'estimatedTokens=123456',
    '{"tokens":123,"password":"synthetic-private-value"}',
    '{"estimatedTokens":123,"tokens":"synthetic-private-value"}',
    '{"pass\\u0077ord":"synthetic-private-value"}',
    'password = os.environ["PASSWORD"]',
    'curl --token synthetic-private-value',
    'curl -token synthetic-private-value',
    '研究：--token synthetic-private-value',
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
  it.each(['cacheTokens', 'cachedReadTokens', 'cachedWriteTokens'])(
    'limits the %s exception to exact JSON integer metrics',
    (key) => {
      for (const count of [0, 123456, Number.MAX_SAFE_INTEGER])
        expect(findSensitivePackageText(`{"${key}" : ${count} }`)).toBeUndefined()
      for (const value of [
        '"123456"',
        '"synthetic-private-value"',
        '-1',
        '1.5',
        '9007199254740992',
        '123456secret'
      ])
        expect(findSensitivePackageText(`{"${key}":${value}}`)).toBeDefined()
      for (const text of [
        `{"${key}":123`,
        `${key}=123456`,
        `--${key} 123456`,
        `{"${key[0].toUpperCase() + key.slice(1)}":123456}`,
        `{"${key}Secret":123456}`,
        `{"${key}":123,"password":"synthetic-private-value"}`
      ])
        expect(findSensitivePackageText(text), text).toBeDefined()
    }
  )
  it('treats object-field values consistently', () => {
    expect(isPrivatePackageValue('')).toBe(false)
    expect(isPrivatePackageValue(' [redacted] ')).toBe(false)
    expect(isPrivatePackageValue('Bearer [redacted]')).toBe(false)
    expect(isPrivatePackageValue('[redacted]extra')).toBe(true)
  })
})

it.each([
  ['{"noCredentials":true}', false],
  ['{"noCredentials":false}\n{"noCredentials":true}\n', false],
  ['{\n "metadata": {"noCredentials":false}\n}', false],
  ['{"authorization":true,"cookie":false,"api-key":true}', false],
  ['{"noCredentials":"true"}', true],
  ['{"noCredentials":123}', true],
  ['{"noCredentials":true,"password":"synthetic-private-value"}', true],
  ['{"password":"synthetic-private-value","password":true}', true],
  ['{"noCredentials":true,"note":"password=synthetic-private-value"}', true],
  ['{"noCredentials":true,"note":"ghp_syntheticprivatevalue"}', true],
  ['{"noCredentials":true,"note":"https://example.org/?token=true"}', true],
  ['{"noCredentials":true}\npassword=synthetic-private-value', true],
  ['{"noCredentials":true,}', true],
  ['{"noCredentials":true', true],
  ['{"noCredentials":tru}', true],
  ['{"noCredentials":trueSuffix}', true],
  ['{"noCredentials":TRUE}', true],
  ["{'noCredentials':true}", true],
  ['noCredentials=true', true],
  ['{"noCredentials":true} garbage', true],
  ['{"noCredentials":true}\n{"result":}', true],
  ['{"noCredentials":true}\n{"password":os.environ["PASSWORD"]}', true]
] as const)('preserves boolean policy across every stream split: %s', (text, blocked) => {
  expect(Boolean(findSensitivePackageText(text))).toBe(blocked)
  for (let split = 0; split <= text.length; split++) {
    const scanner = new PackageTextScanner()
    scanner.write(text.slice(0, split))
    scanner.write(text.slice(split))
    expect(Boolean(scanner.finish()), `split ${split}`).toBe(blocked)
  }
})

it.each(['noCredentials', 'authorization', 'no-authorization', 'has-cookie', 'no-api-key'])(
  'keeps boolean %s metadata safe at every overlap alignment',
  (key) => {
    for (let shift = -key.length; shift <= 1; shift++) {
      const text =
        ' '.repeat(65536 - 8192 - 2 + shift) + `{"${key}":true,"notes":"${'a'.repeat(8192)}"}`
      expect(findSensitivePackageText(text)).toBeUndefined()
      const scanner = new PackageTextScanner()
      scanner.write(text.slice(0, 65536))
      scanner.write(text.slice(65536))
      expect(scanner.finish(), `overlap shift ${shift}`).toBeUndefined()
    }
  }
)

it.each(['true', 'false', '"true"', '"synthetic-private-value"', '123456'])(
  'preserves the value type after an overlap-truncated key: %s',
  (value) => {
    for (const shift of [-2, 0]) {
      const prefix = ' '.repeat(65536 - 8192 - 2 + shift) + '{"noCredentials":'
      const text = prefix + ' '.repeat(9000) + value + '}'
      const scanner = new PackageTextScanner()
      scanner.write(text.slice(0, 65536))
      scanner.write(text.slice(65536))
      expect(Boolean(scanner.finish())).toBe(value !== 'true' && value !== 'false')
    }
  }
)

it('reports the actual later credential with its original stream offset', () => {
  const prefix = '{"noCredentials":true}\n' + ' '.repeat(70000)
  const secret = '{"apiKey":"synthetic-private-value"}\n'
  const text = prefix + secret
  const scanner = new PackageTextScanner()
  for (let start = 0; start < text.length; start += 65536)
    scanner.write(text.slice(start, start + 65536))
  const result = scanner.finish()!
  expect(result.match).toMatchObject({ rule: 'field', label: '"apiKey"' })
  expect(result.offset + result.match.offset).toBe(prefix.length + 1)
  expect(
    result.text.slice(
      result.match.valueOffset,
      result.match.valueOffset! + result.match.valueLength!
    )
  ).toBe('synthetic-private-value')
})

it('hashes and measures the sensitive value instead of the detector span', () => {
  const text = '{"apiKey":"secret-value"}'
  const match = findSensitivePackageText(text)
  expect(match).toMatchObject({ rule: 'field', valueLength: 'secret-value'.length })
  expect(match).toBeDefined()
  const evidence = buildSensitiveContentEvidence(text, match!, 'records.json @0')
  expect(text.slice(match!.valueOffset, match!.valueOffset! + match!.valueLength!)).toBe(
    'secret-value'
  )
  expect(evidence.valueLength).toBe('secret-value'.length)
  expect(evidence.valueHash).toBe(createHash('sha256').update('secret-value').digest('hex'))
  expect(evidence.matchLength).toBeGreaterThan(evidence.valueLength!)
})

it('locates credentials in JSON-escaped URL authorities', () => {
  const text = String.raw`https:\/\/[redacted]:secret-value@example.org`
  const match = findSensitivePackageText(text)
  expect(match).toMatchObject({ rule: 'url', valueLength: 'secret-value'.length })
  expect(text.slice(match!.valueOffset, match!.valueOffset! + match!.valueLength!)).toBe(
    'secret-value'
  )
})

it.each([
  'https://example.org/#token=secret-value',
  'https://example.org/#view?token=secret-value'
])('scans sensitive query values in URL fragments: %s', (text) => {
  const match = findSensitivePackageText(text)
  expect(match).toMatchObject({ rule: 'url', valueLength: 'secret-value'.length })
  expect(text.slice(match!.valueOffset, match!.valueOffset! + match!.valueLength!)).toBe(
    'secret-value'
  )
})

it('keeps oversized detector spans within the operation contract bounds', () => {
  const text = `apiKey=${'a'.repeat(12_000)}`
  const match = findSensitivePackageText(text)
  expect(match).toBeDefined()
  const evidence = buildSensitiveContentEvidence(text, match!, 'objects/result.json @0')
  expect(evidence.matchLength).toBe(10_000)
  expect(evidence.valueLength).toBeUndefined()
  expect(evidence.valueHash).toMatch(/^[a-f0-9]{64}$/)
})

it('keeps matched values out of location errors', async () => {
  const { PackageSensitiveContentError } = await import('./sensitive-content')
  const error = new PackageSensitiveContentError('file?token=synthetic-private-value', 'url')
  expect(error.message).not.toContain('synthetic-private-value')
  expect(error.location).toContain('[redacted]')
})

it.each([
  '{"estimatedTokens":71862,"difference":16335}',
  '{"tokens":88197,"estimated":true}',
  '{"cacheTokens":123456,"cachedReadTokens":123456,"cachedWriteTokens":0}',
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

it.each([1, 2, 3, 4])('recognizes redacted Bearer values through %i JSON layers', (depth) => {
  let text = JSON.stringify({ authorization: 'Bearer [redacted]' })
  for (let layer = 0; layer < depth; layer++) text = JSON.stringify({ result: text })
  expect(findSensitivePackageText(text)).toBeUndefined()
  for (let length = 1; length < text.length; length++)
    expect(
      findSensitivePackageText(text.slice(0, length), false),
      `prefix ${length}`
    ).toBeUndefined()

  const secret = text.replace('[redacted]', 'synthetic-private-value')
  const match = findSensitivePackageText(secret)
  expect(match).toBeDefined()
  expect(buildSensitiveContentEvidence(secret, match!, 'records.json').context).not.toContain(
    'synthetic-private-value'
  )
  expect(findSensitivePackageText(text + '\npassword=synthetic-private-value')).toBeDefined()

  for (const suffix of ['suffix', '\\', '"suffix', '\\"suffix']) {
    let literal = JSON.stringify({ note: `Bearer [redacted]${suffix}` })
    for (let layer = 0; layer < depth; layer++) literal = JSON.stringify({ result: literal })
    expect(findSensitivePackageText(literal), `literal suffix ${suffix}`).toBeDefined()
  }
})

it.each([
  'Bearer [redacted]' + '\\'.repeat(7),
  'Bearer [redacted]' + '\\'.repeat(7) + 'suffix',
  JSON.stringify({ authorization: 'Bearer [redacted]\\' }),
  JSON.stringify({ note: 'Bearer [redacted]\\' }),
  JSON.stringify({ note: 'Bearer [redacted]"suffix' }),
  JSON.stringify({ result: JSON.stringify({ authorization: 'Bearer [redacted]suffix' }) })
])('does not treat literal credential suffixes as serialization: %s', (text) => {
  expect(findSensitivePackageText(text)).toBeDefined()
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

it.each([
  'https://user:password@host/...',
  'http://user:password@host/...',
  '`https://user:password@host/...`',
  String.raw`https:\/\/user:password@host/...`,
  'https://%75ser:pass%77ord@host/%2E%2E%2E'
])('accepts only the canonical explanatory URL across split reads: %s', (text) => {
  expect(findSensitivePackageText(text)).toBeUndefined()
  for (let split = 1; split < text.length; split++) {
    const scanner = new PackageTextScanner()
    scanner.write(text.slice(0, split))
    scanner.write(text.slice(split))
    expect(scanner.finish(), `split ${split}`).toBeUndefined()
  }
})

it.each([
  'https://user:password@host/...extra',
  'https://user:password@host/real',
  'https://user:password@real.example/...',
  'https://user:actual-secret@host/...',
  'https://actual-user:password@host/...',
  'https://user:password@host:8443/...',
  'https://user:password@host/... ?token=actual-secret',
  'https://user:password@host/...?token=actual-secret',
  'https://user:password@host/...#token=actual-secret',
  'https://user:password@host/... Authorization: Bearer actual-secret',
  'https://user:password@host/',
  'https://user:password@h'
])('still detects credentials alongside or instead of the example: %s', (text) => {
  expect(findSensitivePackageText(text)).toBeDefined()
  for (let split = 1; split < text.length; split++) {
    const scanner = new PackageTextScanner()
    scanner.write(text.slice(0, split))
    scanner.write(text.slice(split))
    expect(scanner.finish(), `split ${split}`).toBeDefined()
  }
})
