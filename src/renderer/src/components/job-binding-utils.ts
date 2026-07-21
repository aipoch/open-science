import type { ToolActivity } from '@/stores/session-store'

// Scans a repl_execute tool-call's rawOutput for a job_id submitted via submit_job.
// The repl kernel returns: { stdout, stderr, result, cwd, figures }
// submit_job returns a JSON object; the kernel stringifies it into `result`.
// We also scan stdout in case the agent printed the result via console.log.
//
// Returns the job_id string if found, otherwise undefined.
export function extractJobIdFromActivity(activity: ToolActivity): string | undefined {
  const raw = activity.rawOutput
  if (!raw || typeof raw !== 'object') return undefined

  const output = raw as Record<string, unknown>

  // Primary path: result field contains JSON-stringified { job_id, ... }
  if (typeof output.result === 'string') {
    const jobId = parseJobIdFromText(output.result)
    if (jobId) return jobId
  }

  // Fallback: scan stdout (in case the agent console.log'd the result)
  if (typeof output.stdout === 'string') {
    const jobId = parseJobIdFromText(output.stdout)
    if (jobId) return jobId
  }

  return undefined
}

// Attempts to parse a job_id from a text that may contain a JSON object with a job_id field.
// Handles both "{ job_id: '...' }" (result) and embedded JSON in stdout.
function parseJobIdFromText(text: string): string | undefined {
  // Direct JSON parse of the entire string (covers result field)
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed) && typeof parsed.job_id === 'string' && parsed.job_id) {
      return parsed.job_id
    }
  } catch {
    // Not a standalone JSON object — scan for embedded JSON blocks
  }

  // Scan for JSON objects embedded in stdout text
  // Match any {...} block that may contain job_id
  const jsonPattern = /\{[^{}]*"job_id"\s*:\s*"([^"]+)"[^{}]*\}/g
  const match = jsonPattern.exec(text)
  if (match) return match[1]

  return undefined
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Determines which activities (tool-calls) contain a given job_id in their rawOutput.
// Returns the activity ids that match. Used to bind RemoteJobRow to the correct tool-call.
export function findActivitiesForJob(activities: ToolActivity[], jobId: string): string[] {
  return activities.filter((a) => extractJobIdFromActivity(a) === jobId).map((a) => a.id)
}
