## ✨ Points forts

- **Criblage de littérature intelligent en direct.** Les collections intelligentes criblent désormais les références en direct, avec des commandes de pause et de reprise, si bien que les campagnes de criblage de grande envergure restent sous votre contrôle du début à la fin. (#2968)
- **Nouveaux connecteurs et outils d’alignement.** HMMER rejoint la famille des connecteurs pour des recherches d’homologie de séquences contre des bases de profils (#2957) ; InterProScan rejoint comme connecteur vérifiant l’état et récupérant les résultats de tâches d’annotation existantes (#2935) ; et le connecteur Genomes gagne l’alignement multiple de séquences Clustal Omega (#2944).
- **Catalogues de fournisseurs rafraîchis.** GPT-6 et Claude Opus 5.5 rejoignent les catalogues de fournisseurs, prêts à être sélectionnés dans les configurations nouvelles et existantes. (#2967)
- **Les preuves PDF suivent la conversation.** Les conversations de l’espace de travail peuvent désormais transporter des preuves PDF avec le premier message, si bien que le contexte arrive avant que l’agent ne se mette au travail. (#2941)

## 🚀 Nouveautés

- Criblage de littérature intelligent en direct : les campagnes de criblage évaluent les références au fur et à mesure de leur arrivée et peuvent être mises en pause et reprises à tout moment. (#2968)
- Connecteur HMMER : recherchez des séquences protéiques ou nucléiques contre des bases de profils HMM pour identifier des familles homologues. (#2957)
- Connecteur InterProScan : vérifiez l’état de tâches d’annotation InterProScan existantes et récupérez leurs résultats par identifiant de tâche. (#2935)
- L’alignement multiple de séquences Clustal Omega arrive dans le connecteur Genomes : alignez trois enregistrements FASTA protéiques, d’ADN ou d’ARN ou plus avec Clustal Omega d’EMBL-EBI et récupérez un fichier d’alignement téléchargeable. (#2944)
- Les modèles GPT-6 et Claude Opus 5.5 rejoignent les catalogues de fournisseurs. (#2967)
- Les conversations de l’espace de travail peuvent inclure des preuves PDF avec le premier message, si bien que l’agent voit le matériel source avant de commencer. (#2941)
- Les diagnostics de session peuvent inclure des preuves de paquets sensibles lorsque vous y consentez explicitement, offrant un contexte plus approfondi pour le dépannage. (#2947)
- Les collections de littérature distinguent désormais leurs portées et les relient, si bien que les collections personnelles et partagées sont clairement séparées et connectées. (#2938)

## 🔧 Améliorations

- L’en-tête de la section des fournisseurs dans les paramètres gagne une action de fournisseur directe, si bien qu’ajouter ou ajuster des fournisseurs demande moins d’étapes. (#2970)
- Les fichiers de l’espace de travail bénéficient d’icônes de type de fichier unifiées, facilitant le parcours visuel des dossiers mixtes. (#2965)

## 🐛 Corrections

- **Notebook** — les environnements Python gérés sous Windows sont restaurés et le chemin Python géré est activé pendant la découverte, si bien que les environnements gérés par l’application fonctionnent à nouveau sous Windows (#2953, #2951) ; lorsque l’accès à l’environnement d’exécution R est refusé, l’application demande désormais confirmation au lieu d’échouer silencieusement (#2930).
- **Session** — les compétitions de sauvegarde de l’environnement d’exécution et de calcul se récupèrent proprement au lieu de perdre du travail (#2955) ; la poursuite et la divulgation de la révision sont stabilisées (#2950) ; une admission indisponible fait l’objet d’une nouvelle tentative avant abandon (#2943).
- **Pont d’agent** — le pont ACP se reconnecte lorsque la capacité de vision change, si bien que les sessions ne restent plus bloquées après une mise à jour de capacité (#2963).
- **Espace de travail** — le compositeur reste occupé pendant qu’une invite d’agent est active, empêchant les envois accidentels en double (#2836) ; l’identité de l’aperçu PDF est préservée lors du premier envoi (#2948).
- **Paramètres** — les raccourcis de recherche globale et locale sont séparés afin de ne plus entrer en conflit (#2934) ; la copie multilingue des connecteurs est complétée (#2946).
- **Compétences** — les flux de travail de rognage et de révision des figures se comportent à nouveau correctement (#2936).
- **Stockage** — les emplacements de données historiques persistent et sont protégés au fil des mises à niveau (#2865).
- **Paquets et intégration** — les indicateurs de jetons ne sont plus appariés à l’intérieur de mots sans rapport (#2940) ; la marque DeepSeek lors de l’intégration est normalisée (#2939).
- **Interface** — l’infobulle d’édition des annotations est simplifiée (#2966) ; l’installateur Windows signale les échecs de nettoyage avec des diagnostics exploitables (#2952).
