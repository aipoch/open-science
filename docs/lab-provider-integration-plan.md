# Lab 中台接入方案（Open-Science 桌面端）

状态：**已按推荐默认实现**（决策记录见 §12）。实现提交见分支 `feat/lab-provider`。

契约来源：`/Users/wangzh/code/helixlife/open-science-lab/docs/api.md` §3–§9（已通读，含 §5.1–5.8、§6、§9、§11 错误码）。
代码基线：`main @ dfb7b5923`（工作区有无关的 `package-lock.json` 本地差异，见 §12-Q4）。

---

## 0. 结论先行

| 维度          | 决策                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider 形态 | 新增 `ProviderType = 'lab'`，固定 id `builtin-lab`，单条记录，应用托管                                                                                        |
| 模型来源      | `GET /api/me/bootstrap` → 写回该 provider 记录的 `models` / `baseUrl` / `apiEndpoints`（xai `fetchedModels` 先例）                                            |
| 凭证          | 新建 `${configRoot}/lab-credentials.json`，密文字段走 `crypto.ts` 的 `encryptKey`；只主进程可读                                                               |
| 授权          | 系统浏览器 + 回环 `http://127.0.0.1:<动态端口>/oauth/callback`，PKCE S256 + state，5 分钟窗口                                                                 |
| 路由          | 零新增协议、零新增流式/取消实现；复用 `ProtocolForwardingBridge` + `NativeResponsesCompatibility`，Lab token 经 `resolveConnection` / `resolveKey` 每请求解析 |
| 故障隔离      | 所有 Lab 错误只落成 Lab 面板内联 `ErrorNotice` + `LabView` 状态；启动恢复 fire-and-forget；无全局对话框、无重试风暴                                           |
| 面板          | 新增 `SettingsPanelId 'lab'`，挂在 **Connections** 分组，`LabPanel` 懒加载                                                                                    |

---

## 1. 事实修正（对任务描述里三处与代码不符的地方）

1. **回环回调不在 `provider-loopback-http-host.ts`。** 该文件是“provider 请求桥”：agent → 应用本进程的 JSON 代理，`listen(0)` 动态端口、服务任意 path、bearer 鉴权，没有任何 OAuth 语义。真正的 **PKCE + `/oauth/callback`** 先例在 `packages/connector-mcp-client/src/oauth-client.ts`（`OAuthCallbackServer`：动态端口、按 state 匹配 pending、5 分钟超时、`closeAllConnections`）与 `src/oauth-redirect.ts`（`normalizeLoopbackOAuthRedirectUri`）。方案复用这套**形状**，回调 host 落在本仓库 main 侧（见 §5）。
2. **`src/main/settings/file-credential-storage.ts` 不存在**（仅 `file-credential-storage.test.ts`）。加密落盘由 `credential-store-mode.ts`（`--credential-store=os|file`，file 仅 Linux headless）+ `crypto.ts`（`enc:` / `file:v1:` / 旧 `plain:`）实现；凭证文档目录是 `${configRoot}`（`settings.json`、`credentials.json`）。方案沿用同一原语与同一目录。
3. **xai 先例是设备码流（RFC 8628），不是回环回调**，且 main 不打开浏览器（renderer 渲染 `<a target="_blank">`，`src/main/windows.ts` 的 `setWindowOpenHandler` → `shell.openExternal`）。可复用的是它的**控制器形状 / 单飞刷新 / 账号态 / 凭证落盘 / 401→forceRefresh 重试**，不可复用授权腿。
   另外：仓库默认分支是 **`main`（没有 `master`）**。

---

## 2. 状态模型

`LabConnectionState`（`src/shared/lab.ts`）：

| state           | 触发                                                                     | 面板                                       |
| --------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| `unconfigured`  | 无 server URL 或未保存                                                   | “未配置”，不发任何请求                     |
| `signedOut`     | 有地址、无有效 refresh token                                             | “未登录”，可发起登录                       |
| `signingIn`     | 登录尝试 pending                                                         | 等待浏览器确认 / 可取消                    |
| `authenticated` | bootstrap 成功                                                           | 用户、设备、模型数、模型列表               |
| `expired`       | refresh 失败 / 401 且 refresh 无效                                       | “需要重新登录”，保留地址与 installation_id |
| `unreachable`   | DNS/连接/超时/5xx                                                        | “中台不可达”，保留上一次已知模型与登录态   |
| `blocked`       | 401/403 `LICENSE_INACTIVE` / `SEAT_REQUIRED` / `ORG_INACTIVE` / 设备超限 | 明确文案 + 可重试                          |

