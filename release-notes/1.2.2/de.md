## ✨ Highlights

- **Strenger Notebook-Netzwerkmodus.** Der optionale Strict-Modus ersetzt Angebote zur Autorisierung durch eine manuell verwaltete Whitelist: Eine Anfrage ist nur erlaubt, wenn sie Ihren Regeln nach Protokoll, Hostname oder IP und Port entspricht — nicht übereinstimmende Anfragen werden ganz blockiert. Der Relaxed-Modus bleibt der Standard und behält das bisherige Genehmigungsverhalten. (#4253)
- **Forschungsfilme werden fortgesetzt.** Eine unterbrochene Filmerzeugung läuft mit validierten Zwischenständen weiter: Fertige Szenen, Kommentar, Zeitmarken und Mischung werden über Prozessneustarts hinweg wiederverwendet, der Dialog zeigt den aktuellen von fünf Schritten, und Sie wählen zwischen Fortsetzen und neuer Erzeugung. (#4290)
- **PDF-Rundlauf ohne Qualitätsverlust.** Externe PDFs stellen vollständige native Abbildungen, Bildunterschriften, Tabellendaten und Lesereihenfolge wieder her, und übersetzte Dokumente behalten die ursprüngliche Struktur und das Layout, statt auf unbewiesene Platzierung zurückzugreifen. (#4300, #4342, #4340, #4334, #4286)
- **Sicherere Windows-Berechtigungen und Updates.** Ordnerberechtigungen im geschützten Modus werden vor dem Speichern geprüft; Update-, Deinstallations- und Übergabe-Abläufe erholen sich zuverlässiger, nennen, was sie blockiert hat, und bewahren ihre Diagnoseinformationen. (#4217, #4305, #4327, #4328, #4337, #4346)
- **Aktualisierter Anbieterkatalog.** Qwen4 Max Preview ergänzt Bailian Token Plans in Peking und Singapur mit einem 1M-Kontextfenster, und die Standardmodelle offizieller Verbindungen werden aktualisiert. (#4311, #4301)

## 🚀 New Features

- Den Notebook-Netzwerkzugriff auf den Strict-Modus schalten: Anfragen müssen einer manuell verwalteten Whitelist nach Protokoll, Hostname oder IP und Port entsprechen, und nicht übereinstimmende Anfragen werden blockiert, ohne eine Autorisierung anzubieten. Regeln lassen sich als bearbeitbare logische Gruppen mit Herkunftsmarkierungen verwalten; die bereits vorhandenen integrierten Ziele werden einmalig vorbelegt und Änderungen bleiben bestehen. Prüfen Sie die vorbelegten Regeln, bevor Sie sich auf den Modus verlassen, da blockierte Anfragen fehlschlagen, statt zu fragen. (#4253)
- Unterbrochene Forschungsfilm-Erzeugung an validierten Prüfpunkten fortsetzen: Fertige Hilfsbausteine und Szenen überleben einen späteren Fehler, Kommentar und Zeitmarken werden unabhängig vom Player-Build zwischengespeichert, und der Film-Dialog zeigt den aktuellen von fünf Schritten mit expliziter Wahl zwischen Fortsetzen und neuer Erzeugung. (#4290)
- Windows-Ordnerberechtigungen im geschützten Modus vor dem Speichern mit einer schreibgeschützten ACL-Prüfung vorbereiten: Unbrauchbare Ordner werden mit ihrem Grund abgelehnt, bevor eine Berechtigung geschrieben wird, sodass die Notebook-Ausführung später nicht mehr mit einem versteckten Kernelstart-Fehler scheitert. (#4217)
- Qwen4 Max Preview aus Bailian Token Plans in Peking und Singapur auswählen: 1M-Kontextfenster, multimodale Eingabe und Reasoning-Aufwand niedrig/mittel/hoch, aufgelöst über den vorhandenen Regionsauswahlschalter und die Schlüsselkonsole. (#4311)

## 🔧 Improvements

- Die Wiederherstellung der Struktur externer PDFs bewahrt vollständige Abbildungen mit ihren Bildunterschriften, Tabellendaten und -zellen sowie die native Lesereihenfolge bei skaliertem Text und laufenden Kopfzeilen. (#4300, #4342, #4340)
- Übersetzte PDFs behalten native Struktur und Layout: Die Platzierung erfordert geprüfte, dem Zieldokument zugehörige Belege, und die ursprünglichen Inhalte bleiben erhalten, wann immer die Platzierung nicht bewiesen werden kann. (#4334, #4286)
- Der Import von Sitzungspaketen meldet sein Ergebnis: Abbruch liefert ein Ergebnis ungleich null, Zeitüberschreitungen der Anfrage werden mit dem Hinweis markiert, vor einem erneuten Versuch zu prüfen, und fehlende Dateien oder fehlerhafte Archive erhalten eigene Fehlercodes mit einer Protokoll-Korrelations-ID. (#4338)
- Standardmodelle offizieller Anbieterverbindungen werden auf aktuelle Empfehlungen aktualisiert. (#4301)
- Vorschauoberflächen passen sich mobilen Ansichtsfenstern an. (#4325)
- Ein konfiguriertes Datenstammverzeichnis ist über registrierte Aliase ansprechbar. (#4306)
- Die lokale CLI hält Anmeldeprofil-Einträge intakt, verzeiht Konsolenfehler und hält Artefakt-Downloads am Leben, während Daten eintreffen. (#4298, #4299)

## 🐛 Bug Fixes

- Wenn der Desktop seinen lokalen Dienst verliert, blockiert eine anwendungsweite Wiederherstellungsoberfläche jetzt die Workspace-Interaktion, bis die Verbindung zurückkehrt, hält Entwürfe gemountet und stellt danach den Fokus wieder her. (#4323)
- Windows-Update- und Deinstallationsabläufe trennen Update-Sicherheit von der Bereinigung der Einträge, prüfen die physischen Installationsressourcen, räumen eigenständige Hilfsprozesse vor der Übergabe ab, brechen Hostprüfungen zügig ab, identifizieren Prozesse anhand ihrer Erzeugungsidentität statt allein anhand der PID und bewahren Fehlerdiagnosen. (#4305, #4327, #4328, #4337, #4346)
- Unterbrochene Windows-Kernel-Jobs erholen sich, und die PowerShell-stderr-Umleitung verschluckt native Notebook-Ausgabe nicht mehr. (#4297, #4295)
- Die Sitzungspersistenz vermeidet Deadlocks bei der Löschungsbereinigung und entkoppelt die Start-Hydratisierung von aktiven Speichervorgängen. (#4312, #4314)
- Fehler der Agenten-Laufzeit unterscheiden Modellanbieterfehler von ACP-Fehlern, neu geladene Sitzungen bleiben bis zur Aktivierung des Prompts geschützt, und abgebrochene Prompts unterbrechen Klassifizierungsabfragen. (#4322, #4283, #4289)
- Unzusammenhängende gespeicherte Ordnerberechtigungen blockieren den Notebook-Start nicht mehr. (#4309)
- Vorschauen halten Inhalte während Versionsprüfungen an Ort und Stelle. (#4293)
- Die direkte Aufhebung von SSH-Jobs begrenzt unbestätigte Abbruchversuche. (#4313)
- Der Kontrast bleibt über helle und dunkle Flächen erhalten, einschließlich Avatare im Dunkelmodus, Replay-Eingabe und Designübergängen. (#4345, #4339, #4332)
- Die Desktop-App beendet sich nach dem ersten unbehandelten Main-Prozess-Fehler, statt in beschädigtem Zustand weiterzulaufen. (#4316)
- Der Status der Umgebungsprüfung ist deutlich von anderen Prüfzuständen formuliert, und Literatur-Einträge akzeptieren LaTeX-Paketlisten mit flexiblen Leerzeichen. (#4347, #4303)

## 🙏 Danksagungen

- Danke an [@roxi3906](https://github.com/roxi3906) für den strengen Notebook-Whitelist-Modus ([#4253](https://github.com/aipoch/open-science/pull/4253)) und die Korrekturen bei der Darstellung riskanten Codes ([#4318](https://github.com/aipoch/open-science/pull/4318), [#4282](https://github.com/aipoch/open-science/pull/4282)).
- Danke an [@ShuangChenyue](https://github.com/ShuangChenyue) für die Vorbereitungsprüfung der Windows-Ordnerberechtigungen ([#4217](https://github.com/aipoch/open-science/pull/4217)).
- Danke an [@liyeshunag](https://github.com/liyeshunag) für die Korrekturen an Anmeldeprofilen der CLI ([#4298](https://github.com/aipoch/open-science/pull/4298)) und die Behandlung abgebrochener Prompts ([#4289](https://github.com/aipoch/open-science/pull/4289)).
- Danke an [@cyj1116](https://github.com/cyj1116) für die mobilen Vorschauoberflächen ([#4325](https://github.com/aipoch/open-science/pull/4325)) und die Korrekturen an Artefakt-Downloads ([#4299](https://github.com/aipoch/open-science/pull/4299)), an [@wen2zhou](https://github.com/wen2zhou) für die Begrenzung der SSH-Abbrüche ([#4313](https://github.com/aipoch/open-science/pull/4313)) und die Bewahrung der PowerShell-Ausgabe ([#4295](https://github.com/aipoch/open-science/pull/4295)), an [@liguohhh](https://github.com/liguohhh) für den Schutz neu geladener Sitzungen ([#4283](https://github.com/aipoch/open-science/pull/4283)), an [@nasus2002](https://github.com/nasus2002) für die LaTeX-Literaturanalyse ([#4303](https://github.com/aipoch/open-science/pull/4303)), an [@guch96](https://github.com/guch96) für die Sitzungspersistenz ([#4314](https://github.com/aipoch/open-science/pull/4314)) und an [@daanveer-tech](https://github.com/daanveer-tech) für die README-Aktualisierungen ([#4292](https://github.com/aipoch/open-science/pull/4292), [#4294](https://github.com/aipoch/open-science/pull/4294), [#4324](https://github.com/aipoch/open-science/pull/4324)).
