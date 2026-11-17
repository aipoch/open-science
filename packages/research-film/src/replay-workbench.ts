import Papa from 'papaparse'
import type { ReplayCase } from './replay-case.js'
import type { ReplayEvidence, ResearchVideoSessionSource } from './source.js'
import type { buildVideoTimeline } from './timeline.js'

type Timeline = ReturnType<typeof buildVideoTimeline>
type Picture = { event: ReplayEvidence; start: number; end: number }
type Scene = {
  id: string
  kind: 'opening' | 'prompt' | 'upload' | 'conversation' | 'run' | 'result'
  start: number
  duration: number
  camera: 'wide' | 'input' | 'result'
  source_ref?: string
  prompt_id?: string
  submit_at?: number
  completion_at?: number
  title?: string
  showcase_title?: string
  result_id?: string
  messages?: Array<{
    id: string
    role: 'agent' | 'system'
    label?: string
    text: string
    at: number
    source_ref: string
  }>
  code?: string
  language?: string
  stdout?: string
  phase?: string
}

function snapshotText(event: ReplayEvidence): string {
  if (event.kind !== 'plan') return event.text
  try {
    const plan = JSON.parse(event.text)
    const phases = Array.isArray(plan?.document?.phases) ? plan.document.phases : []
    const lines = [plan?.document?.task_summary]
    for (const phase of phases) {
      lines.push(phase?.name)
      const delegations = Array.isArray(phase?.delegations) ? phase.delegations : [phase]
      for (const step of delegations.flatMap(
        (item: { steps?: Array<{ title?: string }> } | null) =>
          Array.isArray(item?.steps) ? item.steps : []
      )) {
        if (typeof step?.title !== 'string') continue
        const status = plan.steps?.[step.title]?.status
        lines.push(`• ${step.title}${typeof status === 'string' ? ' · ' + status : ''}`)
      }
    }
    const text = lines.filter((line) => typeof line === 'string').join('\n')
    return text || event.text
  } catch {
    return event.text
  }
}

/** Trusted projection only: the model chooses evidence and narration, never UI code or actions. */
export function replayWorkbench(
  spec: ReplayCase,
  source: ResearchVideoSessionSource,
  timeline: Timeline,
  pictures: Picture[],
  assets: Record<string, string>
): Record<string, unknown> {
  const evidence = source.replay!.events
  const humanInputs = new Map(
    evidence
      .filter((event) => event.kind === 'human-input')
      .map((event) => [event.messageId, event.id])
  )
  const attachments = evidence
    .filter((event) => event.kind === 'attachment')
    .map((event) => ({
      id: event.id,
      name: event.title,
      prompt_id: humanInputs.get(event.messageId),
      bytes: Number(event.text.match(/(\d+) bytes/)?.[1]) || undefined
    }))
  const results = pictures
    .filter(({ event }) => event.kind === 'result')
    .map(({ event }) => {
      const common = { id: event.id, name: event.title, evidence_refs: [event.id] }
      if (event.image) return { ...common, type: 'image', src: assets[event.image] }
      if (event.previewText !== undefined && /\.(csv|tsv)$/i.test(event.title)) {
        const parsed = Papa.parse<string[]>(event.previewText, {
          skipEmptyLines: true,
          delimiter: /\.tsv$/i.test(event.title) ? '\t' : ','
        })
        if (!parsed.errors.length && parsed.data.length)
          return { ...common, type: 'table', columns: parsed.data[0], rows: parsed.data.slice(1) }
      }
      return {
        ...common,
        type: 'report',
        text:
          event.previewText ??
          `${event.title}${event.status ? ' · ' + event.status : ''}\n\n${event.text}`
      }
    })
  const scenes: Scene[] = []
  // Share the first measured voice window with the title; no silence or fabricated narration.
  const opening = Math.min(4, (pictures[0].end - pictures[0].start) * 0.3)
  scenes.push({
    id: 'opening',
    kind: 'opening',
    start: 0,
    duration: opening,
    camera: 'wide',
    showcase_title: spec.title.includes(': ') ? spec.title.replace(': ', '|**') + '**' : spec.title
  })
  pictures.forEach(({ event, start, end }, index) => {
    start = index === 0 ? opening : start
    const duration = end - start
    const common = {
      id: 'record-' + index,
      start,
      duration,
      source_ref: event.id,
      camera: 'wide' as const
    }
    if (event.kind === 'human-input') {
      const upload = attachments.some((file) => file.prompt_id === event.id)
      scenes.push({
        ...common,
        kind: upload ? 'upload' : 'prompt',
        camera: 'input',
        prompt_id: event.id,
        submit_at: duration * 0.92
      })
    } else if (event.kind === 'agent-message' || event.kind === 'application-event') {
      scenes.push({
        ...common,
        kind: 'conversation',
        camera: 'wide',
        messages: [
          {
            id: event.id,
            source_ref: event.id,
            role: event.kind === 'application-event' ? 'system' : 'agent',
            text: event.text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[Image: $1]'),
            at: 0
          }
        ]
      })
    } else if (event.execution && ['completed', 'failed', 'error'].includes(event.status ?? '')) {
      scenes.push({
        ...common,
        kind: 'run',
        title: event.title,
        code: event.execution.code,
        language: event.execution.language === 'repl' ? 'javascript' : event.execution.language,
        stdout: event.execution.output,
        completion_at: duration * 0.35,
        phase: event.status === 'completed' ? 'complete' : 'failed'
      })
    } else if (event.kind === 'result') {
      scenes.push({
        ...common,
        kind: 'result',
        camera: 'result',
        result_id: event.id,
        completion_at: 0
      })
    } else {
      // A recorded snapshot is evidence, not a newly generated file or a witnessed user action.
      scenes.push({
        ...common,
        kind: 'conversation',
        camera: 'wide',
        messages: [
          {
            id: event.id,
            source_ref: event.id,
            role: 'system',
            label: event.kind === 'attachment' ? 'Input attachment' : 'Recorded snapshot',
            text: `${event.title}${event.status ? ' · ' + event.status : ''}\n\n${snapshotText(event)}`,
            at: 0
          }
        ]
      })
    }
  })
  return {
    schema_version: 1,
    id: 'operation-replay',
    title: spec.title,
    project_title: source.sessionTitle,
    duration: timeline.duration,
    fps: 30,
    provenance: 'Recorded session · reconstructed actions · time compressed',
    conversation_mode: 'full',
    show_agent_thinking: false,
    agent_model: 'Agent',
    environment: { mode: 'local' },
    plan: { mode: 'omit', steps: [] },
    prompts: evidence
      .filter((event) => event.kind === 'human-input')
      .map((event) => ({ id: event.id, text: event.text, source_ref: event.id })),
    attachments,
    results,
    scenes,
    captions: timeline.captions['16x9'].map((caption) => ({
      ...caption,
      start: caption.words[0][1]
    })),
    omissions: source.replay!.omissions,
    audio: 'mix.wav'
  }
}