`unreachable` 与 `blocked` 是“已登录但当前不可用”的降级态，不销毁凭证（除 `expired`）。

---

## 3. 新增文件（主进程）

全部位于 `src/main/settings/`：

| 文件                        | 职责（公开符号）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lab-resource-limits.ts`    | `LAB_RESOURCE_LIMITS`：`loginAttemptTimeoutMs 8000`、`tokenTimeoutMs 8000`、`bootstrapTimeoutMs 8000`、`logoutTimeoutMs 5000`、`loginWindowMs 5*60_000`、`accessRefreshLeadMs 60_000`、`maxResponseBytes 1 MiB`、`maxModels 500`、`modelIdCharacters 200`、`serverUrlCharacters 2048`、`installationIdCharacters 128`、`documentBytes 1 MiB`；`assertLab*` 校验函数（对齐 `provider-resource-limits.ts` / `device-credential-resource-limits.ts`）                                                                                                                     |
| `lab-credential-store.ts`   | `${configRoot}/lab-credentials.json`（与 `credentials.json` 同目录）；`LabCredentialStore`：`read()`、`mutate(fn)`（FIFO 串行 + `writeDurableJsonFile` 原子写）、`saveSession(...)`、`clearTokens()`（保留 `installationId`）、`ensureInstallationId()`。文档形状：`{version:1, serverUrl, installationId, credentialRef:'enc:<密文>', updatedAt}`；`credentialRef` 内是 `{accessToken, refreshToken, tokenExpiresAt, sessionExpiresAt}` 的 JSON，经 `encryptKey` / `tryDecryptKey`。**解密失败**（钥匙串锁定/换机）等价于 `expired`，不丢 serverUrl 与 installationId |
| `lab-device-info.ts`        | `collectLabDeviceInfo()`：`os.hostname()`、`os.userInfo().username`、`process.platform`、`os.release()`、`process.arch`、`app.getVersion()`、`os.cpus()[0]?.model`、`app.getLocale()`、`Intl.DateTimeFormat().resolvedOptions().timeZone`；逐字段 clamp 到契约上限，**任何字段失败即丢弃该字段**，永不让采集阻塞登录                                                                                                                                                                                                                                                   |
| `lab-api.ts`                | 纯 HTTP（`netFetchStandard` + `fetchProviderRequest` + `readBoundedResponseText`）：`registerLoginAttempt`、`exchangeCode`、`refresh`、`logout`、`bootstrap`；统一 `LabApiError { code: LabErrorCode; status?; reason? }`；**不重试**、每次请求 AbortSignal 超时、token 不进日志（`errorLogFields` + 显式 redact）                                                                                                                                                                                                                                                     |
| `lab-callback-host.ts`      | `LabCallbackHost`：`listen(0, '127.0.0.1')` → `http://127.0.0.1:<port>/oauth/callback`；按 state 匹配 pending；`begin(state): {promise, cancel}`；5 分钟超时；成功/取消/过期三个最小 HTML 页（文案取 main `native` 命名空间，不做 8 语言外的新体系）；`close()` 释放端口                                                                                                                                                                                                                                                                                               |
| `lab-oauth.ts`              | `LabOAuthController`（对齐 `XaiOAuthControllerPort` 形状）：`beginLogin()`（生成 `code_verifier`/`code_challenge` S256/`state`/`installation_id`/`device_info` → `POST /api/auth/login-attempts` → 启动回调 host → `shell.openExternal(authorization_url)` → 返回 `{authorizationUrl, expiresAt}`）、`waitForLogin()`（等回调 → `POST /oauth/token` → 落库）、`cancelLogin()`、`logout()`、`getAccessToken(forceRefresh?)`、`getAccessCredential()`、`dispose()`、`quiesce()`                                                                                          |
| `lab-account-owner.ts`      | 组合根 + 状态机 + **单飞刷新**（`refreshPromise` + `isCurrentInFlight` + `refreshGeneration` 代际，完全照抄 `xai-oauth.ts:282-296` 的形态）；`restoreAtStartup()`（fire-and-forget，8s 超时，失败只改状态）、`refreshCatalog()`、`setServerUrl()`、`beginLogin/waitLogin/cancelLogin`、`logout()`（先 `POST /api/me/logout`，失败也本地清理）、`getAccessToken(forceRefresh)`、`getView(): LabView`、`getModels()`                                                                                                                                                     |
| `lab-provider.ts`           | 纯函数：模型 id 命名空间（`toLabModelId('id') => 'lab:id'`、`labModelWireId('lab:id') => 'id'`、`labModelLabel`）、`labBaseUrl(serverUrl, modelBaseUrl)`、`labApiEndpointsFromProtocols(protocols)`、`labProviderRecord(view)`、`LabErrorCode → copy key` 映射                                                                                                                                                                                                                                                                                                         |
| `lab-catalog-sync.ts`       | 唯一允许写 lab provider 的记录写入器：`syncLabProvider(settings, input)`（CAS：id/type/serverUrl 不匹配则放弃）、`removeLabProvider(...)`、**登录/刷新只更新 lab 记录，绝不调用 `setActiveProvider`**                                                                                                                                                                                                                                                                                                                                                                  |
| `lab-selection-fallback.ts` | `capturePreviousSelection(settings)`（用户切到 Lab 前记住 `{providerId, model}`）、`restoreSelectionAfterLogout(...)`（当前选择是 lab → 恢复；场景模型/子代理/复核/视觉/分类等若指向 lab → 回退 `inherit`）；其余字段一个都不动                                                                                                                                                                                                                                                                                                                                        |

