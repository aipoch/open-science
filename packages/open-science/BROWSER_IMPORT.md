# Import a browser-held `.science` package

The `@aipoch/open-science/browser-import` entry point runs in a browser. The website downloads a
complete `Blob` or `File`, launches the installed desktop app through `open-science://`, and sends
the bytes to a temporary receiver on `127.0.0.1`. Open-Science never downloads a remote package URL.
Open-Science receives the file automatically and validates the package before asking for a target.
The user then chooses the destination and confirms the final import.

## Website integration

Use `@aipoch/open-science/browser-import`, not the Node SDK root. Probe the running service before
downloading. If it is unreachable, offer **Open Open-Science** and **Check again**, as well as an
installation link. `launchOpenScience(): void` synchronously requests `open-science://open`:
call it directly inside a click handler, before any `await`. It only starts or shows the app; it
needs no Blob, creates no import task, and does not download anything. Returning normally proves
neither installation nor successful launch. Browsers may silently block external navigation.

After downloading a complete Blob, prepare a transfer, navigate to its `url`, then call `send()`.
Automatic navigation after an asynchronous download is best effort. Keep a direct-click retry
button: neither a placeholder tab nor an earlier click preserves activation through a download.
Pure launch and import launch share the existing OS protocol registration and single-instance
routing. Older desktop builds support the import URL but may ignore the new pure `open` route;
ship a desktop build containing this contract when offering the pure-launch action.

The example expects these existing DOM elements (all buttons are `type="button"`):
`continueButton` ("Download and continue"), `openButton` ("Open Open-Science"),
`probeButton` ("Check again"), `reconnectButton` ("Retry connection"), `retryButton` ("Open and retry transfer"),
`restartButton` ("Start a new transfer"), `cancelButton` ("Cancel"), `status`, and a visible
`downloadLink` to `/open-science/download`. Keep the page open. A product can show the recovery
buttons only when relevant; do not remove the open/recheck path when discovery fails.

