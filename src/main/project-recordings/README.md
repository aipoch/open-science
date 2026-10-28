# Project recording evidence sink

This owner records evidence during an already admitted execution. It cannot create an environment,
start a program, navigate a page, evaluate project code, or create a Notebook Run. Replay only reads
the resulting ordinary Artifacts; `.science` and run-observation archive version 1 remain unchanged.

`startProjectRecording` receives Main-owned source readers, a bounded optional Artifact writer, and
the producer-generation guard. It samples declared image outputs immediately and then every two
seconds by default, retaining changed PNG/JPEG/WebP bytes. It caps frame count, decoded pixels,
individual bytes, total bytes, index bytes and read duration. Duplicate content at one source is
not written again. A `host-view` source must be supplied by the existing visible Electron capture
adapter; this owner never creates a browser. All capture failures are partial-coverage evidence,
not experiment failures. Call `finish` before the existing turn's write capability expires; it
drains admitted work and writes one `project-recording-<id>.json` index. `abort` cancels capture and
drains admitted writes, and `finish` can still publish partial evidence afterwards.

## Optional state and operation records

An author can explicitly declare an ordinary output named `project-recording-data.json`. Only this
declared output is read through the existing managed-output authority. It is UTF-8 JSON, at most
512 KiB, with this schema:

```json
{
  "format": "open-science-project-recording-data",
  "version": 1,
  "states": [
    {
      "id": "state-0",
      "sequence": 0,
      "reportedAt": 1791351200000,
      "label": "Initial state",
      "value": { "score": 0 }
    }
  ],
  "events": [
    {
      "id": "action-0",
      "sequence": 0,
      "reportedAt": 1791351201000,
      "name": "Move left",
      "data": { "actor": "agent-1" }
    }
  ]
}
```

Both arrays are required and may be empty. `reportedAt`, state `label`, and event `data` are optional.
IDs and increasing sequence numbers are stable within each channel. Repeated identical entries are
deduplicated; changing a previously recorded ID or reusing its sequence is rejected. Sliding windows
are accepted, but omitted sequence numbers are recorded as coverage gaps. Each array holds at most
500 entries; each JSON value has a 64 KiB, 16-level, 4096-node limit. Write the declared file
atomically from the project when practical; a partially written JSON file is a failed sample, not
permission to retry the experiment. Data is never evaluated. Strings that resemble commands remain
strings.

The index preserves the author's ID and optional reported time separately from Main's intake
`recordedAt`. These entries are labelled `author-declared`, not host-observed user interactions.
Host screenshots, original project-export images and explicitly derived frames retain their
provenance; the existence of a generated diagram does not establish that it was the original UI.

The index contains source version IDs plus checksums and sizes. Those sender IDs are evidence only;
the receiving reader must resolve them through its import receipt and local immutable Artifact
scope. Missing references must not launch the project or fetch a sender path/URL.

## Regression ownership

CI registers this sink and its shared contracts in `scripts/ci/module-impact/main_run_observation.json`.
This is test routing, not a requirement for a Notebook Run or the live observation owner: the sink
still accepts state/event-only output and operates without a viewer. The renderer's independent
project track, Results reader and material-selection lifecycle belong to `replay_observation`.
Pinned offline plan admission belongs to `research_reproduction`; screened publication belongs to
`notebook_application`. Existing source-regression capability overlays remain in force.

Run the colocated declaration/recorder/managed-adapter and shared project-recording tests for
capture and publication changes. For receiving-side changes, also run `recorded-results.test.ts`,
`ResultsPanel.test.tsx`, `ProjectReplay.test.tsx` and `use-recorded-materials.test.tsx`. These checks
cover immutable receiving identities, missing evidence, independent state-only records and stale
asynchronous replies; they do not establish scientific reproduction or installed-client acceptance.
The module ownership and consumer-coverage guards ensure changes to their dependencies retain these
tests in selective CI runs.