**加密范围说明（可一行切换）**：access/refresh token 与到期时间放在 `credentialRef` 加密信封内；`serverUrl` 与 `installationId` 以明文存在同一文档（它们本就是非密信息，`serverUrl` 同时存在于 provider 记录的 `baseUrl`，`installationId` 是设备配额键——若也加密，钥匙串锁定时会既丢配置又被服务端当成新设备）。若你要求“全部字段加密”，只需把这两个字段并入信封。

共享类型：`src/shared/lab.ts`（`LabConnectionState`、`LabView`、`LabErrorCode`、`LabSignInChallenge`、`LabLoginResult`、`SetLabServerRequest` 等，全部可跨 IPC）。

---

## 4. 修改文件（主进程 / shared）

| 文件                                                                                  | 改动                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/settings.ts`                                                              | `ProviderType += 'lab'`；`LAB_PROVIDER_ID='builtin-lab'`、`labProviderIdentity()`、`isLabProvider()`；`usesAppProviderTransport` 纳入 lab；`shareProviderTransportFamily` 改为三值；`isProviderUsableByFramework` 的 app-managed 允许列表（`:242`）纳入 lab；`SettingsSnapshot.lab?: LabView` |
| `src/shared/provider-reasoning-effort.ts`                                             | `case 'lab'`（网关无 reasoning 契约 → `{ supported: false }`），这是编译期穷尽检查点                                                                                                                                                                                                          |
| `src/shared/configured-model-catalog.ts`                                              | lab 条目的 `label` 去前缀（`labModelLabel`）；`supportsImageInput` 走默认 false 分支                                                                                                                                                                                                          |
| `src/main/settings/record-codec.ts`                                                   | `PROVIDER_TYPES` 加入 `'lab'`（漏了会导致记录被静默丢弃）；lab 记录只持久化通用字段（`models`/`baseUrl`/`apiEndpoints`）                                                                                                                                                                      |
| `src/main/settings/provider-runtime-projection.ts`                                    | `resolveProviderApiEndpoints`、`resolveProvider`（lab：`baseUrl` 取自记录、`key: undefined`、**model 剥前缀为 wire id**）、`availableModels`（记录里的 models）、`providerSupportsImageInput`（false）                                                                                        |
| `src/main/settings/provider-accounts.ts`                                              | `prepareProvider` 的固定身份分支加 lab；`validateProvider` 对 lab 跳过探针（bootstrap 即真相）；`isProviderKeyUsable` → `lab.isUsable()`；`deleteProvider` 拒绝删除 lab（提示用“退出登录”）                                                                                                   |
| `src/main/settings/provider-transport-owner.ts`                                       | `acquireHarness` 允许列表加 lab；lab 的每条 transport 用 `resolveConnection`（chat-completions/responses）或 `resolveKey`（codex native responses）取 token；CodeBuddy/OpenCode 走同一 `resolveConnection`                                                                                    |
| `src/main/settings/backend-resolver.ts`                                               | 注入 `getLabAccessToken(forceRefresh?)`，与 `getXaiOAuthAccessToken` 并列（选项定义 `provider-transport-owner.ts:145`，组合根在 `service.ts`）                                                                                                                                                |
| `src/main/settings/service.ts`                                                        | 构造 `LabAccountOwner`；`getSettingsSnapshot` 注入 `lab` 视图；`dispose()`/`quiesceAuthentication()` 收编；启动恢复在 `src/main/index.ts` 的启动序列里 fire-and-forget                                                                                                                        |
| `src/main/settings/provider-model-catalog-owner.ts`                                   | lab 分支：`refresh()` → `lab.refreshCatalog()`（不走 `createProvider().listModels`）                                                                                                                                                                                                          |
| `src/main/settings/provider-validation-state.ts`                                      | lab 的 validation target 路由 = 记录里的 `apiEndpoints` 首选                                                                                                                                                                                                                                  |
| `src/main/settings/harness-session-owner.ts`                                          | 允许列表与 `baseline.keyRef` 判断纳入 lab（无 keyRef）                                                                                                                                                                                                                                        |
| `src/main/settings/agent-runtime-manager.ts`                                          | preflight 的 provider 可用性判断纳入 lab                                                                                                                                                                                                                                                      |
| `src/main/settings/ipc.ts`                                                            | 新增 `settings:lab-*` handler（7 条，见 §6）                                                                                                                                                                                                                                                  |
| `src/shared/renderer-contracts/settings-lab.ts`（新）+ `renderer-contract-catalog.ts` | `LOCAL` 档的 7 条 callable；`npm run gen:web-api-map` 重生成 `src/shared/web-api-map.generated.ts`                                                                                                                                                                                            |

---

## 5. 授权时序（浏览器 + 回环回调）

1. 面板保存 `https://lab.example.com`（校验见 §6），主进程生成一次性 `code_verifier`（43–128 chars）+ `code_challenge=S256` + `state`（16–256 未保留字符）。
2. `POST /api/auth/login-attempts`（公开）：`client_id=open-science-desktop`、`redirect_uri=http://127.0.0.1:<端口>/oauth/callback`、`state`、`code_challenge`、`code_challenge_method=S256`、`installation_id`、`device_name`、`device_info`（§3；全部可选、失败降级）。
3. 校验 `expires_at - now ≤ 5 分钟`、`authorization_url` 的 origin **必须等于配置的 server origin**（防重定向投毒），否则中止。
4. `shell.openExternal(authorization_url)`；面板进入 `signingIn`，`wait-login` 长轮询。
5. 浏览器完成确认 → 302 到 `http://127.0.0.1:<端口>/oauth/callback?code=…&state=…`。
6. `LabCallbackHost` 校验 path / state / 超时；向浏览器回 200 极简 HTML（“可关闭此窗口”）。
7. `POST /oauth/token`（`application/x-www-form-urlencoded`，`grant_type=authorization_code`、`client_id`、`code`、**完整** `redirect_uri`、`code_verifier`）→ `{access_token, expires_in:900, refresh_token, refresh_expires_in, session_expires_at}`。
8. 落盘：refresh/access 加密；`session_expires_at`、`installation_id`、server URL 明文；`device_info` 只用于展示（不落 token 相关）。
9. `GET /api/me/bootstrap` → 写 lab provider 记录（§7）；`SettingsSnapshot.lab` 推送 `settings:changed`。
10. 取消/关闭面板 → `cancel-login`：abort fetch、关回调 host、清 pending，状态回 `signedOut`，无残留 promise。