```js
import {
  BrowserImportError,
  checkBrowserImportAvailability,
  launchOpenScience,
  prepareBrowserImport
} from '@aipoch/open-science/browser-import'

let blob // Retain downloaded bytes for retry; release after receipt or explicit discard.
let transfer
let active // Only one operation owns an AbortController at a time.

function render() {
  for (const button of [
    continueButton,
    openButton,
    probeButton,
    reconnectButton,
    retryButton,
    restartButton
  ]) {
    button.disabled = !!active
  }
  continueButton.disabled ||= !!blob
  reconnectButton.disabled ||= !transfer
  retryButton.disabled ||= !blob
  restartButton.disabled ||= !blob
  cancelButton.disabled = !active
}

async function run(work, cancelTransfer = false) {
  if (active) return
  const controller = new AbortController()
  active = controller
  render()
  try {
    // Calls work synchronously until its first await, preserving a direct click for navigation.
    await work(controller.signal)
  } catch (error) {
    if (controller.signal.aborted) {
      // Only cancelling send invalidates a transfer; cancelling a probe must preserve it.
      if (cancelTransfer) transfer = undefined
      status.textContent = blob
        ? 'Cancelled. Click Open and retry transfer to use the downloaded package.'
        : 'Cancelled. Click Download and continue to try again.'
    } else if (error instanceof BrowserImportError) {
      switch (error.code) {
        case 'launch-failed':
          status.textContent = 'Could not request opening Open-Science. Click Open and try again.'
          break
        case 'timeout':
        case 'readiness-exhausted':
          status.textContent =
            'The receiver is not ready. Finish opening Open-Science, then click Retry connection. If the transfer expired, start a new transfer.'
          break
        case 'incompatible':
          transfer = undefined
          status.textContent =
            'Could not verify the receiver. Update Open-Science and start a new transfer.'
          break
        case 'cancelled':
          transfer = undefined
          status.textContent =
            'Transfer cancelled in Open-Science. Start a new transfer to try again.'
          break
        case 'transfer-failed':
          status.textContent =
            'Transfer failed. Retry to resume; if the receiver expired, start a new transfer.'
          break
        default:
          status.textContent =
            'This browser cannot perform this action. Download the package and open it locally.'
      }
    } else {
      status.textContent = 'Could not prepare or download the package. Please try again.'
    }
  } finally {
    active = undefined
    render()
  }
}

async function probe(signal) {
  status.textContent = 'Checking Open-Science…'
  const result = await checkBrowserImportAvailability({ signal, timeoutMs: 2000 })
  signal.throwIfAborted()
  status.textContent =
    result.status === 'available'
      ? blob
        ? 'Open-Science is reachable. Retry the downloaded package.'
        : 'Open-Science is reachable. You can download and continue.'
      : 'Could not reach Open-Science. Open the app and check again, or install it first.'
  return result.status === 'available'
}

function openTransfer() {
  // transfer.url is a credential; never log or persist it.
  try {
    window.location.assign(transfer.url)
  } catch {
    throw new BrowserImportError('launch-failed', 'Could not request opening Open-Science.')
  }
}

async function send(signal) {
  await transfer.send({
    signal,
    readinessMode: 'wait-for-launch',
    attemptTimeoutMs: 2000,
    readyTimeoutMs: 120000,
    onPhase: (phase) => {
      status.textContent =
        phase === 'waiting-for-receiver'
          ? 'Waiting for Open-Science. Allow browser permissions if prompted…'
          : 'Sending package…'
    },
    onProgress: ({ sentBytes, totalBytes }) => {
      status.textContent = `Sending ${Math.round((sentBytes / totalBytes) * 100)}%`
    }
  })
  blob = undefined
  transfer = undefined
  status.textContent =
    'Received by Open-Science. Select a destination and confirm the import there.'
}

continueButton.onclick = () =>
  void run(async (signal) => {
    if (!(await probe(signal))) return // No Blob download until the service is reachable.
    status.textContent = 'Downloading package…'
    const response = await fetch('/packages/study.science', { signal })
    if (!response.ok) throw new Error('Package download failed')
    const downloaded = await response.blob()
    signal.throwIfAborted()
    blob = downloaded
    transfer = prepareBrowserImport(blob, { filename: 'study.science' })
    openTransfer() // Best effort after await; direct-click retry remains available.
    await send(signal)
  }, true)

openButton.onclick = () =>
  void run(async (signal) => {
    launchOpenScience() // Synchronous click, before probe; does not create an import task.
    await probe(signal) // One bounded check; Check again is available if startup takes longer.
  })
probeButton.onclick = () => void run(probe)
// After a timeout, reconnect the same transfer without navigating or downloading again.
reconnectButton.onclick = () => void run(send, true)

function retry(fresh) {
  return run(async (signal) => {
    if (fresh || !transfer) {
      transfer = prepareBrowserImport(blob, { filename: 'study.science' })
    }
    // Reuse the transfer while its receiver is alive. A fresh transfer uses the retained Blob.
    openTransfer() // Still in this click's synchronous stack, before any await.
    await send(signal)
  }, true)
}
retryButton.onclick = () => void retry(false)
restartButton.onclick = () => void retry(true)
cancelButton.onclick = () => active?.abort()
render()
```

Cancelling a send retains the Blob but discards the transfer. Cancelling a probe preserves both. A transient transfer failure retains both
for resumption; a new transfer creates a new secret and port without downloading again. The SDK
cannot reliably distinguish an expired receiver from a blocked connection, so the example offers
an explicit **Start a new transfer** action. An abandoned partial receiver expires and cleans up.
Disable actions while an operation settles, including cancellation cleanup. To explicitly discard a
package, cancel and await that operation first, then clear both `blob` and `transfer`.

`send()` returns `{ received: true }` after the entire file reaches the local receive/import queue.
It does **not** mean all package checks have passed, a destination was selected, or import succeeded.
The desktop validates the package, asks for a destination and requires final import confirmation.
Those steps do not block the transport acknowledgment. No website receives desktop data or general
API credentials. Never put a remote URL, Blob URL or file contents in the protocol.

