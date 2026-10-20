## ✨ Points forts

- **Extension des connecteurs.** La découverte des statistiques récapitulatives GWAS rejoint le connecteur de génétique humaine, InterProScan gagne la soumission de séquences, et le connecteur IEDB ajoute les recherches de preuves de récepteurs. (#3278, #3280, #3304)
- **Un meilleur départ.** L'écran de nouvelle conversation unifie les démarreurs de recherche avec le compositeur, et l'en-tête de session gagne un menu d'actions courantes. (#3297, #3267)
- **Fournisseur Requesty.** Requesty rejoint le sélecteur de fournisseurs officiel avec un catalogue de modèles sélectionné. (#3114)

## 🚀 Nouveautés

- Découverte des statistiques récapitulatives GWAS dans le connecteur de génétique humaine : localisez les fichiers complets de statistiques récapitulatives, les métadonnées et les informations sur le génome de référence d'une étude. (#3278)
- Le connecteur InterProScan gagne la soumission de séquences bornée, complétant le flux soumission → statut → résultats sans création manuelle de tâche. (#3280)
- Le connecteur IEDB gagne les recherches de preuves de récepteurs TCR et BCR aux côtés de la recherche d'épitopes et de tests. (#3304)
- Nouvelle expérience de démarrage de conversation : les démarreurs de recherche restent à un clic pendant la rédaction, avec une option compacte d'importation de paquet. (#3297)
- Le menu de l'en-tête de session regroupe les actions courantes : modifier et épingler la session, démarrer une discussion latérale ou un embranchement, exporter la conversation, le paquet de session ou les diagnostics, et archiver. (#3267)
- Fournisseur Requesty dans le sélecteur de fournisseurs officiel, avec catalogue de modèles sélectionné et validation de connexion intégrée. (#3114)

## 🔧 Améliorations

- Les onglets de discussion latérale et la barre d'outils suivent la mise en page compacte de l'espace de travail. (#3275)
- Les catalogues de modèles OpenRouter et Requesty sont actualisés. (#3276)

## 🐛 Corrections

- **Relecture et sessions** — le défilement des suites et les questions de fichiers enregistrées sont préservés dans la relecture (#3292) ; les sessions importées conservent leurs interactions historiques en lecture seule (#3269) ; le compositeur conserve son contexte lorsqu'une liaison de session change (#3306).
- **Notebook et runtimes** — la filiation des fichiers de notebook multilingue est correctement projetée (#3296) ; les documents d'exécution corrompus sont isolés sans bloquer la récupération (#3294) ; les environnements R sont préservés lorsque les chemins du projet contiennent des espaces (#3290).
- **PDF et aperçu** — l'extraction de mise en page des publications est renforcée pour les articles externes complexes (#3286) ; le contexte PDF persiste avant l'admission du premier message (#3270) ; les notes PDF vérifiées sont unifiées entre les projets (#3264) ; les notifications persistantes du lecteur sont réduites (#3274).
- **Agents et autorisations** — les paramètres de connexion partagée sont isolés par défaut (#3289) ; les refus d'autorisation Claude sans surveillance sont expliqués dans l'espace de travail (#3287).
- **Espace de travail et fiabilité** — la barre de titre reste au-dessus des superpositions et hors des surfaces portées par portail (#3285, #3307) ; le compositeur de discussion latérale et les icônes de lecture sont alignés (#3301) ; les icônes de l'en-tête de session ne se chevauchent plus (#3279) ; les signets non résolus sont traités et les surlignages d'aperçu sont effacés (#3272) ; les transactions d'artefacts expirées sont réessayées (#3295) ; la punctuation entre guillemets ne déclenche plus de faux positifs d'identifiants (#3271) ; les échecs de création de signets sont diagnostiqués avec leur étape d'échec (#3273).
