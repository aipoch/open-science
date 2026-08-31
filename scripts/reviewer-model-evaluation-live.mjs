#!/usr/bin/env electron
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Electron CLI validates runtime data. */
// Live, non-persistent model harness. Credentials are decrypted in memory and never logged or captured.
import { app, safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { CAPTURE_SCHEMA_VERSION, sealReviewerModelCapture } from './reviewer-model-evaluation.mjs'

const RUNNER_VERSION = '1.0.0'
const SYSTEM_PROMPT = `You are the Open Science Reviewer auditing exactly one completed Conversation Turn. Use only tool evidence. Trace, do not recompute or conduct research. Missing or unsupported evidence limits coverage and is not a finding. Rendered labels, pages, table values, and visible content require a matching content view. Method, execution, existence, and generation claims default to trace and must not open binary content. Submit exactly one accepted result with submit_findings and no prose afterward.`
const getArg = (name, fallback) => {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback
}
const repetitions = Number(getArg('runs', '1'))
const outputArgument = getArg('output', 'test/fixtures/reviewer-model-evaluation.json')
const requested = new Set(getArg('fixtures', '').split(',').filter(Boolean))
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
app.setName('Open Science (DEV)')

const turn = (claim, user = 'Complete the requested analysis.') => ({
  blocks: [
    { blockIndex: 0, id: 'user', kind: 'message', role: 'user', content: user },
    {
      blockIndex: 1,
      id: 'activity',
      kind: 'activity',
      sourceId: 'activity',
      title: 'Notebook Run',
      status: 'completed',
      fileEvidence: [
        {
          versionId: 'artifact-1',
          role: 'work_product',
          scopeReason: 'produced-by-turn',
          traceAvailable: true,
          contentAvailable: true
        }
      ]
    },
    {
      blockIndex: 2,
      id: 'agent',
      kind: 'message',
      role: 'agent',
      content: claim,
      artifactIds: ['artifact-1']
    }
  ]
})
const trace = (code, output = 'artifact-1') => ({
  kind: 'trace',
  versionId: 'artifact-1',
  producer: { activityId: 'activity', status: 'completed', code },
  inputs: [],
  outputs: [{ versionId: output, checksum: 'sha256:fixture' }],
  limitations: []
})
const makePlot = async () =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420"><rect width="720" height="420" fill="white"/><text x="360" y="34" text-anchor="middle" font-size="22">Treatment response</text><rect x="180" y="205" width="120" height="140" fill="#3b82f6"/><rect x="430" y="125" width="120" height="220" fill="#14b8a6"/><text x="25" y="220" text-anchor="middle" font-size="20" transform="rotate(-90 25 220)">Concentration (g)</text></svg>`
    )
  )
    .png()
    .toBuffer()
const plot = await makePlot()
const fixtures = [
  {
    id: 'image-method-result',
    instruction:
      'Audit only the method and numerical result claims. Attached is an existence claim, not a visible-content claim; do not read content.',
    turn: turn('I used a Welch t-test; p=0.031. The result figure is attached.'),
    trace: {
      ...trace("welch_t_test(values); plot(unit='mg')"),
      result: { test: 'Welch t-test', pValue: 0.031 }
    },
    content: {
      kind: 'image',
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${plot.toString('base64')}`
    }
  },
  {
    id: 'image-label-mismatch',
    instruction: 'Audit the agent claim and final visual.',
    turn: turn('The attached figure reports treatment concentration in mg.'),
    trace: trace("plot(unit='mg')"),
    content: {
      kind: 'image',
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${plot.toString('base64')}`
    }
  },
  {
    id: 'targeted-source',
    instruction: 'Audit the source attribution.',
    turn: turn(
      'Source-1 pages 4-5 require adults aged 18-65 and report an adjusted effect of 0.42 (95% CI 0.20-0.64).'
    ),
    trace: {
      kind: 'source-trace',
      versionId: 'source-1',
      role: 'source_document',
      limitations: []
    },
    content: {
      kind: 'document-pages',
      pages: [
        { page: 4, text: 'Eligibility: adults aged 18-65.' },
        { page: 5, text: 'Adjusted effect 0.42; 95% confidence interval 0.20 to 0.64.' }
      ],
      partial: true
    }
  },
  {
    id: 'csv-regression',
    instruction: 'Audit the generated CSV claims.',
    turn: turn('The generated CSV has three rows and mean value 12.'),
    trace: trace('write_csv([10,12,14])'),
    content: { kind: 'tabular', columns: { value: ['10', '12', '14'] }, rowCount: 3 }
  },
  {
    id: 'unsupported-binary',
    instruction: 'Audit the generation claim.',
    turn: turn(
      'Generated the requested binary output successfully.',
      'Generate an opaque binary output.'
    ),
    trace: trace("write_binary('artifact-1')"),
    content: { kind: 'unavailable', limitation: 'unsupported-format' }
  }
]

