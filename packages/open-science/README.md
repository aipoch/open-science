# @aipoch/open-science

Node.js SDK and command-line client for an Open Science daemon running on the local machine.

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

The package also installs the `open-science` command:

```bash
open-science start --no-open
open-science project list --json
open-science run --project systematic-review --prompt-file task.md --wait --json
open-science session status <session-id> --json
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
open-science stop
```

Use `--jsonl` instead of `--json` to receive progress events before the final run object. The default
approval profile is `ask`; unattended workflows must explicitly select `--approval-profile auto` or
`--approval-profile full` when that access is appropriate.
