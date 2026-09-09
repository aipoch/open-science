# Agent file discovery scope

Notebook Shell checks file-discovery commands before preparing the workload sandbox or spawning
the workload. Searches must use a directory within the Session cwd. A cwd of a filesystem root
is rejected. Managed outputs should be located through the Project artifact catalog instead of
searching the host filesystem.

On POSIX, the existing web-tree-sitter runtime loads the pinned Bash 0.25.1 grammar. The check
walks commands, pipelines, substitutions, literal nested shell scripts, and resolvable assignments.
It treats command options according to the discovery utility, then checks lexical and canonical
paths, including existing ancestors of missing paths. A symlink pointing outside cwd cannot be
used as a search root. Directory-link following is rejected because validating a root alone
does not constrain the targets encountered during traversal.

On Windows, a separate non-interactive PowerShell process uses the OS `Parser.ParseInput` API
to return command names and literal arguments. It never evaluates the submitted code. The host
checks those arguments before starting the workload. Unresolved variables, wildcard roots,
ambiguous options, and searches with an uncertain changed cwd are rejected. Use `-LiteralPath .`
and `-Filter` for a scoped `Get-ChildItem` query. Nested CMD/PowerShell/WSL execution is rejected;
write the scoped command directly in PowerShell instead.

## Covered discovery surfaces

| Surface                                                                     | Policy                                                                                               |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `find`                                                                      | Check all starting paths; reject indirect roots, link following, and nested `-exec`/`-ok` execution. |
| `rg`, recursive `grep`, `fd`/`fdfind`                                       | Separate patterns and option values from search paths; reject unresolved roots and link following.   |
| `ls`, `tree`, `du`                                                          | Check enumeration roots, including recursive forms.                                                  |
| `locate` variants                                                           | Reject host-wide index queries.                                                                      |
| `mdfind`                                                                    | Require scoped `-onlyin` roots.                                                                      |
| PowerShell `Get-ChildItem`, `gci`, `dir`, `ls`, `Get-Item`, `Select-String` | Check literal path arguments; reject unknown scope.                                                  |
| Windows `where.exe /r`                                                      | Check the recursive root; nested `cmd /c dir /s` is rejected.                                        |

## Framework routing

The ACP Session cwd remains supplied by the existing create/resume/adopt lifecycle. It is a
starting directory, not an operating-system access boundary. Native discovery that bypasses the
Notebook preflight is disabled at the framework's existing configuration boundary:

| Framework/path                                       | Enforcement                                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                                          | Mandatory `disallowedTools` includes Bash, Glob, and Grep, including when caller session options are supplied.                                                                              |
| OpenCode V1                                          | Highest-precedence `OPENCODE_CONFIG_CONTENT` denies bash, glob, grep, list, and external_directory. Read can enumerate directories, so outside-directory grants must not reopen that route. |
| CodeBuddy                                            | Explicit native tool list retains Read/Write/Edit and omits Bash/Glob/Grep on all launch platforms.                                                                                         |
| Codex Responses, compatibility, Bridge, subscription | Existing shared `features.shell_tool: false` remains enforced; shell discovery uses the Notebook MCP tool. Route configuration is tested independently of model output.                     |

Configuration tests establish the app's emitted policy, not a claim that live traffic from every
provider version was captured. The shared ACP protocol does not require every tool to request
permission, so permission-request telemetry is not used as an interception boundary.

## Compatibility and limits

- Historical command text and saved runs are not migrated. Newly submitted or retried broad
  searches can now fail before workload execution. Already running work is not interrupted.
- Preflight rejection follows the existing preparation-failure path before durable Run admission:
  no Notebook Run is inserted for that rejected request. The service releases admission so a
  corrected request can proceed; this is covered by the service-level rejection/retry regression.
- Some formerly valid shell forms require rewriting: unknown option shapes, dynamic search
  arguments, aliases, xargs, indirect/nested execution, and directory-link following are rejected
  conservatively. Exact external reads such as `cat /etc/hosts` are not treated as bulk discovery.
- OpenCode's native external-directory permission changes from ask to deny. This also affects
  explicit native reads outside cwd; use an available app-owned exact-file operation where permitted.
  Claude and CodeBuddy retain their ordinary native Read tools.
- No runtime settings, stored grants, database schema, persisted formats, or Run state values are
  added. The Bash grammar is a packaged resource with a license and integrity provenance file.
- No new execution deadline or Python/R kernel policy is introduced. Existing Shell timeout and
  cancellation behavior remain in their existing owner.
- This is a command-admission safeguard, not a complete interpreter or OS sandbox. Arbitrary
  imported scripts, Python/R/JavaScript filesystem operations, tool implementations outside these
  routes, and filesystem changes after checking require runtime containment. This change does not
  rebuild the OS sandbox's read allowlist. A large but in-scope tree may still take a long time.

## Verification

`shell-search-admission.test.ts` tests POSIX syntax and the common preparation boundary using a
throwing sandbox double, plus a real search restricted to a temporary fixture directory. Unsafe
examples never execute. `shell-search-scope.test.ts` tests portable PowerShell admission fixtures;
`powershell-search-parser.windows.test.ts` exercises the actual OS parser on Windows CI. Mocked
fixtures do not replace the Windows lane.

The final impact set also includes Shell process ownership/cancellation, Notebook MCP admission,
the shared Python/R dependency parser consumers, all framework policy tests, Codex route tests,
and ACP Session create/resume/adopt/presentation tests. Required PR CI remains authoritative for
the complete suite and supported platform lanes.

## Primary references

- [Bash grammar release metadata](https://github.com/tree-sitter/tree-sitter-bash/blob/v0.25.1/package.json)
- [PowerShell Parser.ParseInput](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.parser.parseinput)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [OpenCode permissions](https://opencode.ai/docs/permissions/)
- [ACP tool calls and optional permission requests](https://agentclientprotocol.com/protocol/v1/tool-calls)

Earlier sandbox investigation found that the current macOS default-allow profile and Linux
read-only host root still permit enumeration of readable trees. Read-only means no writes, not
no scanning. Windows enforcement depends on its selected sandbox mode. A future filesystem
visibility change must preserve runtime startup and exact library reads and needs separate
platform verification; command preflight does not prove those sandbox changes have been made.
