import { describe, expect, it } from 'vitest'

import {
  KERNEL_FIGURES_DIR_ENV,
  frameRNamespaceRequest,
  frameRInterruptProbeRequest,
  frameRRequest,
  frameRStageRequest,
  framePythonNamespaceRequest,
  framePythonRequest,
  parseLoopResponse,
  type KernelLoopResponse
} from './kernel-protocol'

describe('parseLoopResponse', () => {
  it('accepts bounded R package evidence and rejects oversized or non-metadata payloads', () => {
    const observation = { locale: 'C', timezone: 'UTC', threadLimits: {}, randomLibraries: [] }
    const rPackages = {
      before: ['readxl'],
      after: ['readxl'],
      reads: [{ name: 'read_excel', package: 'readxl' }],
      complete: true,
      cleanSession: true
    }
    const wire = {
      req_id: 'r',
      stdout: '',
      stderr: '',
      error: null,
      cwd: '/tmp',
      figures: [],
      environment: {
        execution_context: { schemaVersion: 1, before: observation, after: observation, rPackages }
      }
    }
    expect(
      parseLoopResponse(JSON.stringify(wire))?.environmentOverlay?.executionContext?.rPackages
    ).toEqual(rPackages)
    rPackages.before = Array.from({ length: 129 }, () => 'readxl')
    expect(
      parseLoopResponse(JSON.stringify(wire))?.environmentOverlay?.executionContext
    ).toBeUndefined()
    rPackages.before = []
    Object.assign(rPackages, { dataframe: ['must not capture user data'] })
    expect(
      parseLoopResponse(JSON.stringify(wire))?.environmentOverlay?.executionContext
    ).toBeUndefined()
  })
  it('keeps bounded execution context but never accepts arbitrary environment variables', () => {
    const observation = {
      locale: 'C',
      timezone: 'UTC',
      threadLimits: { OMP_NUM_THREADS: '2' },
      randomLibraries: ['numpy']
    }
    const context = { schemaVersion: 1, before: observation, after: observation }
    const wire = {
      req_id: 'r1',
      stdout: '',
      stderr: '',
      error: null,
      cwd: '/tmp',
      figures: [],
      environment: { packages: [], execution_context: context }
    }
    expect(parseLoopResponse(JSON.stringify(wire))?.environmentOverlay?.executionContext).toEqual(
      context
    )
    Object.assign(observation.threadLimits, { API_KEY: 'secret' })
    expect(
      parseLoopResponse(JSON.stringify(wire))?.environmentOverlay?.executionContext
    ).toBeUndefined()
  })
  it('parses a well-formed snake_case response line into camelCase', () => {
    const line = JSON.stringify({
      req_id: 'r1',
      stdout: 'hi',
      stderr: 'oops',
      error: null,
      interrupt_ack: true,
      result: '42',
      cwd: '/tmp/nb',
      figures: [{ mime: 'image/png', path: '/tmp/fig1.png' }],
      environment: {
        runtime_version: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.2.0',
            version_status: 'known',
            ecosystem: 'python',
            evidence_sources: ['python-kernel-modules'],
            loaded_state: 'loaded'
          }
        ]
      }
    })
    expect(parseLoopResponse(line)).toEqual({
      reqId: 'r1',
      stdout: 'hi',
      stderr: 'oops',
      error: null,
      interruptAck: true,
      errorLine: null,
      result: '42',
      cwd: '/tmp/nb',
      figures: [{ mime: 'image/png', path: '/tmp/fig1.png' }],
      environmentOverlay: {
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.2.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-kernel-modules'],
            loadedState: 'loaded'
          }
        ]
      }
    })
  })

  it.each([false, true])('preserves explicit execution_started=%s evidence', (executionStarted) => {
    expect(
      parseLoopResponse(JSON.stringify({ req_id: 'evidence', execution_started: executionStarted }))
    ).toMatchObject({ executionStarted })
  })

  it.each([undefined, null, 0, 1, 'false', 'true'])(
    'leaves execution evidence unknown for missing or non-boolean value %s',
    (executionStarted) => {
      expect(
        parseLoopResponse(JSON.stringify({ req_id: 'legacy', execution_started: executionStarted }))
      ).not.toHaveProperty('executionStarted')
    }
  )

  it('fills in safe defaults for missing fields', () => {
    const line = JSON.stringify({ req_id: 'r2' })
    expect(parseLoopResponse(line)).toEqual({
      reqId: 'r2',
      stdout: '',
      stderr: '',
      error: null,
      errorLine: null,
      result: null,
      cwd: '',
      figures: []
    })
  })

  it('parses error_line into errorLine when the loop attributes a source line', () => {
    const line = JSON.stringify({
      req_id: 'r4',
      error: "there is no package called 'ggrepel'",
      error_line: 7
    })
    expect(parseLoopResponse(line)?.errorLine).toBe(7)
  })

  it('leaves errorLine null when error_line is absent or non-numeric', () => {
    expect(parseLoopResponse(JSON.stringify({ req_id: 'r5', error: 'boom' }))?.errorLine).toBeNull()
    expect(
      parseLoopResponse(JSON.stringify({ req_id: 'r6', error_line: 'nope' }))?.errorLine
    ).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseLoopResponse('not json')).toBeNull()
  })

  it('returns null for a non-object JSON value', () => {
    expect(parseLoopResponse('42')).toBeNull()
    expect(parseLoopResponse('null')).toBeNull()
    expect(parseLoopResponse('[1,2,3]')).toBeNull()
  })

  it('ignores non-object entries within figures', () => {
    const line = JSON.stringify({
      req_id: 'r3',
      figures: [{ mime: 'image/png', path: '/f.png' }, 'garbage', 42, null]
    })
    expect(parseLoopResponse(line)?.figures).toEqual([{ mime: 'image/png', path: '/f.png' }])
  })

  it('parses bounded namespace fields and locale-independent R text', () => {
    const encode = (value: string): string => Buffer.from(value).toString('base64')
    const response = parseLoopResponse(
      JSON.stringify({
        req_id: 'namespace-1',
        namespace: {
          variable_count: 2,
          variables_truncated: true,
          variables: [
            {
              name: 'x',
              type: 'builtins.int',
              size_bytes: 28,
              shape: '1 item',
              preview: '42'
            },
            {
              name_base64: encode('图形'),
              type_base64: encode('Figure'),
              preview_base64: encode('活跃变量'),
              preview_truncated: true,
              is_private: true
            }
          ]
        }
      })
    )

    expect(response?.namespace).toEqual({
      variableCount: 2,
      variablesTruncated: true,
      variables: [
        {
          name: 'x',
          type: 'builtins.int',
          sizeBytes: 28,
          shape: '1 item',
          preview: '42'
        },
        {
          name: '图形',
          type: 'Figure',
          preview: '活跃变量',
          previewTruncated: true,
          private: true
        }
      ]
    })
  })
})

