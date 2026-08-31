import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

const typescriptRulesOff = Object.fromEntries(
  Object.keys(tseslint.plugin.rules).map((rule) => [`@typescript-eslint/${rule}`, 'off'])
)

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      // Local package caches and generated scratch trees are not repository source.
      '**/.pnpm-store/**',
      '**/tmp/**',
      // Packaged e2e build output (electron-builder --dir into dist-e2e-*); bundled JS, not source.
      '**/dist-e2e-*',
      // Git worktrees hold full source copies; don't lint duplicate source from either supported root.
      '**/.claude/**',
      '**/.worktree/**',
      // Codex worktrees (same duplicate-source rationale as .claude/.worktree) and local SDD scratch.
      '**/.codex/**',
      '**/.scratch/**',
      // Local subagent scratch (ledgers, briefs, ad-hoc demo scripts) — never shipped.
      '**/.superpowers/**',
      // Keep official shadcn registry output unmodified; local adaptations live in wrappers.
      'src/renderer/src/components/ui/message-scroller.tsx',
      // Keep the pinned low-level runtime and native helper sources auditable against their
      // provenance. Open Science-owned adapter code under the package's src/ directory is linted.
      'packages/notebook-network-sandbox/runtime/**',
      'packages/notebook-network-sandbox/vendor/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    files: ['resources/notebook/*.js', 'resources/find-overlay/*.js'],
    rules: typescriptRulesOff
  },
  eslintConfigPrettier
)
