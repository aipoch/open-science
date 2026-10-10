## ✨ Lo más destacado

- **Backend independiente en Node.** Los servicios compartidos detrás del escritorio, la web, la CLI y el Notebook ahora se ejecutan en un proceso Node normal — la línea de comandos y el modo sin cabeza ya no necesitan un host Electron sin ventana, la aplicación de escritorio se conecta como cliente nativo y los backends de escritorio eligen automáticamente un puerto libre. (#3358, #3393)
- **Alcance de conectores.** Un nuevo conector ENCORI integrado aporta evidencia de interacciones miRNA–diana y ARN–ARN, ChEMBL añade detalles de ensayo y paginación de bioactividad, y ClinVar añade evidencia de envíos individuales. (#3376, #3343, #3361)
- **Fidelidad para PDF científicos.** La traducción de PDF conserva el orden de lectura nativo, las etiquetas ActualText anidadas se verifican correctamente y la extracción de estructura mantiene las figuras propias de la fuente y los registros de tabla completos. (#3360, #3348, #3370)
- **Aprobaciones y captura más tranquilas en el Notebook.** Los entornos de ejecución predeterminados listos ya no preguntan dos veces, los entornos mixtos se reportan con precisión y los metadatos de compilación de paquetes permanecen visibles. (#3380, #3398, #3385)

## 🚀 Novedades

- Backend independiente en Node para los servicios compartidos — `open-science start` se ejecuta sin Electron y la aplicación de escritorio se conecta como cliente nativo (#3358)
- Conector ENCORI con diez herramientas para dianas de miRNA, interacciones ARN–ARN, evidencia regulatoria, tablas de referencia y conjuntos de datos masivos (#3376)
- El conector de ChEMBL gana detalles de ensayo y paginación de bioactividad más allá de los primeros 1 000 registros (#3343)
- El conector de ClinVar gana evidencia de envíos individuales para comparar las clasificaciones de los remitentes (#3361)
- Estado vacío en Inicio con orientación y una acción para crear proyecto (#3371)

## 🔧 Mejoras

- Entornos del Notebook: captura precisa de entornos mixtos de Conda/pip, metadatos de compilación de micromamba conservados en la tabla de paquetes, y dependencias de devoluciones de llamada y linaje de archivos de entrada endurecidos (#3398, #3385, #3369)
- Las credenciales de Linux dejan de sondear el backend Secret Service tras la primera operación de secreto, evitando salidas de recuperación fatales espurias (#3389)
- La aprobación y el descarte del plan de sesión ya no interfieren con la recuperación de la ejecución (#3366)

## 🐛 Correcciones

- Los backends de escritorio asignan un puerto libre, corrigiendo los fallos de inicio cuando ya hay otro backend en ejecución (#3393)
- La detección de Python en Windows ya no malinterpreta rutas de intérpretes con espacios o paréntesis (#3362)
- El tiempo de ejecución de escritorio conserva el perfil de backend seleccionado en Windows (#3395)
- Importar un paquete `.science` en un proyecto nuevo ya no falla durante la adopción del catálogo (#3379)
- Las colecciones inteligentes reanudan y reintentan el lote fallido en lugar de empezar de nuevo (#3351)
- Codex recupera los argumentos de herramientas MCP transmitidos que llegan vacíos en la llamada completada (#3349)
- Cambiar de Especialistas en Windows ya no deja un traspaso aprobado pendiente y bloqueando peticiones posteriores (#3388)
