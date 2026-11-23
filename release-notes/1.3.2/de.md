## ✨ Highlights

- **Lange Gespräche nutzen weniger Arbeitsspeicher.** Gestreamte Antworten sammeln keine versteckten Performance-Einträge mehr an, und Gesprächsinhalte, die Sie gerade nicht anzeigen, werden freigegeben, sobald sie sicher gespeichert sind — große Sitzungen bleiben flott, ohne Ihre Position, ausstehenden Änderungen oder laufende Arbeit zu verlieren. (#4500)
- **Kilo Gateway ist ein offizieller Anbieter.** Fügen Sie ihn mit oder ohne API-Schlüssel hinzu: Eine anonyme Katalogaktualisierung zeigt die kostenlosen Modelle, für die Ihre Verbindung berechtigt ist, und der Anbieterschritt der Ersteinrichtung kann übersprungen werden, um die Entscheidung später zu treffen. Vorhandene Zugangsdaten und Hauptmodell-Entscheidungen bleiben beim Update erhalten. (#4465)
- **Überprüfbare Bildmodell-Kataloge.** Offizielle Bilddienste für OpenAI, MiniMax, Bailian und Volcengine Ark können ihre gebündelte Modellliste vor dem Speichern beim Anbieter aktualisieren und behalten Ihr aktives Modell, wenn es weiterhin verfügbar ist. (#4474)
- **Zuverlässige erste Nachrichten in Agentensitzungen.** Neue Standard-Agenten-, Claude-Code- und Codex-Gespräche schlagen nicht mehr vor ihrer ersten Modellanfrage fehl, und der integrierte Agent startet geplante Sitzungen mit ihrem vorgesehenen Prompt. (#4505, #4490)
- **PDF-Übersetzung mit nativer Layouttreue.** Umgebrochene Titel, Bildunterschriften, Definitionen und mathematische Aussagen werden in Lesereihenfolge wiederhergestellt, und Formeln, Links und Grafiken bleiben im übersetzten Dokument an ihrem ursprünglichen Platz. (#4492)

## ⚠️ Scope & Safety

- **Das Hinzufügen von Kilo ohne Schlüssel kontaktiert Kilo anonym.** Die Katalogaktualisierung, die berechtigte kostenlose Modelle zeigt, ist eine Anfrage an die Server von Kilo, die keine Kontoidentität enthält. Bild- und Modellanfragen nach der Einrichtung gehen wie bei jeder anderen Anbieterverbindung an Kilo. Siehe [Empfänger von Daten](https://github.com/aipoch/open-science/blob/v1.3.2/docs/security.md#data-recipients). (#4465)
- **Die Prüfung eines Bildmodell-Katalogs kontaktiert den Anbieter.** Eine Aktualisierung sendet die Zugangsdaten der konfigurierten Verbindung an diesen Anbieter, um dessen Bildmodelle aufzulisten, und ein fehlgeschlagener Check kann bereits Gesendetes nicht zurückholen. Führen Sie ihn nur für Verbindungen aus, die Sie konfiguriert haben. Siehe [Empfänger von Daten](https://github.com/aipoch/open-science/blob/v1.3.2/docs/security.md#data-recipients). (#4474)

## 🚀 New Features

- Kilo Gateway als offiziellen Anbieter mit optionalem API-Schlüssel hinzufügen; eine anonyme Katalogaktualisierung zeigt die berechtigten kostenlosen Modelle, und das Speichern ohne Schlüssel hält die Modellentscheidung offen. (#4465)
- Der Anbieterschritt der Desktop-Ersteinrichtung erhält eine Überspringen-Aktion, die Kilo ohne Schlüssel hinzufügt und die Modellentscheidung Ihnen überlässt; Updates ergänzen fehlende Kilo-Konfigurationen, ohne vorhandene Anbieterzugangsdaten oder Hauptmodell-Entscheidungen zu ändern. (#4465)
- Offizielle Bilddienste für OpenAI, MiniMax, Bailian und Volcengine Ark können den Live-Bildmodell-Katalog des Anbieters auf Anfrage prüfen: Übereinstimmende gebündelte Modelle werden vor dem Speichern angezeigt, das aktive Modell bleibt erhalten, und ein als Standard beibehaltenes Modell, das im aktualisierten Katalog fehlt, wird markiert. (#4474)
- Bildkatalog-Anfragen an Bailian sind auf die Region des Arbeitsbereichs beschränkt, und mit China verknüpfte Zugangsdaten sind auf den China-Katalog beschränkt. (#4474)

## 🔧 Improvements

- Lange Gespräche und Sitzungen nutzen weniger Arbeitsspeicher: Gestreamte Antworten sammeln keine versteckten Performance-Einträge mehr an, inaktive Gesprächsinhalte werden freigegeben, sobald ihre dauerhafte Kopie übereinstimmt, und Live-Sitzungsaktualisierungen nutzen serialisierte Kopien für Zustellung und Wiedergabe. (#4500)
- Arbeitsspeicherdruck im Notebook wird durch einen schließbaren Hinweis mit sechssekündiger Ablaufzeit gemeldet, statt die obere Zeile des Arbeitsbereichs zu belegen oder einen Modal zu öffnen; die Weigerung, einen Lauf zu starten, gilt nur für tatsächliche Ausführungsentscheidungen, und die Wiederherstellung wird einmal gemeldet, sobald sie abgeschlossen ist. (#4499)
- Die Startseite nennt den konkreten Grund, warum ein Use-Case-Download fehlgeschlagen ist — fehlendes Manifest, nicht verfügbares Paket, Zeitüberschreitung, Netzwerk, Server, Verifizierung, voller Datenträger oder Speicherproblem — statt eines generischen Fehlers. (#4498)
- Die Wiedergabe hält historische Gespräche übersichtlich: Die Aktionen für Fragen und Erfassen abgeschlossener Schritte erscheinen bei Hover oder Tastaturfokus, mit vollflächigen Zielen auf Geräten mit Touch oder hybridem Zeiger. (#4483)

## 🐛 Bug Fixes

- Neue Standard-Agenten-, Claude-Code- und Codex-Gespräche schlagen nicht mehr vor ihrer ersten Modellanfrage fehl, wenn die Notebook-Authority-Vorbereitung eine bereits verbundene native Sitzung ohne Verlauf fortsetzt. (#4505)
- Der integrierte Agent öffnet geplante Sitzungen mit ihrem ersten Prompt, statt einen verbundenen Schreiber während der Notebook-Zugangsdatenaktualisierung zu unterbrechen. (#4490)
- Die PDF-Übersetzung stellt Text wieder her, den die native Extraktion über Zeilen oder Seitengrenzen hinweg aufgeteilt hat — Titel, Bildunterschriften, Definitionen und mathematische Aussagen — und hält Formeln, Referenztext, Links und eingebettete Grafiken beim Zurückschreiben an ihrem ursprünglichen Ort. (#4492)
- Der Notebook-Start deutet eine geschlossene WSL-Befehlspipe nicht mehr als Fehler. (#4500)

## 🙏 Danksagungen

- Danke an [@ShuangChenyue](https://github.com/ShuangChenyue) für die konkreten Gründe beim Fehlschlag von Use-Case-Downloads ([#4498](https://github.com/aipoch/open-science/pull/4498)).
- Danke an [@liguohhh](https://github.com/liguohhh) für die offiziellen Bildmodell-Katalogprüfungen ([#4474](https://github.com/aipoch/open-science/pull/4474)) und die Kilo-Gateway-Einrichtung ([#4465](https://github.com/aipoch/open-science/pull/4465)).