**刷新（严格单飞）**：`getAccessToken()` 命中缓存（剩余 > 60s 直接返回）→ 否则加入 `refreshPromise`；`POST /oauth/token` `grant_type=refresh_token`；轮换写入必须 CAS（旧 refresh 不匹配就放弃，绝不重试）；响应丢失/网络失败 → **不重试**，状态 `expired`，清 token。请求侧 401 → 一次 `forceRefresh` 重试，仍 401 → `expired`。

---

## 6. 设置入口、URL 校验与 IPC

- 面板：`SettingsPanelId 'lab'` + `SETTINGS_GROUPS`（**Connections** 组，`FlaskConical` 图标）+ `SettingsPage` 的 `lazy()` 分支（插在 `isProviderFormOpen` / `ModelPanel` fallback 之前）。`SettingsPage.architecture.test.ts` 的懒加载清单要加 `LabPanel`。
- URL 校验：复用 `src/shared/provider-url-policy.ts` 的 `getCustomProviderBaseUrlError`（仅 http/https、无 query/fragment、凭据不许进 URL）+ **额外规则**：非回环地址必须 `https:`（新增 `getLabServerUrlError`，放 `src/shared/lab.ts`，纯函数便于单测）。
- IPC（全部 `LOCAL`，Web 端注册拒绝桩）：