### Availability, phases and errors

`checkBrowserImportAvailability({ signal?, timeoutMs?, origin?, port? })` probes exactly one
endpoint, `http://127.0.0.1:49151/v1/browser-import/capabilities`, with a default 2,000 ms budget,
including the response body. It returns:

- `{ status: 'available' }`: a compatible, running, reachable service responded.
- `unavailable`: no reachable service, including opaque network/CORS/local-network denials.
- `unsupported-browser`, `incompatible`, `timeout`, or `aborted`.

An unreachable service is **not** proof that Open-Science is uninstalled or its protocol unregistered.
Local-network access may prompt; the probe is not guaranteed to be silent. Discovery is advisory and
can be forged by a local port occupant. It is never used for authorization. Only the temporary
secret-bound readiness proof authenticates the actual receiver; discovery alone permits sending
neither transfer credentials nor plaintext bytes.

`prepareBrowserImport(file, { filename?, origin?, port? })` synchronously prepares a complete,
browser-held Blob/File; it performs no network request. `filename` defaults to a File's name.
`origin` defaults to the page origin and must match it. It returns `{ readonly url, send }`.
`send()` accepts:

| Option              | Contract                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readinessMode`     | `attempts` (default) or explicit `wait-for-launch`.                                                                                                                       |
| `readinessAttempts` | Integer 1–5, default 5 in `attempts` mode. Ignored in `wait-for-launch`.                                                                                                  |
| `attemptTimeoutMs`  | Default 2,000 ms; accepts positive values up to 30,000 ms. In `wait-for-launch`, values above 2,000 ms are clamped to 2,000 ms. Includes headers and response body reads. |
| `readyTimeoutMs`    | Default 120,000 ms. Capped at 120,000 ms in `wait-for-launch`, 300,000 ms in `attempts`. Smaller positive budgets are supported.                                          |
| `signal`            | Cancels waiting or transfer; rejection preserves the caller's abort reason.                                                                                               |
| `onPhase`           | Optional callback with `waiting-for-receiver` or `transferring`.                                                                                                          |
| `onProgress`        | Optional callback with `{ sentBytes, totalBytes }`, after each authenticated chunk acknowledgment.                                                                        |

Default `attempts` mode is unchanged: five stalled two-second attempts and four one-second gaps
can take about **14 seconds**. Increasing `readyTimeoutMs` alone does not increase that attempt
count. Opt into `wait-for-launch` when a user may need more time to respond to the browser's
external-protocol prompt. It retries until this transfer's identity proof succeeds, the caller
cancels, an identity/compatibility error occurs, or the total readiness budget expires. It is not
cut off after five requests. Every failed request is followed by a 1,000 ms gap, unless the overall
budget or cancellation stops that gap. All readiness timers are cleared on completion or failure.

The browser's **Open application** permission prompt exposes no display, accept or cancel callback
to an ordinary webpage. The SDK does not infer acceptance from focus, visibility or elapsed time.
Only the current transfer's secret-bound handshake proves readiness. A generic `available` probe
is insufficient. Display waiting copy until that handshake succeeds; a timeout means only that
verified readiness was not reached in budget, not that the user rejected the prompt.

The overall budget covers request headers, response body reads and retry gaps. Browser suspension
can delay timer delivery; a late proof is rejected against the readiness deadline. These budgets
stop at readiness and **do not limit subsequent whole-file transfer**. Each transport request still
has its own timeout. Waiting never opens the protocol automatically: launch once from a click,
then wait. After timeout, call `send()` again with the **same transfer** and a fresh, non-aborted
signal to reconnect without another navigation or download. Each call gets a new readiness budget.

`onPhase('waiting-for-receiver')` fires before the readiness request.
`onPhase('transferring')` fires only after receiver identity verification, before encrypting/sending
chunks (or completing an already-uploaded file). It never fires for an already-received package.
Calling `send()` on an object with a cached receipt returns that receipt without network activity
or callbacks. The first progress event follows the first acknowledged chunk, not readiness; phases
let a website avoid guessing from elapsed time. Callbacks should not throw.

`BrowserImportError` extends `Error`, has `name === 'BrowserImportError'` and a stable `code`:

| Code                  | Meaning / recovery                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unsupported-browser` | Required browser capability is absent; pure launch requires a navigation API only.                                                                                       |
| `launch-failed`       | Synchronous navigation threw. Silent browser/OS refusal cannot be detected.                                                                                              |
| `readiness-exhausted` | Attempt mode exhausted its count; retry the same transfer when the receiver becomes reachable.                                                                           |
| `timeout`             | Readiness deadline elapsed (including launch-wait expiry); the same transfer may be retried without relaunch.                                                            |
| `incompatible`        | Receiver identity or cancellation response cannot be verified. Stop and prepare a new transfer after correcting the receiver; earlier chunks may already have been sent. |
| `cancelled`           | The desktop authenticated a cancellation. Terminal for this transfer; keep the Blob and explicitly prepare a new transfer.                                               |
| `transfer-failed`     | An operation after verified readiness failed, including network or acknowledgment validation; retry/resume or prepare a new transfer.                                    |

