import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  buildSensitiveContentEvidence,
  findSensitivePackageText,
  isPrivatePackageField,
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
    'credentials',
    'authentication',
    'authorization',
    'cookie',
    'apiKey',
    'x-api-key',
    'x-amz-security-token'
  ])('accepts boolean members at the credential position %s', (key) => {
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
    const text = `{"credentials":${value},"result":"ok"}`
    for (let length = 1; length < text.length; length++)
      expect(
        findSensitivePackageText(text.slice(0, length), false),
        `prefix length ${length}`
      ).toBeUndefined()
    expect(findSensitivePackageText(text)).toBeUndefined()
  })
  it.each([
    '{"credentials":"true"}',
    '{"credentials":"false"}',
    '{"credentials":"synthetic-private-value"}',
    '{"credentials":123456}',
    '{"credentials":true,"apiKey":"synthetic-private-value"}',
    '{"credentials":true}\n{"apiKey":"synthetic-private-value"}\n'
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
    '{"estimatedTokens":"ghp_syntheticprivatevalue"}',
    '{"tokens":"123456"}',
    '{"tokens":123456secret}',
    '{"tokens":-1}',
    '{"tokens":1.5}',
    '{"tokens":123',
    'tokens=123456',
    '{"tokens":123,"password":"synthetic-private-value"}',
    '{"estimatedTokens":123,"tokens":"synthetic-private-value"}',
    '{"pass\\u0077ord":"synthetic-private-value"}',
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
  it('treats object-field values consistently', () => {
    expect(isPrivatePackageValue('')).toBe(false)
    expect(isPrivatePackageValue(' [redacted] ')).toBe(false)
    expect(isPrivatePackageValue('Bearer [redacted]')).toBe(false)
    expect(isPrivatePackageValue('[redacted]extra')).toBe(true)
  })
})

it.each([
  ['{"credentials":true}', false],
  ['{"credentials":false}\n{"credentials":true}\n', false],
  ['{\n "metadata": {"credentials":false}\n}', false],
  ['{"authorization":true,"cookie":false,"api-key":true}', false],
  ['{"credentials":"true"}', true],
  ['{"credentials":123}', true],
  ['{"credentials":true,"password":"synthetic-private-value"}', true],
  ['{"password":"synthetic-private-value","password":true}', true],
  ['{"credentials":true,"note":"password=synthetic-private-value"}', true],
  ['{"credentials":true,"note":"ghp_syntheticprivatevalue"}', true],
  ['{"credentials":true,"note":"https://example.org/?token=true"}', true],
  ['{"credentials":true}\npassword=synthetic-private-value', true],
  ['{"credentials":true,}', true],
  ['{"credentials":true', true],
  ['{"credentials":tru}', true],
  ['{"credentials":trueSuffix}', true],
  ['{"credentials":TRUE}', true],
  ["{'credentials':true}", true],
  ['credentials=true', true],
  ['{"credentials":true} garbage', true],
  ['{"credentials":true}\n{"result":}', true],
  ['{"credentials":true}\n{"password":os.environ["PASSWORD"]}', true]
] as const)('preserves boolean policy across every stream split: %s', (text, blocked) => {
  expect(Boolean(findSensitivePackageText(text))).toBe(blocked)
  for (let split = 0; split <= text.length; split++) {
    const scanner = new PackageTextScanner()
    scanner.write(text.slice(0, split))
    scanner.write(text.slice(split))
    expect(Boolean(scanner.finish()), `split ${split}`).toBe(blocked)
  }
})

