## ✨ 亮点

- **所有资源，一处管理。** 资源中心现在统一管理 Skills、连接器和专家——包括 Marketplace 安装（Web UI 同样支持）——卡片、筛选器和详情视图保持一致；Skill 引用会在项目窗格中打开，无需离开当前对话。(#4270)
- **科学提示词优化。** 在输入区一键优化当前项目的提示词；可审查、编辑或撤销结果，并在项目设置中保存自定义模板。优化仅在你调用时、通过已配置的服务商运行。(#3991)
- **更强大的内置 Agent。** 主 Agent 和子智能体现在可使用 Codex 订阅账户，Claude Fable 5.2 加入模型列表，超长回答不再在 4,096 token 处被截断。(#4250, #4249, #4275)
- **长研究会话导出不再卡顿。** Notebook 和 Compute 运行以紧凑、可验证的形式只将证据存储一次，因此长历史的 `.science` 导出既快又小。(#4248, #4258, #4240)
- **经受真实网络考验的云端算力登录。** Modal 和 Hugging Face 在打开浏览器前先准备好兼容的 Python 运行时，账户验证现在遵循系统代理。(#4255)

## 🚀 新功能

- 可在统一的资源中心管理 Skills、连接器和专家——并可在 Marketplace 中安装（Web 渲染端同样支持）——目录卡片一致、筛选器可重置、支持批量选择和详情抽屉；来自输入区和已发送消息的 Skill 引用会在项目资源中心窗格中打开，不打断当前对话或草稿。(#4270)
- 可在输入区优化当前项目的提示词：结果替换草稿前可先审查和编辑；撤销可恢复之前的文本及被移除的粘贴附件；自定义优化模板保存在项目设置中。优化由手动触发，仅在被调用时通过已配置的服务商运行。(#3991)
- 内置 Open-Science Agent 的主 Agent 和子智能体可使用导入的或应用自有的 Codex 订阅账户，登录、刷新和凭据更换复用现有的 Codex 连接流程。(#4250)
- 可从内置的 Anthropic 模型列表中选择带 1M 上下文窗口的 Claude Fable 5.2。(#4249)
- 可沿 BibTeX 和 RIS 将参考文献元数据导出为 CSV——跨页选择参考文献并逐项排除，或导出整个项目/集合——使用 16 个稳定的英文列名，缺失值留空。(#4262)

## 🔧 改进

- 内置 Agent 遵循每个模型公布的输出上限（先取配置值，再取准确的厂商元数据，最后回退到 16,384 token），并优先使用每个模型的原生端点协议，使服务商支持的长回答完整送达。(#4275)
- 内置 Agent 正确计量上下文占用，长会话中压缩时机大幅延后。(#4209)
- 已回答的 Agent 提问不再等待延迟的持久化落盘，消除了回答继续之前“完成结果尚未提交”的停滞。(#4279)
- Modal 和 Hugging Face 计算目标共享一套 Python 运行时准备流程：检查所选解释器但不向其安装内容，授权和 SDK 调用始终绑定到它，过期的授权结果无法再覆盖更新的连接。(#4255)
- Notebook 和 Compute 证据按唯一内容只存储一次并带经验证的摘要；长历史导出——同一文件上数百次运行——生成紧凑的包，首次导出会回填历史证据。(#4248, #4258, #4240, #4259)
- 切换会话时研究影片生成会继续进行，不再随发起会话的停止而中断。(#4268)
- 空闲的 Python、R、REPL 和 Shell 解释器在会话 15 分钟无活动后被回收，并按类型使用小型池，已结束的对话不再累积常驻运行时。(#4274)
- 上下文重置通知 6 秒后自动消失，资源目录卡片保持用量头像紧凑。(#4281, #4276)

## 🐛 问题修复

- 聊天中附加的 Notebook 文件可再次打开预览，回复中的本地文件链接会打开对应文件。(#4257)
- 签名版 Windows 更新打包已解除阻塞，更新恢复会指出占用应用的文件和进程、清理已关闭的启动日志，并在不卡死安装程序的情况下解除阻塞。(#4233, #4230, #4231, #4247)
- 文献导入保留标识符路由和 DOI 字母大小写。(#4225)
- 网站来源预览在窄布局下恢复响应式。(#4220)
- 外部 PDF 结构恢复增强了对损坏文件的防护，PDF 翻译按文档隔离 Agent 提示词和工具能力。(#4238, #4228)
- 移动配对在你选择前保持关闭，Web 远控 RPC 失败会说明原因，不再静默失败。(#4221)
- 服务商错误详情可完整穿过 Agent 运行时传递，OpenCode 请求分类失败不再泄漏到触发它的请求之外。(#4237, #4261)
- 对话提交可靠确认终止事件，授权的本地 CLI 导入在会话包中恢复可用，长对话中的首条消息导航已恢复。(#4269, #4267, #4260)
- Linux 恢复不再把已确认的内核线程误判为泄漏的 Notebook 进程。(#4265)

## 🙏 致谢

- 感谢 [@wen2zhou](https://github.com/wen2zhou) 为内置 Agent 提供 Codex 订阅支持（[#4250](https://github.com/aipoch/open-science/pull/4250)）、Modal 和 Hugging Face 运行时准备（[#4255](https://github.com/aipoch/open-science/pull/4255)）以及聊天文件预览（[#4257](https://github.com/aipoch/open-science/pull/4257)）。
- 感谢 [@roxi3906](https://github.com/roxi3906) 实现项目级提示词优化（[#3991](https://github.com/aipoch/open-science/pull/3991)）。
- 感谢 [@nasus2002](https://github.com/nasus2002) 实现文献 CSV 导出（[#4262](https://github.com/aipoch/open-science/pull/4262)）并修复 DOI 处理（[#4225](https://github.com/aipoch/open-science/pull/4225)）。
- 感谢 [@guch96](https://github.com/guch96) 修复已回答问题的继续执行（[#4279](https://github.com/aipoch/open-science/pull/4279)）并实现 Windows 更新恢复（[#4230](https://github.com/aipoch/open-science/pull/4230)），感谢 [@cyj1116](https://github.com/cyj1116) 改进移动配对（[#4221](https://github.com/aipoch/open-science/pull/4221)），感谢 [@daanveer-tech](https://github.com/daanveer-tech) 完善 README 基准测试文档（[#4219](https://github.com/aipoch/open-science/pull/4219)、[#4227](https://github.com/aipoch/open-science/pull/4227)）。
