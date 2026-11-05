## ✨ Highlights

- **La configuración se reorganiza en pestañas especializadas.** Las preferencias generales se dividen en pestañas dedicadas: Apariencia y Notificaciones pasan a la configuración de Sistema, mientras que General ahora muestra información de la aplicación, diagnósticos, herramientas de línea de comandos y recursos de ayuda — incluido un enlace directo a la guía de instalación y actualización manual — sin tener que buscar. (#4022)
- **Importe referencias por lotes desde DOI, arXiv o PubMed.** Añadir desde DOI o enlace ahora acepta hasta 100 identificadores mixtos por importación — DOI, ID de arXiv, PMID, PMCID o enlaces oficiales de artículos — normalizándolos y deduplicándolos antes de la revisión habitual y del guardado transaccional. (#4039)
- **Resúmenes de estudio con IA para la literatura.** La vista de detalle de la biblioteca Literature incorpora una tarjeta de resumen de IA que condensa un artículo en cinco secciones estructuradas — pregunta de investigación, población de estudio, métodos, hallazgos principales y limitaciones — generada con su modelo principal configurado a partir del texto completo o del resumen, e indicando cuál de los dos utilizó. (#4037)
- **Las sesiones finalizadas liberan sus procesos de agentes.** Las sesiones completadas en los cinco frameworks de agentes ya no acumulan procesos de proveedor y de herramientas en memoria: los runtimes compartidos de revisión, los leases de traspaso reemplazados y los intentos de limpieza fallidos se liberan o reintentan hasta confirmarse, de modo que las jornadas largas con muchas sesiones siguen siendo fluidas. (#4046, #4054, #4061)

## 🚀 New Features

- Tencent TokenHub incorpora el modelo de razonamiento Hy4 y las rutas actuales de DeepSeek V4.1 Flash con ventanas de contexto de 1.000.000 de tokens, así como entrada de imágenes para GLM-5.3-Flash, Kimi K3 y MiniMax M3. (#4060)

## 🔧 Improvements

- Las consultas de eQTL Catalogue vuelven a funcionar tras la retirada de la API REST original, usando archivos indexados, y ahora validan que las coordenadas usen el ensamblaje GRCh38 en lugar de devolver silenciosamente coincidencias engañosas. (#4036)
- El orden de lectura y la extracción de PDF son más fiables: el orden automático usa evidencia de texto posicionado para distinguir columnas de prosa de filas de tabla, los límites de recorte se verifican contra la fuente nativa, las celdas de tabla ambiguas conservan su texto original con un aviso de fiabilidad, y el worker de PDF de Windows ya no falla durante el cierre. (#3994, #4056)
- Los diálogos de actualización ahora nombran el proceso que bloquea en lugar de imprimir rutas completas del sistema, y los fallos de recuperación del escritorio conservan su evidencia de error real en los paquetes de diagnóstico y los registros en lugar de informar solo de un fallo genérico. (#4047, #4045)
- La cobertura de reproducción de los análisis en R es más honesta: las llamadas científicas que pueden forzar argumentos o despachar métodos ahora revocan las pruebas de archivo obsoletas, de modo que la verificación posterior ya no exagera de qué archivos dependió un resultado. (#4052)

## 🐛 Bug Fixes

- Las actualizaciones en macOS ya no se bloquean por poseedores de archivos ordinarios de solo lectura como el agente StoreKit, y Windows ya no clasifica erróneamente como extraños los procesos del propio backend de la aplicación durante la preparación de la actualización. (#4028)
- La inspección de actualizaciones de Windows ya no informa de ocupación desconocida cuando faltan herramientas del sistema en PATH o los análisis se alargan, y los recibos obsoletos de Notebook ya no bloquean la recuperación tras la reutilización de un identificador de proceso. (#4042)
- Una descarga guardada ya no termina con un error de permiso cuando el propio directorio de destino no es legible; el archivo completado se conserva. (#4053)
- Las herramientas de línea de comandos de Notebook en el sandbox recurren al runtime de Node de la propia aplicación cuando la versión de PATH es demasiado antigua para usar el proxy configurado, solucionando el acceso a la red dentro del sandbox. (#4058)
- Las comprobaciones de protección de Windows ya no cierran una puerta de enlace compartida sana entre sondeos ni informan de un falso fallo de runtime. (#4029)
- Buscar de nuevo un artículo borra el aviso anterior de «No se pudo añadir el PDF» una vez que la nueva búsqueda tiene éxito. (#4041)
- Pi ahora se instala correctamente en la aplicación de escritorio empaquetada en lugar de fallar al localizar sus archivos de arranque. (#4027)
- El compositor ya no muestra un aviso duplicado de modelo no disponible junto al estado del selector de modelo. (#4051)
- Una descarga de artefacto que finaliza y luego falla al liberar su capacidad ya no escapa como un error no controlado que puede terminar el backend. (#4055)
- Los artefactos de Markdown reparan al abrirse una cabecera de procedencia obsoleta dejada por versiones anteriores, y el panel de procedencia ahora explica explícitamente la evidencia de ejecución incompleta. (#4021)