| 通道                                           | 请求 → 响应                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `settings:lab-set-server`                      | `SetLabServerRequest {serverUrl}` → `LabView`（保存后校验）                                 |
| `settings:lab-check`                           | `LabCheckRequest {serverUrl?}` → `LabView`（探测草稿地址，不保存、不清理当前登录；8s 超时） |
| `settings:lab-begin-login`                     | `{}` → `LabSignInChallenge {authorizationUrl, expiresAt}`                                   |
| `settings:lab-wait-login`                      | `{}` → `LabView`（成功/取消/过期/失败全部从 UI 有落点）                                     |
| `settings:lab-cancel-login`                    | `{}` → `LabView`                                                                            |
| `settings:lab-refresh` / `settings:lab-logout` | `{}` → `LabView`                                                                            |

- 状态推送复用既有 `settings:changed`（`SettingsSnapshot.lab`），不新增事件通道。

---

## 7. 模型接入与“不改已选”约束

1. **记录**：`builtin-lab`（`type: 'lab'`）只在登录后存在；`models = bootstrap.models.map(id => 'lab:' + id)`；`apiEndpoints` 由 `protocols` 映射（`openai → 'chat-completions'`，`openai-response → 'responses'`），去重后写入；`baseUrl = serverUrl + model_base_url`；`model_base_url` 必须是部署内相对路径或同 origin/path 前缀的绝对地址，越界即拒绝。
2. **模型 id 命名空间**：存储/展示用 `lab:<modelId>`，请求边界由 `resolveProvider` 剥回 wire id（网关只认公开 id）。`configuredModelKey` 仍按既有 `[providerId, model]` 双保险。
3. **选择器**：不改 `ActiveModelSelect` / `ScenarioModelList` / `SubagentModelSelect` 的交互——它们都从 `buildConfiguredModelCatalog(providers…)` 取值，lab provider 记录进 `SettingsSnapshot.providers` 后自动出现。
4. **不覆盖**：登录 / 刷新 / 目录更新只调用 `lab-catalog-sync`（只写 lab 记录），禁止 `setActiveProvider`。测试断言登录前后 `activeProviderId`、`activeModel`、`subagentModel`、`reviewerModel`、`visionModel`、`sessionDetailsModel`、`promptOptimizationModel`、各分类绑定逐字段相等。
5. **退出登录回退**：记录删除前读取 `activeProviderId`；若是 lab → 恢复 `capturePreviousSelection` 记住的个人选择（没有记忆时退回第一个可用个人 provider 的首个模型）；场景/子代理等绑定的 providerId 若是 lab → 重置为 `inherit`。
6. **框架可用性**：lab 只提供 chat-completions / responses，因此内置 Agent、Codex（responses）、CodeBuddy（chat-completions 桥）可用；Claude Code（messages）自动不可用，沿用既有“framework-incompatible”提示，不新增逻辑。
7. **协议窄化取舍**：bootstrap 的 `protocols` 是 per-model 的；本期只在 provider 级取并集，由各框架自己的 `preferredEndpoint` 选 wire。某模型不支持该 wire 时由网关 403 `MODEL_PROTOCOL_NOT_SUPPORTED` → 映射成 Lab 错误文案（见 §12-Q3）。

---

## 8. 故障隔离落点

