---
name: env-management
description: Use when a notebook run fails on a missing package (ImportError, ModuleNotFoundError, "there is no package called"), or when you need to install, add, or manage Python or R packages for the notebook runtime. Covers routing Python vs R through the manage_packages tool, why in-cell %pip/!pip/install.packages() and OS installers are forbidden, restarting the kernel after an install, and when to stop and ask the user.
license: Apache-2.0
---

# Environment and package management

The notebook runs against the session's **bound runtime**: the app-managed default (`default-python` / `default-r`) unless you bind another one with `notebook_bind_runtime` — a named environment you created, or one of the user's own detected interpreters. You never activate environments by hand, and you never install packages from inside a cell. Installs happen in the trusted main process through a single tool, `manage_packages`, and always land in the currently bound runtime. This page is the workflow for getting a package installed and for knowing when a package is not something you can install yourself.

## When a package is missing

A run that fails with `ImportError` / `ModuleNotFoundError` (Python) or `Error in library(x): there is no package called 'x'` (R) means the package is not in the environment yet. The fix is one `manage_packages` call, not a code change. Do not rewrite the cell to use a different library that "does roughly the same thing" — install the package the task actually needs. Do not fall back to reading data or computing results a worse way to dodge the missing import.

## Route by language

- Python package → `manage_packages(language="python", packages=["numpy", "pandas"])`.
- R package → `manage_packages(language="r", packages=["ggplot2"])`. R packages install from conda-forge as `r-<name>` automatically; pass the plain CRAN name (`ggplot2`, not `r-ggplot2`).
- A PyPI-only Python package that is not on conda → add `usePip=true`.
- A package that needs a specific conda channel → pass `channels=["bioconda"]`. Leave `channels` off otherwise; the app supplies the right default mirror.

Every install lands in the session's bound runtime and persists — there is no "temporary" install to undo later. Install once; it stays available in later cells and sessions on that runtime. To install into a different environment, bind or switch to it first (`notebook_bind_runtime` / `notebook_switch_runtime`); there is no per-call environment argument. The app-managed defaults are additive-only (bare name or `name==version`); for uninstalls, version ranges, or git/URL specs, create a named environment and install there.

## Restart the kernel after an install when told to

`manage_packages` returns `{ ok, needsRestart, log, error }`. When `needsRestart` is `true` (always true for R, because the running kernel holds the old library state), call `notebook_restart` before you `import` or `library()`-load the new package, then re-run the cell. For Python, a fresh `import` usually sees the new package without a restart; if an earlier failed import was cached, restart and retry. Read `log` when `ok` is `false` to see why the install failed.

## Never install any other way

These bypass the install gate and are forbidden:

- OS package managers — `apt`, `brew`, `yum` — and `sudo`.
- `curl | bash`, downloading and running installers, or hand-rolled `subprocess` installs.
- In-cell installs: `%pip install`, `!pip install`, `install.packages(...)`, `remotes::install_github(...)`. These run inside the kernel, which has no install-network path and is sandboxed in a later phase — they do not belong in a cell.

## When to stop and tell the user

Some things are not a `manage_packages` install:

- A package that needs a **system / OS-level dependency** (a compiler, a shared C library, a CUDA/GPU toolchain) that is not present. Stop and report the limitation to the user — say what is needed and why it is out of scope here; do not try to self-install system dependencies.

When you need an isolated environment (to remove/downgrade a package, use richer specs, or keep a project's deps separate), create one with `manage_environments(action:"create", language, name)`, then `notebook_bind_runtime` to it before running cells or installing there. `manage_environments` also lists and removes named environments (the app-managed defaults cannot be removed).