Discovery returns status objects for operational failures. Invalid arguments and concurrent
`send()` calls throw ordinary `Error`s; caller cancellation rejects with `signal.reason`, not a
wrapped SDK error. Do not parse error message text. A lost completion response can occur after the
file was queued: retry the same live transfer to recover its receipt before starting a fresh one,
which could result in another import. Browser-side cancellation after receipt cannot undo the desktop queue; use the desktop import controls.

Transfer recovery rules:

- `timeout` / `readiness-exhausted`: retain the Blob and transfer. Reconnect using `send()` alone;
  no implicit launch, download, or cancellation request occurs on timeout.
- `transfer-failed`: reuse the same live receiver to resume from its authenticated offset or recover
  a lost completion receipt. If it is no longer reachable, retain the Blob and explicitly prepare
  and launch a new transfer. Network errors cannot reliably distinguish expiry from blocked access.
- `incompatible`: do not keep polling an unverified identity. Correct the receiver/app version,
  then prepare and launch a new transfer from the retained Blob.
- Desktop cancellation (`cancelled`): the receiver returns a transfer-secret-signed cancellation.
  Stop retrying this transfer; subsequent `send()` calls reject with the same code without network
  activity. Keep the Blob if the user wants to explicitly prepare and launch a new transfer. This
  requires the updated SDK; older SDKs do not recognize this error contract.
- Caller cancellation: waiting requests/gaps stop immediately. Before identity verification the SDK
  sends no DELETE to an untrusted port; an abandoned receiver expires normally. After verification
  it attempts authenticated cleanup (up to two seconds). Discard the cancelled transfer and create
  a new one from the retained Blob; the SDK does not automatically recreate/relaunch it or enforce
  a permanent object tombstone. An already-aborted signal rejects again before network activity.
- Concurrent `send()` calls on one transfer are rejected. Sequential calls with a cached receipt
  return `{ received: true }` without another upload; this is not a new import. A new transfer may
  create a separate queued import, so reconnect first when a completion acknowledgment was lost.

`readinessMode` and `BrowserImportReadinessMode` are additive. Existing calls retain the five-attempt
behavior and existing phase/error codes. The wait mode works with the existing version 1 receiver;
no new desktop handshake or general availability dependency is introduced. Fetch `.mjs`, `.d.ts`
and the license from the same verified source commit when vendoring. No npm publication is implied.

### Receipt, validation and repeated imports

There is no website permission dialog, persistent origin allowlist, or authorization/revocation API.
The launch protocol binds a fresh secret, exact Origin, transfer port, filename and size. Host/Origin
checks, authenticated requests/receipts, encrypted chunks and staging limits apply to every transfer.
The desktop uses the existing package inspector before destination selection, including archive
path and content validation. Final import revalidates the staged archive and retains the existing
`packageOrigin` and `receipt.json` provenance; no separate browser import ledger is created.