| 场景                                                | 落点                                                               | 用户可见                                  |
| --------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| 地址非法 / 非 https（非回环）                       | `getLabServerUrlError`，`set-server` 直接返回错误，不落盘          | 面板字段内联错误                          |
| DNS / 连接失败 / 超时                               | `lab-api` 8s 超时 → `unreachable`                                  | 面板 “中台不可达” + 重试按钮              |
| 401（access 过期）                                  | 自动 `forceRefresh` 一次                                           | 无感                                      |
| 401（refresh 失效）                                 | `expired`，清 token 保留 installation_id                           | “需要重新登录”                            |
| 403 LICENSE_INACTIVE / SEAT_REQUIRED / ORG_INACTIVE | `blocked` + reason 文案                                            | 面板内联，不弹对话框                      |
| 设备超限（token 交换或 bootstrap）                  | `blocked` + “在浏览器中选择要替换的设备后重试”                     | 面板内联                                  |
| bootstrap 失败但已有模型                            | 保留旧模型，仅状态降级                                             | 模型仍可选；请求失败走 §9 映射            |
| 应用启动                                            | `restoreAtStartup()` 不 `await`，8s 上限；失败只写日志（无 token） | 启动、provider 列表、个人对话完全不受影响 |

**硬约束（用测试锁死）**：

- lab 模块不得 import 任何全局对话框（`dialog`/`AlertDialog`/`showMessageBox`）；architecture test 断言。
- lab 的网络调用只允许出现在 `lab-api.ts`（architecture test 断言 `lab-account-owner.ts` 无 `fetch(`）。
- Lab 失败不得写入其它 provider 的 `lastValidationFailure`，也不得让 `buildConfiguredModelCatalog` 整体抛错。
- 无自动重试：单次请求一次超时即失败（401 的一次 forceRefresh 是唯一例外）。

---

## 9. 文案与 i18n（8 语言）

新增 ~34 个 key，全部落在 `renderer` 命名空间（只有回环 HTML 页走 main `native`）：

- 导航/字段：`Lab`、`Lab server`、`Server address`、`Save`、`Save and test connection`、`Refresh models`
- 动作：`Sign in`、`Cancel sign-in`、`Sign out`、`Retry`
- 状态：`Not configured`、`Not signed in`、`Signing in…`、`Waiting for browser confirmation…`、`Signed in`、`Session expired — sign in again`、`Lab server unreachable`、`Lab access blocked`
- 摘要：`Signed in as {{name}}`、`Device: {{name}}`、`{{count}} models available`（8 语言全复数类别：de `_one/_other`，fr/es `_one/_many/_other`，ru `_one/_few/_many/_other`，zh/ja/ko 仅 `_other`）
- 错误：`Enter a Lab server address.`、`Lab server address must be a valid HTTP or HTTPS URL.`、`Use HTTPS for a Lab server that is not on this computer.`、`Remove credentials from the Lab server address.`、`Lab server address must not include query parameters or fragments.`、`Lab sign-in was cancelled.`、`The sign-in request expired. Start sign-in again.`、`Lab sign-in failed. Try again.`、`Your organization's Lab license is inactive.`、`A Lab seat is required for this account.`、`Your organization is inactive.`、`This account already uses the maximum number of Lab devices. Choose a device to replace in the browser, then retry.`、`The Lab server did not respond in time.`、`The Lab server rejected the request.`、`Lab models are unavailable while signed out.`
- 帮助：`Lab models use your organization's gateway. Sign in to see them in Conversation models.`

词典沿用 AGENTS.md 的强制术语（credential token = 令牌/權杖/トークン/토큰/Token(s)/токен；`Lab` 作为产品名保留不译）。新增 key 需过 `src/renderer/src/i18n/resources.test.ts`。

---

## 10. 测试矩阵（验收 8 条 → 文件）

主进程单测（fixture / `localhost` `createServer` 假服务器，**不连真实中台**）：

| 验收         | 文件                                                                                                      | 断言要点                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1 未配置     | `src/main/settings/lab-account-owner.test.ts`、`src/renderer/src/pages/settings/LabPanel.render.test.tsx` | 不配置时 0 次网络调用（fetch mock 断言）、状态 `unconfigured`、面板只显示未配置                                                     |
| 2 未登录     | `lab-oauth.test.ts` + `LabPanel.render.test.tsx`                                                          | 可保存地址、发起登录；`logout` 后个人 provider 仍可选中                                                                             |
| 3 已登录     | `lab-oauth.test.ts`、`lab-api.test.ts`、`lab-model-routing.test.ts`、`configured-model-catalog.test.ts`   | bootstrap 解析 → 记录/模型；`lab:` 前缀与 wire 剥离；`chat-completions`/`responses` 流式透传 + abort 取消（真 `http.createServer`） |
| 4 过期/刷新  | `lab-account-owner.test.ts`                                                                               | 并发 10 次 `getAccessToken` 只发 1 次 refresh（单飞）；refresh 失败 → `expired`；重启 restore 成功/失败两条路径                     |
| 5 断网       | `lab-restore.test.ts`、`lab-api.test.ts`、`ProvidersPanel` 渲染测试                                       | 启动 8s 内返回、不抛；provider 列表与个人对话渲染正常；错误文案明确                                                                 |
| 6 登录不覆盖 | `lab-selection-invariance.test.ts`                                                                        | 登录/刷新/目录更新前后逐字段比较选择类配置                                                                                          |
| 7 退出登录   | `lab-selection-fallback.test.ts` + `lab-catalog-sync.test.ts`                                             | lab 模型消失；active 回退到记忆的个人模型；场景绑定回 `inherit`                                                                     |
| 8 不泄漏     | `lab-credential-privacy.test.ts`                                                                          | `SettingsSnapshot`/`ProviderView` 序列化不含 token/refresh/access；日志捕获不含 token（含 `errorLogFields` 路径）                   |

