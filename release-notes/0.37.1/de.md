## ✨ Highlights

- **Treue der PDF-Strukturextraktion wiederhergestellt.** Die Strukturextraktion behält vollständige Abbildungen mit Beschriftungen und Legenden bei, rekonstruiert linierte Tabellen neben Formeln, ohne sie zurückzuweisen, und bewahrt die native Zuordnung von Abbildungsbereichen, Tabellendatensätzen und quellbewiesenem Text. (#3456, #3465)
- **Eine ruhigere, robustere Windows-Erfahrung.** Die Desktop-CLI funktioniert ab Installationspfaden mit Nicht-ASCII-Zeichen, die PDF-Übersetzung verarbeitet Windows-Laufwerkspfade, und Notebook-Kernel sowie Umgebungserfassungen öffnen keine Konsolenfenster mehr. (#3457, #3460)

## 🔧 Verbesserungen

- Desktop-Installer und die eigenständige Laufzeit verabschieden sich von ungenutzten Laufzeit-Payloads — doppelte gebündelte Abhängigkeiten, ungenutzte Modelllaufzeit- und Tokenizer-Ressourcen sowie Plattformbibliotheken, die die App nie lädt — und machen das durch die Backend-Aufteilung von v0.37.0 eingetretene Größenwachstum rückgängig (#3451, #3470)

## 🐛 Fehlerbehebungen

- Eine mit Leerzeichen geschriebene Panel-Referenz im Fließtext teilt eine Abbildung nicht mehr in separate Raster- und Vektorzuschnitte, und Detector-Abstand unterhalb der Abschlusslinie einer Tabelle führt nicht mehr dazu, dass die gesamte Tabelle als beschädigte Formel zurückgewiesen wird (#3465)
- Die native PDF-Extraktion behält Beschriftung und Grafikbesitz beim richtigen Element, stellt unabhängig begrenzte Tabellendatensätze mit gruppierten Kopfzeilen und Zeilengruppen wieder her und bewahrt Zellquellreferenzen und Rich-Text (#3456)
- Die Desktop-CLI liest ihren Starter unter Legacy-Codepages nicht mehr falsch, wenn der Installationspfad chinesische Zeichen enthält, und bewahrt die Codepage und den Exitcode des Aufrufers (#3457)
- Die lokale PDF-Übersetzung unter Windows schlägt nicht mehr mit einer nicht unterstützten Modul-URL fehl, wenn sich die WASM-Ressourcen auf einem Laufwerkspfad befinden (#3457)
- Notebook-Kernel, Umgebungs-Fingerprinting, Paketinventar und Sperrerfassung blenden während der Ausführung kein Konsolenfenster oder Windows-Terminal mehr auf (#3460)
