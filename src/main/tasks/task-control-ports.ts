export class TaskRunTracingError extends Error {
  constructor(
    message = 'Set OPEN_SCIENCE_AGENT_OTLP_TRACES_ENDPOINT to a full HTTP(S) traces URL and check the OTLP headers or credentials for that configuration. Restart the backend and retry --otel-traces.'
  ) {
    super(message)
  }
}

type TaskControlPorts = {
  specialists: {
    resolve(reference: string): Promise<{ id: string }>
  }
}

export type { TaskControlPorts }