Repeated delivery of the same protocol secret is handled once. The desktop queue also deduplicates
the same active/queued local path. These are transport/queue protections, **not** a ban on repeated
imports: sending and importing the same package again with a new transfer creates an independent
session using the existing import rules. Package content may be shared while session identities
and import receipts remain independent.

Discovery starts when an authenticated Electron desktop attaches to the Node receiver, and closes
with that runtime. A surviving background runtime can still answer discovery; the protocol launch
brings the desktop forward. The headless general API is unchanged. `OPEN_SCIENCE_BROWSER_IMPORT_DISCOVERY_PORT` can override the single discovery
port for isolated development; pass the same `port` to discovery SDK calls. `port` in
`prepareBrowserImport` remains the separate ephemeral **transfer** port. If another profile owns
the discovery port, discovery is unavailable for this profile; existing protocol imports still work.
Do not scan ports or substitute the general desktop API.

## Requirements and recovery

- An installed desktop build with the `open-science` protocol association. Development builds do
  not take over the user's installed application's protocol association.
- An HTTPS website, or an HTTP loopback origin for local development. Cross-origin package
  downloads must already be permitted by the package host's CORS policy.
- Browser support for Web Crypto, `Blob`, `fetch`, and `AbortSignal.any/timeout`. The browser may
  ask permission to open Open-Science and to access the local network. Users must allow both.
  Browser/enterprise policies may prohibit loopback requests; offer a normal file download and
  local file-open import as the fallback. HTTPS-to-loopback compatibility is browser-dependent;
  browser behavior requires separate validation for the supported browser and OS.
- If the website uses CSP, allow the loopback receiver in `connect-src`, for example
  `http://127.0.0.1:*`, in addition to the site's existing download destinations.
- Version 1 accepts nonempty packages up to **2 GiB**, sent in **4 MiB** chunks. The website owns
  storage of the completed Blob; the SDK only reads one chunk at a time. This browser transfer
  limit is intentionally separate from the desktop archive format's larger limit.
- Filenames must fit both 160 UTF-16 code units and 255 UTF-8 bytes, and cannot use Windows reserved
  device names such as `CON.science`. Both the SDK and receiver validate these portable limits.
- A transfer has a two-minute idle timeout. Keep the same transfer object and call `send()` again
  after a transient connection failure to resume from the acknowledged offset while the receiver
  is alive. Cancellation removes a partial transfer; prepare a new transfer before retrying it.
- If the port is occupied, the app is absent, or the receiver expires,
  sending fails or times out. Prepare a new transfer (a new secret and port), then click Open again.
  There is no silent port scanning, external-app detection, or remote download fallback.
- Received files remain available for the desktop import queue and retry UI. They are removed when
  consumed, explicitly discarded, replaced as a retry source, or the runtime shuts down. Abandoned
  files from a crashed runtime are cleaned before the next browser transfer starts.

## Pure launch protocol

`open-science://open` (also accepting a trailing `/`) only starts or shows the application.
Parameters, fragments, credentials, ports and extra path segments are rejected. It is routed from
cold-start arguments, second-instance arguments and macOS `open-url` events through the same
relay, with no call to the package receiver. It does not alter the version 1 import protocol below.

## Transport contract (version 1)

The launch URL carries `version=1`, the exact website `origin`, a random 32-byte hexadecimal
`secret`, a random `port` in 49152–65535, the safe `.science` filename `name`, and byte `size`.
There is no package URL, filesystem path, Blob URL, or file body in the launch URL. Treat the URL as
a credential: do not put it in analytics, logs, persistent links, or error reports.

When the protocol launches a transfer, the app binds only `127.0.0.1:<port>`. Every request must have the exact
`Host` and website `Origin`. CORS is scoped to that origin, without cookies. This receiver is
separate from the authenticated general-purpose web service; that service's CORS policy stays
unchanged. At most 16 transfer records and 2 GiB of advertised unconsumed data are admitted.

- `GET /v1/import/ready?challenge=<random 32-byte hex>` proves receiver identity using
  HMAC-SHA256 with the launch secret bytes over
  `open-science-import-v1:<challenge>:<offset>:<accepted as 0 or 1>`.
