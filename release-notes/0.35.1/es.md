## ✨ Lo más destacado

- **Expansión de conectores.** El descubrimiento de estadísticas resumidas GWAS se une al conector de genética humana, InterProScan gana el envío de secuencias y el conector IEDB añade búsquedas de evidencia de receptores. (#3278, #3280, #3304)
- **Un mejor comienzo.** La pantalla de nueva conversación unifica los iniciadores de investigación con el compositor, y el encabezado de sesión gana un menú de acciones comunes. (#3297, #3267)
- **Proveedor Requesty.** Requesty se une al selector oficial de proveedores con un catálogo de modelos curado. (#3114)

## 🚀 Novedades

- Descubrimiento de estadísticas resumidas GWAS en el conector de genética humana: localiza archivos completos de estadísticas resumidas, metadatos e información del genoma de referencia de un estudio. (#3278)
- El conector de InterProScan gana el envío de secuencias con límites, completando el flujo de trabajo de envío → estado → resultados sin creación manual de trabajos. (#3280)
- El conector IEDB gana búsquedas de evidencia de receptores TCR y BCR junto a la búsqueda de epítopos y ensayos. (#3304)
- Nueva experiencia de inicio de conversación: los iniciadores de investigación siguen a un clic mientras se redacta, con una opción compacta de importación de paquetes. (#3297)
- El menú del encabezado de sesión agrupa las acciones comunes: editar y fijar la sesión, iniciar un chat lateral o una bifurcación, exportar la conversación, el paquete de sesión o los diagnósticos, y archivar. (#3267)
- Proveedor Requesty en el selector oficial de proveedores, con catálogo de modelos curado y validación de conexión integrada. (#3114)

## 🔧 Mejoras

- Las pestañas y la barra de herramientas del chat lateral siguen la disposición compacta del espacio de trabajo. (#3275)
- Los catálogos de modelos de OpenRouter y Requesty se actualizan. (#3276)

## 🐛 Correcciones

- **Reproducción y sesiones** — el desplazamiento de seguimiento y las preguntas sobre archivos grabados se conservan en la reproducción (#3292); las sesiones importadas mantienen sus interacciones históricas de solo lectura (#3269); el compositor conserva su contexto cuando cambia la vinculación de la sesión (#3306).
- **Notebook y tiempos de ejecución** — el linaje de archivos del notebook entre lenguajes se proyecta correctamente (#3296); los documentos de ejecución corruptos se aíslan sin bloquear la recuperación (#3294); los entornos de R se conservan cuando las rutas del proyecto contienen espacios (#3290).
- **PDF y vista previa** — la extracción de maquetación de literatura se endurece para artículos externos complejos (#3286); el contexto del PDF persiste antes de que se admita el primer mensaje (#3270); las notas verificadas de PDF se unifican entre proyectos (#3264); se reducen los avisos persistentes del lector (#3274).
- **Agentes y permisos** — los ajustes de inicio de sesión compartido se aíslan por defecto (#3289); las denegaciones de permisos de Claude desatendidas se explican en el espacio de trabajo (#3287).
- **Espacio de trabajo y fiabilidad** — la barra de título se mantiene por encima de las superposiciones y fuera de las superficies portaladas (#3285, #3307); los iconos del compositor del chat lateral y de lectura se alinean (#3301); los iconos del encabezado de sesión ya no se solapan (#3279); los marcadores no resueltos se gestionan y los resaltados de la vista previa se aclaran (#3272); las transacciones de artefactos caducadas se reintentan (#3295); la puntuación entre comillas ya no activa falsos positivos de credenciales (#3271); los fallos de creación de marcadores se diagnostican con su etapa de fallo (#3273).
