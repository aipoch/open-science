## ✨ Highlights

- **Ihre Zotero-Bibliothek importieren.** Die Literaturbibliothek erhält Import aus Zotero: Übernehmen Sie eine persönliche Bibliothek oder ausgewählte Sammlungen aus Zotero 10 oder neuer auf demselben Rechner — mit bibliografischen Metadaten, PDFs, Schlagwörtern, Sammlungshierarchien und Quellenlinks; vorhandene Referenzen werden abgeglichen, statt dupliziert. (#3949)
- **Die PDF-Lesereihenfolge ist automatisch.** Beim Öffnen eines verknüpften PDFs werden oberhalb des Dokuments keine dauerhaften Steuerelemente für die Lesereihenfolge mehr angezeigt. Die Extraktion bevorzugt die eigenen logischen Tags der Datei und greift auf Layoutanalyse zurück, wenn Tags fehlen oder mehrdeutig sind; auch historische Nachrichten mit manuellen Regionen werden in der neuen automatischen Reihenfolge gelesen. (#3979)
- **Die Windows-Einrichtung ist schneller und sicherer.** Die Installation sinkt von median ~21 s auf ~14 s, mit einem Drittel weniger Paketdateien und paralleler Extraktion; Updates löschen keine Forschungsdaten mehr, die neben der Anwendung abgelegt sind, und Installationen in tiefe Ordnerpfade werden abgeschlossen, statt beim Kopierschritt zu scheitern. (#3957, #3963, #3946)
- **Lang laufende Abschnitte behalten ihre Artefakte.** Die Artefaktveröffentlichung läuft nicht mehr zwei Stunden in einen noch laufenden Assistentenabschnitt ab: Fähigkeiten gelten nun für den gesamten offenen Abschnitt, sodass Übernacht- und Langstapel-Sitzungen ihre Dateien wie bisher veröffentlichen. (#3980)

## 🚀 New Features

- Die Literaturbibliothek lässt sich nach persönlichen Notizen durchsuchen — eine Notiz wie "diese Methode passt zu meinen Daten" findet ihre Referenz jetzt über das normale Suchfeld. (#3942)
- Eigene stdio-Konnektoren, die mit npx oder npm konfiguriert wurden, laufen jetzt auch auf Rechnern ohne diese Befehle, indem die gebündelte Node- und npm-Laufzeit der Anwendung verwendet wird, während installierte Befehle Vorrang behalten. (#3954)

## 🔧 Improvements

- Übersetzte PDFs öffnen schneller: Die Quellenverifikation gespeicherter Übersetzungen überschneidet Lesezugriffe jetzt in kleinen Stapeln beim ersten Öffnen, und der ungenutzte lokale Übersetzungsworker wurde aus der Installation entfernt, wodurch diese kleiner wird. (#3982, #3978)
- Beobachtungen von Slurm-Warteschlange, -Controller und -Buchhaltung werden unabhängig voneinander aufgelöst; terminale Job-Ergebnisse werden vor der Protokollsammelung persistent, Stornierungen liefern genau ein Endergebnis, und kurze Windows-SSH-Befehle hängen nicht mehr an einer im Leerlauf befindlichen Eingabepipe. (#3937)
- Menüs mit Teilen-Schaltfläche — Senden/Warteschlange/Stoppen im Gespräch, Genehmigungen von Berechtigungen, Auswahl von Literaturgesprächen, PDF-Markierungs- und Flächenwerkzeuge — teilen sich ein verbundenes Panel mit automatischer Platzierung, umkehrbaren Animationen und unabhängig nutzbaren primären und Pfeil-Schaltflächen. (#3925)
- Gemeldete Sicherheitshinweise werden mit kompatiblen Abhängigkeitsaktualisierungen und beschränktem Parsing anstelle rückverfolgungsanfälliger Musterabgleiche behandelt. (#3956)
- Die WSL-Einrichtungshinweise nennen jetzt von Anfang an, dass gespiegeltes Netzwerk Windows 11 22H2 oder neuer erfordert, statt einen Modus zu empfehlen, den Windows 10 nicht bereitstellen kann. (#3945)
- Die interaktive Anmeldedaten-Genehmigung wartet bis zu fünf Minuten auf Ihre Zustimmung, und die Wiederherstellung nach einem Timeout erklärt, was geschehen ist, statt wie ein Problem mit einem fehlenden Schlüssel auszusehen. (#3939)

## 🐛 Bug Fixes

- OpenCode-Sitzungen enden nicht mehr mit einem internen Fehler, wenn der Name eines Tool-Aufrufs nach seinem ersten Ausgabefragment eintrifft; 1.x-Kompaktierungszusammenfassungen bleiben aus Gesprächen und dem Verlaufs-Replay heraus, und große Konfigurationen starten unter Windows nicht mehr fehl. (#3970, #3967, #3948)
- Der Windows-Start akzeptiert Cookie-Speicher mit Binär-Payload-Feldern, statt die Startvorprüfung mit einem Entschlüsselungsfehler zu blockieren. (#3955)
- Native Windows-R-Sitzungen funktionieren, wenn das temporäre Verzeichnis der Anwendung Leerzeichen enthält. (#3958)
- Das Desktop-Fenster verliert nicht mehr die Synchronisation, wenn eine Sitzungsmomentaufnahmen-Lesung eintrifft, während alle Kanäle für Großübertragungen belegt sind. (#3969)
- Beim Senden einer ersten Nachricht werden Denkanzeige und verstrichene Zeit nicht mehr vor der tatsächlichen Übermittlung angezeigt, und das Stoppen der Vorbereitung stellt Ihren ungesendeten Entwurf wieder her. (#3931)
- Importierte Sitzungen zeigen vergangene Zustellungsfehler als eingeklappte, aufklappbare Historie, statt als aktuellen Fehler oberhalb der Verzweigungsaktion. (#3941)
- Die DOCX-Vorschau-Symbolleiste bleibt beim Scrollen bei jedem Zoom über dem Dokumentinhalt. (#3743)
