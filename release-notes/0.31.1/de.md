## ✨ Highlights

- **Sequenzierläufe über die Zugriffsnummer erreichen.** Neue ENA-Tools lösen eine öffentliche ENA/INSDC-Zugriffsnummer für Studie, Experiment, Probe oder Run zu den zugehörigen Sequenzierläufen auf — mit Metadaten zu Studie, Probe, Experiment, Organismus, Plattform und Bibliothek sowie den vom Archiv erzeugten FASTQ-Dateien, bereit für die weitere Analyse. (#2813)
- **Genmengen-Anreicherung mit g:Profiler.** Der Genes-Konnektor kann jetzt GO- und Pathway-Anreicherung für eine differentielle oder Marker-Gengruppe ausführen — mit Eingrenzung auf den Organismus, wählbaren Evidenzquellen und einem expliziten statistischen Hintergrund, damit die Anreicherungsergebnisse gut kontrolliert sind. (#2802)
- **NCBI-Referenzgenom-Abfragen.** Eigenständige NCBI-Tools lösen Taxonnamen auf und melden Mehrdeutigkeiten, betrachten versionierte Genom-Assemblies und schlagen Sequenz-Aliasse nach — historische Assembly-Zugriffsnummern bleiben abfragbar, statt durch die neueste Revision ersetzt zu werden. (#2796)
- **Optionale Klassifikationsmodelle.** In den Einstellungen lässt sich ein dedizierter Klassifikationsdienst anbinden, sodass die Auswahl von Fähigkeiten und Konnektoren auf einem eigens dafür gewählten Modell statt auf einem Konversationsmodell erfolgt; die Funktion bleibt deaktiviert, bis ein Dienst hinterlegt ist, und gespeicherte Anmeldedaten werden geprüft, bevor sie übernommen werden. (#2799)

## 🚀 Neue Funktionen

- Fernzugriff-Kopplungsanfragen erscheinen jetzt vor der Liste vertrauenswürdiger Browser — mit Countdowns, Dringlichkeits-Badges und Hinweisen zum Abgleichcode; das Widerrufen vertrauenswürdiger Browser bleibt sicher, selbst wenn der aktuelle Browser sich selbst widerruft. (#2812)
- Eine durch den Notebook-Netzwerkschutz blockierte R-Ausführung zeigt eine Inline-Warnkarte, die auf die Netzwerkeinstellung verweist, die das Problem behebt, und erklärt, dass die Zelle nicht ausgeführt wurde. (#2790)

## 🔧 Verbesserungen

- Lange Konversationen bleiben reaktionsschnell: Das Layout des Transkriptverlaufs und das Parsen gestreamter Nachrichten sind begrenzt, und die Arbeit mit Annotations- und Größenänderungs-Abonnements wurde stabilisiert. (#2801, #2807)
- Der Notebook-Ausführungsverlauf verfolgt REPL-Abhängigkeiten und erfasst die Datei-Herkunft, die eine Sitzungsübergabe hervorbringt. (#2808)
- Klassifikationsausführungen zeichnen Diagnosen pro Aufruf auf, damit stille Modellfehler sichtbar werden. (#2806)

## 🐛 Fehlerbehebungen

- **Notebook und Berechnung** – persistente Windows-Kernel-Prozessbäume werden überwacht, damit Ausführungen sauber enden (#2770); veraltete Windows-R-Paketinventare werden erneut versucht, statt zu scheitern (#2789); Paketinventar-Berichte aus micromamba-Umgebungen werden akzeptiert (#2774); die REPL-Beendigung zeichnet Diagnosen auf (#2777); Befehle aus der Befehlszeile können auf GUI-autorisierte externe Ordner zugreifen (#2797); gepackte Notebook-Skripte übernehmen keine fremden Moduldefinitionen mehr (#2781).
- **Sitzungen und Agent-Laufzeit** – verlorengegangene OpenCode-Sitzungen werden beim Start wiederhergestellt (#2805); doppelt vergebene Eigentümerschaft bei der Sitzungsfortsetzung wird abgesichert (#2810); Abbrüche bleiben erhalten und nicht aufgeräumte Delegierte werden isoliert (#2518); Sitzungen mit fehlenden Codex-Rollout-Dateien werden übernommen (#2779); zuverlässige Fortsetzungen übergeordneter Nachrichten werden zugelassen (#2803); Eigentümerschafts-Einträge von Delegierten erholen sich nach einem App-Neustart (#2785); die Sitzungsidentität bleibt über Framework-Wechsel hinweg erhalten (#2778).
- **Konnektoren** – GTEx-Genreferenz-Ergebnisse werden seitenweise ausgeliefert, statt abgeschnitten zu werden (#2768); partielle Fehler von Open Targets GraphQL werden sichtbar gemacht, statt still verworfen zu werden (#2760); die hg19-Konservierungsanalyse wählt die richtige Standard-Spur (#2796).
- **Oberfläche und Speicher** – Freigabe-Karten öffnen sich nicht mehr erneut und rauben dem Eingabefeld den Fokus (#2654); doppelte Vorschauen ausstehender Nachrichten werden entfernt (#2655); die Liste der letzten Sitzungen behält ihre Reihenfolge, während Sitzungen aktualisiert werden (#2769); Regressionen beim Tastaturzugriff wurden behoben (#2786); passive Laufzeit-Beobachter kollidieren nicht mehr mit dem Sitzungsspeicher (#2649); die OpenCode-Veröffentlichung erholt sich, wenn ein Dateizugriffsfehler sie unterbricht (#2780); Hilfsfunktionen des Fähigkeits-Erstellers werden nicht mehr mit fremden Moduldefinitionen verwechselt (#2804); Literatur-Abbildungen und Tabellenstrukturen werden korrekt aus PDFs wiederhergestellt (#2794).
