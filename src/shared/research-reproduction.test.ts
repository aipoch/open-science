import { describe, expect, it, vi } from 'vitest'

import {
  compareResearchReproductionArchiveEntries,
  inspectResearchReproductionDescription,
  isPortableResearchReproductionPath,
  parseResearchReproductionDescription,
  RESEARCH_REPRODUCTION_FORMAT,
  RESEARCH_REPRODUCTION_MAX_BYTES,
  resolveResearchReproductionMaterials,
  validateResearchReproductionArchiveEntries,
  type ResearchReproductionArchiveEntry,
  type ResearchReproductionDescription,
  type ResearchReproductionMaterialCandidate,
  type ResearchReproductionMaterialResolution
} from './research-reproduction'

const digest = 'a'.repeat(64)
const file = (
  path = 'project/package.json'
): Extract<ResearchReproductionArchiveEntry, { type: 'file' }> => ({
  path,
  type: 'file' as const,
  sha256: digest,
  sizeBytes: 20
})
const fixture = (): ResearchReproductionDescription => ({
  format: RESEARCH_REPRODUCTION_FORMAT,
  descriptionVersion: 1,
  title: 'A fixed engineering snapshot',
  materials: [
    {
      key: 'source',
      role: 'source',
      availability: 'included',
      filename: 'source.tar.gz',
      sha256: digest,
      sizeBytes: 100,
      restorePath: 'source',
      archive: { format: 'tar.gz', entries: [{ path: 'project', type: 'directory' }, file()] },
      source: { repository: 'https://github.com/example/project', commit: 'b'.repeat(40) }
    }
  ],
  plans: [
    {
      key: 'smoke',
      title: 'Check engineering materials',
      scope: 'engineering-check',
      materialKeys: ['source'],
      claim: 'Checks engineering materials only.',
      limitations: ['Does not reproduce a scientific result.'],
      entrypoints: [
        { materialKey: 'source', path: 'project/package.json', arguments: ['--dry-run'] }
      ],
      requirements: {
        node: '>=22',
        platforms: ['darwin', 'linux'],
        lockfile: { materialKey: 'source', path: 'project/package.json' }
      }
    }
  ],
  parameters: [{ key: 'rounds', type: 'number', description: 'Requested rounds.', default: 1 }],
  secrets: [
    {
      key: 'provider-key',
      description: 'Receiver supplies this key.',
      required: true,
      environmentVariable: 'PROVIDER_API_KEY',
      planKeys: ['smoke']
    }
  ]
})

