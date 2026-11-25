## ✨ Highlights

- **Kleinere macOS-Updates.** In-App-Updates unter macOS laden nun signierte Deltas statt ZIP-Blockmaps herunter, sodass ein Update nur überträgt, was sich geändert hat — und ein fehlendes Delta kann nicht mehr stillschweigend zu einem vollständigen Download werden. (#4649)
- **Literatur lesen, ohne den Platz zu verlieren.** Abbildungen und Tabellen lassen sich direkt aus Textverweisen heraus in der Vorschau anzeigen, und ausgewählte Passagen werden direkt am Ort übersetzt — einseitige, reine Bild-PDFs öffnen sich nun mit einer auswählbaren Textebene. (#4681, #4667)
- **Mehr Wege, Modelle anzubinden.** Cloudflare AI Gateway, AWS Bedrock Runtime, Microsoft Foundry und Vectrust ergänzen den Anbieterkatalog, daneben eigene Ollama-, LM-Studio-, llama.cpp- und vLLM-Presets mit lokaler Modellermittlung. (#4662)
- **Eine leichtere, stabilere App.** Gesprächsverläufe und Notebook-Abbildungen werden bei Bedarf geladen, Katalogdurchläufe auf der Startseite und das Tippen im Arbeitsbereich kosten weniger, und die Notebook-Speicherzulassung prüft vor der Fortsetzung von Desktop-Arbeit erneut. (#4676, #4678, #4695)

## ⚠️ Scope & Safety

- **Neue Anbieterverbindungen senden Daten an die von Ihnen konfigurierten Endpunkte.** Anfragen über ein Cloud-Gateway (Cloudflare AI Gateway, AWS Bedrock Runtime, Microsoft Foundry, Vectrust) gehen an den jeweiligen Anbieter unter dessen Bedingungen; lokale Presets (Ollama, LM Studio, llama.cpp, vLLM) halten den Datenverkehr auf dem Rechner oder Netzwerk, auf das Sie sie ausrichten. Prüfen Sie das Ziel, bevor Sie sensiblen Projektinhalt über eine neu hinzugefügte Verbindung leiten. Siehe [Empfänger von Daten](https://github.com/aipoch/open-science/blob/v1.3.5/docs/security.md#data-recipients). (#4662)

## 🚀 New Features

- Anbieter erhalten **Cloud-Gateway-Presets** (Cloudflare AI Gateway, AWS Bedrock Runtime, Microsoft Foundry, Vectrust) mit protokollspezifischen Endpunkten und Authentifizierung sowie **lokale Modell-Presets** (Ollama, LM Studio, llama.cpp, vLLM) mit lokaler Modellermittlung; Cloud- und lokale Anbieter teilen sich eine bearbeitbare Modellliste mit Anzeigenamen, Kontextfenstern und Reasoning-Aufwand. (#4662)
- Abbildungen und Tabellen **lassen sich im PDF-Reader direkt aus Textverweisen in der Vorschau anzeigen**, selbst wenn das Paper nur die Nummer oder gar nichts verlinkt. (#4681)
- Der PDF-Reader kann **eine ausgewählte Passage direkt am Ort übersetzen** und hält dabei Ihre Leseposition; einseitige reine Bild-Literatur-PDFs öffnen sich mit einer auswählbaren Textebene. (#4667)
- Die Einstellungen erhalten eine **Bilddienst-Auswahl**, die die offiziellen Dienste vor dem benutzerdefinierten Formular zeigt, und die Anbieterliste wird neu sortiert, sodass aktive Abonnements zuerst erscheinen. (#4650)
- Die Windows-Desktop-Einrichtung installiert nun den Befehlsstarter `open-science`, sodass externe Agenten die App direkt nach einer stillen Installation steuern können. (#4679)
- Externe Agenten können gruppierte CLI-/MCP-Schleifen gegen die App über den gemeinsamen Agenten-Adaptervertrag ausführen. (#4661)

## 🔧 Improvements

- Lange Sitzungen fühlen sich leichter an: Gesprächsverläufe und Notebook-Abbildungen werden bei Bedarf statt alle auf einmal geladen, und Katalogdurchläufe auf der Startseite sowie das Tippen im Arbeitsbereich erledigen pro Tastenschlag weniger Arbeit. (#4676, #4678)
- Die Notebook-Speicherzulassung prüft vor der Fortsetzung von Desktop-Arbeit den verfügbaren Speicher erneut, und plattformübergreifende Speicherschwellen werden gesenkt, um realem Spielraum zu entsprechen. (#4695, #4643)
- Die Modellverfügbarkeit wird nun nach Ursache erklärt, sodass ein unbrauchbares Modell sagt, warum es nicht nutzbar ist, statt einfach nur fehlzuschlagen. (#4696)
- Verwaltete Agenten-Installationen prüfen npm-Registries gleichzeitig, was die Einrichtungswartezeit in langsamen Netzwerken verkürzt. (#4660)
- Themenkontrast und Sichtbarkeit der Anbieter-Symbole sind in hellen und dunklen Modi verbessert. (#4655)

## 🐛 Bug Fixes

- Die PDF-Übersetzung bewahrt das native Layout originalgetreuer, mit verbesserter Segmentierung und Rückschreibung wissenschaftlicher PDFs; die Vorschau-Verifizierung ist abgetrennt, sodass Layoutprobleme vor der Auslieferung sichtbar werden. (#4671, #4693, #4697)
- Das Wiederaufnehmen von Sitzungen erholt sich, wenn ein Modellanbieter vorübergehend nicht verfügbar ist, und wiederaufgenommene Läufe werden anhand ihres dauerhaften Wiederherstellungszustands validiert, statt vollständig fehlzuschlagen. (#4672, #4652)
- Wiederholungen der Anbieter-Bridge bewahren nun den ursprünglichen Modellfehler, statt ihn zu verschleiern. (#4653)
- Notebook-Robustheit: Übergabe-Metadaten und gespeicherte Terminal-Ausgaben überstehen die Sitzungswiederherstellung, Startprüfungen bleiben auf den wiederhergestellten Ausführungsweg begrenzt, und erfasste Abbildungen werden gerendert, wenn Werkzeugzeilen aufgeklappt werden. (#4657, #4647, #4677)
- Sitzungspakete leiten temporären Speicherplatz zum Daten-Stammverzeichnis statt zum Systemlaufwerk. (#4665)
- Updates: Der prominente Update-Hinweis ist zurück, Windows-Upgrades tolerieren vorübergehende Laufzeit-Trennungen, und Laufzeit-Downloads werden bei Netzwerkfehlern wiederholt. (#4646, #4645, #4644)
- Forschungsfilme behalten Alternativtexte für Nicht-Bild-Ziele, importierte Forschungsnavigation bleibt reaktionsschnell, und erfasste Arbeitsdateien lösen keine falschen Kürzungswarnungen mehr aus. (#4670, #4663, #4648)

## 🙏 Danksagungen

- Danke an alle, die Probleme mit Updates, Notebooks und Modellanbietern in [Discord](https://discord.gg/zxQAYjReRv), auf [X](https://x.com/aipoch_ai) und in den [Discussions](https://github.com/aipoch/open-science/discussions) gemeldet haben.
- Danke an [@liguohhh](https://github.com/liguohhh) für die Cloud-Gateway- und lokalen Modell-Presets ([#4662](https://github.com/aipoch/open-science/pull/4662)).
- Danke an [@nasus2002](https://github.com/nasus2002) für die Vorschau von Abbildungen und Tabellen aus Textverweisen ([#4681](https://github.com/aipoch/open-science/pull/4681)).
- Danke an [@guch96](https://github.com/guch96) für die gruppierte CLI-/MCP-Agentenschleife und die Notebook-Speichernachprüfungen ([#4661](https://github.com/aipoch/open-science/pull/4661), [#4695](https://github.com/aipoch/open-science/pull/4695)).
- Danke an [@ShuangChenyue](https://github.com/ShuangChenyue) für gleichzeitige Registry-Prüfungen und Sitzungswiederherstellung bei Anbieterausfällen ([#4660](https://github.com/aipoch/open-science/pull/4660), [#4672](https://github.com/aipoch/open-science/pull/4672)).
- Danke an [@cyj1116](https://github.com/cyj1116) für die Notebook-Übergabe und die Wiederherstellung von Terminal-Ausgaben ([#4657](https://github.com/aipoch/open-science/pull/4657)).