架构/边界测试：

- `src/main/settings/lab-fault-isolation.architecture.test.ts`（新）：无 dialog import、无全局 show\*、fetch 只允许在 `lab-api.ts`、`lab-*` 不得被 renderer import。
- `src/main/settings/settings-backend.architecture.test.ts`、`provider-runtime-projection.architecture.test.ts`：lab 分支纳入允许清单。
- `src/renderer/src/pages/settings/SettingsPage.architecture.test.ts`：`LabPanel` 加入懒加载断言。
- `src/shared/renderer-surface-inventory.test.ts`、`renderer-surface-matrix.test.ts`、`renderer-contract-catalog.test.ts`、`src/preload/index.test.ts`：新通道/契约登记。
- `settings-panel-loader.test.ts` 无需改；`LabPanel` 若要用首帧数据，走 `loadSettingsPanel` 预载模式。

**测试写法约定（照仓库现状）**：

- 渲染测试第一行必须 `// @vitest-environment jsdom`；用 `createRoot` + `act`（settings 页惯例），`window.api` 在 `beforeEach` 装到真实 `window` 上，`afterEach` `vi.unstubAllGlobals()` + unmount。
- `SettingsPage.render.test.tsx` 会断言导航分组标题含 `Intelligence / Connections / Workspace / System` → Lab 挂在已有分组下即可（无新增分组标题）。
- 主进程测试**注入 `fetch`**（构造函数/选项），绝不打真实网络；确需 socket 时 `listen(0,'127.0.0.1')` 并在 `afterEach` 关闭（`provider-loopback-http-host.test.ts` 先例）。
- 时间相关（5 分钟窗口/8s 超时/刷新提前量）用 `vi.useFakeTimers()` + `advanceTimersByTimeAsync`，`afterEach(() => vi.useRealTimers())` 并断言 `vi.getTimerCount() === 0`。
- 测试标题用动词开头的英文陈述句（`keeps…`/`locks…`/`coalesces…`），不用 should；`describe` 用名词短语描述被拥有的关注点。

---

## 11. 工程门禁与实施阶段

**门禁**（AGENTS.md + `docs/testing.md` + `pr-gate.yml`，按 CI 实际顺序）：

1. `npx vitest run <改动的 *.test.ts>`（快循环；`npx` 直跑可跳过 `pretest` 的 prisma check + `build:packages`）。
2. `npx vitest run src/renderer/src/i18n/resources.test.ts`（i18n 独立 lane）。
3. `npm run lint` + `npx prettier --check <改动文件>`（CI 用 `scripts/ci/check-changed-format.mjs`；单引号、无分号、100 列、无尾逗号）。
4. `npm run typecheck:web` 与 `npm run typecheck:node`（会先 `build:packages`）。
5. 新 IPC：契约登记后 `npm run gen:web-api-map` → `npm run check:web-api-map`。
6. **模块登记（硬门禁）**：每个新建 `src/**` 文件必须且只能出现在一个 `scripts/ci/module-impact/<module-id>.json` 的 `ownerPaths` 里 → `node scripts/ci/audit-module-ownership.mjs` + `npx vitest run --config scripts/ci/vitest.registration.config.ts`；随后 `npm run generate:module-consumers && npm run check:module-consumers`。
7. 端到端前最后一次 `npm test`（含 architecture project 串行跑 `*.architecture.test.ts`）。
8. 提交信息用 Conventional Commits + scope，如 `feat(settings): add Lab enterprise provider`。

