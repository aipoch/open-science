## ✨ Highlights

- **Ein Ort für jede Ressource.** Die Ressourcenverwaltung verwaltet jetzt Fähigkeiten, Verbindungen und Spezialisten — einschließlich Installation aus dem Marktplatz, auch in der Weboberfläche — mit gemeinsamen Karten, Filtern und Detailansichten, und Fähigkeiten-Verweise öffnen im Projektbereich, ohne die Unterhaltung zu verlassen. (#4270)
- **Wissenschaftliche Prompt-Optimierung.** Verfeinern Sie den Prompt des aktuellen Projekts mit einem Klick direkt aus dem Eingabebereich; prüfen, bearbeiten oder widerrufen Sie das Ergebnis und speichern Sie eigene Vorlagen in den Projekteinstellungen. Die Optimierung läuft nur über Ihren konfigurierten Anbieter, wenn Sie sie aufrufen. (#3991)
- **Ein stärkerer integrierter Agent.** Codex-Abonnementkonten stehen jetzt für den Haupt-Agenten und untergeordnete Agenten zur Verfügung, Claude Fable 5.2 ergänzt die Modellliste, und lange Antworten werden nicht mehr bei 4.096 Tokens abgeschnitten. (#4250, #4249, #4275)
- **Lange Forschungssitzungen exportieren ohne Hänger.** Notebook- und Compute-Läufe speichern ihre Belege einmalig in kompakter, überprüfbarer Form, sodass `.science`-Exporte langer Verläufe schnell und klein bleiben. (#4248, #4258, #4240)
- **Cloud-Compute-Anmeldung, die echte Netzwerke übersteht.** Modal und Hugging Face stellen eine kompatible Python-Laufzeit bereit, bevor der Browser geöffnet wird, und die Kontenprüfung folgt jetzt Ihrem Systemproxy. (#4255)

## 🚀 New Features

- Fähigkeiten, Verbindungen und Spezialisten verwalten — und aus dem Marktplatz installieren, auch im Web-Renderer — in der vereinheitlichten Ressourcenverwaltung, mit einheitlichen Katalogkarten, zurücksetzbaren Filtern, Mehrfachauswahl und Detailfenstern; Fähigkeiten-Verweise aus dem Eingabebereich und gesendeten Nachrichten öffnen im Ressourcenbereich des Projekts, ohne die aktive Unterhaltung oder den Entwurf zu stören. (#4270)
- Den Prompt des aktiven Projekts aus dem Eingabebereich optimieren: Ergebnis vor dem Ersetzen des Entwurfs prüfen und bearbeiten, Widerrufen stellt den vorherigen Text und entfernte eingefügte Anhänge wieder her, und eigene Optimierungsvorlagen liegen in den Projekteinstellungen. Die Optimierung ist manuell und läuft nur beim Aufruf über den konfigurierten Anbieter. (#3991)
- Importierte oder app-eigene Codex-Abonnementkonten für den Haupt-Agenten und untergeordnete Agenten im integrierten Open-Science-Agenten nutzen, wobei Anmeldung, Auffrischung und Austausch der Anmeldedaten die bestehenden Codex-Verbindungsabläufe wiederverwenden. (#4250)
- Claude Fable 5.2 mit einem Kontextfenster von 1M aus der mitgelieferten Anthropic-Modellliste auswählen. (#4249)
- Bibliografische Metadaten zusammen mit BibTeX und RIS als CSV exportieren — ausgewählte Einträge über Seiten hinweg mit einzelnen Ausnahmen oder ein ganzes Projekt bzw. eine ganze Sammlung — mit 16 stabilen englischen Spaltennamen und leeren Zellen für fehlende Werte. (#4262)

## 🔧 Improvements

- Der integrierte Agent beachtet den ausgeschriebenen Ausgabelimit jedes Modells (konfigurierter Wert, dann exakte Anbieter-Metadaten, dann ein Fallback von 16.384 Tokens) und bevorzugt das native Endpunktprotokoll jedes Modells, sodass anbieterunterstützte lange Antworten vollständig ankommen. (#4275)
- Der integrierte Agent misst seine Kontextnutzung korrekt und verdichtet in langen Sitzungen deutlich später. (#4209)
- Eine beantwortete Agentenfrage wartet nicht mehr auf einen verzögerten Persistenz-Schreibvorgang, wodurch der Hänger „completion has not committed yet“ vor Fortsetzung der Antwort entfällt. (#4279)
- Modal- und Hugging-Face-Compute-Ziele teilen einen gemeinsamen Ablauf zur Vorbereitung der Python-Laufzeit: Der gewählte Interpreter wird geprüft, ohne in ihn zu installieren, Autorisierung und SDK-Aufrufe bleiben an ihn gebunden, und ein veraltetes Autorisierungsergebnis kann eine neuere Verbindung nicht mehr überschreiben. (#4255)
- Notebook- und Compute-Belege werden einmalig pro eindeutigem Inhalt mit geprüften Prüfsummen gespeichert; Exporte langer Verläufe — hunderte Läufe über dieselben Dateien — erzeugen kompakte Pakete, und der erste Export fügt historische Belege nach. (#4248, #4258, #4240, #4259)
- Die Erzeugung von Forschungsfilmen läuft beim Wechsel der Sitzung weiter, statt mit der Unterhaltung zu stoppen, die sie gestartet hat. (#4268)
- Untätige Python-, R-, REPL- und Shell-Interpreter werden nach 15 Minuten ohne Sitzungsaktivität zurückgefordert, mit kleinen Pools pro Art, sodass beendete Unterhaltungen keine residenten Laufzeiten mehr ansammeln. (#4274)
- Der Hinweis auf den Kontext-Reset schließt sich nach sechs Sekunden selbst, und Ressourcenkatalogkarten halten ihre Nutzungsavatare kompakt. (#4281, #4276)

## 🐛 Bug Fixes

- Im Chat angehängte Notebook-Dateien öffnen wieder eine Vorschau, und lokale Dateilinks in Antworten öffnen die entsprechende Datei. (#4257)
- Die signierte Windows-Update-Verpackung ist entblockt, und die Update-Wiederherstellung nennt die Dateien und Prozesse, die die App offen halten, beschränkt geschlossene Startprotokolle und löst Blocker, ohne den Installer festzufahren. (#4233, #4230, #4231, #4247)
- Literaturimporte bewahren die Weiterleitung von Kennungen und die Groß- und Kleinschreibung von DOIs. (#4225)
- Website-Quellvorschauen reagieren in schmalen Layouts wieder flexibel. (#4220)
- Die Wiederherstellung der PDF-Struktur härtet sich gegen beschädigte Dateien ab, und die PDF-Übersetzung isoliert agenteneigene Prompts und Werkzeugfähigkeiten pro Dokument. (#4238, #4228)
- Die Mobilgeräte-Kopplung bleibt aus, bis Sie sie auswählen, und RPC-Fehler der Web-Fernsteuerung erklären, was passiert ist, statt still zu scheitern. (#4221)
- Fehlerdetails von Anbietern überleben die Agenten-Laufzeit, und Fehler bei der OpenCode-Anfrageklassifizierung laufen nicht mehr über die Anfrage hinaus aus, die sie ausgelöst hat. (#4237, #4261)
- Gesprächsfestschreibungen bestätigen terminale Ereignisse zuverlässig, autorisierte lokale CLI-Importe funktionieren in Sitzungspaketen wieder, und die Navigation zur ersten Nachricht ist in langen Unterhaltungen wiederhergestellt. (#4269, #4267, #4260)
- Die Linux-Wiederherstellung hält bestätigte Kernel-Threads nicht mehr für undichte Notebook-Prozesse. (#4265)

## 🙏 Danksagungen

- Danke an [@wen2zhou](https://github.com/wen2zhou) für die Codex-Abonnementunterstützung im integrierten Agenten ([#4250](https://github.com/aipoch/open-science/pull/4250)), die Modal- und Hugging-Face-Laufzeitvorbereitung ([#4255](https://github.com/aipoch/open-science/pull/4255)) und die Chat-Dateivorschauen ([#4257](https://github.com/aipoch/open-science/pull/4257)).
- Danke an [@roxi3906](https://github.com/roxi3906) für die projektbezogene Prompt-Optimierung ([#3991](https://github.com/aipoch/open-science/pull/3991)).
- Danke an [@nasus2002](https://github.com/nasus2002) für den bibliografischen CSV-Export ([#4262](https://github.com/aipoch/open-science/pull/4262)) und die DOI-Behandlungskorrekturen ([#4225](https://github.com/aipoch/open-science/pull/4225)).
- Danke an [@guch96](https://github.com/guch96) für die Korrektur der Fortsetzung nach beantworteten Fragen ([#4279](https://github.com/aipoch/open-science/pull/4279)) und die Windows-Update-Wiederherstellung ([#4230](https://github.com/aipoch/open-science/pull/4230)), an [@cyj1116](https://github.com/cyj1116) für die Verbesserungen der Mobilgeräte-Kopplung ([#4221](https://github.com/aipoch/open-science/pull/4221)) und an [@daanveer-tech](https://github.com/daanveer-tech) für die Benchmark-Dokumentation im README ([#4219](https://github.com/aipoch/open-science/pull/4219), [#4227](https://github.com/aipoch/open-science/pull/4227)).
