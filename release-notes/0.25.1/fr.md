## ✨ Points forts

- **Les noyaux de notebook protégés démarrent directement sous Windows.** Les noyaux Windows démarrent sous le bac à sable réseau sans le chemin de lancement indirect qui pouvait les laisser sans protection ou les empêcher de démarrer. (#2081)
- **Les exports de fichiers sont publiés de façon atomique.** Les fichiers exportés n'apparaissent qu'une fois entièrement écrits, si bien qu'un export en échec ou interrompu ne peut plus laisser un fichier partiel derrière lui, et les exports de paquet conservent des horodatages valides quel que soit le fuseau horaire. (#2070, #2072)
- **Les aperçus des images générées sont rétablis.** Les images que l'agent génère affichent de nouveau leurs aperçus au lieu de revenir à des espaces réservés. (#2082)
- **Les incohérences du catalogue de compétences se rétablissent d'elles-mêmes.** Settings détecte et répare les incohérences du catalogue au lieu de laisser des compétences manquantes ou dupliquées. (#2080)

## 🐛 Corrections

- **Notebook et calcul** — les limites de concurrence des sessions persistent après les redémarrages (#2077) ; la récupération de finalisation d'artefact peut être retentée après une tentative en échec (#2068) ; et les contrats de sélection d'environnement d'exécution périmés ne bloquent plus le démarrage des noyaux. (#2073)
- **Fichiers et artefacts** — le contexte de lecture des PDF conserve l'identité logique du fichier lorsque le fichier sous-jacent est remplacé (#2094) ; et les modifications des détails de session ne s'écrasent plus entre elles avec des données périmées. (#2079)
- **Sessions et persistance** — les combinaisons de récupération de session périmées sont normalisées au démarrage (#2092) ; les tours Task sont admis avant la persistance afin que le travail en file d'attente ne soit pas perdu (#2078) ; et le nettoyage des données associées se rétablit et se poursuit après un échec de suppression. (#2074)
- **Agents et fournisseurs** — l'usage des appels de modèle Claude finalisés est récupéré dans les statistiques d'usage (#2086) ; CodeBuddy préserve les arguments de commande vides sous Windows (#2089) ; et les paquets Spécialiste se rétablissent après des interruptions avec des indications claires sur leur origine. (#2076)
- **Espace de travail et paramètres** — l'application nettoie les écouteurs du cycle de vie du renderer qui pourraient s'accumuler au fil des longues sessions (#2083) ; et les incohérences du catalogue de compétences sont détectées et réparées automatiquement. (#2080)