- Mutating requests authenticate with `Authorization: HMAC <hex signature>` over
  `<METHOD>\n<pathname plus query>\n<X-Chunk-SHA256 or empty>`, using the secret bytes. The secret
  itself is never sent in an HTTP request.
- `PUT /v1/import/chunk?offset=<offset>` carries a 12-byte random IV followed by AES-256-GCM
  ciphertext and its 16-byte tag. The AES key is SHA-256 of the UTF-8 string
  `open-science-encryption-v1:<secret hex>`, and additional authenticated data is `offset:<offset>`.
  `X-Chunk-SHA256` is the plaintext chunk digest. Offsets, digest, decrypted length and total size
  are checked before publishing bytes. Acknowledgments authenticate `offset:<new offset>`.
- `POST /v1/import/complete` requires the complete declared length, syncs and closes the file, and
  enqueues it once. The 202 receipt authenticates `received:<total size>`. Repeated completion is
  idempotent while the receiver is alive.
- `DELETE /v1/import` cancels a partial transfer. After receipt, the desktop owns the queued import;
  cancel it in the app.
- Desktop receipt progress is per transfer and uses actual bytes written after authentication and
  decryption. A valid import launch first shows the filename and `Preparing to receive package…`
  while startup finishes. The same desktop dialog continues through `Waiting for browser…`,
  `Receiving package…`, and `Validating package…` before destination selection and final confirmation.
  Presentation snapshots survive late renderer mounting; startup errors remain visible. Pure
  `open-science://open` does not create a receipt task. Neither 100% received nor
  `received: true` means imported: package validation, target selection and final confirmation follow.
- `Cancel transfer` stops receipt, joins any active disk write, and removes unqueued temporary bytes.
  If queue admission wins the race, the queue cancels that source and owns its release. Other
  transfers and imports are unaffected. A signed `410` body `{ code: 'cancelled', proof }` remains
  available on that transfer endpoint for the idle retention window (normally 120 seconds).
  `proof` is HMAC-SHA256 over `cancelled` with the transfer secret. The SDK verifies this proof
  before treating the response as cancellation; an unsigned or invalid proof is `incompatible`.
  The tombstone cannot accept more bytes or recreate the cancelled transfer. After it expires,
  network loss alone cannot establish whether cancellation happened.

The SDK verifies handshake and acknowledgment proofs and encrypts chunks even on loopback. If an
unrelated local process occupies or later takes over the port, it cannot read package plaintext,
learn the launch secret from HTTP, or forge successful receipt. This does not defend against an
attacker already able to inspect the browser/app process or intercept OS protocol delivery.

## Development

Use this task's existing ignored configuration from the repository root. Manual startup (not part
of this contract's automated verification):

```sh
sh .dev-isolate/science-protocol-import/run.sh npm run dev
```

The wrapper sets `OPEN_SCIENCE_USER_DATA` and `OPEN_SCIENCE_CONFIG_ROOT` under
`.dev-isolate/science-protocol-import`, enables `OPEN_SCIENCE_ALLOW_MULTI_INSTANCE=1`, and uses
discovery port `49151` (the SDK default). Websites may omit `port` in
`checkBrowserImportAvailability`; this does not change the transfer port range.

Focused automated verification uses the same wrapper:

```sh
sh .dev-isolate/science-protocol-import/run.sh npx vitest run \
  packages/open-science/browser-import.test.ts \
  src/main/session-package/browser-import-protocol.test.ts \
  src/main/session-package/browser-import.test.ts \
  src/main/session-package/browser-import-sdk.integration.test.ts --maxWorkers=1
```

Protocol tests cover cold arguments, running-app URL events and dispatch without launching an OS
protocol handler. The local receiver integration test uses real Node HTTP, temporary files and a
synthesized Origin header, not a browser or installed desktop. These tests do not establish OS
registration, browser prompt behavior, or real browser-to-desktop integration. No real desktop
integration is run for this contract change. Packaged macOS/Windows/Linux and browser permission
behavior remain separate manual validation boundaries.