**代码约束（lint 会红）**：`@typescript-eslint/no-explicit-any` 是 error；`explicit-function-return-type` 是 error（具名函数/导出箭头都要标注返回类型）；`react-refresh/only-export-components` 是 error → **`LabPanel.tsx` 只能导出组件与字面量常量**，状态映射/文案表放同级 `.ts`（如 `lab-panel-view.ts`）；owner 模块里禁止 `console.`（architecture test 断言）。

**阶段与写入域**（Agent Teams；共享文件只由 Lead 改）：

| 阶段                  | 负责人     | 写入域                                                                                                                                                                                                                          | 依赖           |
| --------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| P0 契约骨架           | Lead       | `src/shared/lab.ts`、`src/shared/settings.ts`、`src/shared/renderer-contracts/settings-lab.ts`、`renderer-contract-catalog.ts`、`settings-navigation.ts`、`SettingsPage.tsx` 占位、`record-codec.ts`                            | —              |
| P1 凭证/授权/API      | teammate A | `src/main/settings/lab-{resource-limits,credential-store,device-info,api,callback-host,oauth,account-owner}.ts` + 对应 `*.test.ts`                                                                                              | P0             |
| P2 模型接入/路由/回退 | teammate B | `src/main/settings/lab-{provider,catalog-sync,selection-fallback}.ts`、`provider-runtime-projection.ts`、`provider-accounts.ts`、`provider-transport-owner.ts`、`backend-resolver.ts`、`provider-model-catalog-owner.ts` + 测试 | P0/P1 接口冻结 |
| P3 渲染层             | teammate C | `LabPanel.tsx`、`stores/settings-lab-slice.ts`、8 个 locale、`LabPanel.render.test.tsx`                                                                                                                                         | P0             |
| P4 接线与验证         | Lead       | `service.ts`、`main/settings/ipc.ts`、`main/index.ts` 启动恢复、module-impact、全量门禁                                                                                                                                         | P1–P3          |
| P5 复核               | verifier   | 只读 + 报告                                                                                                                                                                                                                     | P4             |

提交信息里写明：Lab provider 选型理由、刷新单飞策略、故障隔离落点。

---

## 12. 取舍与决策记录（实现采用推荐默认，PR 中复核）

**Q1（形态）— 已采用新增 `ProviderType 'lab'`**（理由见 §0/§3）。复用 `custom` + 隐藏 key 无法表达每模型双协议，会把 Lab 暴露进用户可编辑 provider 表单，且无法承载登出/刷新生命周期。

**Q2（模型 id）— 已采用 `lab:<id>` 前缀**：主进程 `resolveProvider` 剥回 wire id，展示 label 去前缀；同时保留既有 `[providerId, model]` 双保险。

**Q3（协议窄化）— 已采用 provider 级并集**，由各框架 `preferredEndpoint` 选 wire；逐模型过滤留作后续（需要改 catalog 与 validation target 语义）。

**Q4（工作区）— 已从 `main` 切 `feat/lab-provider`**；`package-lock.json` 的本地差异已复原；本方案文档保留在 `docs/`。

**Q5（场景绑定回退）— 已采用重置为 `inherit`**：退出登录时 Lab 记录删除，活动选择恢复到此前的个人 provider/模型；指向 Lab 的场景绑定回退到继承，避免悬空引用。

---

## 13. 风险与回滚

- **风险 1**：`ProviderType` 新增会触发约 12 处 switch/allow-list，漏一处会让 Lab 在某个框架下静默不可用 → 用 `provider-reasoning-effort.ts` 的 `never` 穷尽 + 现有 architecture tests 兜底。
- **风险 2**：刷新轮换语义（重复使用旧 refresh 会吊销整个会话）→ 严格单飞 + CAS 落库 + 响应丢失不重试，已按契约实现。
- **风险 3**：`resolveConnection` 路径会把错误脱敏成固定文案（`protocol-forwarding-bridge.ts` 的 `privateCredentials` 分支）→ 需要给该 target 增加可选 `mapError`，只映射 Lab 自己构造的、无 token 的错误对象，保持其余路径不变。
- **回滚**：所有改动都在新文件 + 显式类型分支上；删掉 `lab` 分支与面板即回到现状，settings.json 中残留的 lab 记录会被 `record-codec` 的允许列表丢弃（表里保留 'lab' 保证不丢数据）。
