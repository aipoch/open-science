## ✨ Highlights

- **Pi rejoint en tant que cinquième framework d’agents.** Aux côtés de Claude Code, OpenCode, Codex et CodeBuddy, vous pouvez désormais exécuter des sessions avec l’agent Pi, avec intégration initiale, réglages, validation de connexion et connexion par abonnement là où cela est disponible. (#3921)
- **Ajoutez des références directement depuis un lien DOI ou arXiv.** La bibliothèque Literature gagne une entrée « Ajouter depuis un DOI ou un lien » : collez un DOI nu, un lien de résolution de DOI ou une URL d’abstract ou de PDF arXiv, révisez les métadonnées résolues et enregistrez-la comme référence sans préparer de fichier d’import. (#3990)
- **Les agents annotent les PDF pendant votre lecture.** Les agents de lecture peuvent désormais énumérer, localiser et créer des notes et des marques dans les Notes & Annotations existantes de la bibliothèque Literature pour les PDF liés, de sorte que des demandes comme « marquez ce paragraphe et résumez pourquoi il compte » persistent sous forme d’annotations réelles. (#3981)
- **Les PDF scannés deviennent lisibles grâce à une OCR optionnelle et à neuf packs de langue.** L’OCR est désormais un composant à la demande plutôt qu’une charge groupée, avec des données de reconnaissance téléchargeables pour l’anglais, le chinois simplifié et traditionnel, l’allemand, l’espagnol, le français, le japonais, le coréen et le russe — le texte des pages scannées apparaît dans la lecture Literature, avec des indicateurs de couverture par page. (#3973, #4000)

## 🚀 New Features

- Le marché Sharing des cas de recherche devient consultable depuis l’accueil et l’espace de conversation : onglets de catégories, recherche par mot-clé, téléchargements directs depuis les détails d’un cas, et vos filtres et votre position de défilement survivent aux allers-retours entre le marché et un projet. (#3996)

## 🔧 Improvements

- Les réglages décrivent désormais chaque connecteur scientifique individuellement — Europe PMC, Research Datasets, ChEA3, bioDBnet et CTD — au lieu de partager un résumé générique. (#3993)
- Les avis d’échec du compositeur sont unifiés en une seule surface cohérente : les échecs de fournisseur, d’environnement, d’entrée, de session et internes présentent chacun une action de récupération claire au lieu de formats d’erreur concurrents. (#3989)
- La publication ou la restauration d’un artefact fait toujours avancer sa dernière version publiée, et le panneau de provenance explique les relations de version plus clairement. (#3783)
- La sélection de langue OCR reste réactive pendant l’enregistrement, et les cartes de modèles locaux présentent l’état et les actions de manière plus cohérente. (#4017)

## 🐛 Bug Fixes

- Les notebooks Windows préparent à nouveau leur runtime shell avant la première utilisation, restaurant l’accès à PowerShell sur les backends neufs. (#4011)
- Les sessions OpenCode ne se terminent plus lorsque les flux de compaction émettent des identités de message non standard. (#3998)
- Poser une question de suivi pendant qu’une tâche en arrière-plan se stabilise ne détruit plus la nouvelle exécution. (#3997)
- Les téléchargements de texte intégral fonctionnent sur les hôtes utilisant des modes DNS Fake-IP tels que Mihomo ou Clash, en différant la résolution vers le proxy configuré lorsque chaque réponse locale est une valeur de substitution. (#3977)
- L’activité des outils Pi s’affiche avec la présentation partagée Skill, Notebook et Literature au lieu d’étiquettes génériques d’entrée/sortie. (#4016)
- Un téléchargement de composant OCR resté bloqué ne gêne plus les lectures PDF ordinaires au-delà du délai existant. (#4019)
