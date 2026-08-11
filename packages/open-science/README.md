# @aipoch/open-science

Node.js SDK and command-line client for an Open Science daemon running on the local machine.

## Documentation

- [CLI guide](./CLI.md) - installation, daemon lifecycle, task automation, artifacts, and exit codes

## SDK quick start

```js
import { connectToOpenScience } from '@aipoch/open-science'

const client = await connectToOpenScience()
const run = await client.startRun({
  project: 'systematic-review',
  prompt: 'Summarize the evidence.',
  permissionProfile: 'auto'
})
const result = await client.waitForRun(run.id)
console.log(result.output)
```

For live automation feedback, subscribe before starting the Run. `run.progress` reports ordered
provider-neutral phases and emits a heartbeat every ten seconds until the first visible provider
output. The timer starts after Task has prepared the Session and registered its Run; Session
creation or resume time before registration is outside this event stream:

```js
const abortController = new AbortController()
const events = client.events({ signal: abortController.signal })
await events.ready

const progress = (async () => {
  for await (const event of events) {
    if (event.type === 'run.progress') {
      console.log(event.data.phase, event.data.elapsedMs, event.data.heartbeat)
    }
  }
})()

const observedRun = await client.startRun({
  project: 'systematic-review',
  prompt: 'Summarize the evidence.',
  permissionProfile: 'auto'
})
const observedResult = await client.waitForRun(observedRun.id)
abortController.abort()
await progress
console.log(observedResult.output)
```

To stop a still-running task instead of waiting for it, cancel it explicitly. Cancellation waits for
provider work and application finalization to drain before returning the terminal Run:

```js
const cancelled = await client.cancelRun(run.id)
console.log(cancelled.status) // cancelled
```

The client discovers the local daemon and reads its authentication token from the Open Science config
directory. Tokens are sent in request headers and are never included in normal command output.
