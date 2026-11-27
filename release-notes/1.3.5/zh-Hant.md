## ✨ 亮點

- **更小的 macOS 更新。** macOS 上的應用程式內更新現在會下載已簽署的差量，取代 ZIP 區塊對映，因此更新只傳輸有變更的部分——缺少差量也不再悄悄變成完整下載。（#4649）
- **閱讀文獻不中斷。** 圖表可直接從內文引用預覽，選取的段落可就地翻譯——僅含影像的單頁 PDF 現在會以可選取的文字層開啟。（#4681、#4667）
- **更多連接模型的方式。** Cloudflare AI Gateway、AWS Bedrock Runtime、Microsoft Foundry 與 Vectrust 加入提供者目錄，並新增 Ollama、LM Studio、llama.cpp 與 vLLM 的專用預設，支援本機模型探索。（#4662）
- **更輕巧、更穩定的應用程式。** 對話歷程與 Notebook 圖表改為按需載入，首頁目錄掃描與工作區輸入的成本更低，Notebook 記憶體准入會在繼續桌面工作前重新檢查。（#4676、#4678、#4695）

## ⚠️ 範圍與安全

- **新的提供者連線會將資料傳送到你設定的端點。** 透過雲端閘道（Cloudflare AI Gateway、AWS Bedrock Runtime、Microsoft Foundry、Vectrust）發出的請求，會依該提供者的條款送往該提供者；本機預設（Ollama、LM Studio、llama.cpp、vLLM）則讓流量留在你指向的機器或網路上。在將敏感的專案內容透過新增的連線傳送之前，請先檢視其目的地。請參閱[資料接收方](https://github.com/aipoch/open-science/blob/v1.3.5/docs/security.md#data-recipients)。（#4662）

## 🚀 新功能

- 提供者新增**雲端閘道預設**（Cloudflare AI Gateway、AWS Bedrock Runtime、Microsoft Foundry、Vectrust），具備各協定的專用端點與驗證，以及**本機模型預設**（Ollama、LM Studio、llama.cpp、vLLM），支援本機模型探索；雲端與本機提供者共用可編輯的模型清單，包含顯示名稱、上下文視窗與推理強度。（#4662）
- PDF 閱讀器中的圖表現在可**從內文引用內嵌預覽**，即使論文只連結編號或完全沒有連結也適用。（#4681）
- PDF 閱讀器可**就地翻譯選取的段落**，保持你的閱讀位置；僅含影像的單頁文獻 PDF 會以可選取的文字層開啟。（#4667）
- 設定新增**影像服務選擇器**，會先顯示官方服務再顯示自訂表單；提供者清單也已重新排序，讓使用中的訂閱優先顯示。（#4650）
- Windows 桌面安裝現在會安裝 `open-science` 命令啟動器，讓外部 Agent 在靜默安裝完成後即可驅動應用程式。（#4679）
- 外部 Agent 可透過共用的 Agent 轉接器合約，對應用程式執行分組的 CLI/MCP 迴圈。（#4661）

## 🔧 改進

- 長工作階段更輕巧：對話歷程與 Notebook 圖表改為按需載入，不再一次全部讀取；首頁目錄掃描與工作區輸入每次按鍵的工作量也更少。（#4676、#4678）
- Notebook 記憶體准入會在繼續桌面工作前重新檢查可用記憶體，並調低各平台的記憶體閾值，以符合實際可用的餘裕。（#4695、#4643）
- 模型可用性現在會依原因說明，無法使用的模型會告訴你原因，不再只是失敗。（#4696）
- 受管理的 Agent 安裝會同時探測多個 npm 登錄檔，縮短慢速網路下的設定等待時間。（#4660）
- 主題對比度與提供者圖示可見度在淺色與深色模式下皆有改善。（#4655）

## 🐛 錯誤修正

- PDF 翻譯更忠實地保留原生版面配置，科學 PDF 的分段與寫回皆有改善；預覽驗證也已分離，讓版面問題在交付前浮現。（#4671、#4693、#4697）
- 當模型提供者暫時無法使用時，工作階段恢復可正常運作；恢復的 Run 會依其持久復原狀態驗證，不再直接失敗。（#4672、#4652）
- 提供者橋接的重試現在會保留原始的模型錯誤，不再將其遮蔽。（#4653）
- Notebook 穩健性：交接中繼資料與已儲存的 shell 輸出在工作階段復原後仍能保留，啟動探測維持在復原中的通道範圍內，擷取的圖表在工具列展開時可正常顯示。（#4657、#4647、#4677）
- 工作階段套件改將暫存空間導向資料根目錄，不再使用系統磁碟。（#4665）
- 更新：顯眼的更新提醒回歸，Windows 升級可容忍暫時性的執行時期中斷，執行時期下載在網路失敗時會重試。（#4646、#4645、#4644）
- 研究影片為非影像目標保留替代文字，匯入的研究導覽保持流暢，擷取的工作檔案不再觸發誤報的截斷警告。（#4670、#4663、#4648）

## 🙏 致謝

- 感謝大家在 [Discord](https://discord.gg/zxQAYjReRv)、[X](https://x.com/aipoch_ai) 與 [Discussions](https://github.com/aipoch/open-science/discussions) 回報更新、Notebook 與模型提供者相關的問題。
- 感謝 [@liguohhh](https://github.com/liguohhh) 貢獻雲端閘道與本機模型預設（[#4662](https://github.com/aipoch/open-science/pull/4662)）。
- 感謝 [@nasus2002](https://github.com/nasus2002) 貢獻內文圖表預覽（[#4681](https://github.com/aipoch/open-science/pull/4681)）。
- 感謝 [@guch96](https://github.com/guch96) 貢獻分組的 CLI/MCP Agent 迴圈與 Notebook 記憶體重新檢查（[#4661](https://github.com/aipoch/open-science/pull/4661)、[#4695](https://github.com/aipoch/open-science/pull/4695)）。
- 感謝 [@ShuangChenyue](https://github.com/ShuangChenyue) 貢獻並行登錄檔探測與提供者中斷時的工作階段復原（[#4660](https://github.com/aipoch/open-science/pull/4660)、[#4672](https://github.com/aipoch/open-science/pull/4672)）。
- 感謝 [@cyj1116](https://github.com/cyj1116) 貢獻 Notebook 交接與 shell 輸出復原（[#4657](https://github.com/aipoch/open-science/pull/4657)）。
