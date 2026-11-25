## ✨ 亮点

- **macOS 更新体积更小。** macOS 上的应用内更新现在下载签名增量包，而非 ZIP blockmap，更新只传输发生变化的部分——缺失的增量包也不会再悄悄变成完整下载。(#4649)
- **读文献不再打断思路。** 图表可直接从文内引用处预览，选中的段落可原位翻译——单页纯图像 PDF 现在会带可选择的文本层打开。(#4681, #4667)
- **连接模型的方式更多。** Cloudflare AI Gateway、AWS Bedrock Runtime、Microsoft Foundry 与 Vectrust 加入提供商目录，同时新增 Ollama、LM Studio、llama.cpp 与 vLLM 专用预设，支持本地模型发现。(#4662)
- **更轻快、更稳定的应用。** 对话记录历史与 Notebook 图表按需加载，首页目录扫描与工作区输入的开销更低，Notebook 在继续桌面工作前会重新检查内存准入。(#4676, #4678, #4695)

## ⚠️ 范围与安全

- **新的提供商连接会将数据发送到你配置的端点。** 通过云网关（Cloudflare AI Gateway、AWS Bedrock Runtime、Microsoft Foundry、Vectrust）的请求会按该提供商的条款发往该提供商；本地预设（Ollama、LM Studio、llama.cpp、vLLM）则将流量保留在你指定的机器或网络内。在通过新添加的连接传输敏感项目内容前，请先确认目的地。参见[数据接收方](https://github.com/aipoch/open-science/blob/v1.3.5/docs/security.md#data-recipients)。(#4662)

## 🚀 新功能

- 提供商新增**云网关预设**（Cloudflare AI Gateway、AWS Bedrock Runtime、Microsoft Foundry、Vectrust），带协议专属端点与认证，以及**本地模型预设**（Ollama、LM Studio、llama.cpp、vLLM），支持本地模型发现；云端与本地提供商共享一份可编辑的模型列表，包含显示名称、上下文窗口与推理档位。(#4662)
- PDF 阅读器中的图表可以**从文内引用处内联预览**，即使论文只链接了编号、甚至什么都没有链接。(#4681)
- PDF 阅读器可以**原位翻译选中的段落**，保持你的阅读位置；单页纯图像文献 PDF 会带可选择的文本层打开。(#4667)
- 设置新增**图像服务选择器**，官方服务显示在自定义表单之前，提供商列表重新排序，活跃订阅优先显示。(#4650)
- Windows 桌面安装现在会安装 `open-science` 命令启动器，外部 Agent 在静默安装后即可直接驱动应用。(#4679)
- 外部 Agent 可以通过共享的 Agent 适配器契约，针对应用运行成组的 CLI/MCP 循环。(#4661)

## 🔧 改进

- 长会话更轻快：对话记录历史与 Notebook 图表按需加载而非一次性全部加载，首页目录扫描与工作区输入每次击键的工作量更少。(#4676, #4678)
- Notebook 在继续桌面工作前会重新检查可用内存，跨平台内存阈值下调以贴近真实余量。(#4695, #4643)
- 模型可用性现在按原因说明，不可用的模型会告诉你原因，而不是仅仅失败。(#4696)
- 托管 Agent 安装会并发探测 npm registry，减少慢网络下的安装等待。(#4660)
- 主题对比度与提供商图标可见性在浅色与深色模式下均有改进。(#4655)

## 🐛 问题修复

- PDF 翻译更忠实地保留原生排版，科学类 PDF 的分段与回写有所改进，且预览校验相互独立，排版问题会在交付前暴露。(#4671, #4693, #4697)
- 会话恢复在模型提供商暂时不可用时也能继续，恢复的 Run 会对照其持久恢复状态进行校验，而不是直接失败。(#4672, #4652)
- 提供商桥接重试现在保留原始模型错误，不再将其掩盖。(#4653)
- Notebook 健壮性：交接元数据与已保存的 shell 输出在会话恢复后仍然保留，启动探测限定在正在恢复的通道内，捕获的图表在工具行展开时正常渲染。(#4657, #4647, #4677)
- 会话包将临时空间定向到数据根目录，而不是系统盘。(#4665)
- 更新：醒目的更新提醒回归，Windows 升级可容忍瞬时运行时断连，运行时下载在网络失败时会重试。(#4646, #4645, #4644)
- 研究影片为非图像目标保留替代文本，导入的研究导航保持响应，捕获的工作文件不再触发误报的截断警告。(#4670, #4663, #4648)

## 🙏 致谢

- 感谢所有在 [Discord](https://discord.gg/zxQAYjReRv)、[X](https://x.com/aipoch_ai) 和 [Discussions](https://github.com/aipoch/open-science/discussions) 中反馈更新、Notebook 与模型提供商问题的用户。
- 感谢 [@liguohhh](https://github.com/liguohhh) 贡献云网关与本地模型预设（[#4662](https://github.com/aipoch/open-science/pull/4662)）。
- 感谢 [@nasus2002](https://github.com/nasus2002) 贡献文内图表预览（[#4681](https://github.com/aipoch/open-science/pull/4681)）。
- 感谢 [@guch96](https://github.com/guch96) 贡献成组 CLI/MCP Agent 循环与 Notebook 内存复查（[#4661](https://github.com/aipoch/open-science/pull/4661)、[#4695](https://github.com/aipoch/open-science/pull/4695)）。
- 感谢 [@ShuangChenyue](https://github.com/ShuangChenyue) 贡献并发 registry 探测与提供商故障时的会话恢复（[#4660](https://github.com/aipoch/open-science/pull/4660)、[#4672](https://github.com/aipoch/open-science/pull/4672)）。
- 感谢 [@cyj1116](https://github.com/cyj1116) 贡献 Notebook 交接与 shell 输出恢复（[#4657](https://github.com/aipoch/open-science/pull/4657)）。