describe('framePythonRequest', () => {
  it('builds a stable-order JSON line terminated by newline', () => {
    expect(framePythonRequest('id', 'print(1)')).toBe('{"req_id":"id","code":"print(1)"}\n')
    expect(framePythonRequest('id', 'print(1)', undefined, ['/registered/generation-1'])).toBe(
      '{"req_id":"id","code":"print(1)","protected_dirs":["/registered/generation-1"]}\n'
    )
  })

  it('builds a distinct namespace operation without executable source', () => {
    expect(framePythonNamespaceRequest('id', true)).toBe(
      '{"req_id":"id","operation":"inspect_namespace","include_private":true}\n'
    )
  })
})

describe('frameRRequest', () => {
  it('builds a length-prefixed header followed by the exact UTF-8 code bytes', () => {
    const code = 'x<-1'
    const buf = frameRRequest('id', code)
    const header = `id ${Buffer.byteLength(code, 'utf8')}\n`
    expect(buf.subarray(0, header.length).toString('utf8')).toBe(header)
    expect(buf.subarray(header.length).toString('utf8')).toBe(code)
    expect(buf.length).toBe(header.length + Buffer.byteLength(code, 'utf8'))
  })

  it('uses the UTF-8 byte length for multibyte code, not the string length', () => {
    // Multibyte (non-ASCII) content so UTF-8 byte length exceeds the JS string length.
    const code = '# café ☕\nx<-1'
    const buf = frameRRequest('id', code)
    const byteLen = Buffer.byteLength(code, 'utf8')
    expect(byteLen).not.toBe(code.length)
    const header = `id ${byteLen}\n`
    expect(buf.subarray(0, header.length).toString('utf8')).toBe(header)
    expect(buf.subarray(header.length).toString('utf8')).toBe(code)
    expect(buf.length).toBe(header.length + byteLen)
  })

  it('marks namespace inspection in the R frame header', () => {
    expect(frameRNamespaceRequest('id', false).toString('utf8')).toBe('id 0 inspect_namespace\n')
    expect(frameRNamespaceRequest('id', true).toString('utf8')).toBe(
      'id 7 inspect_namespace\nprivate'
    )
  })
})