describe('optional reproduction description', () => {
  it('roundtrips ordinary JSON without mutating it or adding execution authority', () => {
    const description = fixture()
    const snapshot = JSON.stringify(description)
    expect(parseResearchReproductionDescription(snapshot)).toEqual({ status: 'valid', description })
    expect(JSON.stringify(description)).toBe(snapshot)
    expect(Object.keys(description)).not.toContain('recipeId')
  })

  it('distinguishes future optional content from invalid v1 content', () => {
    expect(
      inspectResearchReproductionDescription({
        format: RESEARCH_REPRODUCTION_FORMAT,
        descriptionVersion: 2,
        future: true
      })
    ).toEqual({ status: 'unsupported', version: 2 })
    for (const descriptionVersion of [0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])
      expect(
        inspectResearchReproductionDescription({ ...fixture(), descriptionVersion }).status
      ).toBe('invalid')
    expect(
      inspectResearchReproductionDescription({ ...fixture(), format: 'open-science-session' })
        .status
    ).toBe('invalid')
  })

  it.each(['value', 'default', 'token', 'credentialId', 'path'])(
    'rejects secret slot field %s rather than serializing a binding',
    (field) => {
      const description = fixture()
      Object.assign(description.secrets![0], { [field]: 'PRIVATE_SENTINEL' })
      const result = inspectResearchReproductionDescription(description)
      expect(result.status).toBe('invalid')
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL')
    }
  )

  it.each(['PATH', 'HOME', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'OPEN_SCIENCE_TOKEN'])(
    'rejects runtime-control secret slot %s',
    (environmentVariable) => {
      const description = fixture()
      description.secrets![0].environmentVariable = environmentVariable
      expect(inspectResearchReproductionDescription(description).status).toBe('invalid')
    }
  )

  it('validates parameter type, slot uniqueness and plan references', () => {
    const description = fixture()
    Object.assign(description.parameters![0], { default: 'one' })
    expect(inspectResearchReproductionDescription(description).status).toBe('invalid')
    const duplicate = fixture()
    duplicate.parameters!.push({
      key: 'provider-key',
      type: 'string',
      description: 'Not a second binding.'
    })
    expect(inspectResearchReproductionDescription(duplicate).status).toBe('invalid')
    const unknown = fixture()
    unknown.secrets![0].planKeys = ['missing']
    expect(inspectResearchReproductionDescription(unknown).status).toBe('invalid')
  })

  it.each([
    'https://user:secret@example.com/repo',
    'https://example.com/repo?token=secret',
    'https://example.com/repo#secret',
    'http://example.com/repo',
    'file:///home/user/repo'
  ])('rejects non-public source locator %s', (repository) => {
    const description = fixture()
    const material = description.materials[0]
    if (material.availability !== 'included') throw new Error('fixture')
    material.source!.repository = repository
    expect(inspectResearchReproductionDescription(description).status).toBe('invalid')
  })

  it.each(['main', 'latest', 'abc123', 'a'.repeat(41)])(
    'requires a complete commit identity: %s',
    (commit) => {
      const description = fixture()
      const material = description.materials[0]
      if (material.availability !== 'included') throw new Error('fixture')
      material.source!.commit = commit
      expect(inspectResearchReproductionDescription(description).status).toBe('invalid')
    }
  )

  it('rejects unknown material keys and undeclared entrypoints', () => {
    const unknown = fixture()
    unknown.plans[0].materialKeys = ['missing']
    expect(inspectResearchReproductionDescription(unknown).status).toBe('invalid')
    const outside = fixture()
    outside.plans[0].entrypoints![0].path = 'project/unlisted.js'
    expect(inspectResearchReproductionDescription(outside).status).toBe('invalid')
    const directory = fixture()
    directory.plans[0].entrypoints![0].path = 'project'
    expect(inspectResearchReproductionDescription(directory).status).toBe('invalid')
  })

  it('allows a single-file entrypoint and lockfile without inventing an inner path', () => {
    const description = fixture()
    description.materials = [
      {
        key: 'source',
        role: 'script',
        availability: 'included',
        filename: 'script.py',
        sha256: digest,
        sizeBytes: 10,
        restorePath: 'script.py'
      }
    ]
    description.plans[0].entrypoints = [{ materialKey: 'source' }]
    description.plans[0].requirements = { lockfile: { materialKey: 'source' } }
    expect(inspectResearchReproductionDescription(description).status).toBe('valid')
  })

  it('rejects duplicate material keys, plan keys and required references', () => {
    for (const mutate of [
      (value: ResearchReproductionDescription) => value.materials.push({ ...value.materials[0] }),
      (value: ResearchReproductionDescription) => value.plans.push({ ...value.plans[0] }),
      (value: ResearchReproductionDescription) => value.plans[0].materialKeys.push('source')
    ]) {
      const description = fixture()
      mutate(description)
      expect(inspectResearchReproductionDescription(description).status).toBe('invalid')
    }
  })

  it('keeps withheld declarations minimal and external references non-executable', () => {
    const description = fixture()
    description.materials.push({
      key: 'private-data',
      role: 'data',
      availability: 'withheld',
      description: 'Original observations are not shared.'
    })
    description.materials.push({
      key: 'remote',
      role: 'reference',
      availability: 'external',
      description: 'Available separately.',
      url: 'https://example.com/public'
    })
    description.plans[0].materialKeys.push('private-data', 'remote')
    expect(inspectResearchReproductionDescription(description).status).toBe('valid')
    Object.assign(description.materials[1], { filename: 'private-participant.csv' })
    expect(inspectResearchReproductionDescription(description).status).toBe('invalid')
  })
})

