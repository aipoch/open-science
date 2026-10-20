# Release compatibility

Starting with Open-Science 1.0.0, stable application releases follow
[Semantic Versioning 2.0.0](https://semver.org/) for the public interfaces defined here.
Compatibility means an integration using an existing supported interface can continue to use
that interface after an upgrade within 1.x. New features may require a newer client or runtime.

## Public interfaces

| Surface                                        | Compatibility commitment within 1.x                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CLI](../packages/open-science/CLI.md)         | Preserve documented commands, options, accepted inputs, defaults with observable effects, and exit-code meanings. Preserve documented JSON/JSONL fields, types and meanings. Human-readable formatting and diagnostic wording may change.                                                                      |
| [Task SDK](../packages/open-science/README.md) | Preserve the root exports and public declarations in the matching release's `@aipoch/open-science` package, including method arguments, results, documented errors and event semantics. Imports of private files are outside this contract.                                                                    |
| Task automation protocol                       | Preserve the requests, responses and events underlying the documented CLI/SDK operations. This does not make every local HTTP route, Electron IPC channel or renderer command a public API.                                                                                                                    |
| `.science` packages                            | Newer 1.x releases continue to import valid packages accepted by earlier 1.x releases, preserving their supported data and provenance meaning. Package schema versions are independent of application versions; importing a package does not guarantee that its code or environment can run on every platform. |
| Existing profiles                              | Preserve the supported upgrade path for research data, settings and credentials. Storage implementations may evolve through migrations; users should not need to reset their profile merely to upgrade within 1.x.                                                                                             |

These promises apply on the documented supported platforms and with the required runtimes and
credentials available. They do not guarantee identical model responses, third-party service
availability, scientific conclusions or byte-for-byte reproduction of an analysis.

## Version and deprecation rules

- **Patch (`1.x.y`):** backward-compatible fixes, including security fixes.
- **Minor (`1.y.0`):** backward-compatible features and public deprecation notices.
- **Major (`2.0.0`):** incompatible changes to an interface covered above.

Mark a public interface deprecated in its owning documentation and release notes, explain the
replacement, and retain it for the rest of 1.x. Removal or an incompatible semantic change requires
a major release and upgrade instructions. Accidental compatibility regressions are bugs to fix;
they do not redefine the contract retroactively.

Additions are compatible only when existing valid clients keep working. New optional request
parameters must preserve existing behavior when omitted. Machine-readable consumers should ignore
unknown object fields and use documented codes rather than matching human-readable messages.
Do not treat an added state, enum value or event kind as automatically compatible: check existing
exhaustive consumers and protocol rules before choosing the version. Retain existing validation,
authorization and integrity checks; relying on a vulnerability or invalid input is not a supported
interface. Security fixes that change documented valid use still follow the version rules above.

An experimental interface must be explicitly identified in its owning documentation when introduced,
with its limitations and versioning expectations. Existing stable interfaces cannot be relabeled
experimental to bypass this policy. Nightly and other prerelease builds are not stable contracts.

## Historical data and upgrade direction

The 1.0 transition retains the existing upgrade and import paths for historical 0.x profiles and
packages, including legacy credential readers. Changing the application version to 1.0.0 does not
introduce a new data format, require a profile reset or remove historical compatibility. Continue
using the existing migrations and recovery checks; do not rewrite released migrations or silently
replace unreadable credentials. See [runtime compatibility](standalone-runtime.md#historical-compatibility-requiring-review).

Compatibility is directional: a newer application reads or migrates supported older data. Older
binaries are not guaranteed to read data written by a newer version. Back up the profile before an
upgrade; a binary downgrade is not a data rollback. Preserve the existing requirement to stop
conflicting runtimes and use matching desktop/backend versions. This policy does not promise mixed
version operation or arbitrary cross-platform transfer of OS-protected credentials.

The historical compatibility policy is a maintenance commitment, not evidence that every released
0.x version has been individually tested against 1.0. Record the source version, platform and checked
profile contents when reporting upgrade acceptance. The pre-1.0 CLI changes listed in the
[1.0.0 upgrade notes](../release-notes/1.0.0/en.md) remain part of the 1.0 baseline.

## Internal code, packages and security support

UI layout, translated copy, internal modules, database tables, on-disk implementation details and
private transports are not public programming interfaces. They may change while preserving the
public contracts and data upgrade paths above. Directly editing an internal database or depending
on undocumented paths is outside this contract.

This policy covers the CLI/SDK shipped with an application release. Independently published packages
follow their own published versions and documented support range; application 1.0 does not promote
every internal `0.x` package to 1.0 or certify every client/server version combination. Do not change
independent package versions or schema identifiers solely to match the application version.

[Security support](../SECURITY.md#supported-versions) covers only the latest stable release and
`main`. Backward compatibility in newer releases does not imply security backports for older ones.

## Change review

For changes touching a public interface or stored data, identify the affected contract, older
consumer or data fixture, compatibility behavior, and focused validation in the PR. Describe new
states/enums, persistent fields/formats and migrations separately. If a proposed change cannot
preserve a stable contract, plan a major release instead of silently weakening this policy.
