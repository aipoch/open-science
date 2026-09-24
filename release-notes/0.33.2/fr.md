## ✨ Points forts

- **Installateurs Windows signés (signature de code).** Les paquets Windows stables sont désormais signés, si bien que l’avertissement SmartScreen « application non reconnue » n’apparaît plus au premier lancement. (#2980)
- **Enrichissement des interactions protéiques STRING.** Le connecteur d’annotation des protéines gagne une analyse d’enrichissement des interactions protéiques (PPI) STRING qui note les associations fonctionnelles au sein de votre liste de gènes. (#2984)
- **Aperçus des sources en direct persistants.** Les aperçus navigateur des sources en direct utilisent désormais une session persistante, si bien que les connexions et l’état survivent aux redémarrages de l’application. (#2824)

## 🚀 Nouveautés

- Les installateurs Windows sont signés (signature de code) — le premier lancement se déroule normalement, sans avertissement. (#2980)
- Enrichissement PPI STRING dans le connecteur d’annotation des protéines : soumettez une liste de gènes et récupérez des scores d’enrichissement ainsi que le réseau d’interactions noté. (#2984)
- Les aperçus navigateur des sources en direct s’exécutent dans une partition persistante, conservant votre session entre les visites et d’un redémarrage à l’autre. (#2824)

## 🔧 Améliorations

- Les téléchargements de l’application pointent désormais vers la page de téléchargement officielle, avec des notes de vérification liées depuis celle-ci. (#2987)

## 🐛 Corrections

- **Délégation** — les résultats terminés survivent aux échecs de nettoyage au lieu d’être abandonnés (#2977) ; le flux de travail de délégation du Figure Composer est rafraîchi (#2981).
- **Espace de travail** — des icônes de type de fichier apparaissent désormais dans les en-têtes des aperçus, en cohérence avec les listes de l’espace de travail (#2982) ; les options des collections intelligentes gagnent un espacement plus serré et plus cohérent (#2985).
- **Notebook** — les obligations de nettoyage conservées de macOS sont isolées, si bien que le travail du notebook n’est pas bloqué par une comptabilité de nettoyage sans rapport (#2919).
- **Backend Codex** — la découverte de plugins et d’applications est désactivée, réduisant l’activité inattendue en arrière-plan (#2979).