describe('bounded plain data', () => {
  it('rejects duplicate JSON keys including escaped equivalents without confusing string contents', () => {
    const json = JSON.stringify(fixture())
    expect(
      parseResearchReproductionDescription(json.replace('"title":', '"title":"first","title":'))
        .status
    ).toBe('invalid')
    expect(
      parseResearchReproductionDescription(
        json.replace('"title":', '"tit\\u006ce":"first","title":')
      ).status
    ).toBe('invalid')
    const description = fixture()
    description.title = 'Data with { "title": "text" } and [brackets]'
    expect(parseResearchReproductionDescription(JSON.stringify(description)).status).toBe('valid')
  })
  it.each(['__proto__', 'prototype', 'constructor'])(
    'rejects reserved JSON key %s at any depth',
    (name) => {
      const json = JSON.stringify(fixture()).replace('"title":', `"${name}":{},"title":`)
      expect(parseResearchReproductionDescription(json).status).toBe('invalid')
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    }
  )

  it('does not invoke accessors or custom serializers', () => {
    const get = vi.fn(() => 'private')
    const description = fixture()
    Object.defineProperty(description, 'title', { get, enumerable: true })
    expect(inspectResearchReproductionDescription(description).status).toBe('invalid')
    expect(get).not.toHaveBeenCalled()
    const toJSON = vi.fn()
    expect(inspectResearchReproductionDescription({ ...fixture(), toJSON }).status).toBe('invalid')
    expect(toJSON).not.toHaveBeenCalled()
  })

  it('rejects prototype-bearing, cyclic, deep, sparse and non-JSON input', () => {
    const cycle: Record<string, unknown> = {}
    cycle.child = cycle
    const deep = Array.from({ length: 26 }).reduce<unknown>((child) => ({ child }), null)
    for (const input of [
      new Date(),
      cycle,
      deep,
      new Array(3),
      undefined,
      { extra: NaN },
      { extra: 1n },
      Object.create({ inherited: true })
    ])
      expect(inspectResearchReproductionDescription(input).status).toBe('invalid')
    expect(parseResearchReproductionDescription('{').status).toBe('invalid')
  })

  it('enforces UTF-8 byte limits before accepting even a future description', () => {
    expect(
      parseResearchReproductionDescription(' '.repeat(RESEARCH_REPRODUCTION_MAX_BYTES + 1)).status
    ).toBe('invalid')
    expect(
      inspectResearchReproductionDescription({
        format: RESEARCH_REPRODUCTION_FORMAT,
        descriptionVersion: 2,
        payload: '中'.repeat(RESEARCH_REPRODUCTION_MAX_BYTES / 2)
      }).status
    ).toBe('invalid')
  })

  it('bounds array cardinality', () => {
    expect(
      validateResearchReproductionArchiveEntries(
        Array.from({ length: 10_001 }, (_, index) => ({ path: `d${index}`, type: 'directory' }))
      ).status
    ).toBe('invalid')
  })
})

describe('portable restore paths and archive inventories', () => {
  it.each([
    '',
    '.',
    '..',
    '/absolute',
    '../escape',
    'a/../b',
    'a//b',
    'a/',
    'C:/data',
    'C:\\data',
    '\\\\host\\share',
    'a\0b',
    'a\nb',
    'a\x7fb',
    'CON.txt',
    'com¹',
    'LPT².csv',
    'folder./x',
    'folder /x',
    'a:b',
    'a*',
    'a?'
  ])('rejects unsafe path %j', (path) => {
    expect(isPortableResearchReproductionPath(path)).toBe(false)
    expect(validateResearchReproductionArchiveEntries([file(path)]).status).toBe('invalid')
  })

  it('accepts portable Unicode and rejects no ordinary file just for a device-like prefix', () => {
    for (const path of [
      '研究/数据.csv',
      'café.csv',
      'COM10.txt',
      'COM¹-report.csv',
      '.config/value.json'
    ])
      expect(isPortableResearchReproductionPath(path)).toBe(true)
  })

  it.each([
    [file('a'), file('a')],
    [file('A'), file('a')],
    [file('café.csv'), file('cafe\u0301.csv')],
    [file('a'), file('a/b')],
    [file('a/b'), file('a')],
    [file('A/one'), file('a/two')],
    [{ path: 'a', type: 'directory' }, file('a')]
  ])('rejects duplicate, normalized or parent collisions %#', (...entries) => {
    expect(validateResearchReproductionArchiveEntries(entries).status).toBe('invalid')
  })

  it.each(['symlink', 'hardlink', 'fifo', 'socket', 'block-device'])(
    'rejects archive member type %s',
    (type) => {
      expect(
        validateResearchReproductionArchiveEntries([{ path: 'a', type, linkname: '../target' }])
          .status
      ).toBe('invalid')
    }
  )

  it('permits explicit directory headers and children in either order', () => {
    const directory = { path: 'a', type: 'directory' }
    expect(validateResearchReproductionArchiveEntries([directory, file('a/b')]).status).toBe(
      'valid'
    )
    expect(validateResearchReproductionArchiveEntries([file('a/b'), directory]).status).toBe(
      'valid'
    )
  })

  it('checks collisions across different materials, including paths inside archives', () => {
    const description = fixture()
    description.materials.push({
      key: 'override',
      role: 'configuration',
      availability: 'included',
      filename: 'config.json',
      sha256: digest,
      sizeBytes: 20,
      restorePath: 'source/project/package.json'
    })
    expect(inspectResearchReproductionDescription(description).status).toBe('invalid')
    const prefix = fixture()
    prefix.materials.push({
      key: 'ancestor',
      role: 'configuration',
      availability: 'included',
      filename: 'config.json',
      sha256: digest,
      sizeBytes: 20,
      restorePath: 'source'
    })
    expect(inspectResearchReproductionDescription(prefix).status).toBe('invalid')
  })

  it('limits individual and aggregate expanded bytes', () => {
    expect(
      validateResearchReproductionArchiveEntries([{ ...file(), sizeBytes: 32 * 1024 ** 3 + 1 }])
        .status
    ).toBe('invalid')
    expect(
      validateResearchReproductionArchiveEntries(
        Array.from({ length: 9 }, (_, index) => ({
          ...file(`f${index}`),
          sizeBytes: 32 * 1024 ** 3
        }))
      ).status
    ).toBe('invalid')
    expect(validateResearchReproductionArchiveEntries([{ ...file(), sizeBytes: -1 }]).status).toBe(
      'invalid'
    )
  })
})

