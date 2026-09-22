# Notebook command and REPL retirement acceptance

This describes the second cleanup-stability batch, PR #2918. Its prerequisite #2909 is merged.
The third batch's macOS independent-command admission is a separate change: this batch does not
promise that another Session can run while same-domain cleanup remains unknown.

## What a user can check

Ordinary UI use cannot reliably reproduce the bug. The failure requires a particular ordering of
process retirement, asynchronous capability acquisition, queued dispatch and late callbacks. Do not
kill the app, clear its temporary files, delete receipts or replay a failed research workload to
try to produce that timing.

A lightweight smoke check in a disposable project can verify normal behavior:

1. In Session A, request a short Notebook computation that prints a unique marker and returns a
   small deterministic result. Check its Notebook run appears once and has the expected output.
2. Execute another short computation in A, then in a separate Session B. Check their output and run
   history remain distinct, with no duplicate terminal results.
3. Use the normal Stop action on a disposable long-running computation, wait for its reported state,
   and submit a new short computation. Preserve any reported cleanup error; do not force past it.
   A cancellation need not retire a persistent kernel, so this step does not prove epoch revocation.
4. If the normal workflow reconnects the model provider, verify a still-live Notebook can continue.
   Do not restart the whole app to simulate provider-only reconnect.

These checks are optional product smoke evidence. They cannot prove old-token revocation or stale
callback isolation. Those acceptance checks are the implementing agent's responsibility.

## Deterministic engineering acceptance

Run from a checkout with prepared dependencies and a generated Prisma client matching its schema:

```sh
npm test -- packages/notebook-network-sandbox/src/index.test.ts \
  src/main/notebook/network-sandbox-owner.test.ts \
  src/main/notebook/runtime-service.rpc-retirement.test.ts \
  src/main/notebook/kernel-executor.test.ts
```

Use isolated fixture storage and fixture-owned child processes only. Record the revision, OS/Node
versions, exact command, exit code, counts and skip reasons. The tests use barriers to control races;
passing an arbitrary sleep-based manual reproduction is not a substitute.

| Behavior                      | Required observation                                                                                                                                       | Evidence owner                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Permanent command retirement  | Cleanup may retry, but the same retired command cannot reactivate or spawn again, during or after a failed attempt.                                        | Package and application sandbox owner tests               |
| Exact REPL authority          | Old capability works before retirement and returns HTTP 401 afterward; another Session and the successor return HTTP 200.                                  | RPC retirement composition test                           |
| Queue and dispatch identity   | A request queued before retirement binds to the successor's actual dispatch epoch; its persisted record matches that epoch.                                | RPC retirement composition test                           |
| Late resolver or cancellation | A capability arriving after retirement/cancellation is released; that request is never dispatched.                                                         | RPC retirement composition test                           |
| Old callback fencing          | Delayed terminated/idle callbacks for the old epoch or executor cannot revoke the replacement; repeated successor calls retain its identity.               | RPC retirement composition test and kernel executor tests |
| Compatibility                 | Python/R termination and provider-only detach/reconnect do not revoke an otherwise live REPL.                                                              | RPC retirement composition test                           |
| Pending output                | Retired invocation output remains associated with its original run until completion; shutdown discards late images even if completion was already pending. | RPC retirement composition test                           |
| Physical ownership            | Retries continue to use the original spawned process owner/epoch; complete proof is retained and incomplete cleanup is not silently forgotten.             | Kernel executor, owner and package tests                  |

The RPC composition tests use the real HTTP server, runtime service and repository with an injected
executor and image fixture. They prove authority, dispatch and persistence contracts; they are not a
real REPL subprocess crash or complete GUI end-to-end test. The kernel suite supplies real process
fixtures where available. Platform-gated skips do not certify Windows, Linux or WSL2.

Run `npm run typecheck`, `npm run lint` and the complete `npm test` when required by
`CONTRIBUTING.md`, including after conflict resolutions that affect ownership/consumer routing.
An independent review must confirm the final mapping and preservation of current main changes.
Keep an explicit distinction between the focused fault-injection run, complete local suite and
remote platform CI. Do not report a local macOS pass as Windows acceptance.
