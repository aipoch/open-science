# 为 Open Science 贡献

感谢你有意参与贡献。本文档说明如何设置项目、我们遵循的工作流，以及变更在合并前必须通过的检查。

> 本文档是英文 `CONTRIBUTING.md` 的翻译。如内容存在差异，请以[英文原文](../../CONTRIBUTING.md)为准。

## 行为准则

在所有互动中保持尊重和建设性。假定他人出于善意，让讨论聚焦于技术本身，并帮助项目成为欢迎所有人的社区。

## 开始使用

### 前提条件

- [Node.js](https://nodejs.org/) 22（参阅 [`.nvmrc`](../../.nvmrc)）和 npm
- Git

### 设置

```bash
# 在 https://github.com/aipoch/open-science/fork 创建仓库分支，然后：
git clone https://github.com/<your-username>/open-science.git
cd open-science

# 将原仓库添加为 upstream（用于保持同步）
git remote add upstream https://github.com/aipoch/open-science.git

npm install
```

`npm install` 会运行 `postinstall` 步骤，生成 Prisma 客户端并安装 Electron 应用的原生依赖项。

### 在开发模式中运行

```bash
npm run dev
```

## 编码智能体导航

从仓库根目录运行安装、开发和验证命令：

| 目的          | 根目录命令                                                     |
| ------------- | -------------------------------------------------------------- |
| 安装          | `npm install`                                                  |
| 运行          | `npm run dev`                                                  |
| 目标测试      | `npm test -- <affected-test-path> [-t '<test pattern>']`       |
| 模块测试      | `npm run test:module -- <module-id>`                           |
| 受影响测试    | `npm run test:affected -- --base <base> --head <head>`         |
| Node 类型检查 | `npm run typecheck:node`                                       |
| Web 类型检查  | `npm run typecheck:web`                                        |
| 代码检查      | `npm run lint`                                                 |
| 完整回退      | `npm run typecheck`、`npm run lint`，然后运行 `npm test`       |
| UI E2E        | `npm run build:e2e`，然后运行 `npm run test:e2e`               |
| UI 流程       | `npm run build:e2e`，然后运行 `npm run test:e2e:journey`       |
| 工作区        | `npm run build:e2e`，然后运行 `npm run test:e2e:workspace`     |
| 无障碍        | `npm run build:e2e`，然后运行 `npm run test:e2e:accessibility` |
| 视觉          | `npm run build:e2e`，然后运行 `npm run test:e2e:visual`        |

Git worktree 只能在仓库的 `.worktree/<name>` 目录下新建，每个变更分支都必须基于默认分支。不要移除或移动其他 worktree。

在执行破坏性 Git 或文件系统操作、会下载或执行新代码的依赖安装、发布软件包或版本、在项目现有流程之外处理凭据，或执行任务未明确要求的外部写入（例如推送、拉取请求、问题和消息）之前，必须获得明确批准。

更改以下领域前，先阅读现有所有者文档，再运行对应的专项检查：

| 领域     | 所有者文档                                                                | 专项检查                                                                                     |
| -------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Renderer | [设计规范](../design.md)                                                  | `npm run typecheck:web`；`src/renderer/` 下的目标测试                                        |
| Notebook | [当前架构](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`；`src/main/notebook/` 下的目标测试                                  |
| Settings | [设置设计](../design.md#settings)                                         | `npm run typecheck`；`src/main/settings/` 和 `src/renderer/src/pages/settings/` 下的目标测试 |
| ACP      | [当前架构](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`；`src/main/acp/` 下的目标测试                                       |

## 项目结构

这是使用 electron-vite、React 和 TypeScript 构建的 Electron 应用。三个运行时进程层和一个共享模块位于 `src/` 下：

- `src/main/` — Electron 主进程（ACP 运行时、会话持久化、产物、Notebook、项目、IPC 处理程序）。
- `src/preload/` — preload 桥，将类型化 `window.api` 公开给 renderer。
- `src/renderer/` — React UI（页面、store、组件）。
- `src/shared/` — 跨进程共享的类型和辅助工具。

## 开发工作流

1. 基于默认分支为变更新建分支。
2. 完成变更，并保持范围集中、内容自洽。
3. 添加或更新覆盖已更改行为的测试。
4. 构建最终测试影响集，并在最后一次实质性编辑后运行。如果无法确定所有权、使用方或风险，请使用完整回退。
5. 创建拉取请求，清晰说明变更及其动机。

### 数据库架构变更

`prisma/schema.prisma` 管理表、列、默认值、索引和外键。Prisma 无法表达的 SQLite CHECK 约束位于 `prisma/sqlite-check-constraints.json`。运行时架构模块由工具生成；不要编辑它，也不要向启动代码添加功能 DDL。

1. 更改 Prisma 架构；仅在必要时更改 SQLite CHECK 契约。
2. 运行 `npm run db:schema:generate` 并审查生成的目标架构。
3. 在 `src/main/database/migrations/` 下添加新的不可变条目；切勿更改已发布迁移或扩展已冻结的 `0001` 旧版修复列表。
4. 提交前运行 `npm run db:schema:check` 和迁移测试。

Prisma CLI 仅用于开发和 CI。打包后的应用执行已检入的迁移清单，不会携带 Prisma migrate engine。

迁移历史由 `src/main/database/` 管理。模块测试可以运行 `migrateApplicationDatabase` 新建当前架构夹具；手工构造的历史架构、升级断言和迁移账本期望应归入数据库迁移测试，而非功能模块测试套件。

### 分支名称

使用 `<type>/<short-description>` 格式，描述使用小写并以连字符分隔：

```text
feat/project-sidebar-filter
fix/notebook-kernel-timeout
ci/ai-pr-review
```

使用以下标准类型前缀之一：

- `feat` — 新功能
- `fix` — 缺陷修复
- `docs` — 仅文档变更
- `style` — 格式调整或其他不影响行为的变更
- `refactor` — 既不修复缺陷也不添加功能的代码变更
- `perf` — 性能改进
- `test` — 添加或修正测试
- `build` — 构建系统或依赖项变更
- `ci` — CI 配置或脚本变更
- `chore` — 不属于其他类型的维护工作
- `revert` — 还原以前的变更

### 编码风格

- 遵循周边代码的风格，包括命名、结构和惯用写法。
- 格式化由 Prettier 处理。`npm run format` 是可选命令；提交前检查其变更，因为它会重写整个仓库中的文件。
- ESLint 强制执行代码检查；运行 `npm run lint`。
- 使用 `react-i18next` 的 `t()` 翻译函数包装用户可见字符串。将对应翻译添加到 `src/shared/i18n/locales/de.json`（德语）、`src/shared/i18n/locales/es.json`（西班牙语）、`src/shared/i18n/locales/fr.json`（法语）、`src/shared/i18n/locales/ja.json`（日语）、`src/shared/i18n/locales/ko.json`（韩语）、`src/shared/i18n/locales/ru.json`（俄语）、`src/shared/i18n/locales/zh-Hans.json`（简体中文）和 `src/shared/i18n/locales/zh-Hant.json`（繁体中文）的 `renderer` 命名空间中。使用英文文本作为翻译键。代码注释和文档保持英文。

## 验证策略

### 稳定的测试命令语义

- `npm test` 始终运行完整的可移植 Vitest 测试套件。其含义不取决于当前分支或变更文件。
- `npm test -- <paths> [-t '<pattern>']` 仅运行调用方明确提供的目标。它不会发现受影响测试，也不得描述为完整验证。
- 影响选择是根据最终 diff 另行做出的决定。不要让 `npm test` 隐式包含 Git diff 行为。

### 内循环

在实现期间，运行能够覆盖所更改行为的最小项目自有测试。每当该行为发生变化时重新运行。早期实现状态的内循环结果不能作为最终证据。

### 最终本地测试影响集

交付前，根据最终实质性 diff 推导最小集合：

1. 更改模块所管理行为的测试；
2. 更改接口和适配器的契约测试；
3. 接口可能更改时，运行使用方或功能切片测试；
4. 每个受影响运行时进程的类型检查；
5. 源代码或受代码检查的配置发生变化时运行 `npm run lint`；
6. 可在本地执行的跨平台、持久化、迁移、构建或 E2E 风险检查。

仅目录相近不能作为影响证据。如果文件混合多项职责，应将其视为影响接口，或使用完整回退。

`test:module` 仅支持 `scripts/ci/module-impact.json` 中声明的模块 ID。它运行该模块精心选择的所有者、契约和代表性使用方测试；对于接口变更，它不是完整的下游验证。接口或其使用方可能发生变化时，使用 `test:affected` 或准确 head 的 PR Gate 计划。

### 完整回退

出现以下任一情况时，运行 `npm run typecheck`、`npm run lint` 和 `npm test`：

- 无法确定所有者模块、更改的接口或使用方；
- 全局验证输入发生变化，包括软件包元数据、TypeScript/Vitest/构建配置、PR Gate 工作流或分类器，或模块影响清单中的所有权、使用方、能力或回退路由；
- 变更跨越多个运行时领域，且没有明确的影响图；
- 候选版本工作流或维护者明确要求完整本地测试套件。

完整回退是一种安全机制，而非每个拉取请求都必须满足的前提。贡献者无需在本地复现所有操作系统 CI 通道。

如果只更改已归属模块中的 `testFiles`，不会触发完整回退。运行清单验证测试、`npm run test:module -- <module-id>`、受影响进程的类型检查和代码检查；准确 head 的 CI 仍是完整可移植及平台测试套件的最终权威。

### CI 权威与证据

PR Gate 根据可信输入对最终 base-to-head diff 分类，添加使用方和平台风险通道，并对未知或含糊的所有权使用完整计划以失败关闭。所选检查具有阻塞性；未选择的检查会报告为跳过，不能视为证明。

最终交付必须列出实质性变更，将每项受影响行为映射到项目自有检查及最终结果（`行为 -> 命令 -> 结果`），说明为什么包含或排除使用方与平台通道，并指出未覆盖风险。说明所有检查均在最后一次实质性编辑后运行。只有独立审查确认该映射覆盖最终状态后，才能将变更标记为已验证。

## 提交消息

每个提交主题都必须使用带范围的 Conventional Commits 格式：

```text
<type>(<scope>): <description>
```

拉取请求中的每个提交都会检查此格式。

使用[分支名称](#分支名称)中列出的相同标准类型前缀。范围应是简短、以连字符分隔的名称，并以小写字母开头；专有名词和技术术语中可以使用大写字母，例如 `macOS`。

```text
feat(projects): add sidebar filter
fix(notebook): prevent kernel startup timeout
ci(review): unify automated AI reviews
```

- 使用清晰的祈使语气描述，并以小写字母开头；专有名词和技术术语中可以使用大写字母，例如 `detect user-installed CRAN R on Windows`。
- 保持主题简洁。如果从 diff 中无法明显看出原因，请在提交正文中解释原因。
- 对于破坏性变更，在冒号前添加 `!`，并添加 `BREAKING CHANGE:` 页脚，例如 `feat(api)!: remove legacy session endpoint`。

## 拉取请求

- 拉取请求标题使用相同的 `<type>(<scope>): <description>` 格式，例如 `feat(projects): add sidebar filter`。
- 在描述中引用所有相关问题。
- 对于改变行为的工作，使用简明描述，让审查者在阅读 diff 前即可评估意图、范围和验证。适用时使用以下结构：

  ```md
  ## Problem

  ## Proposed change

  ## Scope and non-goals

  ## Acceptance criteria and validation

  ## Review focus
  ```

- 对于架构变更、数据流、状态转换或跨多个组件的交互，如果 Mermaid 图能让设计更易理解和审查，请考虑添加。
- 小型文档、维护和范围较窄的修复可以使用简短摘要，但仍应说明预期行为和验证。
- 包含[验证策略](#验证策略)中的最终证据映射，说明所列检查均在最后一次实质性编辑后运行，并指出未覆盖风险。
- 保持拉取请求规模合理、范围集中，便于审查。
- 确保最终测试影响集通过；需要完整回退时，确保完整回退通过。
- 拉取请求检查通过后，仅使用 **squash merge** 直接合并。不要仅因 `main` 推进而更新分支；只有发生合并冲突或维护者要求时才更新。squash 提交主题必须保留拉取请求标题的 Conventional Commit 格式。
- 合并到 `main` 的非文档变更会触发 [Nightly 工作流](../../.github/workflows/nightly.yml)，它会在生成的提交上运行合并后验证和跨平台软件包认证。

## 报告问题

提交缺陷报告时包括：

- 预期结果和实际结果。
- 复现步骤。
- 操作系统和应用版本。
- 相关日志或截图（如有）。

## 发布 npm 软件包

维护者应遵循 [npm 软件包发布指南](../npm-release.md)。npm 软件包版本使用 `npm-v*` 标签，并通过受保护的 `Publish npm package` 工作流发布。

## 许可证

参与贡献即表示你同意，你的贡献将在与本项目相同的 [Apache License 2.0](../../LICENSE) 下许可。
