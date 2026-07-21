import type { NotebookOutput } from '../../shared/notebook'

// One rendered figure produced during a cell execution; already base64-encoded by the driver.
export type MappedFigure = { mime: string; base64: string }

// The mapped result: structured outputs plus the flattened text streams the driver persists.
export type MappedLoopOutputs = {
  outputs: NotebookOutput[]
  stdout: string
  stderr: string
  traceback: string
}

// Pure mapping from one exec-loop response to NotebookOutput[] plus flattened text streams.
// Order: stream(stdout), stream(stderr), figures (array order), result display, error.
export function mapLoopOutputs(input: {
  stdout: string
  stderr: string
  error: string | null
  errorLine?: number | null
  result: string | null
  figures: MappedFigure[]
}): MappedLoopOutputs {
  const { stdout, stderr, error, errorLine, result, figures } = input
  const outputs: NotebookOutput[] = []

  if (stdout) outputs.push({ type: 'stream', name: 'stdout', text: stdout })
  if (stderr) outputs.push({ type: 'stream', name: 'stderr', text: stderr })

  for (const figure of figures) {
    outputs.push({ type: 'display', data: { [figure.mime]: figure.base64 } })
  }

  if (result) outputs.push({ type: 'display', data: { 'text/plain': result } })

  let traceback = ''
  if (error) {
    const errorOutput: NotebookOutput = {
      type: 'error',
      message: error.split('\n')[0],
      traceback: error
    }
    if (typeof errorLine === 'number') errorOutput.line = errorLine
    outputs.push(errorOutput)
    traceback = error
  }

  return { outputs, stdout, stderr, traceback }
}
