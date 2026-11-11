## ✨ Highlights

- **Pi kommt als fünftes Agenten-Framework hinzu.** Neben Claude Code, OpenCode, Codex und CodeBuddy können Sie jetzt Sitzungen mit dem Pi-Agenten ausführen — einschließlich Einrichtung, Einstellungen, Verbindungsprüfung und, wo verfügbar, Anmeldung über ein Abo. (#3921)
- **Referenzen direkt aus einem DOI- oder arXiv-Link hinzufügen.** Die Literaturbibliothek erhält einen Eintrag »Aus DOI oder Link hinzufügen«: Fügen Sie eine reine DOI, einen DOI-Resolver-Link oder eine arXiv-Abstract-/PDF-URL ein, prüfen Sie die aufgelösten Metadaten und speichern Sie den Eintrag als Referenz — ohne eine Importdatei vorbereiten zu müssen. (#3990)
- **Agenten annotieren PDFs während des Lesens.** Lese-Agenten können jetzt in den vorhandenen Notizen und Anmerkungen der Literaturbibliothek zu verknüpften PDFs Notizen und Markierungen auflisten, finden und erstellen, sodass Anfragen wie »markieren Sie diesen Absatz und fassen Sie zusammen, warum er wichtig ist« als echte Annotationen bestehen bleiben. (#3981)
- **Gescannte PDFs werden mit optionalem OCR und neun Sprachpaketen lesbar.** OCR ist jetzt eine Komponente auf Abruf statt gebündelte Nutzlast, mit herunterladbaren Erkennungsdaten für Englisch, vereinfachtes und traditionelles Chinesisch, Deutsch, Spanisch, Französisch, Japanisch, Koreanisch und Russisch — Text von gescannten Seiten erscheint in der Literaturleseansicht mit Abdeckungsanzeigen pro Seite. (#3973, #4000)

## 🚀 New Features

- Der Teilen-Marktplatz für Forschungsfälle ist jetzt über die Startseite und den Gesprächsarbeitsbereich durchsuchbar: Kategoriekarteireiter, Stichwortsuche, direkte Downloads aus den Falldetails, und Ihre Filter sowie die Scrollposition bleiben beim Wechsel zwischen Marktplatz und Projekt erhalten. (#3996)

## 🔧 Improvements

- Die Einstellungen beschreiben jetzt jeden wissenschaftlichen Konnektor einzeln — Europe PMC, Research Datasets, ChEA3, bioDBnet und CTD — statt eine gemeinsame allgemeine Zusammenfassung zu teilen. (#3993)
- Fehlermeldungen im Eingabebereich sind auf eine einheitliche Oberfläche vereinigt: Anbieter-, Umgebungs-, Eingabe-, Sitzungs- und interne Fehler zeigen jeweils eine klare Wiederherstellungsaktion an, statt mit konkurrierenden Fehlerformaten aufzutreten. (#3989)
- Das Veröffentlichen oder Wiederherstellen eines Artefakts bringt immer dessen neueste veröffentlichte Version mit, und das Provenienz-Panel erklärt die Versionsbeziehungen deutlicher. (#3783)
- Die OCR-Sprachauswahl bleibt beim Speichern reaktionsfähig, und Karten lokaler Modelle zeigen Status und Aktionen konsistenter an. (#4017)

## 🐛 Bug Fixes

- Windows-Notebooks bereiten ihre Shell-Laufzeit vor der ersten Verwendung wieder vor und stellen den PowerShell-Zugriff auf frischen Backends wieder her. (#4011)
- OpenCode-Sitzungen enden nicht mehr, wenn Kompaktierungsströme nichtstandardmäßige Nachrichten-Identitäten ausgeben. (#3998)
- Wenn Sie eine Folgefrage stellen, während eine Hintergrundaufgabe abgeschlossen wird, geht der neue Lauf nicht mehr verloren. (#3997)
- Volltext-Downloads funktionieren auf Rechnern mit Fake-IP-DNS-Modi wie Mihomo oder Clash, indem die Auflösung an den konfigurierten Proxy übergeben wird, wenn jede lokale Antwort ein Platzhalter ist. (#3977)
- Die Pi-Tool-Aktivität wird mit der gemeinsamen Darstellung für Skills, Notebooks und Literatur angezeigt, statt mit generischen Ein-/Ausgabebezeichnungen. (#4016)
- Ein blockierter OCR-Komponentendownload verzögert normale PDF-Lesevorgänge nicht mehr über die vorhandene Frist hinaus. (#4019)
