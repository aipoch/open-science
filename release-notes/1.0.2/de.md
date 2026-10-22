## ✨ Highlights

- **Fünf neue Scientific Connectors sowie tiefere GDC- und Ensembl-Unterstützung.** Der Katalog erreicht nun die HGNC-Gennomenklatur, PubTator-3-Literaturannotationen, DGIdb-Medikament-Gen-Interaktionen, RNAcentral-Datensätze nicht-codierender RNA und einen neuen Orphadata-Connector für seltene Erkrankungen (standardmäßig deaktiviert, pro Specialist oder Main aktivierbar). GDC-Datei- und Fallsuchen führen nun Proben-, Aliquot- und Tumor-/Normal-Workflow-Metadaten mit, sodass Ergebnisse aus unterschiedlichen Biospezimen nicht mehr unter einem Fall vermischt werden, und das Ensembl-VEP-Werkzeug akzeptiert HGVS-Variantennotation direkt, statt eine manuelle Umwandlung in Koordinaten zu erfordern. (#3738, #3744, #3732)
- **Antwortkarten sagen Ihnen die Wahrheit darüber, wie viele Antworten Sie geben können.** Auswahlfragen zeigen nun korrekt eine Single-select- oder Multi-select-Kennzeichnung an, statt stets mehrere Auswahlmöglichkeiten zu suggerieren, jede beantwortete Frage in einer Gruppe zeigt ihren eigenen vollständigen Text und ihre Antwort, statt unter einer gemeinsamen Zählung zusammengefasst zu werden, und das Aufklappen einer vergangenen Antwort zeigt ihre vollständige Optionsliste. (#3690)
- **Sitzungspaket-Dialoge hören auf herumzuspringen.** Der `.science`-Import-/Export-Dialog ändert seine Größe und Position nicht mehr, wenn sich Schritte und Zähler ändern — er behält eine stabile Position und passt seine Größe an seinen Inhalt an. (#3747)
- **Schnelleres Laden von Sitzungen bei großen Projekten.** Das Öffnen von Sitzungen mit viel Verlauf überspringt bei einem sauberen Neuladen redundante Konsistenzprüfungen und cacht aufwendige Abfragen, was Hydration und Startzeit verkürzt, ohne die Wiederherstellungsprüfungen zu schwächen, die nach einem unsauberen Herunterfahren laufen. (#3718)
- **Sicherheitspatches für die gebündelte Node-Laufzeit und die erste npm-Veröffentlichung der CLI.** Desktop- und eigenständige CLI-Builds liefern nun Node 22.23.4 und eine aktualisierte Undici-Netzwerkbibliothek aus und schließen damit die Node.js-Sicherheitshinweise von Oktober. Die eigenständige CLI und das Task SDK sind nun auch über `npm install --global @aipoch/open-science` installierbar, zusätzlich zum bestehenden Homebrew-Tap. (#3751, #3750)

## 🚀 New Features

- Die CLI erhielt lokale Befehle `version`, `help` und `paths`, die die installierte App-Version, Befehlshilfe und Konfigurationsverzeichnisse melden, ohne dass ein laufender Dienst nötig ist. (#3752)
- Fünf neue Scientific Connectors: HGNC-Gennomenklatur, PubTator-3-Literaturannotationen, DGIdb-Medikament-Gen-Interaktionen, RNAcentral-RNA-Datensätze und Orphadata-Assoziationen für seltene Erkrankungen (Orphadata ist standardmäßig deaktiviert). (#3738)
- GDC-Datei- und Fallsuchen können nach Fall, Probentyp und Analyse-Workflow filtern, und Zusammenfassungen enthalten verknüpfte Proben-, Aliquot- und Workflow-Metadaten. (#3744)
- Das Ensembl-VEP-Connector-Werkzeug akzeptiert HGVS-Notation (zum Beispiel eine Transkript-codierende Änderung) direkt, neben Varianten-IDs und genomischen Koordinaten. (#3732)
- Das `@`-Erwähnen eines Artefakts funktioniert nun auch von entfernten Web-Chat-Clients aus, nicht nur in der lokalen Desktop-App. (#3719)

## 🔧 Improvements

- Codex-Sitzungen mit Abonnementmodellen erhalten nun die tatsächliche Kontextfenstergröße des Modells angewendet, und die gemeldete Nutzung spiegelt Codex' eigene Kapazität wider statt eines überhöhten Standardwerts. (#3739)
- Fehlerdialoge für Ordnerzugriff und Ordnerfreigabe behalten die spezifische, übersetzte Fehlermeldung, statt jeden Fehler zu einer generischen Meldung zusammenzufassen, und schneiden ihre Aktionsschaltflächen nach dem Anzeigen eines Fehlers nicht mehr ab. (#3710)
- Diagnoseexport-Ergebnisse bleiben in einem festen Bereich sichtbar, statt unter eine scrollende Dateiliste geschoben zu werden, und unvollständige Exporte werden als Warnungen angezeigt, statt wie vollständige Erfolge auszusehen. (#3741)
- Das Importieren von 257 oder mehr installierten Skills auf einmal schlägt nicht mehr vollständig fehl — große Auswahlen werden nun in Stapeln übermittelt. (#3711)
- Das Importieren eines externen Skills, dessen Name mit einem reservierten Präfix beginnt, gelingt nun mit einem sicheren lokalen Namen, statt stillschweigend aus dem Katalog gefiltert zu werden. (#3712)
- Das Ablegen eines Ordners auf dem Nachrichten-Composer zeigt nun einen klaren Hinweis, die darin enthaltenen Dateien auszuwählen, statt den Ordner zu übernehmen und mit einem verwirrenden Fehler zu scheitern. (#3709)
- Entwürfe und laufende Arbeit sind besser geschützt: Connector- und Compute-Einstellungsformulare verlieren nicht gespeicherte Eingaben nicht mehr durch veraltete Abschlüsse, Fehler bei wartenden Nachrichten sind mit einer Rückgängig-Option sichtbar, und die App warnt vor dem Beenden oder Neuladen bei ungesendeten Nachrichten. (#3722)
- Das Wechseln von Gesprächen, während eine Nachricht an ein anderes Gespräch noch gesendet wird, springt die Ansicht nicht mehr zurück zu jenem anderen Gespräch. (#3706)

## 🐛 Bug Fixes

- Abgelaufene oder ungültige Modell-/Connector-Anmeldedaten zeigen nun einen spezifischen Wiederherstellungspfad statt eines rohen Authentifizierungsfehlers, und der Composer wird nur deaktiviert, während eine Wiederherstellung tatsächlich erforderlich ist, sodass Entwürfe und laufende Antworten nicht verloren gehen. (#3737)
- Eine dauerhafte Frage, die vor der Aufzeichnung fehlgeschlagen ist, oder eine, die von einem bereits abgeschlossenen Turn übrig blieb, konnte jeweils fälschlicherweise den Composer hinter einer veralteten Fragekarte verbergen; beide Fälle sind nun behoben, und der Composer erscheint wieder. (#3734, #3725)
- Das Löschen einer Literature-Sammlung mit einer gleichnamigen Unter-Sammlung meldet nicht mehr fälschlicherweise einen Namenskonflikt und blockiert nicht mehr die Löschung. (#3736)
- DOCX-Vorschauen setzen nummerierte Listenzähler nicht mehr mitten im Dokument zurück und stellen Tabellenrahmen nun konsistent mit Desktop-Dokumenteneditoren dar. (#3735)
- Die PDF-Lektüre bewahrt Abbildungsausschnitte, Bildunterschriften und Tabellenstruktur originalgetreuer, und Inhalte im Reader-Modus werden für komplexe wissenschaftliche PDFs genauer klassifiziert und dargestellt. (#3727)
- Zuverlässigkeit von Sitzungspaketen (`.science`): Das Wiederholen eines teilweise übernommenen Imports erzeugt keine doppelte Sitzung mehr, das Bearbeiten des Titels einer importierten Sitzung wird nicht mehr durch die Schreibschutz-Sperre abgelehnt, doppelte Ausführungsnachweise innerhalb eines Archivs werden auf der Festplatte geteilt statt pro Referenz kopiert, und Exportfehler behalten eine spezifische Diagnose statt einer generischen Meldung über fehlenden Speicherplatz. (#3694, #3733)
- Die Nachverfolgung von Notebook-Abhängigkeiten und Dateiherkunft ist über verkettete CSV-Lese-, Transformations- und Exportvorgänge sowohl in Python- als auch in R-Analysezellen genauer. (#3728)
- Eine große Artefaktfinalisierung, die mitten in der Transaktion in ein Timeout lief, meldet keinen Fehler mehr, wenn der zugrunde liegende Schreibvorgang bereits übernommen worden war. (#3717)
- Der integrierte MiniMax-M3.1-Connector schlägt nicht mehr fehl, wenn er über Codex verwendet wird. (#3731)
- Codex-Initialisierungsfehler behalten nun den tatsächlichen Startfehler in der Diagnose, statt nur eine generische Bereinigungswarnung. (#3726)
- Das Beenden der App, während die lokale Verbindung abbricht, hängt nicht mehr fest und zeigt nicht mehr zwei widersprüchliche Fehlerdialoge. (#3704)
- Eine nach einer Speichermigration wiederhergestellte Sitzung konnte als beschäftigt hängen bleiben, selbst nach erfolgreicher Fortsetzung; Wiederholungsversuche werden nun korrekt angenommen. (#3705)
- Die App konnte selten nicht starten, weil eine harmlose, teilweise geschriebene SQLite-Journal-Datei fälschlicherweise als beschädigt erkannt wurde; dies wird nun korrekt erkannt, sodass der Start fortgesetzt wird. (#3701)
- Das Beenden der App während eines Datenbank-Commits verhindert nicht mehr ein saubereres Herunterfahren. (#3703)
- Unter Windows konnte eine gesperrte Berechtigungsdatei der Workspace-Netzwerk-Sandbox hängen bleiben und sich nicht erholen; der Berechtigungsstatus wird nun bis zum Abschluss der Bereinigung erhalten. (#3721)
