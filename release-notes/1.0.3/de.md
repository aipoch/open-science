## ✨ Highlights

- **Sieben neue Scientific-Connector-Werkzeuge decken Bildgebung, Signalwege, Lipide, Strukturen und Krebsmodelle ab.** Neue Werkzeuge erschließen Bildgebungskollektionen von The Cancer Imaging Archive (TCIA) und KEGG-Signalwegabfragen (beide optional aktivierbar), molekulare Regulation über OmniPath, exakte LIPID-MAPS-Verbindungssuche, PDBe-Strukturvalidierung mit UniChem-Kreuzabgleich, DepMap- und CCLE-Abfragen von Krebszelllinien sowie eine PDB-Ähnlichkeitssuche für Strukturen — allesamt standardmäßig deaktiviert und pro Quelle dauerhaft aktivierbar. (#3760, #3799, #3805, #3808, #3815, #3818, #3828)
- **Die Literature-Bibliothek wird zu einem vollwertigen Forschungs-Posteingang.** Die Semantic-Scholar-Zitationsrecherche deckt Referenzen und zitierende Arbeiten einer Publikation auf, Anhänge aus mehreren Quellen laden mit Fortschrittsanzeige und Vorschau (einschließlich Word-Dokumenten) herunter, PDFs und Bibliografiedateien lassen sich per Drag-and-drop importieren, und Smart-Screening-Ergebnisse lassen sich als tabellenkalkulationsfertiges CSV exportieren. (#3791, #3787, #3776, #3822)
- **Sitzungspakete funktionieren überall.** `.science`-Export und -Import laufen nun auch über headless CLI und lokale Web-Sitzungen, nicht nur in der Desktop-App. (#3801)
- **Übersetzte PDFs erhalten eine optionale inhaltserste Layout, und Notebooks erhalten Ordnerzugriffsbeschränkungen.** Übersetzte Editionen können Fließtext und Bildunterschriften in einspaltige Seiten umbrechen, während Bilder, Tabellen, Formeln und Bibliografie original bleiben, mit Seitenzuordnungen von Quelle zu Ausgabe für den Vergleich. Ordnerzugriffsbeschränkungen für Notebooks, standardmäßig aktiviert, halten Notebook- und Shell-Ausführung innerhalb der von Ihnen autorisierten Ordner. (#3637, #3800)

## 🚀 New Features

- Optional aktivierbare TCIA- (Krebsbildgebungskollektionen) und KEGG- (Signalwege und Medikamente) Connector-Werkzeuge. (#3799)
- OmniPath-Abfragen über molekulare Regulation und Signalwechselwirkungen. (#3805)
- Exakte LIPID-MAPS-Verbindungssuche nach Kennung oder Name. (#3808)
- PDBe-Strukturvalidierung mit UniChem-Abgleich auf verknüpfte chemische Datenbanken. (#3815)
- DepMap- und CCLE-Abfragen von Krebsmodellen für Zelllinien-Abhängigkeitsdaten. (#3818)
- PDB-Ähnlichkeitssuche für Strukturen, ausgehend von einer Strukturkennung. (#3828)
- Semantic-Scholar-Zitationsrecherche in Literature mit optionalem API-Schlüssel für höhere Ratenlimits. (#3791)
- Anhänge aus mehreren Quellen mit Fortschrittsanzeige je Datei, Archiventpackung ausgewählter Dateien und Vorschau nach Dateityp einschließlich Word-Dokumenten. (#3787)
- Drag-and-drop-Import von PDFs und Bibliografiedateien in die Literature-Bibliothek sowie Anhang-Downloads aus der Detailansicht der Referenz. (#3776)
- Smart-Screening-Ergebnisse lassen sich als CSV exportieren, mit allen Kandidaten samt Endurteilen, manuellen Entscheidungen, Begründungen und Modellwahrscheinlichkeiten. (#3822)
- `.science`-Sitzungspaket-Export und -Import über headless CLI und lokale Web-Sitzungen. (#3801)
- Option für ein inhaltserstes Layout übersetzter PDFs, standardmäßig deaktiviert und je Übersetzungsedition gespeichert. (#3637)
- Ordnerzugriffsbeschränkungen für Notebooks, standardmäßig für neue Einrichtungen aktiviert, halten Notebook- und Shell-Ausführung in autorisierten Ordnern. (#3800)
- Das Werkzeug für lokale Dateien kann autorisierte Verzeichnisse auf Abruf auflisten, sodass Agents vorhandene Ordnerfreigaben wiederverwenden, statt erneut zu fragen. (#3767)
- Kimi-K3.1-Pro-Anbietermodelle stehen zur Auswahl. (#3835)

## 🔧 Improvements

- Sitzungspaket-Übertragungen übertragen standardmäßig mehr Daten, und der Import überspringt wiederholte Verifikationsdurchläufe, sodass große Archive schneller fertig werden. (#3782, #3780)
- PDF-Anmerkungen und Strukturanalysen sind bei großen Dokumenten schneller. (#3825, #3831)
- Specialist-Wechsel zeigen Fortschritt an, während der neue Specialist lädt. (#3778)
- Einstellungseditoren sperren ihre Eingaben während des Speicherns und schützen ungespeicherte Entwürfe über die Bildschirme Memory, Tags und Anmeldedaten hinweg. (#3781, #3849)

## 🐛 Bug Fixes

- Windows: Die Registrierung des `open-science`-Protokolls ist wiederhergestellt, der Notebook-Host wird in Entwicklungseinrichtungen vor dem Start neu gebaut, und Sitzungspakete hashen Inhalte unter Windows korrekt. (#3777, #3843, #3829)
- Die Sitzungswiederherstellung übersteht nun Modellfehler, und beschädigte Gesprächsdateien lassen sich löschen, statt die Wiederherstellung zu blockieren. (#3740, #3804)
- Der Specialist-Wechsel erholt sich von bestimmten Anbieterablehnungen, ohne das Gespräch zu verlieren, und Fähigkeitsfehler werden von nicht verfügbaren Bindungen unterschieden. (#3772, #3796)
- Der Composer wechselt korrekt zwischen Stopp und wartendem Senden. (#3768)
- Sitzungspakete: Forschungscode löst keine falsch-positiven Anmeldedatenwarnungen mehr aus, und der Export setzt nach einer Quittierung sensibler Inhalte korrekt fort. (#3817, #3846)
- Notebook-Netzwerk-Sandbox: Genehmigungen bleiben über Neustarts erhalten, Platzhalterregeln und URL-Eingabe werden akzeptiert, die native Proxy-Weiterleitung ist aktiviert, und Dateisystem- sowie Proxy-Grenzen bleiben erzwungen. (#3830, #3826, #3827, #3841)
- Notebook-Analyse bewahrt Herkunft über verkettete wissenschaftliche Effekte hinweg, signierte Shell-Exit-Codes bleiben erhalten, Schutzprüfungen verlangsamen den Sitzungsstart nicht mehr, und Shell-Suchen bleiben innerhalb der Dateisystem-Sandbox. (#3812, #3851, #3839, #3788)
- Die PDF-Verarbeitung schließt abgeschnittenen Text und umbrochene Abbildungsverweise aus der Strukturanalyse aus, härtet die Zuständigkeit für Abbildungen, Tabellen und Reader, und vereinfacht Einzelseiten-Vorschauen. (#3795, #3814, #3816)
- Die Desktop-Wiederherstellung behebt wiedergegebene Titel-, Wiederholungs- und Schutzfehler. (#3823)
- Argumente der Claude-Abonnement-Prüfung bleiben in den Einstellungen erhalten. (#3837)
- Unbeteiligte Dienste werden von der Bereinigung laufender Prozesse ausgenommen. (#3797)
- Browser-Importe bewahren Wiederholungsversuche über eine Unterbrechung hinweg. (#3770)