const tools = [
  {
    type: 'function',
    function: {
      name: 'read_turn',
      description: 'Read ordered blocks and evidence descriptors for this Turn.',
      parameters: { type: 'object', additionalProperties: false, properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_artifact',
      description:
        'Read trace or targeted content. Use trace for method, execution, existence, and generation. Content is mandatory for rendered labels, pages, and values; never open content merely because a file was generated.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'view'],
        properties: {
          id: { type: 'string' },
          view: { type: 'string', enum: ['trace', 'content'] },
          pages: { type: 'array', items: { type: 'integer' } }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'submit_findings',
      description: 'Submit the final review.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['checks'],
        properties: {
          checks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['status', 'claim', 'evidence'],
              properties: {
                status: { type: 'string', enum: ['pass', 'warn', 'fail'] },
                claim: { type: 'string' },
                evidence: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }
]
const decrypt = (keyRef) =>
  keyRef?.startsWith('plain:')
    ? Buffer.from(keyRef.slice(6), 'base64').toString('utf8')
    : keyRef?.startsWith('enc:')
      ? safeStorage.decryptString(Buffer.from(keyRef.slice(4), 'base64'))
      : undefined
const provider = async () => {
  const settings = JSON.parse(
      await readFile(join(homedir(), '.open-science-project/settings.json'), 'utf8')
    ),
    configured = settings.providers?.find(({ id }) => id === settings.activeProviderId),
    apiKey = decrypt(configured?.keyRef)
  if (!settings.activeModel || !configured || !apiKey)
    throw new Error('The active development model/provider credential is not configured.')
  if (configured.vendorId !== 'glmcodingplan')
    throw new Error(`Live runner does not support configured vendor ${configured.vendorId}.`)
  const host = configured.region === 'china' ? 'https://open.bigmodel.cn' : 'https://api.z.ai'
  return {
    model: settings.activeModel,
    provider: `${configured.vendorId}:${configured.region ?? 'global'}`,
    endpoint: `${host}/api/coding/paas/v4/chat/completions`,
    apiKey
  }
}
const parse = (value) => {
  try {
    return JSON.parse(value || '{}')
  } catch {
    return {}
  }
}
const valid = (checks) =>
  Array.isArray(checks) &&
  checks.length > 0 &&
  checks.every(
    (check) =>
      ['pass', 'warn', 'fail'].includes(check?.status) &&
      typeof check.claim === 'string' &&
      check.claim &&
      typeof check.evidence === 'string' &&
      check.evidence
  )
const addUsage = (target, usage) => {
  target.inputTokens += usage?.prompt_tokens ?? 0
  target.cachedTokens += usage?.prompt_tokens_details?.cached_tokens ?? 0
  target.outputTokens += usage?.completion_tokens ?? 0
}
const call = async (configuration, messages) => {
  const started = Date.now(),
    response = await fetch(configuration.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${configuration.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: configuration.model,
        reasoning_effort: 'low',
        temperature: 0,
        messages,
        tools,
        tool_choice: 'auto'
      })
    }),
    body = await response.json()
  if (!response.ok)
    throw new Error(
      `Provider request failed (${response.status}): ${body?.error?.message ?? 'unknown error'}`
    )
  return { body, latencyMs: Date.now() - started }
}
const run = async (configuration, fixture, repetition) => {
  const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Review fixture ${fixture.id}. ${fixture.instruction} Begin by calling read_turn.`
      }
    ],
    toolCalls = [],
    usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }
  let latencyMs = 0
  for (let step = 0; step < 10; step++) {
    const response = await call(configuration, messages)
    latencyMs += response.latencyMs
    addUsage(usage, response.body.usage)
    const message = response.body.choices?.[0]?.message
    if (!message) throw new Error('Provider returned no assistant message.')
    messages.push(message)
    for (const toolCall of message.tool_calls ?? []) {
      const name = toolCall.function.name,
        args = parse(toolCall.function.arguments)
      toolCalls.push({ name, args })
      if (name === 'submit_findings') {
        if (valid(args.checks))
          return {
            runId: `${fixture.id}-${repetition}`,
            scenarioId: fixture.id,
            repetition,
            raw: { checks: args.checks, toolCalls },
            providerUsage: usage,
            latencyMs
          }
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            error: 'Validation error: every check needs status, claim, and evidence.'
          })
        })
        continue
      }
      if (name === 'read_turn') {
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(fixture.turn)
        })
        continue
      }
      const value = args.view === 'trace' ? fixture.trace : fixture.content
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(
          value.dataUrl ? { kind: value.kind, mimeType: value.mimeType } : value
        )
      })
      if (value.dataUrl)
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: `Media returned for ${args.id}:` },
            { type: 'image_url', image_url: { url: value.dataUrl } }
          ]
        })
    }
  }
  throw new Error(`${fixture.id} exceeded the tool-step limit.`)
}

const main = async () => {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5)
    throw new Error('--runs must be from 1 to 5.')
  await app.whenReady()
  app.dock?.hide()
  const configuration = await provider(),
    selected = requested.size ? fixtures.filter(({ id }) => requested.has(id)) : fixtures
  if (!selected.length || (requested.size && selected.length !== requested.size))
    throw new Error('--fixtures contains an unknown id.')
  const runs = []
  for (const fixture of selected)
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      process.stderr.write(`Running ${fixture.id} / ${repetition}...\n`)
      runs.push(await run(configuration, fixture, repetition))
    }
  const capture = sealReviewerModelCapture({
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    captureId: `live-${new Date().toISOString().replaceAll(':', '-')}`,
    recordedAt: new Date().toISOString(),
    model: configuration.model,
    provider: configuration.provider,
    strategy: 'proposed-unified',
    source: outputArgument,
    runner: { name: 'reviewer-model-evaluation-live', version: RUNNER_VERSION },
    runs
  })
  const output = resolve(root, outputArgument)
  await writeFile(output, `${JSON.stringify(capture, null, 2)}\n`, 'utf8')
  process.stdout.write(`${output}\n`)
}
main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
  .finally(() => app.quit())
