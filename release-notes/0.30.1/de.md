## ✨ Highlights

- **Aktualisierungen von Fähigkeiten als echten Diff prüfen.** Aktualisierungsvorschauen werden über einen gemeinsamen Quell-Diff-Betrachter dargestellt – Dateikopfzeilen mit Änderungszählern, Zeilennummernspalte, gestrichelte rote Löschstreifen und durchgezogene grüne Einfügestreifen, optionale Syntaxhervorhebung sowie lesbare Rückfälle für fehlerhafte oder übermäßig große Patches. (#2632)
- **Nebengespräche starten als Entwürfe mit dem passenden Modell.** Neue Nebengespräche öffnen sofort einen leeren Entwurf, erben das aktuelle Modell und den Reasoning-Aufwand des Hauptgesprächs und übernehmen Ihre eigene Auswahl beim nächsten Senden; unberührte leere Entwürfe werden automatisch verworfen. (#2598)
- **Ein eigenständiges Zurücksetzungswerkzeug für Windows.** Wenn beschädigte Daten eine Neuinstallation überdauern, listet ein geführtes Befehlszeilenwerkzeug aufgelöste Daten, Konfiguration, Profil und authentifizierte Laufzeit-Caches auf, verweigert unsichere Ziele und löscht erst, nachdem Sie eine exakte Bestätigung eingegeben haben – laufende Laufzeiten blockieren die Bereinigung. (#2626)
- **Kleine Annehmlichkeiten im gesamten Arbeitsbereich.** Tag- und Ressourcenauswahllisten erhalten Tastatursuche und -erstellung, die Projektlizenz wird während der Installation angezeigt, `.science`-Pakete können die von Ihnen ausgewählten Literatur-PDFs enthalten, und Ausführungsvorschauen und Schaltflächen teilen sich eine gemeinsame Bewegungssprache. (#2600, #2591, #2637, #2639)

## 🚀 Neue Funktionen

- **Gemeinsamer hervorgehobener Diff-Betrachter** – in der gesamten App wiederverwendbar und zuerst in den Dialog für Fähigkeitsaktualisierungen integriert, mit übersetzten Trennern für ausgelassenen Kontext und Beschriftungen für Bildschirmleser, die die Bedeutung der Änderung bewahren. (#2632)
- **Entwürfe und Gesprächsmodelle für Nebengespräche** – Entwürfe mit Text oder Anmerkungen überstehen die Navigation, die Absicht, den Anbieter-Standard zu verwenden, bleibt über Neustarts und Fortsetzungsfehler hinweg erhalten, und das Sendemenü wirkt bei leerem Eingabefeld nicht mehr deaktiviert. (#2598)
- **Eigenständiges Windows-Werkzeug zum Zurücksetzen von Daten** – basiert auf PowerShell und ist aus der Dokumentation verlinkt; es validiert jedes Ziel vor dem Löschen, hebt untergeordnete Verknüpfungen auf, ohne ihnen zu folgen, verarbeitet die Konfiguration zuletzt und hält Fehler sichtbar. (#2626)
- **Tag-Auswahllisten mit Tastatursuche und -erstellung** in Ressourcenauswahllisten (#2600), **Anzeige der Projektlizenz während der Installation** (#2591), **auswählbare Literatur-PDFs in `.science`-Paketen**, eine **animierte gemeinsame Karte zur Ausführungsvorschau** (#2637) und **vereinheitlichte Schaltflächenbewegung und Aktionsfeedback** (#2639).

## 🔧 Verbesserungen

- Inkompatible Anbieter werden auf einer eigenen Route geprüft, statt die aktive zu stören, und schlüssellose lokale Gateways sind jetzt zulässig. (#2569)
- Die Freigabe zum Lesen im Web wird für den Rest des Gesprächs gemerkt, statt erneut nachgefragt zu werden. (#2635)
- Hinweise zur PDF-Evidenz erläutern deren Einschränkungen und diagnostizieren die Quellen von Lesezeichen. (#2594)
- Der Fähigkeiten-Marktplatz löst Aktualisierungskonflikte durch geprüfte Aktualisierungen an Ort und Stelle, und Weiterleitungen von Release-Assets für Spezialisten werden sicher verfolgt. (#2615)

## 🐛 Fehlerbehebungen

- **Sitzungen und Pläne** – die Freigabesperre von Sitzungsplänen übersteht MCP-Zeitüberschreitungen (#2631); verifizierte historische Artefaktbindungen werden wiederhergestellt (#2633); der Abbruch von Aufgabenausführungen wird mit der Sitzungszulassung synchronisiert (#2618); Laufzeiten bleiben erhalten, wenn der Sitzungsstart noch aussteht (#2620); Nebengespräche sind vom Exportumfang der Pakete ausgenommen (#2619), und OpenCode-Anweisungen für Nebengespräche lecken nicht mehr in Hauptgespräche (#2624); Literaturansichten kehren zum ursprünglichen Projektgespräch zurück (#2599).
- **Notebook und Berechnung** – eingereihte Läufe und der Laufzeitzustand bleiben konsistent (#2589); Bereinigungswiederholungen bewahren den nativen Terminierungsnachweis (#2623); nicht zugängliche geerbte PATH-Verzeichnisse werden toleriert (#2613); bereits maskierte Linux-Pfade werden nicht erneut maskiert.
- **PDF und Vorschauen** – blockiertes Parsen wird wiederhergestellt und Extraktionsfehler werden gemeldet (#2597); native Abbildungs- und Tabellenlayouts werden nach einer Regression wiederhergestellt (#2617); Hintergrund-Overlays bleiben unter aktiven Modaldialogen. (#2593)
- **Fähigkeiten und Konnektoren** – das Pooling von Batch-Resten in ESM-2 wird korrigiert (#2601); gnomAD-Regionsargumente werden validiert (#2616), und Referenz-Builds werden passend zu den Datensätzen zugeordnet (#2596).
- **Plattform** – macOS-Installationen mit Schreibschutz werden angeleitet, Berechtigungen vor dem Aktualisieren zu korrigieren (#2603); fehlende Importe dateigestützter Codex-Anmeldedaten werden in den Einstellungen erklärt (#2609); das Feedback zur Tag-Zuweisung ist wieder unmittelbar (#2610), und der Zeigercursor bleibt während des Speicherns erhalten.
