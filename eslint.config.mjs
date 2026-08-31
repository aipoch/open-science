import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

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
      // Runtime kernel loop scripts shipped as raw resources (CommonJS, not part of the TS source tree).
      'resources/notebook/*.js',
      // Whole-window find overlay: an ES-module page shipped as a raw resource (not part of the TS source tree).
      'resources/find-overlay/*.js',
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
      // Keep the pinned native helper sources auditable against their provenance.
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
    // The pinned runtime intentionally matches C0 controls before logging protocol violations.
    files: ['packages/notebook-network-sandbox/runtime/src/gateway/violation-log.ts'],
    rules: {
      'no-control-regex': 'off'
    }
  },
  eslintConfigPrettier
)
