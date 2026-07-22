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

The client discovers the local daemon and reads its authentication token from the Open Science config
directory. Tokens are sent in request headers and are never included in normal command output.