describe('current research material resolution', () => {
  const candidate = (
    overrides: Partial<ResearchReproductionMaterialCandidate> = {}
  ): ResearchReproductionMaterialCandidate => ({
    researchId: 'import-new',
    artifactId: 'remapped-artifact',
    filename: 'source.tar.gz',
    sha256: digest,
    sizeBytes: 100,
    ...overrides
  })
  const resolve = (
    artifacts: ResearchReproductionMaterialCandidate[],
    description = fixture()
  ): ResearchReproductionMaterialResolution[] =>
    resolveResearchReproductionMaterials(description, { researchId: 'import-new', artifacts })

  it('resolves by immutable content after IDs and display names change', () => {
    expect(resolve([candidate({ filename: 'renamed.tar.gz' })])).toEqual([
      { key: 'source', status: 'available', artifactIds: ['remapped-artifact'] }
    ])
  })

  it('never fills a missing material from another research in the same catalog', () => {
    expect(resolve([candidate({ researchId: 'other-research' })])).toEqual([
      { key: 'source', status: 'missing' }
    ])
  })

  it('does not confuse matching names with matching evidence', () => {
    expect(resolve([candidate({ sha256: 'b'.repeat(64) })])).toEqual([
      { key: 'source', status: 'mismatch' }
    ])
    expect(resolve([candidate({ sizeBytes: 101 })])).toEqual([
      { key: 'source', status: 'mismatch' }
    ])
  })

  it('distinguishes excluded payloads and unprovided materials without seeking substitutes', () => {
    expect(resolve([candidate({ contentAvailable: false })])).toEqual([
      { key: 'source', status: 'missing' }
    ])
    const description = fixture()
    description.materials.push(
      { key: 'private', role: 'data', availability: 'withheld', description: 'Not shared.' },
      { key: 'remote', role: 'data', availability: 'external', description: 'Obtain separately.' }
    )
    expect(resolve([], description)).toEqual([
      { key: 'source', status: 'missing' },
      { key: 'private', status: 'withheld' },
      { key: 'remote', status: 'external' }
    ])
  })

  it('returns all identical verified aliases deterministically without selecting by filename', () => {
    expect(
      resolve([
        candidate({ artifactId: 'z' }),
        candidate({ artifactId: 'a' }),
        candidate({ artifactId: 'a' }),
        candidate({ artifactId: 'excluded', contentAvailable: false })
      ])
    ).toEqual([{ key: 'source', status: 'available', artifactIds: ['a', 'z'] }])
  })
})

describe('observed archive inventory comparison', () => {
  it('matches exact file identities with optional parent directory headers and reordered entries', () => {
    expect(
      compareResearchReproductionArchiveEntries(
        [{ path: 'a', type: 'directory' }, file('a/b'), file('a/c')],
        [file('a/c'), file('a/b')]
      )
    ).toEqual({ status: 'matched' })
  })

  it('rejects invalid declared or observed members', () => {
    expect(compareResearchReproductionArchiveEntries([file('../escape')], [file()]).status).toBe(
      'invalid'
    )
    expect(
      compareResearchReproductionArchiveEntries([file()], [{ path: 'link', type: 'symlink' }])
        .status
    ).toBe('invalid')
  })

  it('rejects a missing file, unlisted file, renamed file or altered bytes', () => {
    for (const entries of [
      [file(), file('additional')],
      [file('other-name')],
      [{ ...file(), sha256: 'b'.repeat(64) }],
      [{ ...file(), sizeBytes: 21 }],
      [{ path: 'project', type: 'directory' }]
    ])
      expect(compareResearchReproductionArchiveEntries([file()], entries).status).toBe('invalid')
  })

  it('rejects unexpected or missing empty directories', () => {
    expect(
      compareResearchReproductionArchiveEntries(
        [file()],
        [file(), { path: 'unlisted', type: 'directory' }]
      ).status
    ).toBe('invalid')
    expect(
      compareResearchReproductionArchiveEntries(
        [file(), { path: 'empty', type: 'directory' }],
        [file()]
      ).status
    ).toBe('invalid')
  })
})
