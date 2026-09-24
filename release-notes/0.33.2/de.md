## ✨ Highlights

- **Code-signierte Windows-Installationsprogramme.** Stabile Windows-Pakete sind jetzt signiert, die SmartScreen-Warnung „Nicht erkannte App“ erscheint beim ersten Start nicht mehr. (#2980)
- **STRING-Proteininteraktions-Anreicherung.** Der Protein-Annotations-Konnektor erhält eine STRING-PPI-Anreicherungsanalyse, die die funktionalen Assoziationen in Ihrer Genliste bewertet. (#2984)
- **Persistente Live-Source-Vorschauen.** Browser-Vorschauen von Live-Quellen nutzen jetzt eine dauerhafte Sitzung, sodass Anmeldungen und Zustand App-Neustarts überleben. (#2824)

## 🚀 Neue Funktionen

- Windows-Installationsprogramme sind code-signiert – der erste Start verläuft ganz normal, ohne Warnung. (#2980)
- STRING-PPI-Anreicherung im Protein-Annotations-Konnektor: Senden Sie eine Genliste und erhalten Sie Anreicherungs-Scores sowie das bewertete Interaktionsnetzwerk. (#2984)
- Browser-Vorschauen von Live-Quellen laufen in einer persistenten Partition und behalten Ihre Sitzung zwischen den Besuchen und über Neustarts hinweg. (#2824)
- Der Berechtigungsmodus „Library Auto" unterbricht seltener und fragt die Genehmigung nur noch dort ab, wo es während der Routinearbeit wirklich zählt. (#2983)

## 🔧 Verbesserungen

- App-Downloads verweisen jetzt auf die offizielle Download-Seite, mit verlinkten Hinweisen zur Überprüfung der Downloads. (#2987)

## 🐛 Fehlerbehebungen

- **Delegation** — abgeschlossene Ergebnisse überleben Aufräumfehler, statt verworfen zu werden (#2977); der Delegations-Workflow von Figure Composer wurde überarbeitet (#2981).
- **Workspace** — Dateityp-Symbole erscheinen jetzt in Vorschau-Kopfzeilen, passend zu den Workspace-Listen (#2982); die Optionen smarter Sammlungen erhalten kompakteren, einheitlicheren Abstand (#2985).
- **Notebook** — beibehaltene macOS-Aufräumverpflichtungen werden isoliert, sodass Notebook-Arbeiten nicht durch unzusammenhängende Aufräumbuchhaltung blockiert werden (#2919).
- **Agent-Laufzeit** — das native Responses-Routing und der Teardown-Abbruch bleiben erhalten (#2972).
- **Codex-Backend** — die Plugin- und App-Erkennung ist deaktiviert und reduziert unerwartete Hintergrundaktivität (#2979).