it.each(['credentials', 'authorization', 'no-authorization', 'has-cookie', 'no-api-key'])(
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
      const prefix = ' '.repeat(65536 - 8192 - 2 + shift) + '{"credentials":'
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
  '{"modelMaxAccessTokens":50,"quota_remaining_refresh_tokens":12}',
  '{"cacheTokens":123456,"cachedReadTokens":123456,"cachedWriteTokens":0,"contextUsedTokens":42}',
  'Authorization: Bearer [redacted]',
  '--authorization Bearer [redacted]',
  'password="\\u005bredacted]"',
  'https://example.org/?token=%5Bredacted%5D',
  'password=%5Bredacted%5D',
  'password="  [redacted]  "',
  'Authorization: Bearer   [redacted]  ',
  String.raw`{"note":"\u0042earer [redacted]"}`,
  '{"password":"  [redacted]  "}'
])('does not reject any incomplete safe prefix: %s', (value) => {
  for (let length = 1; length < value.length; length++)
    expect(
      findSensitivePackageText(value.slice(0, length), false),
      `prefix length ${length}`
    ).toBeUndefined()
  expect(findSensitivePackageText(value)).toBeUndefined()
  for (let split = 0; split <= value.length; split++) {
    const scanner = new PackageTextScanner()
    scanner.write(value.slice(0, split))
    scanner.write(value.slice(split))
    expect(scanner.finish(), `split ${split}`).toBeUndefined()
  }
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

describe('Python loop headers in research code', () => {
  const code = 'for token in tokens:\n    groups.setdefault(find(token), []).append(token)'
  const serialized = JSON.stringify({ content: code })

  it.each([
    code,
    serialized,
    JSON.stringify({ snapshot: serialized }),
    'for name, value in tokens:\n    print(name, value)',
    'async for item in tokens:\n    print(item)'
  ])('accepts loop syntax across every stream split: %s', (text) => {
    expect(findSensitivePackageText(text)).toBeUndefined()
    for (let split = 0; split <= text.length; split++) {
      const scanner = new PackageTextScanner()
      scanner.write(text.slice(0, split))
      scanner.write(text.slice(split))
      expect(scanner.finish(), `split ${split}`).toBeUndefined()
    }
  })

  it('retains the loop prefix when the overlap starts inside the header', () => {
    for (let shift = -code.indexOf('tokens'); shift <= 6; shift++) {
      const text =
        ' '.repeat(65536 - 8192 - code.indexOf('tokens') + shift) + code + ' '.repeat(8192)
      const scanner = new PackageTextScanner()
      scanner.write(text.slice(0, 65536))
      scanner.write(text.slice(65536))
      expect(scanner.finish(), `overlap ${shift}`).toBeUndefined()
    }
  })

  it.each([
    'tokens: synthetic-private-value',
    'tokens=synthetic-private-value',
    "'tokens': 'synthetic-private-value'",
    'for token in tokens: password="synthetic-private-value"',
    'for token in tokens:\n    password="synthetic-private-value"',
    'for token in tokens:\n    print("ghp_syntheticprivatevalue")',
    'for token in tokens:\n    url="https://example.org/?token=synthetic-private-value"',
    'for token in tokens:\n    tokens="synthetic-private-value"'
  ])('still detects credentials in and around loops: %s', (code) => {
    for (const text of [code, JSON.stringify({ content: code })]) {
      expect(findSensitivePackageText(text)).toBeDefined()
      for (let split = 0; split <= text.length; split++) {
        const scanner = new PackageTextScanner()
        scanner.write(text.slice(0, split))
        scanner.write(text.slice(split))
        expect(scanner.finish(), `split ${split}`).toBeDefined()
      }
    }
  })
})

describe('noncredential syntax and metadata', () => {
  const safe = [
    'if token:\n    print(value)',
    'while tokens:\n    tokens.pop()',
    'if token:\n    print(value)\nwhile tokens:\n    tokens.pop()',
    'elif not token:\n    pass',
    'for (token, value) in tokens:\n    print(value)',
    'for (token,) in tokens:\n    print(token)',
    'for ( token , value ) in tokens:\n    print(value)',
    'token == expected',
    'token => value',
    'tokens = []',
    'tokens = []\npassword = os.environ["PASSWORD"]',
    'password["value"] = {}\npassword["value"] = os.environ["PASSWORD"]',
    'credentials = {}',
    'password = os.environ["PASSWORD"]\nprint(password)',
    'password = process.env.PASSWORD\r\nconsole.log(password)',
    'tokens = []\nprocessTokens(tokens)',
    'token == expected\nreport(token)',
    'password["value"] = {}',
    'tokens[0] = []',
    'password["value"] = os.environ["PASSWORD"]',
    'tokens[0] = process.env.API_TOKEN',
    '{"tokens":null}',
    '{"tokens":[]}',
    '{"credentials": { }}',
    '{"token_type":"Bearer"}',
    'password = os.environ["PASSWORD"]',
    "token = os.getenv('API_TOKEN')",
    'apiKey = process.env.API_KEY',
    'def parse(token: str):\n    return token',
    'const token: string;'
  ]
  it.each([...safe, ...safe.map((content) => JSON.stringify({ content }))])(
    'accepts proven noncredentials: %s',
    (text) => {
      expect(findSensitivePackageText(text)).toBeUndefined()
      for (let split = 0; split <= text.length; split++) {
        const scanner = new PackageTextScanner()
        scanner.write(text.slice(0, split))
        scanner.write(text.slice(split))
        expect(scanner.finish(), `split ${split}`).toBeUndefined()
      }
    }
  )
  it.each([
    '{"tokens":null',
    '{"tokens":["actual-secret"]}',
    '{"tokens":{"password":"actual-secret"}}',
    '{"token_type":"ghp_syntheticprivatevalue"}',
    '{"secretName":"ghp_syntheticprivatevalue"}',
    'token: str',
    'def parse(token: str = "actual-secret"): pass',
    'password = os.getenv("PASSWORD", "actual-secret")',
    'password = os.environ["PASSWORD"] + "actual-secret"',
    'if token: password="actual-secret"',
    'for (token, value) in tokens: password="actual-secret"',
    'token == expected; password="actual-secret"',
    'tokens = []; password="actual-secret"'
  ])('keeps literal or ambiguous credentials visible: %s', (text) => {
    expect(findSensitivePackageText(text)).toBeDefined()
    for (let split = 0; split <= text.length; split++) {
      const scanner = new PackageTextScanner()
      scanner.write(text.slice(0, split))
      scanner.write(text.slice(split))
      expect(scanner.finish(), `split ${split}`).toBeDefined()
    }
  })
})

it('checks export metadata values independently of their field names', () => {
  const cursor = 'opaque-cursor-7M2Q'
  const secret = 'ghp_syntheticprivatevalue'
  for (const key of [
    'page_token',
    'next_page_token',
    'next_page_tokens',
    'authMan',
    'tokenizer_token_index',
    'authPanelTitle',
    'secretName',
    'apiSecretName',
    'API_SECRET_NAME',
    'NEXT_PAGE_TOKEN',
    'clientToken',
    'jobContinuationToken',
    'reportSessionToken',
    'report.session.token',
    'provider.has.api.key',
    'reportSessionTokenValue',
    'providerHasApiKeyValue',
    'authorizationHeaderName',
    'providerHasSecretToken',
    'REPORT_SESSION_TOKEN',
    'worker_session_token',
    'database_secret',
    'APP_SECRET_KEY_LABEL',
    'credential_name',
    'hasCredentials',
    'no-api-key',
    'hasDatabasePassword',
    'providerHasApiKey',
    'database_requires_password',
    'modelMaxAccessTokens',
    'quota_remaining_refresh_tokens',
    'worker-supports-refresh-tokens',
    'reportPageToken',
    'pipelineSecretKeyLabel',
    'compassWord',
    'contextUsedTokens',
    'notes'
  ]) {
    const formats = [
      (value: string) => JSON.stringify({ [key]: value }),
      (value: string) => JSON.stringify({ content: `${key}=${value}` }),
      (value: string) => `https://example.org/results?${key}=${value}`,
      (value: string) => `--${key} ${value}`
    ]
    for (const format of formats) {
      if (key.includes(' ') && format === formats[3]) continue
      expect(findSensitivePackageText(format(cursor))).toBeUndefined()
      expect(findSensitivePackageText(format(secret))).toBeDefined()
    }
  }
  const encoded = String.raw`{"notes":["\u0067hp_syntheticprivatevalue"]}`
  const match = findSensitivePackageText(encoded)!
  expect(match).toBeDefined()
  expect(buildSensitiveContentEvidence(encoded, match, 'data.json').context).not.toContain(
    'syntheticprivatevalue'
  )
  expect(
    findSensitivePackageText('https://example.org/#next_page_token=Bearer%20opaque')
  ).toBeDefined()
  for (const key of [
    'signature_value',
    'sig-value',
    'X-Amz-Credential',
    'X-Goog-Credential',
    'X-Signature'
  ]) {
    expect(findSensitivePackageText('https://example.org/?' + key + '=opaque')).toBeUndefined()
    expect(findSensitivePackageText('https://example.org/?' + key + '=' + secret)).toBeDefined()
  }
  expect(findSensitivePackageText('authMan["password"]="private-value"')?.label).toBe('password')
  expect(findSensitivePackageText(`page_token=${cursor}&password=private-value`)?.label).toBe(
    'password'
  )
})

it('keeps the complete metadata key when a file scan resumes inside its name', () => {
  for (const [source, sensitive] of [
    [JSON.stringify({ next_page_token: 'cursor' }), false],
    [JSON.stringify({ content: 'search\npage_token=cursor' }), false],
    ['https://example.org/?%70age_token=cursor', false],
    ['access_token=private-value', true]
  ] as const) {
    const text = source + 'x'.repeat(9000)
    for (let offset = 0; offset < source.length; offset++) {
      const split = offset + 8192
      const scanner = new PackageTextScanner()
      scanner.write(text.slice(0, split))
      scanner.write(text.slice(split))
      expect(Boolean(scanner.finish()), `${source} at ${offset}`).toBe(sensitive)
    }
  }
})

it('preserves the tokens value type when the scan window starts at the key', () => {
  for (const tokens of [123, 'opaque']) {
    const text = JSON.stringify({ tokens, notes: 'x'.repeat(9000) })
    const split = text.indexOf('tokens') + 8192
    const scanner = new PackageTextScanner()
    scanner.write(text.slice(0, split))
    scanner.write(text.slice(split))
    const expected = typeof tokens === 'string'
    expect(Boolean(findSensitivePackageText(text))).toBe(expected)
    expect(Boolean(scanner.finish())).toBe(expected)
  }
})

it('checks escapes in a long JSON string and reports the original source span', () => {
  const chunk = 64 * 1024
  const prefix = '{"notes":"'.padEnd(2 * chunk - 7, 'x') + '😀 '
  const token = String.raw`\u0067hp_syntheticprivatevalue`
  for (const escaped of [token, '\\' + token, String.raw`Bearer\u0020[redacted]`]) {
    const text = prefix + escaped + ' ' + 'x'.repeat(chunk) + '"}'
    const scanner = new PackageTextScanner()
    for (let i = 0; i < text.length; i += chunk) scanner.write(text.slice(i, i + chunk))
    const finding = scanner.finish()
    expect(Boolean(finding)).toBe(escaped === token)
    if (finding) {
      const { match, offset } = finding
      expect(offset + match.valueOffset!).toBe(prefix.length)
      expect(match.valueLength).toBe(token.length)
      expect(buildSensitiveContentEvidence(finding.text, match, 'data.json').context).not.toContain(
        'syntheticprivatevalue'
      )
    }
  }
})

it('keeps a decoded assignment through whitespace across reads in the same JSON string', () => {
  const gap = ' '.repeat(140000)
  const key = String.raw`\u0070assword`
  const opaque = String.raw`priv\u0061te-value`
  for (const [content, blocked] of [
    [key + gap + '=' + gap + opaque, true],
    [key + '=' + gap + '[redacted]', false],
    [key + '=' + gap + 'process.env.PASSWORD', false],
    [key + '=' + gap + '","' + opaque, false],
    [String.raw`report.session.\u0074oken` + '=' + gap + opaque, false]
  ] as const) {
    const text = '["' + content + '"]'
    const scanner = new PackageTextScanner()
    for (let i = 0; i < text.length; i += 65536) scanner.write(text.slice(i, i + 65536))
    const finding = scanner.finish()
    expect(Boolean(finding)).toBe(blocked)
    if (finding) {
      const { match, offset } = finding
      expect(offset + match.valueOffset!).toBe(text.indexOf(opaque))
      expect(buildSensitiveContentEvidence(finding.text, match, 'data.json').valueHash).toBe(
        createHash('sha256').update(opaque).digest('hex')
      )
    }
  }
})

it('scans complete escaped JSON strings even without a raw candidate', () => {
  const text = String.raw`{"notes":["\u0067hp_syntheticprivatevalue"]}`
  expect(findSensitivePackageText(text)).toBeDefined()
  const scanner = new PackageTextScanner()
  scanner.write(text)
  expect(scanner.finish()).toBeDefined()
})

it('recognizes the value type inside JSON quoted in a long string', () => {
  const chunk = 64 * 1024
  for (const tokens of [123, 'opaque']) {
    const text = JSON.stringify({
      notes: 'x'.repeat(125000) + ' ' + JSON.stringify({ tokens }) + ' ' + 'y'.repeat(chunk) + '\n'
    })
    const scanner = new PackageTextScanner()
    for (let i = 0; i < text.length; i += chunk) scanner.write(text.slice(i, i + chunk))
    expect(Boolean(scanner.finish())).toBe(typeof tokens === 'string')
  }
})

it('distinguishes numeric search patterns from PAT assignments across export chunks', () => {
  for (const [code, sensitive] of [
    ['const pats = ["0.59", "−0.03", "278"];', false],
    ['const pats=[redacted]"0.59","-0.03"];', false],
    ['const pats=["0.59","ghp_syntheticprivatevalue"];', true],
    ['const pats=[redacted]"0.59","ghp_syntheticprivatevalue"];', true],
    ['const pats=["0.59","278"', false],
    ['const pats=["0.59","278"] + privateValue;', false],
    ['const pats=["0.59","278"]; password="private-value"', true]
  ] as const) {
    for (const text of [code, JSON.stringify({ code })]) {
      for (let split = 0; split <= text.length; split++) {
        const scanner = new PackageTextScanner()
        scanner.write(text.slice(0, split))
        scanner.write(text.slice(split))
        expect(Boolean(scanner.finish()), `${code} at ${split}`).toBe(sensitive)
      }
    }
  }
})

it.each([
  ['os.environ["PASSWORD"]', ' + "actual-secret"'],
  ['os.getenv("PASSWORD")', ' or "actual-secret"'],
  ['process.env.PASSWORD', ' || "actual-secret"'],
  ['process.env.PASSWORD\n', ' + "actual-secret"'],
  ['[', '"actual-secret"]']
])('retains an unfinished assignment beyond the overlap: %s', (prefix, suffix) => {
  // The provisional exemption must expire well before the 8192-character overlap.
  expect(findSensitivePackageText(`password = ${prefix}` + ' '.repeat(513), false)).toBeDefined()
  const first = ' '.repeat(65536 - `password = ${prefix}`.length) + `password = ${prefix}`
  const text = first + ' '.repeat(16384) + suffix
  expect(findSensitivePackageText(text)).toBeDefined()
  for (const size of [1, 511, 8192, 65536]) {
    const scanner = new PackageTextScanner()
    scanner.write(first)
    for (let at = first.length; at < text.length; at += size)
      scanner.write(text.slice(at, at + size))
    expect(scanner.finish(), `chunk size ${size}`).toBeDefined()
  }
})

it.each([
  'password == "actual-secret"',
  'token === "actual-secret"',
  'password = {}\npassword["value"] = "actual-secret"',
  'tokens = []\ntokens[0] = "actual-secret"',
  'password["nested"]["value"] = "actual-secret"'
])('detects literal comparison operands and sensitive indexed writes: %s', (code) => {
  for (const text of [code, JSON.stringify({ content: code })]) {
    expect(findSensitivePackageText(text)).toBeDefined()
    for (let split = 0; split <= text.length; split++) {
      const scanner = new PackageTextScanner()
      scanner.write(text.slice(0, split))
      scanner.write(text.slice(split))
      expect(scanner.finish(), `split ${split}`).toBeDefined()
    }
  }
})

it.each([
  'password = process.env.PASSWORD',
  'password = os.environ["PASSWORD"]',
  'password = []',
  'credentials = {}',
  'token == expected'
])('retains literal expression continuations: %s', (prefix) => {
  for (const suffix of ['\n + "actual-secret"', '\r\n + "actual-secret"', ', "actual-secret"']) {
    const code = prefix + suffix
    for (const text of [code, JSON.stringify({ content: code })]) {
      expect(findSensitivePackageText(text)).toBeDefined()
      for (let split = 0; split <= text.length; split++) {
        const scanner = new PackageTextScanner()
        scanner.write(text.slice(0, split))
        scanner.write(text.slice(split))
        expect(scanner.finish(), `split ${split}`).toBeDefined()
      }
    }
  }
})

it.each([
  'and ("actual-secret")',
  'or ("actual-secret")',
  'if (condition) else "actual-secret"',
  'in ("actual-secret",)',
  'is ("actual-secret")',
  'instanceof ("actual-secret")',
  'as ("actual-secret")',
  'satisfies ("actual-secret")',
  '("actual-secret")',
  '["actual-secret"]',
  '`actual-secret`',
  'print(password); password = "actual-secret"'
])('keeps credentials after a newline visible: %s', (suffix) => {
  const code = 'password = process.env.PASSWORD\n' + suffix
  for (const text of [code, JSON.stringify({ content: code })]) {
    expect(findSensitivePackageText(text)).toBeDefined()
    for (let split = 0; split <= text.length; split++) {
      const scanner = new PackageTextScanner()
      scanner.write(text.slice(0, split))
      scanner.write(text.slice(split))
      expect(scanner.finish(), `split ${split}`).toBeDefined()
    }
  }
})

it('distinguishes authentication metadata from credential positions', () => {
  expect(isPrivatePackageField('auth_mode', 'custom-mode')).toBe(false)
  for (const key of ['api_key', 'clientSecret', 'OPENAI_API_KEY', 'accessToken', 'password'])
    expect(isPrivatePackageField(key, 'opaque-value')).toBe(true)
})

it.each(['api key', 'access token', 'client secret'])(
  'recognizes spaced credential key %s',
  (key) => {
    expect(isPrivatePackageField(key, 'opaque')).toBe(true)
    for (const text of [
      JSON.stringify({ [key]: 'opaque' }),
      key + '=opaque',
      'https://example.org/?' + encodeURIComponent(key) + '=opaque'
    ]) {
      expect(findSensitivePackageText(text)).toBeDefined()
    }
  }
)

it.each([
  'apiSecret',
  'api_secret',
  'api-secret',
  'API_SECRET',
  'ACME_SECRET_KEY',
  'sessionToken',
  'AWS_SESSION_TOKEN',
  'tenantOAuthSessionToken',
  'oauth.token',
  'my.oauth.token',
  'cookieValue',
  'db_password_value',
  'oauth-token-value',
  'authorizationHeader',
  'proxy.authorization.header',
  'req.headers.authorization',
  'JWT_SECRET',
  'tenantSigningSecret',
  'oauth_signature',
  'oidcSignature',
  'authenticationToken',
  'authorizationToken',
  'openai_api_key',
  'db_password',
  'warehouseAPIKey',
  'service-client-secret',
  'archive_private_key',
  'tenantRefreshToken',
  'tenantRefreshTokens',
  'secretToken',
  'DEPLOY_SECRET_TOKEN',
  'service-secret-tokens',
  'accessTokens',
  'githubToken',
  'hf_token',
  'backupPassphrase'
])('recognizes %s as a credential position', (key) => {
  expect(isPrivatePackageField(key, 'opaque')).toBe(true)
  const scanner = new PackageTextScanner()
  scanner.write(`{"${key}`)
  scanner.write('":"opaque"}')
  expect(scanner.finish()).toBeDefined()
  for (const text of [
    JSON.stringify({ [key]: 'opaque' }),
    `${key}=opaque`,
    `https://example.org/?${key}=opaque`,
    `--${key} opaque`
  ]) {
    expect(findSensitivePackageText(text)).toBeDefined()
  }
})