describe('KERNEL_FIGURES_DIR_ENV', () => {
  it('is the stable env var name for the figures directory', () => {
    expect(KERNEL_FIGURES_DIR_ENV).toBe('OPEN_SCIENCE_KERNEL_FIGURES_DIR')
  })
})

describe('R stage protocol', () => {
  it('frames a zero-body trusted probe without consuming the next UTF-8 user frame', () => {
    const probe = frameRInterruptProbeRequest('probe')
    expect(probe.toString('utf8')).toBe('probe 0 interrupt_probe\n')
    const code = '结果 <- "café"'
    const next = frameRRequest('next', code)
    const combined = Buffer.concat([probe, next])
    expect(combined.subarray(probe.length).equals(next)).toBe(true)
    expect(next.toString('utf8')).toBe(`next ${Buffer.byteLength(code, 'utf8')}\n${code}`)
  })

  it('passes the exact missing object allowlist without converting supplement into restore', () => {
    const code = 'heat <- resultTable + clean'
    const stageSupplement = {
      inputPath: '/input.rds',
      expectedOutputPath: '/output.rds',
      names: ['clean']
    }
    const frame = frameRStageRequest('supplement', code, { stageSupplement })
    const boundary = frame.indexOf(10)
    const body = frame.subarray(boundary + 1)
    expect(frame.subarray(0, boundary).toString()).toBe(`supplement ${body.length} execute_stage`)
    expect(JSON.parse(body.toString())).toEqual({
      code,
      stage_supplement: {
        input_path: '/input.rds',
        expected_output_path: '/output.rds',
        names: ['clean']
      }
    })
    expect(stageSupplement.names).toEqual(['clean'])
  })

  it('preserves a strict environment proof and rejects malformed proof without losing run output', () => {
    const proof = { schema_version: 1, packages: [{ name: 'DESeq2', version: '1.48.2' }] }
    const response = (environment_proof: unknown): ReturnType<typeof parseLoopResponse> =>
      parseLoopResponse(
        JSON.stringify({
          req_id: 'run',
          stdout: 'done',
          error: null,
          stage_checkpoint: {
            state: 'available',
            input_names: ['dds'],
            output_names: ['res'],
            environment_proof
          }
        })
      )
    expect(response(proof)?.stageCheckpointCapture).toEqual({
      state: 'available',
      inputNames: ['dds'],
      outputNames: ['res'],
      environmentProof: { schemaVersion: 1, packages: proof.packages }
    })
    for (const invalid of [
      null,
      { ...proof, schema_version: 2 },
      { ...proof, extra: true },
      { ...proof, packages: [] },
      { ...proof, packages: [...proof.packages, ...proof.packages] },
      { ...proof, packages: [{ name: 'DESeq2', version: '1.48.2', extra: true }] },
      { ...proof, packages: [{ name: '../DESeq2', version: '1.48.2' }] },
      { ...proof, packages: [{ name: 'DESeq2', version: 'x'.repeat(129) }] },
      {
        ...proof,
        packages: [
          { name: 'DESeq2', version: '1.48.2' },
          { name: '', version: '1' }
        ]
      }
    ]) {
      const parsed = response(invalid)
      expect(parsed?.stageCheckpointCapture).toEqual({
        state: 'unavailable',
        reason: 'invalid-checkpoint-environment-proof'
      })
      expect(parsed).toMatchObject({ reqId: 'run', stdout: 'done', error: null })
    }
  })

  it('frames original source separately from trusted checkpoint paths using UTF-8 byte length', () => {
    const code = '结果 <- x + 1'
    const options = {
      stageCheckpoint: { inputPath: '/session/input.rds', outputPath: '/session/output.rds' }
    }
    const frame = frameRStageRequest('run', code, options)
    const boundary = frame.indexOf(10)
    const body = frame.subarray(boundary + 1)
    expect(frame.subarray(0, boundary).toString()).toBe(`run ${body.length} execute_stage`)
    expect(JSON.parse(body.toString())).toEqual({
      code,
      stage_checkpoint: {
        input_path: options.stageCheckpoint.inputPath,
        output_path: options.stageCheckpoint.outputPath
      }
    })
    expect(frameRRequest('raw', code).toString()).toBe(`raw ${Buffer.byteLength(code)}\n${code}`)
  })
  it('frames explicit package projection and optional footprint observation', () => {
    const packageContext = {
      schemaVersion: 1 as const,
      sourcePackages: ['DESeq2', 'base'],
      targetPackages: ['base']
    }
    const frame = frameRStageRequest('r', 'NULL', {
      stageRestore: {
        inputPath: '/input',
        expectedOutputPath: '/output',
        packageContext,
        observeRuntimeFootprint: true
      }
    })
    expect(JSON.parse(frame.subarray(frame.indexOf(10) + 1).toString()).stage_restore).toEqual({
      input_path: '/input',
      expected_output_path: '/output',
      observe_runtime_footprint: true,
      package_context: {
        schema_version: 1,
        source_packages: ['DESeq2', 'base'],
        target_packages: ['base']
      }
    })
    const wire = {
      outcome: 'equal',
      scientific_outcome: 'equal',
      package_context: {
        schema_version: 1,
        source_packages: ['DESeq2', 'base'],
        target_packages: ['base']
      },
      runtime_footprint: {
        process_id: 123,
        packages: [{ name: 'base', version: '4.5.3' }],
        library_paths: ['/prefix/lib/R/lib/libR.dylib']
      }
    }
    const parse = (comparison: unknown): KernelLoopResponse['stageComparison'] =>
      parseLoopResponse(JSON.stringify({ stage_comparison: comparison }))?.stageComparison
    expect(parse(wire)).toEqual({
      outcome: 'equal',
      scientificOutcome: 'equal',
      packageContext,
      runtimeFootprint: {
        processId: 123,
        packages: [{ name: 'base', version: '4.5.3' }],
        libraryPaths: ['/prefix/lib/R/lib/libR.dylib']
      }
    })
    for (const invalid of [
      { ...wire, scientific_outcome: undefined },
      { ...wire, scientific_outcome: 'different' },
      { ...wire, package_context: { ...wire.package_context, target_packages: ['base', 'base'] } },
      { ...wire, runtime_footprint: { ...wire.runtime_footprint, process_id: 0 } },
      {
        ...wire,
        runtime_footprint: { ...wire.runtime_footprint, packages: [{ name: '', version: '1' }] }
      },
      { ...wire, runtime_footprint: { ...wire.runtime_footprint, library_paths: ['a\0b'] } },
      {
        ...wire,
        runtime_footprint: { ...wire.runtime_footprint, library_paths: Array(4097).fill('/x') }
      }
    ])
      expect(parse(invalid)).toEqual({
        outcome: 'unavailable',
        reason: 'invalid-stage-comparison-response'
      })
  })

  it('maps restore/comparison paths and bounded response evidence without accepting kernel paths', () => {
    const framed = frameRStageRequest('r', 'print(x)', {
      stageRestore: { inputPath: '/input', expectedOutputPath: '/output' }
    }).toString()
    expect(framed).toContain(
      '"stage_restore":{"input_path":"/input","expected_output_path":"/output"}'
    )
    const compare = frameRStageRequest('r', 'print(x)', {
      stageExpectedOutputPath: '/output'
    }).toString()
    expect(compare).toContain('"stage_expected_output_path":"/output"')
    const response = parseLoopResponse(
      JSON.stringify({
        stage_checkpoint: {
          state: 'available',
          input_names: ['x'],
          output_names: ['y'],
          input_path: '/untrusted'
        },
        stage_comparison: { outcome: 'different' }
      })
    )
    expect(response?.stageCheckpointCapture).toEqual({
      state: 'available',
      inputNames: ['x'],
      outputNames: ['y']
    })
    expect(response?.stageComparison).toEqual({ outcome: 'different' })
    expect(
      parseLoopResponse(
        JSON.stringify({
          stage_checkpoint: { state: 'available', input_names: ['x', 'x'], output_names: [] }
        })
      )?.stageCheckpointCapture
    ).toEqual({ state: 'unavailable', reason: 'invalid-checkpoint-response' })
  })
})
