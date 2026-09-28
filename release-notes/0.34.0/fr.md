## ✨ Points forts

- **Linux ARM64 natif.** Open Science propose désormais des installateurs ARM64 pour Linux aux côtés de la version x64, couvrant ainsi les machines virtuelles Linux sur Apple Silicon et les stations de travail ARM. (#3106)
- **Extension des connecteurs.** Un nouveau connecteur Pathway Commons rejoint les sources d’expression inter-espèces cBioPortal, openFDA, MGnify et Bgee étendues. (#3113, #3101, #3097)
- **Navigation entre sessions depuis la zone de notification.** Le menu de la zone de notification du bureau liste désormais les sessions pour un basculement rapide sans ouvrir la fenêtre principale. (#3047)
- **Electron 43.** L’application passe à Electron 43 pour un runtime plus récent et mieux pris en charge. (#3060)

## 🚀 Nouveautés

- Installateurs Linux ARM64 natifs aux côtés des paquets x64 existants. (#3106)
- Connecteur Pathway Commons : recherchez des voies, listez les voies principales, inspectez les graphes d’interactions et exportez les résultats. (#3113)
- Outils d’expression inter-espèces Bgee : appels d’expression, liens de téléchargement et requêtes SPARQL entre espèces. (#3097)
- Connecteurs cBioPortal, openFDA et MGnify étendus avec une couverture de requêtes plus large. (#3101)
- MiniMax M3.1 Flash Preview comme option de fournisseur intégrée. (#3110)
- Jeux de données de journaux avec attributs de référence pour organiser les collections de literature. (#3095)
- Navigation entre sessions depuis la zone de notification du bureau pour un basculement rapide. (#3047)
- Actions de référence dans l’espace de travail pour travailler avec les références de literature en contexte. (#3058)
- Aperçu des références de la bibliothèque et étendues de messages affinés. (#3042)
- Montée de version vers le runtime Electron 43. (#3060)

## 🔧 Améliorations

- Les bascules d’espace de travail conservent les lignes de session, rendant la navigation dans la barre latérale nettement plus rapide. (#2992)
- La découverte d’interpréteurs lance moins de sous-processus, accélérant le démarrage du runtime. (#3055)

## 🐛 Corrections

- **Sessions et récupération** — les paquets de session reconnaissent les valeurs de jeton sérialisées masquées (#3112) ; la récupération reprend après les erreurs de connexion de l’agent (#3104) ; les nouvelles conversations peuvent démarrer pendant la préparation de l’envoi (#3109) ; la délégation est restaurée après un arrêt et un redémarrage de l’application (#3092) ; la compaction native du contexte se stabilise de façon fiable (#3053) ; la configuration de Prisma et l’admission de continuation sont renforcées (#3028) ; l’historique des sous-agents est préservé entre les cycles de vie de l’aperçu (#3091) ; les notebooks conservent le premier aperçu d’exécution en arrière-plan (#3054).
- **Literature et PDF** — l’extraction des figures et des tableaux est renforcée (#3096) ; les métadonnées manquantes et les détails d’importation PDF sont récupérés (#3049) ; toutes les références s’ouvrent depuis l’aperçu de la bibliothèque (#3068) ; l’espacement des références de l’aperçu est resserré (#3103).
- **Réviseur et runtimes** — les évaluations de correction interrompues reprennent (#3093) ; le runtime Codex exige une CLI prise en charge et répare les runtimes obsolètes (#3052).
- **Calcul distant** — l’énumération des répertoires distants macOS est prise en charge (#3085) ; la disponibilité du runtime WSL et les notifications de cycle de vie sont renforcées (#3090).
- **Expérience de l’espace de travail** — les modifications sont protégées et les actions de l’espace de travail clarifiées (#3063) ; la sélection par lots de la bibliothèque est opt-in avec des boutons de chat aplatis (#3062) ; le focus clavier et la navigation par Échap sont affinés (#3059) ; les régressions de mise en page, d’accessibilité et de flux de travail sont réparées (#3077) ; les anciens rappels de rechargement d’annotation sont ignorés (#3061).
- **Paramètres et explications** — l’installateur de Claude gère les redirections et les réponses HTML (#3098) ; les explications du serveur local, des autorisations de runtime et des contrôles désactivés sont plus claires (#3070, #3087, #3080).
