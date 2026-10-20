# @aipoch/notebook-code-risk

Notebook source risk detection. Built and versioned with Open Science; usable as an independent npm tarball.

Node >=22.13.0. Run `npm run build`, `npm run typecheck` and `npm test` in this package.
The repository command `npm run check:notebook-packages` copies each package outside the repository, installs only declared dependencies, runs its checks, and consumes `npm pack` output in a clean application.

Only documented `exports` are public. Do not import `src` or `dist` paths. Public interfaces remain stable; changes requiring caller migration are made atomically in this repository.

`analyzeNotebookCodeRisk(language, source, context?, history?, signal?)` returns risk findings. Context contains only the working directory and Python binding names. The host selects replay history and performs permission admission. Existing-file checks are repeated for each call; source memoization does not cache permissions.

`analyzePowerShellCodeRisk(source, parseCommands, signal?, cwd?)` receives the host-selected parser. Cancellation is passed to that parser. Findings and errors retain the existing application behavior.

## Safety and integration

- **Scope:** Bounded source analysis for visible destructive effects and explicit dynamic execution
  in Python, R, REPL, Bash, and the host-parsed PowerShell path.
- **Controls:** Findings identify source evidence for the current decision; history and existing-file
  checks help interpret that source. Findings do not grant execution authority or cache permissions.
- **Remaining risks:** No findings does not mean safe code. Libraries, native extensions, dynamic
  paths, and runtime behavior can hide side effects. Analysis is not atomic filesystem enforcement
  or a complete malware, data-disclosure, or scientific-correctness check.
- **Safe integration:** The host must enforce authorization, process isolation, filesystem/network
  policy, and cancellation. Do not interpret analysis failures as clearance. Review unfamiliar code
  and retain backups of writable inputs. See the application's
  [execution boundaries](https://github.com/aipoch/open-science/blob/main/docs/security.md#code-and-notebook-execution).
