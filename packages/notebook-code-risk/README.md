# @aipoch/notebook-code-risk

Notebook source risk detection. Built and versioned with Open Science; usable as an independent npm tarball.

Node >=22.13.0. Run `npm run build`, `npm run typecheck` and `npm test` in this package.
The repository command `npm run check:notebook-packages` copies each package outside the repository, installs only declared dependencies, runs its checks, and consumes `npm pack` output in a clean application.

Only documented `exports` are public. Do not import `src` or `dist` paths. Public interfaces remain stable; changes requiring caller migration are made atomically in this repository.

`analyzeNotebookCodeRisk(language, source, context?, history?, signal?)` returns risk findings. Context contains only the working directory and Python binding names. The host selects replay history and performs permission admission. Existing-file checks are repeated for each call; source memoization does not cache permissions.

`analyzePowerShellCodeRisk(source, parseCommands, signal?, cwd?)` receives the host-selected parser. Cancellation is passed to that parser. Findings and errors retain the existing application behavior.
