# Phase 1 Agent loop acceptance

Track the gates in [the English implementation plan](real-agent-loop-implementation-plan.en.md)
and [the original Chinese implementation note](real-agent-loop-implementation-plan.md) and
[spec #54](https://github.com/guch96/open-science/issues/54). An installed package, an Agent
turn, a Notebook dispatch, and verified files are separate observations.

## Terminal API provider setup: November 21, 2026

The macOS arm64 and headless Linux arm64 npm candidates passed the same installed-package
journey. A standard MCP stdio client did discovery from an empty profile, selected the built-in
Agent, and received an `enter_provider_credential` action for each of Messages, Chat Completions,
and Responses. The test ran each returned command verbatim in a terminal. The profile path
contained spaces and an apostrophe. For each protocol it observed cancellation and a rejected
key without a saved Provider, hidden input on the successful save, a matching request at the
fixture Provider endpoint, and a duplicate command rejected before accepting input. Reconnecting
MCP found the same ID, model, and validation protocol. Explicit activation separately returned
Agent readiness. The suite used synthetic keys, no browser, no model-key environment variables,
and no host-specific form. The Linux test opted into existing file storage for the disposable profile.

Service regression tests resolve the installed Anthropic and OpenAI model routes as Messages and
Responses respectively, and reject a changed protocol or endpoint before sending a probe. The
Windows PowerShell command is implemented; a Windows terminal run has not yet been exercised.

## Browser-free setup regression: November 21, 2026

After the premature launch below, `d63e139d9` made the README prompt explicit, removed browser
launch actions from ordinary readiness results, and documented when a selected Provider needs
a browser handoff. The actual macOS npm installation passed npm resolution, native loading,
and Electron-free startup. Its CLI tarball SHA-256 was
`896f0ff52c18251f0fb4e41e8e3ddc61ebd5a74f05c8648d3fd926b797140e8e`; the unchanged macOS native
tarball SHA-256 was `d6a225a1fc17aca50c0f5cb3bd9cf17c8c7dea22a6927e74661818ab27a341a9`.

WorkBuddy cached the earlier command after an on-disk configuration edit. The connection panel
was used to load and trust the verified local preview. A new WorkBuddy task then received the
exact revised README prompt, changing only the link to the fork commit. The fresh profile's
trace recorded seven discovery and readiness requests, including both languages, and no opens,
research, or package writes. An independent "where are the R settings?" turn returned
Settings > Runtimes > Notebook without a tool call. A third, explicitly authorized turn selected
the built-in Agent, activated the keyless Kilo Provider, and completed managed R preparation
under operation `e7d1eace-25c9-4de8-b307-70d8d5d839e4`. The operator did not open setup or
install Python. CLI JSON and WorkBuddy MCP agreed that Agent was ready, R was prepared, and
Python was absent. The Notebook execution readiness check separately reported host memory
pressure. The three turns had zero `open_setup` calls and zero research or package writes.

## WorkBuddy research and delivery: November 21, 2026

WorkBuddy 5.9.4 (Hy4 flash) connected to the actual `89010daee` macOS arm64 npm build using a
fresh profile and local MCP stdio. The exact short README prompt differed only in the URL for the
fork build. It discovered supported capabilities and found zero Projects and Sessions. It also
called `open_setup` (trace sequence 14, `launch_requested`); this confirms the browser launch was
requested, not that the page loaded. The setup prompt's request for directions should not result
in opening a browser. The separate configuration turn used MCP to select `open-science-agent`,
activate the keyless Kilo Provider, and prepare managed R 4.4.3 with operation
`f2b476d0-edd2-4e57-9654-3d6e1770a11a`. MCP and CLI JSON agreed on Agent and R readiness. Python
remained unprepared. That turn did not call `open_setup`.

WorkBuddy created Project `cmwq88zmp0000jgachtswc1hh` only after the separate study request.
Request `81be68a4-face-4f27-a748-d5190cb13dba` admitted Run
`7f0e2068-a9d1-403a-bf9c-d5e87cd637b9` in Session `69ba13a2-8c7d-4141-a34b-05771baaa930`.
The runtime and code review showed `kernelDispatched: false` before the synthetic test operator
relayed one-time decisions in WorkBuddy. The sandbox refused a copy from the external delivery
directory. A root AskUser response authorized relaying the known CSV content, producing linked
Run `3f79ec71-0cd4-4aea-a003-05c0c3a9f31e`. That Run acknowledged the choice; the next request
supplied the exact input rows to the same Session. Request `986122da-9dad-466c-97e9-f284ba95ea5c`
admitted Run `ec80009c-a38e-478f-9b8f-c8f593fad146`. After declining the separate permission to
install `dplyr`, the same Run completed real base R Notebook `notebook-run-1795254976121-9`
with `kernelDispatched: true`. WorkBuddy recovered its bounded wait timeouts by querying the
existing Run. None of these decisions or business operations required an Open-Science Web UI.

| WorkBuddy delivery         | MCP download or operation ID           |   Bytes | SHA-256                                                            |
| -------------------------- | -------------------------------------- | ------: | ------------------------------------------------------------------ |
| `greenhouse_report.md`     | `effeca1f-89dd-42c1-ac5a-d7086aab38cf` |     761 | `05f57e7b80fb01c3e9c905d17dd734b61352b201bd0b6e407b3853e3e8ad9f1c` |
| `greenhouse_results.csv`   | `6411463c-9b7a-4b2b-8fb9-79a7f96aafbd` |      61 | `81fff5f2a1d733a530e83e7b1479b4334d3003ed84dee0dd065454a322665838` |
| `greenhouse-study.science` | `88342a49-b8cd-4414-b39f-7600b4b71482` | 133,849 | `6f64a81e0b3e9d9230cc26e2017db401e7879b6bd6fef2f061214bb04dc9d91b` |

MCP reported `handoffStatus: complete` for the research and `delivery.status: verified` for
the export. Both downloads matched the MCP receipts. The archive contained the exact input
(`133bd5847fe8ede80adc34e1274442466931914adb50f196cafeb63eefc42abc`) and both delivered files;
all 19 inventory records (14 unique entries) matched their bytes. Independent recomputation
gave counts of 4 in both groups, means 13 and 17 cm, and treatment minus control 4 cm. This
synthetic package did not trigger sensitive export review. Only this archive was handed to
the independent receiving environment.

In a separate Plan First Run `8494bc30-c256-47ef-8b01-80237a390133`, WorkBuddy allowed plan
generation, presented version `f5c8da47-c54c-4996-9d49-27ec8a29bf29` at revision 3, and waited.
The operator added and withdrew delegation in separate turns. The same Run returned to `relay`
at revision 2 with the plan still pending. WorkBuddy then relayed explicit approval of the read
version. It presented a new AskUser question, which the service identified as a main-task
question. After an actual service interruption, WorkBuddy rediscovered and answered that
pending question on the same Run. The linked Run
`70740fd9-21f0-4205-a412-d6106a3056de` encountered Notebook stop
`1ccdd20a-7ede-4b9e-991f-532a32105179`. The test operator explicitly chose to continue that
stop in the conversation. MCP returned new request `60255eed-2a0c-4b32-bafb-a328b13ee184`
and Run `eab67021-edd9-47ca-b6a7-e1a6bddd58e8`, which completed. The stopped cell was not
replayed or reported as a confirmed Notebook dispatch.

## Delegated question recovery and parent settlement: November 21, 2026

WorkBuddy 5.9.4 and a live model used the installed `8a3f8a4fd` macOS build. Original request
`gr-review-replay-20261121-8c4f2a` completed Run `ef95d632-2927-4c03-a773-2ba8e5e5fe9e`.
The operator chose `GROUP COUNTS` in the existing conversation. MCP recorded `user_relay` on
the child question and linked completed Attempt `attempt-10e83dba-8eff-4415-af1f-f27299a98eb1`
in Frame `frame-473dc6be-9c27-4133-bbf7-07fa832166d7`. The linked parent Run
`dc45f740-43ee-4af5-b760-c8112d160c1d` dispatched to the Provider. It confused the child
Attempt with a Notebook background Run, then passed the child handle to `host.agents.switch`.
The malformed argument became a request to switch to Main Agent, which parked on an approval
outside the Task interaction list. The parent's bounded waits timed out. An independent
installed MCP client confirmed the child was complete and the parent was still running with no
listed interactions. It cancelled only the stalled synthetic parent Run and observed `cancelled`.
There was no replacement submission, service restart, or confirmed Notebook dispatch in that run.

`daef8c104` supplies a non-blocking `host.collect` call in the settlement prompt and rejects
malformed Specialist switch targets before creating an approval. Valid named targets and explicit
`null` still use the existing approval. The macOS npm pair passed the installed-package check;
the CLI and native tarball SHA-256 values were
`896f0ff52c18251f0fb4e41e8e3ddc61ebd5a74f05c8648d3fd926b797140e8e` and
`446d148b76510992907234ff5848118e8b744df8778c06a8558af7c3e10a6270`. Six suites (229 tests)
passed, including real REPL validation. In the installed MCP replay with a scripted Provider,
the parent completed after one settlement dispatch. MCP reconnected to the same service, relayed
one answer to the child continuation, and reported `changed: false` for the duplicate answer.
The child continuation completed after one Provider wake. This fixture does not establish the
final WorkBuddy conversation result.

On the same installed build in a fresh macOS profile, an MCP SDK client replayed the scope
question with the live keyless Kilo Provider. Request `d5adba2d-2512-4605-abe4-4a92968ecbdb`
admitted Run `8e8ddc8e-f7a9-479c-b253-32388deec7b6`. Linked parent Run
`5df50bb4-848c-4f27-a8d2-504262943b12` called `host.collect` once and completed without a
Specialist switch. It collected the original Attempt's waiting response and presented the
question. The client relayed `GROUP COUNTS`; child continuation
`attempt-feccbfa1-636d-4de9-acf9-a1ab69b2329a` completed and a duplicate answer returned
`changed: false`. The parent reported the question before receiving the new Attempt's output.
This shows the parent can finish without the unrelated approval and that the answer resumes the
child. The test used no Python or R cell and made no file delivery claim. It did not use the
WorkBuddy desktop client, whose window was unavailable while macOS was locked.

### WorkBuddy desktop replay of the fix

WorkBuddy 5.9.4 (Hy4 flash) reconnected to the installed `daef8c104` macOS arm64 npm pair on
the prepared test profile. MCP and CLI JSON agreed that the Agent and R were ready and Python
was absent. The first scope request created a project over MCP but used WorkBuddy's own
reviewer; that question was skipped and does not count as Open-Science execution. The next
request specified that the reviewer should run inside Open-Science, without naming any tools
or call order.

Request `gsr-scope-review-20261121-1926` admitted Run `af2161b7-97d4-4431-abe4-5f40a9e9f705`
in Session `dafc60f6-49c8-48de-92da-4f509e12f48c`. The original Run used the default `relay`
policy and exposed a scoped child question. The automatic parent Run
`035b7094-a808-4852-9402-582658b232d6` used `host.collect` and completed before the answer,
reporting that the child was waiting for input. No Specialist switch or hidden approval
interrupted it. WorkBuddy presented the question in its own conversation and read the
interaction again before relaying the operator's `GROUP COUNTS` choice. Two invalid requests
were rejected. WorkBuddy looked up the schema and retried successfully on the original Run
with `user_relay`. The child continuation `attempt-f88deb8a-89f4-4be2-872a-9a2103a325f4`
completed. Both Run scopes had no remaining interactions, and WorkBuddy identified the older
waiting messages as historical output.

When asked to read the finished review, WorkBuddy submitted one short reporting turn in the
same Session (`gsr-scope-report-20261121-1930`, Run
`b0b9bcb2-8b4f-4b6a-8f83-40fae0d82c84`). It followed that Run after a bounded timeout. The
main Agent used `host.children` and `host.collect` on the exact resumed Attempt, then
reported `GROUP COUNTS`. WorkBuddy returned the result and both identities. The MCP trace
contains one study submission, one reporting turn, one accepted answer, and no `open_setup`
calls. No replacement study or new reviewer was created. This scope review did not perform
Python or R analysis; the Notebook and file delivery evidence is recorded separately above.

### Installed sensitive export review

An independent installed `8a3f8a4fd` MCP stdio run used a scripted loopback Provider and a
synthetic credential pattern. The staged findings were redacted and the destination stayed
absent before the decision. Rejecting operation `317393b9-6079-4adb-b6af-a00eee97fe3e` did not
publish a file. Task delegation and a mismatched candidate digest could not approve operation
`f33cff54-f21a-485d-8e8d-b2a6e2af7992`. A scoped `user_relay` approval of that operation moved
from `pending` to verified delivery when queried by the same ID. The resulting 2,782 bytes
matched the reviewed digest `51987a201976bb80f289fffa5be2ede838d34ab42c1e98ea59f492bf50d9eaeb`.
The operator responses were simulated for this test. The greenhouse archive did not require
sensitive review, and no live OAuth sign-in is claimed.

## Independent receiving Agent: WorkBuddy package

OpenCode 1.19.5 with a live Hy4 model received the WorkBuddy archive in a fresh Debian 13
arm64 container running the matching `89010daee` Linux npm build. This container had its own
profile and Secret Service, no host mounts, and working Bubblewrap with host cgroup visibility.
No source database, working directory, or credential crossed. The source package matched its
digest and size in the receiver. The first turn used the short README prompt and the binary
attachment and performed only discovery and readiness. The host's text pre-read failed on the
binary attachment; MCP imported the same file by local path only after a separate request.

Import operation `c9ddc321-f8d5-45c4-9afc-0f06b7641d13` yielded read-only Session
`import-b336ad27-cd8c-4766-95b1-c44747ef8ec9`. Its two historical Artifacts matched the original
downloads; inspection ran no Notebook. The receiver selected the built-in Agent and keyless
Kilo Provider and prepared R independently. Explicit Fork consent created writable Session
`5aeff623-4c58-4ca8-9969-51b71d70b58b` through operation
`b1fad4d1-317c-4782-869b-02352367aec9`. The source Session stayed read-only.

The separately requested study used new request `30ff2107-e652-4b54-80a8-15d8dac175ff`,
Run `478e5704-e8a0-4d83-91dc-28c6ff00647d` and default `relay`. OpenCode treated the
requested managed R interpreter as the user's approval of that binding in the same turn.
It later waited for an explicit decision on a proposed shell write, relayed the operator's
refusal, and queried the original Run after a bounded timeout. Managed R Notebook
`notebook-run-1795255522069-7` completed with `kernelDispatched: true`. Independent
recomputation verified sample variance `20/3` cm² and range `6` cm in both groups.

| Receiving delivery            | MCP download or operation ID           |   Bytes | SHA-256                                                            |
| ----------------------------- | -------------------------------------- | ------: | ------------------------------------------------------------------ |
| `greenhouse_followup.md`      | `37ce3b87-0a4c-4305-8538-c3878f72db5c` |   2,019 | `04a8c037e0bf246e83cfe9d01b0bae5396b0c91ec2b86435900d4910a19457de` |
| `greenhouse_variance.csv`     | `e1db1866-3134-48ee-9ad5-5da3bc79fea3` |     101 | `92e7e8dcac04a52f3b8ac201fdab4efc985a9f0d2d5da896ccfbc19ac2dec59a` |
| `greenhouse-followup.science` | `6a217375-dc7b-4d92-abb8-76d4df7cb5d7` | 300,363 | `4d9a5e5191bb125a1d004c801b5b808b2d0279f7400cb5a9327bcedf1499241c` |

MCP verified both new downloads and the export. All 30 archive inventory records matched,
including both historical Artifacts, both new Artifacts, and the unchanged input. After an
actual service restart the same OpenCode conversation recovered the original request, Run,
Notebook and verified delivery, without another submission. The export lookup returned
`unconfirmed` after restart while the saved bytes still matched the original digest. The trace
contains one import, one Fork, one research submission, and one export.

## Installed cold startup and external Agent handoff: November 21, 2026

The actual macOS and Linux arm64 npm installations from `10186febe` passed npm resolution,
native loading, and service startup without Electron. Both CLI tarballs had SHA-256
`04a40fed8bf8bd5276ba62777e6b1639c1dbc98e49b8ab6bec06fa62373ceb9f`; the macOS and Linux
native tarball digests were `09783c70914325bf1c03ebbf831c628be3bbd3bbcffc379fbd2ace8b4a6a10b8`
and `420d87781d7369dcd8e7c7362bfc17eea0f83adbaf62979cc64292770625fa59`.

- The earlier `a5146a817` macOS install reproduced `EADDRINUSE` when a fresh MCP profile tried
  to start on the occupied default loopback port. Its first `doctor` call also probed before
  startup settled. The fix binds a free loopback port for a new MCP profile, waits for its
  startup on readiness calls, and reuses the daemon for the same profile. With port 44100 still
  occupied, real installed stdio connected to a fresh profile on port 55188. It returned
  `service: ready`, no selected runtime, unprepared Python and R, and an empty Project list.
  Reconnecting retained the same PID and port. The 226 CLI, MCP and runtime regression tests
  and all 2,992 architecture checks passed.
- OpenCode `1.19.5` received the README quote with only its URL changed to the matching fork
  commit. It started the new macOS profile through MCP, read the guide and catalog, checked
  both languages, and made no setup writes or research submissions. In a separate run on
  `a5146a817`, OpenCode selected the built-in Agent, saved and activated an ordinary local
  custom API Provider, then installed R through MCP without preparing Python. It reported
  `notebook_memory_pressure` separately from the prepared language. Stopping the local test
  model relieved host pressure without changing product memory policy.
- Direct MCP stdio from `a5146a817` used a deterministic Provider with the real macOS service
  and managed R kernel. Request `83c431d2-f887-49ff-bd64-c182b1a0fb1c` was admitted as Run
  `bfa48358-4706-4c3a-81e2-5cb352f3bb24`. Notebook `notebook-run-1795251910182-1` dispatched
  and the adapter verified its report and table (`7c524acf-53b3-4bf9-8ae0-038d1bbc1b3b` and
  `914e5e9a-bcd9-441b-8e37-1673a2cf4742`). Export `0aa98ff5-c76d-4cb4-b823-ff869d0aa105`
  produced `greenhouse-study.science` (61,928 bytes, SHA-256
  `7b131b33fff79c3fbcabd384f3cab383d15eb5c23f418bb47ff10b82b0038736`). All 19 inventory
  records matched the archive. A service restart preserved the original request, Run and
  Notebook identity. Independent calculation verified counts of 4, group means of 13 and 17 cm,
  and a 4 cm difference.
- An independent Debian 13 arm64 container received only that package as research state. It
  used its own Secret Service, no host directory mounts, and the `a5146a817` Linux build. Real
  OpenCode did not import from the short prompt with the package. It imported on a separate
  request (`1bc608e0-e504-4ed3-8085-9f9279f1a155`), inspected the read-only Session and historical
  outputs, and waited for the operator's explicit decision to Fork
  (`ef6ded58-4331-4c29-8440-f824d2c67440`). A separately configured, live keyless Provider
  ran request `greenhouse-followup-001`, Run `234a4da1-92d0-48a6-b557-0bed48579d77`. Before
  the operator relayed approval, the R runtime review showed `kernelDispatched: false`. The
  operator later declined an unrelated shell write; the same Run used an authorized path and
  completed Notebook `notebook-run-1795252421928-3`. OpenCode verified both new local Artifacts
  and export `1a5e9404-403c-4dc8-b67e-f8771ddab368` through MCP. `greenhouse-followup.science`
  was 139,744 bytes with 27 matching inventory records and SHA-256
  `68f55be6c2374305c83b6aa0a9cc64b12cc38b3cd3244ffdb9fa2eb491703f11`. Independent
  recomputation confirmed sample variance `20/3` cm² and range `6` cm in both groups.
- OpenCode's binary attachment preview could not read the archive as text. No import occurred
  during setup. The separate import request supplied the same local file by path, which MCP
  read normally. A host that cannot attach `.science` files can use this local-path workflow.
- The Linux service restart recovered the same accepted request, Run, Notebook and verified
  report/table. The original export operation was `unconfirmed` after restart even though
  the file still matched its pre-restart digest. The Agent queried the original operation and
  did not resubmit or re-export. The original import stayed read-only throughout.

WorkBuddy 5.9.4 saved a separate connector for the new install; all three old Open-Science
entries and their enabled states were preserved. The desktop bridge lost its window before
first-use Trust, so no MCP call or research submission is attributed to that connector. The
Linux replay above used the direct MCP fixture package, not a WorkBuddy-produced archive.
At this checkpoint, neither #80 nor #81 had passed. The later WorkBuddy-origin archive replay is
recorded above. No package was published to npm.

### Installed AskUser recovery and live task delegation

Both npm builds from `89010daee` passed installed resolution, native loading, and startup.
The shared CLI tarball digest was `678f95559eaa7bdfe0ae47e41f7e8b7142694eaf51f75327b2d747125121557b`;
macOS and Linux arm64 native digests were `d6a225a1fc17aca50c0f5cb3bd9cf17c8c7dea22a6927e74661818ab27a341a9`
and `e96626b8a03df5ffccf7e10b4b7aa7a527460d017793d14a14e08515702ea2ae`.

- With the actual macOS service, local MCP stdio and a deterministic Provider, #73 reproduced
  a delegated question whose new Attempt failed before provider dispatch after an interrupted
  service. On `89010daee`, the restarted service retained request
  `08ef9662-866b-4ebe-9d3f-78aae74b7468`, original Run `dafdef0e-6631-4297-88d6-8a8a3af8000e`,
  question revision and source Attempt. The relayed answer drove new Attempt
  `attempt-0b9a1539-44be-441b-acf6-31f77c397f0d` to completion. Repeating the same answer
  returned `changed: false`; the Provider received exactly one continuation with the answer.
  Disconnecting only MCP also passed and retained the same service PID. An explicit clean
  shutdown expires an unresolved live question. The regression checks that the recovered
  child can receive the answer without reacquiring the original Notebook authority.
- In a separate live model run on macOS `10186febe`, OpenCode configured Kilo and prepared R
  through MCP. The default relay test reached an R runtime review without kernel dispatch but
  the service was no longer running after that headless host turn ended. The next call
  recovered the failed Run and refused the expired approval instead of resubmitting. The
  operator started the same profile independently using the CLI and separately authorized
  a new synthetic study with task-local delegation. Request `gh-r-run-20261121-b1`, Run
  `e7118d00-8954-431e-b8fd-768a32147efc`, used a scoped `delegated_agent` review response
  and completed Notebook `notebook-run-1795253184772-1` with managed R. OpenCode downloaded
  and verified two Artifacts through MCP (`20fe0c57-f2b5-40d2-bf0a-7c25501e21d1` and
  `9a410b72-b58f-45c4-a021-9789fba52d5c`). The host paused after downloading; the test operator
  completed the handoff through direct MCP stdio on the existing Run. Export
  `34a3b750-103b-4e53-b448-33110d38f0e6` delivered `greenhouse-study.science` (73,115 bytes,
  SHA-256 `928d66e7b019bf2920802f5d0b9ec31d1f0b18330b9efa91d760f0b14198293d`). All 19 archive
  inventory records and both downloaded files matched; independent calculation reproduced the
  counts, group means and 4 cm difference. The WorkBuddy connector still needs its first connection.

## Task setup preview: Linux arm64, November 21, 2026

The npm build from `ee0edc803` includes [#77](https://github.com/guch96/open-science/issues/77)
and [#78](https://github.com/guch96/open-science/issues/78). Its installed-package test passed
real npm resolution and native loading without Electron. The CLI tarball SHA-256 was
`d09788df64e9fbb1eef63923224daf21c9c4949f01efdfa481c5926db218b415`; the Linux native tarball
SHA-256 was `d5afcea87f63454ab2e75bab6fca476cce1fb19fd292c101eca3a098cc3571a6`.

In a fresh Debian 13 arm64 container (no source mounts, Node `24.22.3`, own Secret Service),
the installed MCP server's read-only check found no selected runtime, no configured provider,
and neither language installed. Separate MCP calls selected `open-science-agent`, validated and
saved a custom API provider for a real local Qwen3-4B model, then activated the exact selection.
The model server had no access to either profile. The model URL used a loopback relay inside
the container after the existing URL policy rejected HTTP for a non-loopback hostname. The
fixture supplied a synthetic environment value; there was no credential handoff.

The MCP client initiated managed R operation `a878e181-6896-46bd-8ec3-43b52d85ba6e` with a
1 ms observation budget, closed the transport while setup was pending, and queried the same
operation over a new transport until it completed. MCP status and CLI JSON agreed that Agent
and R were ready, and Python was still absent. Project lists remained empty. This is installed
setup and disconnect evidence only. No WorkBuddy conversation, research, Notebook dispatch or
file delivery was part of this run.

## Task interaction preview: macOS arm64, November 21, 2026

The installed npm CLI and native runtime built from `a16448a4d` passed real npm resolution,
native loading, and the standalone startup check. Their SHA-256 values were
`630f310cdb53d6fdccb6e399563842347fccb592c8b909600330e05b88bd7bcb` and
`090214025c179c0e0503b0fd0ca513cf7b95926adde7853206c28fabf6bf4ba4`. Actual MCP stdio exposed
Plan, ordinary permission, AskUser, Notebook continuation, and sensitive export responses.
CLI JSON and MCP agreed on an unset Agent runtime and separate unprepared Python and R
environments in the new profile. The MCP Project list was empty after discovery.

The earlier `fbdc980eb` package admitted a real Plan First task with the local Qwen3-4B provider.
The model processed the prompt and generated tokens, but no Plan interaction appeared during
the bounded five-minute probe. The Kilo free route also admitted a Run without yielding a Plan
in that observation window. No Plan decision or new Run is attributed to either probe. After a
controlled restart of the Qwen test profile, CLI JSON recovered accepted request
`a58208fb-ac69-44e6-bba2-a23f8d002206` and the original Run
`963b646d-dda5-4599-9c62-e658cd6ba57d` with `failureCode: process_restarted` and unconfirmed
Notebook execution. No replacement request was sent.

The WorkBuddy 5.9.4 window showed the older Notebook review stop without dispatch. When the
preview package was ready, the computer use session could no longer attach to the WorkBuddy
window. The preview therefore verifies installation, discovery, and restart lookup; it does
not pass the WorkBuddy or independent receiving environment gates in #80 and #81.

### Managed R dispatch with a live model

The installed macOS arm64 build from `0dd064848` used CLI tarball SHA-256
`f942c5939a8f91dfe1c9ceefd7fb039475cb0f7bc4b94ce6f9dd2db0d3cd8dc1` and native tarball SHA-256
`138358538f9a71817335812c64d68d56f126e385d36853d08d6bc13a1d24cad6`. An MCP client prepared managed
R and verified readiness after reconnecting; Python remained unprepared. A real local Qwen3-4B
model requested `default-r` in Run `480dc334-db9b-40a0-bcab-70116572c645`, under durable request
`422cafe3-5144-4a70-93df-1161e3177478`. Execution was waiting for review with `kernelDispatched:
false`. The synthetic test operator relayed the review for that environment through MCP. In
the same Run, Notebook `notebook-run-1795247171409-1` dispatched and printed `12`. Repeating
the decision through CLI JSON returned `changed: false`. The observation also exposed a
missing `execution.language` field, fixed in `73eadaf5d`.

The subsequent greenhouse study (`ef495b54-845f-4133-9f54-f1219dee6503`, Run
`d268c732-69c0-4554-a99d-2af6f0008dec`) reached the model's output limit without dispatching
a Notebook. Its Run failed and had no Artifacts. These are real model and installed Notebook
observations from a direct MCP client, separate from the WorkBuddy conversation gate.

## Existing Notebook interpreters (#79): macOS arm64, November 21, 2026

The `ffadf8047` build passed installed npm resolution, native loading and startup with
Node 24.22.2. The entry and native tarball SHA-256 values were
`aef9f2a525a0b2f2c47107c77101cfd46833eba535d46bbbc2094b8899e9b662` and
`97e93e5676993ca6ae116ad4dc38954ab1883ae9ad05101b1e2e4516dc920c9f`.

Two fresh profiles had neither managed language prepared. Actual MCP stdio registered and
enabled two existing candidates for the requested language, passed the exact `runtimeId` and
language to `start_run`, and received an accepted durable receipt. CLI JSON and MCP agreed on
the available interpreters, the same-Run review and the final execution evidence. Both reviews
showed `kernelDispatched: false`; a response for the wrong language was refused, and the
fixture relayed the one-time decision for the exact requested interpreter on the original Run.

| Language       | Task Run                               | Notebook Run                   | Stdout   |
| -------------- | -------------------------------------- | ------------------------------ | -------- |
| Python 3.12.16 | `2bb12be9-bb8f-4ca4-b9b7-35104be0b149` | `notebook-run-1795248180444-1` | `12.0`   |
| R 4.4.3        | `ff4a3aa7-87d1-426d-a4bf-b6690ed9472c` | `notebook-run-1795248124010-1` | `[1] 12` |

Both completed with `kernelDispatched: true` and `runtimeSource: external`, and reported the
selected external interpreter's exact identity. The other language remained unprepared. The
first external Conda R run reproduced a macOS sandbox block at its own `lib/R` launcher.
The fix allows the selected external Conda R's library tree to be read and keeps writes and
unrelated paths denied; a real-kernel regression checks both boundaries. The provider response
was deterministic in this check. The runtime, Notebook dispatch, isolation, and output were
real; this check did not exercise WorkBuddy or a live model.

## Installed delivery and independent R continuation preview: November 21, 2026

The source used an actual macOS arm64 npm installation from `331d078d2`; the independent
receiver used the Linux arm64 installation from `a7bb7ac56`. The functional source was the
same. The CLI tarballs shared SHA-256
`aef9f2a525a0b2f2c47107c77101cfd46833eba535d46bbbc2094b8899e9b662`. The macOS and Linux
native tarball SHA-256 values were `4ce6e6100cc9e1e38756924e82dfd02e350c4f6e22ff0b88769b9dff77e7fbc7`
and `c161e8c43ea5e881df6e5a109a42afef2b084cd3ae3a1a7754f1f1978ae0ec08`.

Both used direct MCP stdio and a deterministic Provider response to test the real service,
managed R kernel, and file operations. The CLI handled service startup and read back the
source receipt as JSON after restart. Fresh profiles had no Projects, runtime selection, or prepared
Python or R. The harness selected the built-in Agent, validated its local API Provider, and
prepared only R through MCP. It used the exact runtime ID returned by discovery.

- On macOS, request `b19a7318-db1d-449b-80c8-e7aa383defb8` admitted Run
  `8b289765-fffe-493c-8768-8bc691574dca` in Session `5895006f-fbb7-466b-9b2f-05151aaf00ba`.
  Notebook `notebook-run-1795249315441-1` completed with real R dispatch. After restarting
  the service, CLI JSON recovered the original receipt and MCP still reported the same
  Notebook execution. Artifact download IDs were `de33651b-7410-4219-8fea-b9aa6ced4d79`
  and `e9258afb-69bc-488a-b054-906acdc15e47`. MCP download, delivery check and export lookup
  (`8a7ea6a4-3d80-4b83-bb2c-76f1f822f456`) agreed on the source files. Independent calculation
  confirmed four observations per group, means of 13 and 17 cm, and a difference of 4 cm.
- Only `greenhouse-study.science` crossed as research content into a fresh Debian 13 arm64
  container. It ran as an unprivileged user with Node `24.22.3`, its own Secret Service, and no
  host directory mounts. A preliminary container with a private cgroup namespace stopped
  before dispatch with `NOTEBOOK_MEMORY_UNAVAILABLE`. The successful container used host
  cgroup visibility and allowed nested namespaces and private procfs mounts. Bubblewrap and
  the product memory check both passed. No application isolation was disabled.
- The receiver matched the source package hash, queried import `57d51a04-230a-453c-9c57-247b56017ec3`,
  and confirmed that Session `import-7398a61a-08f1-41bb-b526-0db7c4e4d79f` was read-only
  with both historical Artifacts. Its fixture operator then created and queried Fork
  `e6ffb021-d6d2-4ca6-ba0e-4db3ee9656a2`. Writable Session `ebbd118e-2be5-4063-90da-a85c209f24ce`
  admitted fresh request `bb61ebd1-ef44-4afd-8295-dce5c1b707bc` as Run
  `15dd888e-7027-4747-8c5e-125486766747`. Notebook `notebook-run-1795249827552-1` read the migrated
  input, dispatched R, and produced new report/table Artifacts. MCP completed delivery and
  verified export `d6dd1426-2ce6-483d-8bbf-9a0f9f478d1a`. The original Session remained read-only.
  Independent calculation confirmed sample variance `20/3` cm² and range `6` cm in both groups.
  With `sleep` as PID 1, the test container did not reap exited children; CLI `stop` timed out
  checking the exited service process. A full restart of the same container preserved the
  profile. MCP recovered the original request, Run and Notebook dispatch without a new submission.

| Verified file                 |   Bytes | SHA-256                                                            |
| ----------------------------- | ------: | ------------------------------------------------------------------ |
| `greenhouse_report.md`        |     183 | `a8232825b8b8fff9d7e680547bc51a68157e01be82b4e8e78b68b4e72d3c4af8` |
| `greenhouse_results.csv`      |      61 | `81fff5f2a1d733a530e83e7b1479b4334d3003ed84dee0dd065454a322665838` |
| `greenhouse-study.science`    |  57,623 | `a90810d78d12684379d70b6fb46026ae4b8a6052923c4a3170089d005dc96e4e` |
| `greenhouse_followup.md`      |     198 | `94dd66cfbc2a6874370c20ba65c4df9c60b88847de6278e7fa7c4788e52e3fd1` |
| `greenhouse_variance.csv`     |     101 | `92e7e8dcac04a52f3b8ac201fdab4efc985a9f0d2d5da896ccfbc19ac2dec59a` |
| `greenhouse-followup.science` | 169,519 | `d9c262e96e6f38b4ddcb4cf9fb6ad50b3d6f9e0fbe04b7d1a280b3fa3dc00d3f` |

Every listed inventory record matched the archived bytes (19 source records and 30 receiver
records). Each archive contained its delivered report and table. The follow-up files came
from the new Run; the receiving model was configured independently.

In a separate live-model run, Qwen3.5-9B used the same MCP runtime review on Run
`c7e99275-2dbf-41d1-8230-e9262f9a9e9d`. The operator declined a shell write and, later, a
report overwrite that violated the test request. It published two Artifacts from
`notebook-run-1795249271838-4`; the last Notebook attempt remained interrupted even though
the Run ended. This is partial live-model evidence, not a completed handoff. An earlier
request using a display label in place of `runtimeId` correctly failed before Provider
dispatch but was misclassified as continuable. `c11ceb790` fixed the projection, and real
MCP stdio and CLI JSON both reported failure without a continuation action.

The direct MCP preview validates the installed service and migration mechanics. It does not
replace #80 and #81's live host acceptance from the short README prompt. WorkBuddy 5.9.4's
separate test connector requires the host's first-use Trust action; the existing connectors
were preserved.

## WorkBuddy setup revision: macOS arm64, November 21, 2026

- Host: WorkBuddy `5.9.4`; Node `24.22.2`. Installed the two actual npm tarballs into a local
  prefix and registered the installed stdio launcher. The default service port was in use;
  the acceptance profiles used separate loopback ports. The first prompt was the single README
  paragraph at `281b3902a`, with only the URL changed to the fork. WorkBuddy read the catalog,
  guide, setup report and runtime list. The new profile had no selected runtime or provider.
  WorkBuddy presented the available runtime IDs, reported Python and R separately, and did not
  submit research or try to install a language.
- In a separate user turn, WorkBuddy selected the built-in Open-Science Agent and configured the
  keyless Kilo free route. CLI JSON confirmed `readiness.agent: ready` on that same profile.
  An explicit request to open the profile used `open_setup`; its local browser tab opened on the
  profile's service port. There was no sign-in or credential input. Other providers still use
  their existing Web settings/account flows.
- The installed-service probe found that the local Task command inventory did not yet include
  `notebook-env:provision`. After `4298dddb1`, the real WorkBuddy R installation completed in
  about 58 seconds. R was ready and Python remained absent. A separate profile installed Python
  through CLI JSON in about 59 seconds and left R absent. The R run also encountered host memory
  recovery, which WorkBuddy reported separately from the ready language. No protection was changed.
  The rebuilt CLI tarball SHA-256 was
  `c6ed1e4f84e060d00b419468116cf25bb89889811374085a9c826066b618354b` and the macOS tarball SHA-256 was
  `af2bb1dc93d25f1bff95edf4864de435ee7292059084c7ec331bdbeab9aab789`.
- The user separately requested a synthetic greenhouse analysis in R. WorkBuddy submitted
  request `67f3418c-b244-4ceb-afed-d9e75d2c08dc`. Run `4d5ed3c7-82c2-430f-b8db-874f4f591603`
  in Session `35e360c5-81fa-48c0-b192-93b093278935` reached `waiting_for_user` with
  `notebook_runtime_review_required` and `kernelDispatched: false`. WorkBuddy reported the
  original Session and stopped at the approval. This is live model and handoff evidence, not
  completed R dispatch, report/CSV delivery, or export evidence.
- A second WorkBuddy task used the same short README prompt in an empty profile with the fixture
  attached through the client. `study.science` had source SHA-256
  `d31f86381012eb7ae54b4ebe6ffca9510e7bc6049dd19e53e5206b7fbbcbcf24`. WorkBuddy noted the
  attachment and continued setup only. Independent Project and Session queries returned empty
  lists. Only after a separate request did WorkBuddy import and inspect `Artifact research`,
  Session `import-11db3b8b-7475-4e01-b1e2-c5de8fe2474b`. Querying operation
  `919cf84b-4733-4abd-aa0e-76e6495f91cb` matched the read-only Session. The fixture had no
  downloadable published Artifacts. There was no Notebook dispatch or Fork. This is isolated
  profile evidence on one Mac, not a new independent machine migration.
- The branch was merged with upstream `2ee4f3b70`. The integrated `486450e9e` build passed
  Node/Web type checks and the actual macOS npm install and native loading check. This test
  used local candidates and does not establish registry availability or coverage for every host.

## Notebook environment handoff follow-up

- WorkBuddy imported `open-science-test-study.science` only after the user asked. The Session
  was read-only, and the delivered `stats_report.md` and `stats_results.csv` matched the source
  sizes and SHA-256 checksums. A later request to run the import triggered a Fork without a
  separate confirmation in the visible conversation. This did not meet the Fork consent gate.
  Run `37c4f689-a77c-4dda-9885-0bd82cb9d619` returned `waiting_for_user` for runtime review, with
  `kernelDispatched: false`, even though the same profile reported Python and R ready.
- With the updated backend and Web build on macOS, real MCP stdio offered both setup paths in
  a fresh profile. `open_setup` opened the Runtimes panel during onboarding. The browser's
  Python setup button prepared Python, and MCP reported R still missing. Closing the panel
  returned to the same onboarding step. `prepare_notebook_environment` then prepared R through
  MCP directly. The browser launched on the same profile and the MCP response did not carry its
  private URL. This verifies environment setup; the original WorkBuddy Run still awaited review.

## Live first research: macOS arm64, November 20, 2026

- OpenCode `1.19.5` received the exact README quote with no attachment or research instructions.
  Its local stdio launcher installed npm `1.3.1` from a loopback registry serving this branch's
  `f937d9f5e` build, including the matching native package. The macOS CLI tarball used for the
  run had SHA-256 `ff1751e7bcdc9d401b32222691d2799e413dbd71cd764ebd352821d0582bb8e5`, and the
  native tarball had SHA-256 `05e2d9e68a9c2d35fb4c0a288b8eb2951e131c2a3acdbfede84c51824ed42361`.
  The initial launcher failed under the test's synthetic home; starting the same installed CLI
  in the normal OS user context with `start --no-open --port 0 --profile` succeeded. The Agent
  found the guide and catalog, reported the missing provider/Python and actual memory pressure,
  and stopped without submitting research.
- The test operator used Web onboarding to choose the built-in keyless Kilo Gateway and install
  managed Python `3.12.16`, then used Model Settings to test the connection. OpenCode rechecked
  the same profile; research was authorized separately once the memory policy reported ready.
  No account credentials were transferred or entered through MCP. This demonstrates a real
  same-profile provider setup, not a completed Codex OAuth login.
- `synthetic-stats-first-study-001` was rejected before Run creation because the Agent supplied
  the not-yet-created download directory as `cwd`. `-002` and `-003` did not complete the study:
  the Ask-policy turn's explicit `notebook_bind_runtime` outcome was unknown. The test retained
  the original receipts and authorized a fresh turn using default Python and the Auto policy.
  The guide/schema now explain the working-directory default and the Notebook tool description
  explains when an explicit runtime selection is needed. Neither change authorizes a missing
  permission or replays a failed request.
- `synthetic-stats-first-study-004` resolved to Run `aa436e83-ed2f-48b0-b99d-08449579bf62`,
  Project `cmwosb6jp0000jgfz5fr528yn`, Session `b8241418-713a-4463-a510-f917c50b6d3e`.
  The real built-in Agent used Kilo's `kilo-auto/free` route. Notebook Run
  `notebook-run-1795167689906-3` reported `completed`, `kernelDispatched: true`; service logs
  also recorded a real dispatched Python cell. One bounded `wait_run` timed out; observation
  of the same Run later completed. After stopping and starting the local service, MCP
  `get_submission` returned the original accepted receipt and `get_run` returned the same
  completed Run and Notebook dispatch evidence. No new Run was submitted for this recovery.
- OpenCode used only MCP for research, Artifact downloads, and export. The test read both
  downloaded files and independently checked the inputs `10, 12, 14, 16, 18`, count `5`, sum `70`,
  mean `14`, min `10`, and max `18`. A same-Run `get_delivery_status` with the chosen local paths
  returned `handoffStatus: complete` and `delivery.status: verified`.

| File                  | Download or operation ID               |  Bytes | SHA-256                                                            |
| --------------------- | -------------------------------------- | -----: | ------------------------------------------------------------------ |
| `stats_report.md`     | `d123ce6c-faab-48b7-9175-1bb057a8e9ad` |    717 | `795a4c0a0a046b074220ef088b894604f7885e93693e210f0963049833237bb2` |
| `stats_results.csv`   | `5be63a7c-843c-4f92-8f65-7b88844b5dd8` |     37 | `6f0ec537637ce5de3ad68d1ba4da9a0599768815f8077134a587f6802781d3c9` |
| `first-study.science` | `d7502d20-befd-4484-ad13-e03a21117f50` | 220810 | `8b30109c9e684f26318d10895f9a2bf19954a6947ca67eba53b28bc8ab26babd` |

The original export lookup returned the completed operation and verified file. The archive's
21 inventory records describe 16 unique archive entries (including the manifest); each listed
size and checksum was independently checked. The inventory includes the actual Notebook and
published result bytes. No credential files were transferred. The Linux receiver reproduced
the source archive SHA-256 before import.

The real expired Codex login trial before this build returned `preparation_failed` for a confirmed
ACP authentication error. The fix persists `provider_auth_required` on that original failed
receipt and projects a sanitized, same-profile user action. Owner tests cover the restart and
deduplication case; real stdio and CLI JSON regressions verify the same projection on all three
receipt commands. It does not change read-only doctor into an online provider probe.

## Live independent migration: Linux arm64, November 20, 2026

- The receiving Open-Science service and MCP host ran as an unprivileged user in a new Debian 13
  Docker container, Node `24.22.3`, Open-Science `1.3.1` from `f937d9f5e`. It mounted no host
  directories and had its own profile, D-Bus and unlocked Secret Service. Only
  `first-study.science` crossed over as research state. The receiver verified its source hash
  before import. The native package SHA-256 was
  `26726de6ad57e5ce8659d79dc86adfc0b18471ff9ecdc3fca3e97d37ff722f82` and the CLI SHA-256 was
  `4b90aef6fe7dc241ef48ca9491d075bd4cd0189b316aab9efd07fa83d13b4db8`.
- Debian 12 did not load the pinned native credential executable (`GLIBCXX_3.4.32` missing);
  Debian 13 provides the required C++ runtime. The container used host cgroup visibility and
  permitted nested namespaces and private procfs mounts. The actual bubblewrap probe passed,
  as did the service's Linux sandbox and memory checks. No app protection or credential check
  was disabled. The operator installed managed Python through the Open-Science Web onboarding.
- OpenCode's CLI could not attach the binary archive directly. The local path represents the
  attachment for a stdio MCP host. The first hosted model hit HTTP 429 before import, and an
  OpenCode trial with a smaller local model did not select the import capability. A separate
  Codex Agent with fresh context received the exact README quote, the local attachment path and
  a generic stdio connection relay. The relay ran entirely in the target container; there was
  no CLI fallback for business calls. The target Open-Science profile independently validated
  a keyless Qwen3-4B-Instruct-2507 model via a local llama.cpp inference service. The inference
  process did not mount either profile or receive credentials.
- The Agent discovered capabilities, checked readiness and imported the real archive. Import
  `cabfa679-2f9c-411e-bb09-e80c1c52a450` (correlation
  `eb4225d3-f3bf-4757-a493-c8a39632f210`) created Project
  `import-332e8800-e46e-4562-92ad-94fa7f9f1ac1` and Session
  `import-37c3aa7f-ce78-49b8-8052-f8bd60b61382`. `get_session` returned `readOnly: true`;
  `list_artifacts` returned `stats_report.md` and `stats_results.csv`. The Agent reported the
  historical values and stopped without executing the Notebook or creating a Fork. The test
  operator then sent a separate user turn explicitly authorizing the Fork and a new study.
- MCP `get_package_operation` confirmed that import. `fork_session` and an independent
  `get_package_operation` lookup confirmed Fork operation `bc95eaea-70a9-4950-91ce-bbef86fa654c`
  (correlation `27d9b67a-b59b-47f5-a583-1ad5dfccf9aa`) and writable Session
  `47568d10-c43b-4361-9393-91c4ff2ecba9` in the receiving Project. The original Session
  remained read-only. A local historical CSV downloaded through MCP was 37 bytes and had the
  same SHA-256 as the source CSV above. Both `stats_input.json` and `stats_results.csv` from
  the package were present in the Fork's Notebook data directory.
- The first follow-up, request `f17b230f-7e96-402e-9d85-855106d54e3c`, reached real local
  inference on Run `5177b0c9-ce67-4480-ae4a-a60d98129b03` without dispatching a Notebook
  cell. The operator explicitly cancelled the Run. A separate MCP read returned `cancelled`,
  no Notebook execution or refusal, and missing report and CSV. No package was requested for
  that Run, and its request ID was not reused.
- The authorized retry `dab298c1-4aaf-4570-b1c2-36922e805a2e` became Run
  `effef533-61bf-4fff-9197-31dda7fa73c3`. The original Web Session showed pending code review
  for Notebook Run `notebook-run-1795170072476-1`. MCP `get_run` reported `running` and
  `wait_run` timed out without a user action. The test operator reviewed the synthetic code and
  used **Allow** in the original Session. The same Notebook Run then reported
  `kernelDispatched: true` and a Python `SyntaxError`: the model emitted literal `\n` outside a
  string. The operator did not approve a second cell with the same error. A fresh MCP client
  confirmed cancellation, no new Artifacts, and missing delivery; no export was attempted.

### Agent, MCP and service in the same receiving environment

- OpenCode `1.19.5` ran inside the Debian 13 container on an empty Open-Science profile, with no
  shared source files beyond the same verified archive. The initial stdio service startup could
  not infer an OS vault on the headless host. An explicit CLI startup with the already unlocked
  Secret Service and the same profile resolved it. README now links this Linux prerequisite at
  the MCP setup step. There was no CLI fallback for package or research operations.
- Given the unchanged README quote and the attachment's local path, OpenCode called readiness,
  discovered capabilities, then imported and inspected the read-only Session. Import operation
  `61cd9043-296f-45a7-90ab-7ef7dbd2b064` (correlation `94c19c96-128c-479d-9c2d-19e6d450f6f8`)
  returned Project `import-aaf4145c-62fd-4824-ba1b-cc3b5e13d725` and read-only Session
  `import-4ecc4a69-8196-4a81-8670-7dcd928d04bb`. `list_artifacts` returned the same report and
  CSV. The Agent then asked for Fork permission. The test operator installed managed Python
  `3.12.16` through Web onboarding, configured the target provider independently, and explicitly
  authorized the Fork and study in a new user turn. Fork `191af3bc-ba7b-46f4-bc1f-d98ee47f92a6`
  (correlation `ec041c95-45d3-4968-91e0-1655150e7fb6`) created writable Session
  `9fcdf9cb-bb4d-4e1f-8e10-8e77a053af02`. Separate operation lookups confirmed both receipts.
- The Agent initially used `requestId` as `runId` and passed new-Session settings when submitting
  to the Fork. The shared capability descriptions now distinguish those inputs, and pending
  receipts include a `wait_submission` action carrying the original `requestId`. The model
  gateway returned HTTP 429 on the first accepted Run `519ca028-7178-438a-a671-4dd52ec288bc`.
  The operator tested keyless local inference and set the model on the Fork itself. Changing the
  profile default did not replace a previously saved Session selection.
- The initial 32K local context budget was insufficient for the configured tools and the replayed
  history. Request `phase1-migration-review-1120`, Run `62cf5993-d3fb-4571-ab16-14d4c6264252`,
  stopped at `max_turn_requests` before sending a model request, but the old outer Run said
  `completed`. That Run had no Notebook or delivery evidence. The repair makes both turn-budget
  and output-budget stops fail the original Run with an actionable message, preserving any
  partial output. The operator set the real llama.cpp context and the provider declaration to
  65,536 for the next attempt; no Notebook or service protection was changed.
- With the installed `7db3f7cb6` build, request `phase1-migration-reviewed-study-1120`, Run
  `b691f39a-d15a-4418-8513-d8f6a96279d1`, reached a real pending review on Notebook Run
  `notebook-run-1795172249682-1`. MCP `get_run` and `wait_run` and CLI JSON `wait_run` all
  reported `waiting_for_user`, `kernelDispatched: false`, and `review_notebook_code_in_app`
  for the same Session and branch. The test operator selected Deny for an invalid cell and
  explicitly cancelled that Run. No cell from that Run was dispatched. The final implementation
  reads review state from the permission broker, so the handoff survives UI evidence trimming.
  Regression tests cover the wrong branch, approval settlement, and redacted public events.

### Verified continuation and second delivery

- The operator supplied a short calculation cell after the model syntax failures. Codex drove
  the repaired follow-up through the target container's installed stdio, with no CLI business
  calls. This was a guided rerun in the same authorized Fork after the in-container OpenCode
  import and Fork. The earlier attempts remain recorded; OpenCode did not finish the whole
  sequence in one unattended conversation.
- New request `phase1-migration-print-study-1120` returned the pending receipt and explicit
  `wait_submission` action, then accepted Run `16837110-d44b-4df4-8130-782ae2fb5526` on the
  existing Fork. The real Qwen3-4B model requested `notebook_execute`; default Python Notebook
  Run `notebook-run-1795172442611-2` completed with `kernelDispatched: true`. The cell read the
  migrated `stats_input.json`, appended `20`, and produced `6,90,15.0,10,20`. The model published
  both files as Artifacts with that Notebook producer ID. The MCP list scoped to the research
  Run returned only those new Artifacts. The original imported Session remains read-only.
- Both Artifacts were downloaded through MCP and verified against their source version bytes
  and checksums. `get_delivery_status` returned `handoffStatus: complete` for this Run.
  Export operation `60d0068f-5e62-47a9-831e-3aa05c0349c0`, correlation
  `bb2c72a7-e15c-4731-8645-3c64f73a9a16`, completed; the original operation lookup confirmed
  it and the delivered package. The archive contains the new Notebook and Artifact contents.
  All 32 inventory records and 23 unique archive entries were read back and verified; the
  archive paths contained no credential files. The report and CSV were read independently and
  the results recalculated from the input.

| File                     | Download or operation ID               |  Bytes | SHA-256                                                            |
| ------------------------ | -------------------------------------- | -----: | ------------------------------------------------------------------ |
| `followup_report.md`     | `4e771478-8b0a-4f80-8471-0922ebe1b3f7` |    154 | `60e82b32006765ee44886ab93f20af4db8b21396a8d281be04daff906bae485b` |
| `followup_results.csv`   | `4bdf31a6-2082-4b11-844e-04421d5a8e11` |     41 | `6f141f51adb0b0bde0baed696b27286a6c11d694960cbe173e844cae937e0254` |
| `followup-study.science` | `60d0068f-5e62-47a9-831e-3aa05c0349c0` | 499414 | `aa15a387ffc592d418dc85f6b7f10edf375c4f7d8707b82b5f225cfe7cee3b7b` |

The receiving service and MCP were then switched to the matching CLI/native npm build from
`57f5c52ce`. After the service restart, that installed build returned the original accepted
receipt, the same Run and Notebook dispatch, and `handoffStatus: complete` for the same files.
No work was resubmitted for this recovery. A separate low-context trial on that build,
request `phase1-budget-repro-1120`, Run `b9df8f56-a7ec-4139-9c4f-42d951943bfc`, returned
`failed` and the same model-limit explanation from CLI JSON and MCP. It did not claim Notebook
execution or delivery. The macOS and Linux package builds both passed `test:npm-installed`;
the focused contracts and Owner test run passed 1,058 tests across 17 files.

### Exact README replay with Ask permissions

- A new receiving profile in the Debian container installed the matching `57f5c52ce` CLI and
  native tarballs (SHA-256 `b42ffcd4107b9fe148a40ee08663d926636bbec09105728e655834a71196422e`
  and `55e70daaa1baa4b8a31757cac2af873b00938650c66b335d73de8fe680b16dbd`). The inbound archive
  matched the first-study digest. OpenCode used the exact README quote and attachment path, with
  only its normal local stdio connection configured. It used `get_setup_status`, `import_session`,
  `get_session`, and `list_artifacts`, then waited for user permission to Fork. Import
  `0560b8e9-586c-43cb-a9c4-e991fdec55d1` created Project `import-37121da8-3456-49e1-a9bd-2f4a517ab5f1`
  and read-only Session `import-7a2ac913-27d6-4ea8-99a7-00a2c37234ff`.
- The test operator independently validated the local Qwen3.5-9B model and provisioned managed
  Python. In the same OpenCode conversation, the operator authorized a Fork and provided a
  statistics question and expected files. MCP Fork `fa52325e-dc2a-4d5f-b197-508a609a6167` created
  writable Session `2ac4794f-bb8f-4c7c-9568-ef34a9cab357`. OpenCode submitted
  `continued-study-run-001`, called `wait_submission` on the pending receipt, then followed the
  accepted Run `b7b08c56-c460-4999-8e82-710be907a07a`. A bounded wait timed out and OpenCode
  queried the original Run rather than submitting another one.
- The built-in agent read the migrated input and called `notebook_execute`. The Session was
  waiting for the Web app's **Confirm Notebook kernel and environment** decision, which happens
  before a data Notebook Run exists. The old build's public `get_run` returned `unconfirmed`
  while `wait_run` timed out. After the operator confirmed the managed Python environment in the
  original Session, that same Run immediately exposed its separate code review as
  `waiting_for_user` with `kernelDispatched: false`. The operator denied a cell with an invalid
  Python import and an unintended write to the source input. No dispatch or delivered output was
  credited to that cell.
- OpenCode resumed the same conversation after the operator increased the model context and
  separately authorized a new Run in the same Fork. Its prompt explicitly preserved the
  historical files. Run `493ff788-d734-4bca-9e45-34682b62e32f` requested a Shell script and then
  a Python cell that both tried to overwrite historical files. The operator denied both in
  Web and explicitly cancelled the Run. OpenCode correctly surfaced the code handoff and stopped
  for the decision, but the local 9B model did not follow the research constraints.
- In the same OpenCode conversation, a separately authorized rerun on `16ed98260` used a short
  Python cell supplied as research input and the independently validated 64K Qwen3-4B provider.
  OpenCode received no tool sequence, internal parameters, or script for the MCP workflow. Its new
  request `continued-study-final-001` became Run `0781abd2-2631-44a4-b444-ce27cf1455b2` on the same
  writable Fork. Notebook Run `notebook-run-1795175195236-1` dispatched Python, read the migrated
  `stats_input.json`, and produced `6,90,15.0,10,20`. Both published Artifacts carry that producer ID.
  OpenCode downloaded both files and exported the package itself over MCP. The original Session
  remained read-only, and no CLI was used for import, research submission, Fork, or delivery.

| File                      | Download or operation ID               |  Bytes | SHA-256                                                            |
| ------------------------- | -------------------------------------- | -----: | ------------------------------------------------------------------ |
| `continued_report.md`     | `acfff3ec-4607-438e-8731-8d67ec7f1d97` |    159 | `568d5eab4008b38fc7b0e363df9d24b39392e3af23e6dd84c274a35a11fc5285` |
| `continued_results.csv`   | `a17224c7-7ffb-42e0-bb64-12640231e10a` |     41 | `6f141f51adb0b0bde0baed696b27286a6c11d694960cbe173e844cae937e0254` |
| `continued-study.science` | `5ea2608d-0138-49ce-94b5-55d2912faae2` | 567366 | `04e5bdec55bdcd68ef6f03a2bc3c1d32bc8f35369f38c5df6d32323ab5004ab1` |

The export operation lookup confirmed the same file (correlation
`1033ac68-9e10-40ac-ab16-b0f492fe93aa`); the receiving import and Fork lookups after restart were
`unconfirmed`, as expected for prior package snapshots. The actual archive and 32 inventory records
(23 unique entries) were verified, including the downloaded bytes. The input and statistics were
verified independently. The model made further Notebook calls after publishing and hit
`FileExistsError` on the exclusive outputs. The last Notebook Run `notebook-run-1795175277009-3`
failed; `get_delivery_status` therefore returned `delivery.status: verified` and
`handoffStatus: incomplete`. OpenCode's final prose overstated the Notebook outcome. This proves
the same external Agent can drive the package and file operations, while the earlier guided run
supplies the clean complete-handoff evidence. It does not close the stricter #67 gate for a clean
run driven entirely by the same external Agent. The shared guide now calls for checking
`get_delivery_status` before reporting success. A separate internal Notebook tool regression
removes technical retry advice after a code or runtime approval was declined.

### Same-Agent replay on the final package build

- A fresh receiving profile and OpenCode home in the Debian 13 arm64 container installed the
  `1.3.1` npm CLI and matching native runtime built from
  `fa81f644def35e1231039122b6e09f31d8cf60f8`. The CLI and native tarballs had SHA-256
  `2d581e9e51b1d6260dd40031474d8b1d9e38a743c6ecafb6120e7760aa634434` and
  `20a3b9748fa799aceae20c815906e144343ff14d45286961ebe1ccdf821dc713`. The container mounted no
  host directories. OpenCode `1.19.5`, stdio MCP, and the service ran inside it as the same
  unprivileged user with Node `24.22.3`, npm `11.19.1`, and an unlocked Secret Service. The
  nested bubblewrap check passed. Only `first-study.science` crossed over as research state;
  the receiver independently matched the source SHA-256 above.
- OpenCode received the exact README quote and attachment path. It called `import_session`,
  `get_session`, `list_artifacts`, and `get_setup_status` over MCP. Import
  `06a03b1c-e0c2-471d-9d6d-ebb49528ea6e` (correlation
  `bb5de8c7-3ad3-4547-a3d6-14406f08bbd8`) created Project
  `import-42e536e8-84ba-4e96-8889-b68b2f3d8513` and read-only Session
  `import-f86556c2-18f8-4232-81e5-9da2544d6edd`. It summarized the two historical Artifacts
  and did not call Fork or submit research. The Notebook evidence in the read-only Session
  describes the imported history; there was no receiver dispatch in this turn.
- The operator provisioned managed Python `3.12.16` through Web onboarding and independently
  configured and validated a keyless local Qwen3.5-9B provider on the receiving profile. The
  llama.cpp inference endpoint had a 65,536-token context and did not access either profile.
  Readiness changed from blocked to ready for both the Agent and Notebook. A separate user
  turn in the same OpenCode conversation then authorized the Fork and specified the follow-up
  statistics and files. It supplied no Python code, expected values, or workflow instructions.
- Fork `6aca19a7-80bd-4f81-abef-7bcedddef7db` (correlation
  `4e9c74f7-bbb1-4914-a2ee-5a074fe8989f`) created writable Session
  `1cd9d46d-9632-4394-8cbb-3b6b407f18ab`. Independent MCP operation lookups confirmed both
  the import and Fork while their snapshots were current. OpenCode followed `start_run` with
  `wait_submission` on `fork-stats-study-20261120`, receiving accepted Run
  `2c35324f-56d4-4772-8075-f865720de86e`. A bounded `wait_run` timed out; the next `get_run`
  queried the same Run and returned `waiting_for_user`, `kernelDispatched: false`, and
  `review_notebook_runtime_in_app`. OpenCode told the user which Session to open and stopped.
  The operator confirmed the prepared environment in the original Web Session and told the
  same OpenCode conversation to continue observing the same study.
- The first generated Python cell had an `ImportError` because `min` and `max` are Python
  built-ins, not members of `statistics`. The inner Agent corrected the code within the
  original Run, without a new submission or a supplied cell. Notebook Run
  `notebook-run-1795183594293-3` reported `completed` and `kernelDispatched: true`; its real
  output was `6,90,15,10,20`. The migrated input had the same SHA-256 as the source both in
  the read-only Session and the Fork.
- The Run completed and published two new Artifacts. A Run-scoped MCP listing linked both to
  the successful Notebook Run, separately from the two historical Artifacts. OpenCode called
  `download_artifact` twice and `export_session` itself; the CLI was used only for local
  startup and read-only comparisons. Its final reply separately reported the successful Python
  run and all three verified files. `get_delivery_status` returned the same result through
  MCP and CLI JSON: `execution.status: completed`, `kernelDispatched: true`,
  `delivery.status: verified`, and `handoffStatus: complete`.

| File                         | Download or operation ID               |  Bytes | SHA-256                                                            |
| ---------------------------- | -------------------------------------- | -----: | ------------------------------------------------------------------ |
| `stats_report_new.md`        | `19a2d5ac-cabb-4dca-9033-d4b020918c90` |    550 | `6ecbd52e2908ecd86c8d5f40903489d3b87a0130551e0e0e28611f34e7de0643` |
| `stats_results_new.csv`      | `158491c1-74eb-4d5e-b476-79f0b8bba0ac` |     37 | `f4187714b0db6da4b0ab5e46562b34385273d6ebf84fd0b26c72db2472990af0` |
| `first-study-forked.science` | `e500fa2b-b226-4418-997d-192bac2cd281` | 499302 | `cbba4a8211b963cc9712ee85c160cf2b02f5ca2f7556ea4d28c406cebec13513` |

The export lookup (correlation `efc2aed2-a096-4473-9006-d9cb4ddd4142`) returned the same verified
package. The downloaded bytes matched the source Artifacts and export receipt. All 32 inventory
records and 23 unique archive entries verified, including the new Notebook record and both new
files. The archive contained no credential files. Independent recomputation and inspection of the
report and CSV confirmed the results. The original Session remained read-only, and its input,
report, and CSV stayed unchanged in both Sessions. The source-to-Fork study and delivery satisfy
the pre-release migration gate in #67.

An additional verification turn exposed a misleading default: OpenCode omitted the custom paths,
got `delivery.status: available`, and incorrectly expected a background check. The shared adapter
now explains that the default directory was checked and tells the Agent to use the actual paths
from the download receipts. The underlying integrity and completion rules are unchanged. The
CLI/MCP regression reproduced the missing instruction before the fix; all 389 package tests passed
after it. The `64ac6bbd88cdfb29695d3c53da7a421638b53df7` Linux npm build passed the install check.
Its CLI tarball SHA-256 was `a7c3183c8868bd7f38853d5c95d75139d95458ace45dc095e242a6f0f4f0d0f0`;
the native tarball SHA-256 was `4bff8452c7230d0726f8e0ab018f59245e45b937c132d5a7a417f0bb2c89468c`.
On the same real Run and files, the installed adapter returned identical CLI JSON and MCP
responses for both the omitted-path case and the complete handoff with the original paths.
The local OpenCode model still misread the first response as a pending check despite the explicit
instruction. When the operator asked it to verify the two existing files by their local paths,
the same Agent called `get_delivery_status` with both paths and received `handoffStatus: complete`
and `delivery.status: verified`. It did not repeat the research, downloads, or export.

### Repaired runtime handoff in the installed build

- macOS and Linux npm builds from `16ed98260` passed `test:npm-installed`. The Linux CLI and
  native tarballs had SHA-256 `081c8671e0492fc04a0d3afb836e0990b32240c03d6e79b6256d079b4f638818`
  and `2f12f1b350120cad7687bcb257389837904a57a79f21f6b43156b08df0eb91be`. The directly installed
  Linux package restarted the earlier receiving service, recovered accepted Run
  `16837110-d44b-4df4-8130-782ae2fb5526`, and verified the earlier files again without resubmission.
- From the same installed package a new Ask-mode Session `c423f8eb-62d9-4c19-812b-df304605de2c`
  ran the synthetic `6 * 7` check. On Run `593b5c56-a4a0-42fa-a58f-800b14467788`
  (`phase1-final-runtime-review-1120`), real `get_run`, `get_session`, and both CLI JSON and MCP
  stdio `wait_run` returned `waiting_for_user`, `kernelDispatched: false`, and
  `review_notebook_runtime_in_app` for the same Session, prompt, and branch. No Notebook Run ID
  or interpreter path was returned before the decision. The operator confirmed the environment in
  the original Web Session. The same research Run then completed with real `kernelDispatched: true`
  on Notebook Run `notebook-run-1795174766048-1` and returned `42`.
- Regression tests cover broker settlement, automatic binding, wrong prompt/branch, redacted
  notices and protocol parity. Session queries also have a regression for a new prompt that
  inherits a prior execution intent: only execution attributable to the new prompt can count.

### Desktop handoff regression

Three Playwright Electron tests passed against the `57f5c52ce` build: restart with a new explicit
Notebook **Continue Notebook work** action followed by Allow or Deny, and a real stdio sensitive
export held until Desktop review. The continuation tests use a deterministic provider. The
sensitive export test uses synthetic content and simulates only the operator's selection in the OS
dialog; it verifies that the app defaults to Cancel and publishes the exact reviewed candidate.

## Earlier packaged MCP handoff: macOS arm64, November 20, 2026

- Build: `2d2fbba9abba0d20e43e0a7af4974c7cdb88541a`, Node `24.22.2`, npm `11.19.1`.
  `npm run stage:backend`, `npm run pack:npm-release`, and `npm run test:npm-installed`
  passed on this commit. The latter confirmed real npm resolution, the npx entry point,
  native loading, and an Electron-free install.
- SHA-256 of the final CLI tarball:
  `49b6bca1d5187e58bc4f673381615526363fad129d47d19abe596f46311f670a`.
- SHA-256 of the matching macOS arm64 tarball:
  `8f3bfbeea258f7aef3fb192395eeda357b4f046e35e9ddec0c23ab0a2b9f1964`.
- A clean temporary npm install launched the installed `open-science mcp --profile` executable
  over real stdio. The client read `openscience://agent/guide`, discovered the package tools,
  and used the repository's `session-package-v0.31.1-minimal.science` fixture. The first attempt
  was blocked by a stale development process holding port `44100`; after that process was stopped,
  the same packaged flow completed on a fresh profile without changing product code.
- Import operation `411a9ad1-d98c-432a-89d7-98de9e57ec58` created Project
  `import-9511f28a-2f69-407f-94e7-08186f4825fe` and read-only Session
  `import-53c9938b-afd3-4aae-b58f-3594a1638b76`. A matching `get_package_operation` lookup
  confirmed the completed import, and `get_session` confirmed `readOnly: true`.
- Fork operation `f3261550-f55d-4e15-9b87-a547c416c91d` returned writable Session
  `f3586e5e-f2d0-4fe3-b1f3-4e600baaf47f`; its original operation lookup also completed.
- Export operation `5cf2de97-9eb7-4d6e-a6f4-d3ac0e531d7a` published `final-fork.science`.
  The delivery was `verified`, the file was 2325 bytes, and its independently checked SHA-256
  was `71679574e24930ccb7db96d5da153662daf438ff7360e8fe69fdfc302e324178`. The archive inventory
  contained `README.md`, `manifest.json`, `records.json`, `ro-crate-metadata.json`, and `session.json`.
- This is packaged protocol and Session-package evidence only. The fixture has no research result
  artifacts, real provider/model call, or Notebook dispatch, so it does not close the first-research,
  independent-migration, or registry gates below.

## Packaged preview: macOS arm64, November 20, 2026

- Build: `02497ab0e350c9a33cef4bcbe875ba2d7ea9185e`, Node `24.22.2`, npm `11.19.1`.
  `npm run stage:backend`, `npm run pack:npm-release`, and `npm run test:npm-installed`
  passed. npm selected both staged `1.3.1` packages; the native dependencies loaded without Electron.
- SHA-256 of the CLI tarball: `82b0299003f5a66d19a2e56f00cf73fd75e12967a2f866b5c4e2f368973b9860`.
  SHA-256 of the matching macOS tarball: `b8b625e2439cb02c7109735e47da3bee772d1090129a9a187ca42e51b05223dd`.
- A fresh Codex CLI `0.169.0-alpha.11.1` conversation received the exact README prompt and
  no package or research data. npm installed from a temporary loopback registry serving the
  staged tarballs. Host configuration writes were denied by the Codex workspace sandbox. With
  the local MCP launch configured for the test session, Codex read the guide and catalog through
  stdio. The initial host connection could not reach the intended service. Explicitly passing
  `--profile` to the MCP launcher resolved profile selection; the same Codex conversation then
  completed capability discovery, Project listing and the setup check. The agent reported the
  missing provider and Notebook prerequisites, then waited without submitting research.
- A separate MCP SDK client launched that same installed executable with a new profile. The
  service started, the guide resource and Project listing worked, and `get_setup_status` reported
  the service ready, provider missing, default Python missing, and host memory pressure. The
  provider handoff named the installed CLI, selected profile and same-profile verification step.
- On the local Docker default deployment, a clean Linux container with bubblewrap could not
  create the namespaces needed by `bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev -- true`.
  This establishes a deployment constraint for that configuration. No product protection was changed.

## Packaged Session handoff preview: macOS arm64

- Build `d012d48dd`: actual CLI and native npm tarballs installed from a loopback registry;
  native loading and the Electron-free install check passed. CLI SHA-256:
  `907203a4033a115af1f29481e0ea5ed20d3c67340e1909918f70bdc84c725a5e`.
  Native package SHA-256: `0a12c72acb6b05b55f060858f025369190ccfb38d94c582248970d32e79433a9`.
- A fresh profile used MCP stdio to import the repository's `v0.31.1-minimal` fixture and read
  back the same read-only Session. Import operation `bc79e0d1-a6cb-4451-b885-0c49e6cb336f`
  returned Session `import-d9c98023-ce0b-439c-b110-0687e0a40f54`. Fixture-authorized Fork
  operation `91a4aaa4-c41a-423d-92bb-b803733fa60d` returned writable Session
  `2a418ecc-bf9c-4a7c-b324-a91c028968de`. The original operation lookup matched each result.
- Export operation `e057d894-57bc-407b-bdc4-bf426ad4145a` published `packaged-fork.science`,
  2316 bytes, SHA-256 `fb6a78a4cec91990d9fe8f137343d3ed48c128a66aaf38111c58469e28a70f3e`.
  The local file matched the Owner's receipt; its archive inventory contained `session.json`,
  `records.json`, `README.md`, and `ro-crate-metadata.json`.
- A separate Codex conversation on the same machine received the exact README quote and this
  package in a fresh profile. It called the guide, catalog, doctor, `import_session`,
  `get_session`, `list_projects` and `list_artifacts` over MCP. It identified the read-only
  Session `import-10a06ec5-31d7-48e7-8de3-6caec7281eba` and waited for permission to Fork.
  The fixture has no results to deliver. The agent did not call `fork_session` or `start_run`.
- Scope: actual packaged service and local files, with an archive fixture and separate profiles.
  No real model call to Open-Science, Notebook dispatch, fresh machine, or registry release.

## Upstream integration check

The Phase 1 branch was integrated against upstream `main` at `32253a047`. The integration
retains upstream's example-download error handling and returns HTTP 409 for both a busy package
Owner and a conflict with a different package operation. The continuation regression queries the
same prompt identity that `get_session` provides. Module registration retains full Web Service
coverage and includes the platform-specific Notebook readiness check in Windows routing.

The upstream candidate passed Node and Web type checks, lint, and 1,749 impact registration
tests. Commit `45e1cc2f3` passed 2,824 CLI, MCP, and service regression tests across 23 suites.
A focused rerun passed 314 tests across six suites, including the updated command wiring,
Fork publication fixture, Desktop-only continuation inventory, and Notebook tool review guard.
The guard review confirmed that the tool text changes do not change schemas, dispatch, or
authorization. The preview below exercised the same CLI and MCP package operations.

The first upstream Windows Core and Ubuntu host checks found the same Desktop Fork test failure:
the Notebook execution fence does a separate Owner lookup while the source is reserved. The
test now checks the actual Archive and persistence reservations once each and verifies their
release. The failure reproduced locally before the change, and the three package lifecycle and
export suites passed 37 tests afterward (three Windows-only cases skipped on macOS).
The same fix passed Windows Core and the previously failing Ubuntu shard on upstream CI.

The full macOS run started before these test fixes and reported 143,412 passing tests. All six
integration failures passed on the focused reruns above. The other 64 failures and two
unhandled errors reproduced on upstream `32253a047`: the build test used an aliased temporary
path, and the two Python suites picked up the system Python 3.9 shim. The three suites passed
160 tests on the candidate with a canonical `TMPDIR` and test-only interpreter overrides
(`OPEN_SCIENCE_TEST_PY_ENV` and `PYTHON`) pointing to the existing Python 3.12.16. These are
separate runs; the first full run was not green.

The Windows updater occupancy check separately hit the five-second PowerShell boot identity
deadline on two hosted runs. The CLI case in the same job still passed. The asynchronous probe
now allows up to 12 seconds for the same kernel query. A timeout or invalid identity still
blocks update recovery; the test continues to require a real identity for both launchers.

Upstream review also found that a prompt-only `get_run` query could use a completed Notebook
run from another message branch. Pending reviews and execution results now use the same
resolved branch. A regression test records real repository evidence from both branches and
checks the inferred branch, explicit branch, and prompt-only fallback without an intent.

A Linux arm64 preview was built from `bde5ca99bcab6509a0f86e387c42bdb4fddcc805`. The npm install
check passed; the CLI and native archives had SHA-256
`ef06ee92e0fd3c56c7ff3f0b02ecdc80ccec02fe1616eb422cf91ceb872ba09b` and
`642f61479c71624e6b1590ed2df38a01879110473f3cdfd76202e804574ef7f1`. On a new profile in the
Debian container, an MCP SDK client used the installed executable to import the verified source
archive and inspect the read-only Session. It downloaded the historical CSV (37 bytes, source
SHA-256 unchanged), created a writable Fork, and exported a verified 193,595-byte archive
(`ae0def0cf8a5182643d9330b9fc0938c1d5828ddfdaef730396d1e68c57c3ffe`). The client queried the
original import, Fork, and export operations. This was an installed-package regression with
existing research, with no new model or Notebook execution. The preview reports `1.3.2` from
the upstream base; it is a different build from the published npm `1.3.2`.

## Remaining gates

The original pre-release README runs (#66 and #67) preceded the revised short prompt and setup
capabilities. The current WorkBuddy run completed research and file delivery, and the actual
WorkBuddy package passed the independent receiving run in [#81](https://github.com/guch96/open-science/issues/81).
The WorkBuddy interaction gate [#80](https://github.com/guch96/open-science/issues/80) passed
the installed desktop replay of the child question, parent continuation, and final result read.
The [upstream PR #4522](https://github.com/aipoch/open-science/pull/4522)
remains Draft and requires the upstream checks and CI owner review of the Windows routing
registration before merge.
Registry verification ([#68](https://github.com/guch96/open-science/issues/68)) is blocked until an
official npm release contains Phase 1. Both README paths must then be repeated from that published
build.

The public npm registry was checked on November 20, 2026. `@aipoch/open-science` had `latest`
at `1.3.2`; both `1.3.1` and `1.3.2` were downloadable from the registry. Their official release
tags resolve to `9861032aa449009449e913188f8bd73a131df908` and
`10f93481f73bdc7cbb95b1116aab9e663ebfa662` respectively. Neither includes the Phase 1 branch.
Both registry CLI archives lack its shared Agent Adapter and capability modules. The local
`1.3.1` package used in the acceptance runs is a different build despite the matching version
number. The registry archives were checked for provenance only; no registry acceptance run is
claimed.

Record the build and environment, IDs linking requests to Runs and package operations, the actual
MCP calls, user decisions, Notebook dispatch, and file paths, byte counts and checksums. Omit
credentials and authentication URLs. Protocol fixtures and real Owner tests do not establish real
model or Notebook success.
