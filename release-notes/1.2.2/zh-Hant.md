## ✨ 亮點

- **嚴格的 Notebook 網路模式。** 可選用的 Strict 模式以手動管理的白名單取代授權提示：只有同時符合你所設定的通訊協定、主機名稱或 IP、以及埠號規則的請求才會被允許，未符合的請求會直接被封鎖。Relaxed 模式仍是預設值，維持現有的核准行為。(#4253)
- **研究影片從檢查點繼續。** 中斷的影片產生會保留已驗證的成果並繼續：已完成的場景、旁白、時間軸與混音會在行程重啟後重複使用，對話框會顯示目前位於五步驟中的哪一步，並由你選擇繼續或重新產生。(#4290)
- **PDF 往返保真度。** 外部 PDF 會復原完整的原生圖形、圖註、表格記錄與閱讀順序，翻譯後的文件也會保留原始結構與版面配置，不再退回未經驗證的版面安排。(#4300, #4342, #4340, #4334, #4286)
- **更安全的 Windows 授權與更新。** 受保護模式下的資料夾授權會在儲存前先驗證；更新、解除安裝與交接流程能更可靠地復原、指出是什麼阻擋了它們，並保留診斷資訊。(#4217, #4305, #4327, #4328, #4337, #4346)
- **供應商目錄更新。** Qwen4 Max Preview 以 1M 內容視窗加入北京與新加坡的 Bailian Token Plans，官方連線的預設模型也已更新。(#4311, #4301)

## 🚀 新功能

- 將 Notebook 網路切換為 Strict 模式：請求必須在手動管理的白名單中同時符合通訊協定、主機名稱或 IP、以及埠號規則，未符合的請求會在未提供授權選項的情況下被封鎖。規則以可編輯的邏輯群組管理並附來源標籤；既有的內建目的地會在首次啟用時植入一次，編輯內容會持久保存。依賴此模式前請先檢閱植入的規則，因為被封鎖的請求會直接失敗而不會發出詢問。(#4253)
- 從已驗證的檢查點繼續中斷的研究影片產生：已完成的輔助程式與場景能在之後的失敗中倖存，旁白與時間軸獨立於播放器建置快取，影片對話框會顯示五步驟中的目前步驟，並提供明確的繼續或重新產生選項。(#4290)
- 在受保護模式下，於儲存前以唯讀 ACL 檢查預先檢驗 Windows 資料夾授權：無法使用的資料夾會在寫入任何授權前連同原因一併拒絕，Notebook 執行不再於之後因隱藏的 kernel 啟動錯誤而失敗。(#4217)
- 從北京與新加坡的 Bailian Token Plans 中選擇 Qwen4 Max Preview：1M 內容視窗、多模態輸入，以及低／中／極高三種推理強度，透過既有的區域選擇器與金鑰控制台解析。(#4311)

## 🔧 改進

- 外部 PDF 結構復原會保留完整的圖形及其圖註、表格記錄與儲存格，以及縮放文字與頁首周圍的原生內嵌閱讀順序。(#4300, #4342, #4340)
- 翻譯後的 PDF 保留原生結構與版面配置：版面安排須具備經驗證的目標語言自有證據，無法證明時一律保留原始內容。(#4334, #4286)
- 工作階段套件匯入會回報結果：取消會回傳非零結果、請求逾時會標記為未確認並附重試前請先檢查的建議，缺漏檔案或格式錯誤的封存會取得各自的錯誤碼與日誌關聯 ID。(#4338)
- 官方供應商連線的預設模型更新為目前的建議版本。(#4301)
- 預覽介面會適應行動裝置的視窗尺寸。(#4325)
- 設定的資料根目錄可透過已註冊的別名存取。(#4306)
- 本機 CLI 保留憑證設定檔、容忍控制台失敗，並在資料傳輸期間維持成品下載不中斷。(#4298, #4299)

## 🐛 錯誤修正

- 桌面版失去本機服務時，現在全視窗的復原介面會阻擋工作區互動，直到連線恢復，期間保持草稿掛載，並在之後還原焦點。(#4323)
- Windows 更新與解除安裝流程將更新安全與記錄清理分開，掃描實體安裝資源，在交接前回收自有的輔助程式，即時取消宿主檢查，以出生身分而非僅 PID 識別行程，並保留失敗診斷資訊。(#4305, #4327, #4328, #4337, #4346)
- 中斷的 Windows kernel 工作會復原，PowerShell stderr 重新導向不再吞掉原生 Notebook 輸出。(#4297, #4295)
- 工作階段持久化避免刪除清理的僵局，並將啟動時的還原與進行中的儲存解耦。(#4312, #4314)
- 智慧代理執行階段錯誤會區分模型供應商失敗與 ACP 失敗，重新載入的工作階段在提示詞啟動前保持受保護，已取消的提示詞會中斷分類查詢。(#4322, #4283, #4289)
- 無關的已儲存資料夾授權不再阻擋 Notebook 啟動。(#4309)
- 預覽在版本檢查期間保持內容不動。(#4293)
- 直接的 SSH 工作中止會限制未確認的中止嘗試。(#4313)
- 淺色與深色介面都能保留對比度，包含深色模式的頭像、重播輸入與主題切換。(#4345, #4339, #4332)
- 桌面版在第一個未捕捉的主行程錯誤後會直接結束，不再以損壞的狀態勉強繼續執行。(#4316)
- 環境檢閱狀態的措辭與其他檢閱狀態有所區分，文獻條目接受含彈性空白的 LaTeX 套件清單。(#4347, #4303)

## 🙏 致謝

- 感謝 [@roxi3906](https://github.com/roxi3906) 提供嚴格的 Notebook 白名單模式（[#4253](https://github.com/aipoch/open-science/pull/4253)）與風險程式碼呈現修正（[#4318](https://github.com/aipoch/open-science/pull/4318)、[#4282](https://github.com/aipoch/open-science/pull/4282)）。
- 感謝 [@ShuangChenyue](https://github.com/ShuangChenyue) 提供 Windows 資料夾授權預先檢驗（[#4217](https://github.com/aipoch/open-science/pull/4217)）。
- 感謝 [@liyeshunag](https://github.com/liyeshunag) 提供 CLI 憑證設定檔修正（[#4298](https://github.com/aipoch/open-science/pull/4298)）與已取消提示詞的處理（[#4289](https://github.com/aipoch/open-science/pull/4289)）。
- 感謝 [@cyj1116](https://github.com/cyj1116) 提供行動裝置預覽介面（[#4325](https://github.com/aipoch/open-science/pull/4325)）與成品下載修正（[#4299](https://github.com/aipoch/open-science/pull/4299)）、感謝 [@wen2zhou](https://github.com/wen2zhou) 的 SSH 中止限制（[#4313](https://github.com/aipoch/open-science/pull/4313)）與 PowerShell 輸出保留（[#4295](https://github.com/aipoch/open-science/pull/4295)）、感謝 [@liguohhh](https://github.com/liguohhh) 的重新載入工作階段保護（[#4283](https://github.com/aipoch/open-science/pull/4283)）、感謝 [@nasus2002](https://github.com/nasus2002) 的 LaTeX 文獻解析（[#4303](https://github.com/aipoch/open-science/pull/4303)）、感謝 [@guch96](https://github.com/guch96) 的工作階段持久化（[#4314](https://github.com/aipoch/open-science/pull/4314)），以及感謝 [@daanveer-tech](https://github.com/daanveer-tech) 的 README 更新（[#4292](https://github.com/aipoch/open-science/pull/4292)、[#4294](https://github.com/aipoch/open-science/pull/4294)、[#4324](https://github.com/aipoch/open-science/pull/4324)）。
