## ✨ Highlights

- **Blick in den integrierten Agenten.** Projekte können die Agenten-Ablaufverfolgung aktivieren und korrelierte Bereiche für Turns, Modellanfragen und Werkzeugausführungen an einen selbst gehosteten OTLP/HTTP-Empfänger exportieren — generische Sammler und Langfuse werden unterstützt — wobei die erfasste Detailtiefe in Ihrer Hand liegt. (#4514)
- **Windows-Updates ohne Hürden und kleiner.** Ein In-App-Update bleibt nicht mehr stehen, solange der integrierte Agent läuft: Die Aktualisierung erkennt die eigenen Agent-Prozesse der App nun, statt fehlzuschlagen. Stabile Windows-Updates werden außerdem wieder als kompakte Installer-Deltas angewendet — v1.3.3 war auf das vollständige Installationsprogramm ausgewichen. (#4602, #4606, #4611, #4605)
- **Lange Notebook-Verläufe bleiben flott.** Beim Starten und Abschließen von Läufen, beim Auswählen von Ergebnissen und beim Öffnen von Vorschauen wird der gesamte Verlauf nicht mehr erneut gelesen, und geeignete Laufübergänge werden zu dauerhaften Prüfpunkten zusammengefasst. (#4615, #4617)
- **Speicheranzeigen, denen Sie vertrauen können.** Unter macOS stimmt die Compute-Zusammenfassung nun mit der Aktivitätsanzeige überein, indem zwischengespeicherter Speicher ausgeschlossen wird; unter Windows wird der zugesicherte Speicher im Verhältnis zu seinem Limit zusammen mit dem physischen Speicher angezeigt. (#4599, #4600)

## ⚠️ Scope & Safety

- **Die Agenten-Ablaufverfolgung sendet Daten an einen von Ihnen konfigurierten Empfänger.** Die projektbezogene Ablaufverfolgung ist standardmäßig deaktiviert und beginnt erst, wenn ein Projekt sie einschaltet; für einen einzelnen CLI-Lauf ist `--otel-traces` (oder `otelTraces: true` im SDK) eine ausdrückliche Opt-in-Entscheidung pro Lauf, die ohne den Projektschalter auskommt. In beiden Fällen gehen die Bereiche — Turn-Struktur, Modellanfragen und Werkzeugausführungen in Ihrer gewählten Detailtiefe — ausschließlich an den in der Startkonfiguration der App gesetzten OTLP/HTTP-Endpunkt, niemals an einen dienstbetriebenen Dienst der App. Wählen Sie einen Empfänger, den Sie kontrollieren, und prüfen Sie die Erfassungsschalter, bevor Sie die Ablaufverfolgung auf gemeinsam genutzten Rechnern aktivieren. Siehe [Empfänger von Daten](https://github.com/aipoch/open-science/blob/v1.3.4/docs/security.md#data-recipients). (#4514)

## 🚀 New Features

- Projekte erhalten einen optionalen Schalter für die **Agenten-Ablaufverfolgung**: Ist er aktiviert und ein Empfänger konfiguriert, exportiert der integrierte Agent korrelierte OTLP/HTTP-JSON-Bereiche für Turns, Modellanfragen und MCP-Werkzeugausführungen an generische Sammler oder Langfuse. Vier Detailschalter steuern, was erfasst wird, und ein lokaler Schalter für den Übertragungsstatus meldet die Zustellgesundheit. (#4514)
- CodeBuddy-Verbindungen ermitteln die von jedem Modell unterstützten Reasoning-Aufwände während der Anmeldung und bei der Katalogaktualisierung; die Auswahl bietet dann nur noch die Stufen an, die das gewählte Modell tatsächlich unterstützt. (#4619)
- Der Modellkatalog von Zhipu führt nun GLM-5.4, das direkt auf Zhipu-Verbindungen verfügbar ist. (#4637)

## 🔧 Improvements

- Lange Notebook-Verläufe kosten weniger: Eine begrenzte, validierte Verlaufsansicht ersetzt wiederholte vollständige Lesevorgänge beim Starten oder Abschließen eines Laufs, beim Auswählen von Ergebnissen oder beim Öffnen von Vorschauen, und geeignete Laufübergänge werden in dauerhafte, pro Ausführungsweg eigene Speicherplätze geschrieben, die zu Prüfpunkten zusammenlaufen. (#4615, #4617)
- Die Compute-Systemzusammenfassung richtet sich an der jeweiligen nativen Zählweise der Plattform aus: Die Nutzung unter macOS stimmt mit der Aktivitätsanzeige überein (zwischengespeicherter Speicher ausgeschlossen), und Windows zeigt den zugesicherten Speicher im Verhältnis zu seinem Limit mit abgestimmten Standardschwellen. (#4599, #4600)

## 🐛 Bug Fixes

- Unter Windows bleibt ein In-App-Update nicht mehr stehen, solange der integrierte Agent oder der Bildhelfer läuft — beide werden nun als eigene Installationshelfer der App erkannt, und die Helfer-Registrierung wird automatisch erzwungen, sodass kein neuer Helfer mehr übersehen werden kann. (#4602, #4606, #4611)
- Stabile Windows-Veröffentlichungen veröffentlichen wieder das kompakte Installer-Delta, das für Delta-Updates verwendet wird; ein fehlendes Delta für eine bereits veröffentlichte Version kann nachgereicht werden, ohne die Version erneut auszuliefern. (#4605)
- CodeBuddy-Filmabonnements bereiten ihre erste Modellanfrage nun korrekt vor, und Nebengespräche des integrierten Agenten halten ihre Prüfpunkte unter dem eigenen Profil des Gesprächs. (#4616)
- Erzeugte Bearbeitungsversionen von Bildern öffnen zuverlässig in der vollständigen Bildvorschau, während ihre Version noch veröffentlicht wird. (#4603)
- Explizite HTTP-Statuscodes der Anbieterseite werden als Anbieterfakten angezeigt: Ein 402 wie „Insufficient Balance" zeigt nun eine handlungsfähige Abrechnungserklärung, wobei der Status und sichere Anbieterdetails erhalten bleiben. (#4601)
- Unter Windows bleibt der erste Python-Plotting-Ablauf nicht mehr an einer übriggebliebenen Kernel-Wiederherstellungssperre aus einem unzusammenhängenden Ausführungsweg stehen. (#4620)
- Wenn eine Werkzeugaktion verweigert wird, endet der Turn nun mit einer dauerhaften Erklärung, statt zu verstummen, und Verweigerungszählungen bleiben von abgeschlossener Arbeit getrennt. (#4517)
- CodeBuddy-Verbindungen stellen das ausgewählte Modell beim Wiederaufnehmen einer verlauftragenden Sitzung wieder her, sodass Token-Nutzungsaktualisierungen weiterlaufen. (#4631)
- Erzeugungen von Forschungsfilmen bleiben sichtbar: Das Gespräch verbleibt mit angezeigtem Filmstatus unter Aktiv, und ein blockierter Filmdialog kann das Gespräch öffnen, das der Erzeugung gehört. (#4633)
- Der integrierte Agent akzeptiert Werkzeugfortsetzungen mit Null-Identitätsfeldern, statt den Turn fehlschlagen zu lassen. (#4638)

## 🙏 Danksagungen

- Danke an alle, die Probleme mit Updates, Notebooks und der Speicherüberwachung in [Discord](https://discord.gg/zxQAYjReRv), auf [X](https://x.com/aipoch_ai) und in den [Discussions](https://github.com/aipoch/open-science/discussions) gemeldet haben.
- Danke an [@wen2zhou](https://github.com/wen2zhou) für die projektbezogene Agenten-Ablaufverfolgung und die laufbezogene CLI-Ablaufverfolgung ([#4514](https://github.com/aipoch/open-science/pull/4514), [#4618](https://github.com/aipoch/open-science/pull/4618)).
