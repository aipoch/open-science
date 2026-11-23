## ✨ Highlights

- **Updates, die Ihnen nicht im Weg stehen.** Unter macOS kann sich ein geeignetes Update beim Beenden der App selbst installieren; unter Windows und Linux kann ein Update vorbereitet werden, während Sie arbeiten, und beim nächsten Start angewendet werden. Hintergrund-Downloads werden nur in einem uneingeschränkten Netzwerk mit ausreichend Speicherplatz zugelassen, und der manuelle Pfad über Herunterladen und Neustarten bleibt jederzeit verfügbar; unter Linux bleibt der AppImage-Pfad über Updates hinweg erhalten. Update-Downloads sind außerdem kleiner, und stabile Windows-Updates können als kompakte Deltas angewendet werden. (#4542, #4518, #4586, #4510)
- **Der integrierte Agent ist überall die Voreinstellung.** Neue Projekte und Sitzungen starten mit dem integrierten Open-Science-Agenten — einschließlich sauberer CLI- und SDK-Installationen, die beim Start nicht mehr fehlschlagen, wenn ein externer Agent-SDK fehlt. Die Installation einer externen Laufzeitumgebung bleibt eine ausdrückliche Entscheidung, die Sie nur treffen, wenn Sie sie brauchen. (#4531)
- **Eine schlankere App.** Die installierte Desktop-App ist unter macOS und Windows kleiner, und die gebündelte Offline-npm-Laufzeitumgebung wird jetzt für Node 22 kompiliert, statt über tausend lose Paketdateien mitzuliefern. (#4555, #4572, #4563, #4592, #4587)
- **Vereinheitlichte Bildbearbeitung.** Bearbeitungsanweisungen befinden sich im Gesprächseingabefeld, Aktionen per Hover und Tastatur starten die Bearbeitung aus jeder Vorschau, und die Versionsnavigation sowie der Vergleich bleiben durchgängig verfügbar. (#4481)
- **Fehler erklären sich selbst.** Undurchsichtige Fehlermeldungen nennen in der gesamten App nun, was tatsächlich passiert ist — Anfragefehler, Lade- und Importprobleme, Ausführungsfehler im Notebook und der Unterschied zwischen Arbeit, die Sie gestoppt haben, und Arbeit, die nie geantwortet hat. (#4565, #4571, #4548, #4549, #4545, #4540, #4583, #4593)

## ⚠️ Scope & Safety

- **Automatische Updates werden im Hintergrund heruntergeladen.** macOS installiert ein Update nur beim Beenden; Windows und Linux bereiten eines nur vor, während die Desktop-App im Hintergrund im Leerlauf ist — all dies setzt klare Belege für ein uneingeschränktes, nicht abgerechnetes Netzwerk und genügend lokalen Speicherplatz voraus, einschließlich eines beschreibbaren Update-Caches unter Linux. Abgerechnete oder eingeschränkte Verbindungen behalten den vollständig manuellen Pfad. (#4542, #4518, #4586)
- **Die Installation einer externen Agent-Laufzeitumgebung lädt aus dem npm-Register herunter.** Die Wahl eines externen Frameworks lädt dessen Laufzeitumgebung über den verwalteten Installer der App aus dem npm-Register — oder dessen dokumentierten Spiegelserver-Ausweichpfad — und verifiziert den Download vor der Verwendung. Einige verwaltete Laufzeitumgebungen ermitteln die jeweils neueste veröffentlichte Version, während andere mit fest gepinnten Versionen oder einer fest eingebundenen Sperrdatei ausgeliefert werden und sich nur mit einem App-Release aktualisieren. Der integrierte Agent benötigt keinen solchen Download. Siehe [Empfänger von Daten](https://github.com/aipoch/open-science/blob/v1.3.3/docs/security.md#data-recipients). (#4531)

## 🚀 New Features

- In offiziellen paketierten stabilen macOS-Builds kann sich ein geeignetes Update beim Beenden der App automatisch installieren; schreibgeschützte Datenträger, App Translocation und nicht beschreibbare Installationen behalten den manuellen Pfad. (#4542)
- In paketierten stabilen Windows-Installationen bereitet eine standardmäßig aktivierte Einstellung Updates beim Start für den nächsten Anwendungsstart vor, sobald der Arbeitsbereich bereit ist, die Desktop-App im Hintergrund läuft, die Verbindung uneingeschränkt ist und genügend Speicherplatz vorhanden ist; ein manueller Download bleibt verfügbar. (#4518)
- In paketierten Linux-Installationen bereitet eine standardmäßig aktivierte Einstellung AppImage-Updates für den nächsten Anwendungsstart vor, während die Desktop-App im Hintergrund im Leerlauf ist — vorausgesetzt, die Verbindung ist uneingeschränkt und der Update-Cache hat Platz; der AppImage-Pfad bleibt über Updates hinweg erhalten, und ein manueller Download bleibt verfügbar. (#4586)
- Der Katalog der Anbieter Bailian ergänzt die Modellfamilie qwen4, wobei der Tarif standardmäßig auf die qwen4-Vorschau ausgerichtet ist. (#4594)
- Die Einstellungen stellen die Verknüpfungen für Fähigkeiten, Spezialisten und Konnektoren wieder her; jede öffnet die installierte Kategorie und kehrt danach zur ursprünglichen Position in den Einstellungen zurück. (#4538)
- Stabile Windows-Updates können als kompakte, unabhängig reproduzierbare Installer-Deltas angewendet werden, und Produktions-Source-Maps der Desktop-App betten keinen Original-Quelltext mehr ein. (#4510)

## 🔧 Improvements

- Die installierte Desktop-Anwendung ist kleiner: geprüfte Abhängigkeitskopien auf Electron-Seite werden unter macOS und Windows entfernt, Drittanbieter-Backend-Abhängigkeiten werden beschnitten und interne Backend-Paketmodule werden gebündelt, die Offline-npm-Laufzeitumgebung wird als einzelnes Bündel für Node 22 kompiliert, und der Film-Compiler sowie die Web-Assets werden verdichtet. (#4555, #4572, #4563, #4554, #4592, #4587)
- Neue Projekte und Sitzungen nutzen standardmäßig den integrierten Open-Science-Agenten; externe Agent-Laufzeitumgebungen werden bei Bedarf über den verwalteten, verifizierenden Installer installiert. (#4531)
- Das Eingabefeld zeigt undurchsichtige Anfragefehler in der Detailansicht, erklärt Fehler bei der Warteschlangenübermittlung von Nachrichten, Vorschauen erklären Fehler beim Laden von Dateien und Quellen, Fehler beim Lesen des Gesprächsverlaufs werden erklärt, und Fehler bei der Bereitstellung und Bereinigung von Anhängen sagen, was schiefgelaufen ist. (#4565, #4583, #4571, #4548, #4539)
- Notebook-Umgebungen halten ihre Manifeste in Sidecar-Dateien vor, die Fristen für die Befehlsausführung werden verlängert, wobei die Stopp-Ursachen erhalten bleiben, das Lesen des Verlaufs und das Layout langer Ausgaben kosten weniger, und Fehler von Konnektoren erscheinen in der Werkzeugliste des Hosts. (#4547, #4544, #4533, #4551)
- Gestreamte Antworten bleiben in langen Gesprächen durch begrenzte Arbeit an der Textsegmentierung reaktionsschnell, und der Bildeditor hält Gesprächsnachrichten an Ort und Stelle, während Sie eine Bearbeitung starten. (#4520, #4559)
- Die App liest unveränderte gebündelte Fähigkeitendokumente nicht erneut und verzichtet auf die Zweigtraversierung bei leeren Netzwerkfreigaben. (#4534, #4535)

## 🐛 Bug Fixes

- Fehlerdetails von Anbietern behalten den klassifizierten Fehlercode und die Anfragekennung, sodass Modellfehler über einen Neustart hinweg handhabbar bleiben. (#4590)
- Unter Windows werden die Speicherschwellen des Notebooks auf den installierten physischen Speicher begrenzt, blockierte Läufe behalten ihre Speicherwerte, und der Speicherdruck von macOS sowie die cgroup-Limits von Linux werden angezeigt. (#4593)
- Unter Windows werden veraltete Datei-Blocker aus einer früheren Sitzung beim Kaltstart erneut geprüft und verworfen, sodass ein vorbereitetes Update die Anwendung abschließen kann. (#4591)
- Einträge der Sitzungen im Infobereich navigieren mit wiederhergestellten Zusammenfassungen, während sich die dauerhafte Projektion noch aktualisiert. (#4582)
- Reparaturen an der PDF-Übersetzung: Nativ extrahierter Text, der Sätze an Spaltenumbrüchen, Bildunterschriften oder Inline-Formeln aufgeteilt hat, wird anhand von Hinweisen aus Schriftart, Glyphen und Geometrie wieder zusammengeführt, und übersetzter Text verdrängt keine native Notation, keine Formularbeschriftungen und keine angrenzenden Grafiken mehr. (#4560)
- Gestoppte Arbeit wird korrekt gekennzeichnet: Vom Benutzer gestoppte Eingaben kommen nach der Bereinigung zur Ruhe, ein gestoppter Lauf wird von einer unbeantworteten Fortsetzung unterschieden, veraltete Diagnosemeldungen ersetzen keine Abbruchmeldungen mehr, und im Leerlauf befindliche Sitzungen stellen losgelöste Lauf-Marker wieder her. (#4552, #4545, #4537)
- Modellfehler werden genau klassifiziert: Fehler beim Anbieter werden von fehlerhaften Antworten und clientseitiger Stapelererschöpfung unterschieden, sichere Diagnosemeldungen bleiben erhalten, und der Lebenszyklus des Responses-Streams meldet die Fertigstellung nicht mehr zu früh. (#4540, #4511)
- Unter Windows stellen Notebook-Kernels ihren Laufzeitstatus nach einem Neustart wieder her, und der Profilschlüssel wird vor Aktualisierungsprüfungen aus dem Cache initialisiert. (#4529, #4569)
- Dateinamen von Antworten zeigen auf das gespeicherte Artefakt, das Löschen von Gedächtniskategorien bindet an bestätigte Notizen, und Sitzungspakete lassen Notebook-Zugriffe zur Ruhe kommen, bevor sie Exportfehler erklären. (#4562, #4512, #4564)
- Vorschauen der Bildbearbeitung bleiben stabil, die Bilddetails zeigen den Notebook-Kernel, der eine Bearbeitung erzeugt hat, und die Update-Aktion wird ausgeblendet, wenn das Rechengerät bereits vorbereitet ist. (#4553, #4557, #4558)
- Das Lesen von Projektdateien erklärt Fehler und prüft unsichere Reparaturen, der Import von GitHub-Fähigkeiten erklärt Verbindungsfehler, und Regressionen bei geplanten Sitzungen und Zertifizierungen sind behoben. (#4541, #4532, #4530)

## 🙏 Danksagungen

- Danke an [@cyj1116](https://github.com/cyj1116) für die vereinheitlichten Bildbearbeitungssteuerungen und die Versionsnavigation ([#4481](https://github.com/aipoch/open-science/pull/4481)).
