## ✨ Highlights

- **Siete nuevas herramientas de Scientific Connectors abarcan imágenes, vías metabólicas, lípidos, estructuras y modelos de cáncer.** Las nuevas herramientas alcanzan las colecciones de imágenes de The Cancer Imaging Archive (TCIA) y las consultas de vías de KEGG (ambas de activación voluntaria), la regulación molecular de OmniPath, la búsqueda exacta de compuestos de LIPID MAPS, la validación de estructuras de PDBe con correspondencia cruzada de UniChem, las consultas de líneas celulares de cáncer de DepMap y CCLE, y la búsqueda de similitud de estructuras de PDB, todas con descubrimiento desactivado de forma predeterminada y una activación voluntaria persistente por fuente. (#3760, #3799, #3805, #3808, #3815, #3818, #3828)
- **La biblioteca Literature se convierte en una bandeja de entrada de investigación completa.** El descubrimiento de citas de Semantic Scholar expone las referencias de un artículo y los trabajos que lo citan, los archivos adjuntos complementarios de múltiples fuentes se descargan con progreso y vista previa (incluidos documentos de Word), los PDF y los archivos bibliográficos se importan mediante arrastrar y soltar, y los resultados de Smart Screening se exportan como CSV listo para hojas de cálculo. (#3791, #3787, #3776, #3822)
- **Los paquetes de sesión funcionan desde cualquier lugar.** La exportación e importación de `.science` ahora se ejecutan desde la CLI sin interfaz y desde sesiones web locales, no solo desde la aplicación de escritorio. (#3801)
- **Los PDF traducidos incorporan una disposición opcional centrada en el contenido, y los notebooks reciben restricciones de acceso a carpetas.** Las ediciones traducidas pueden refluir el texto del cuerpo y los pies de figura en páginas de una sola columna manteniendo las imágenes, tablas, fórmulas y la bibliografía originales, con correspondencias de página de origen a salida para la comparación. Las restricciones de acceso a carpetas del notebook, activadas de forma predeterminada, mantienen la ejecución del notebook y del shell dentro de las carpetas autorizadas. (#3637, #3800)

## 🚀 New Features

- Herramientas de conector de activación voluntaria de TCIA (colecciones de imágenes de cáncer) y KEGG (vías y fármacos). (#3799)
- Consultas de OmniPath sobre regulación molecular e interacciones de señalización. (#3805)
- Búsqueda exacta de compuestos de LIPID MAPS por identificador o nombre. (#3808)
- Validación de estructuras de PDBe con correspondencia de UniChem a bases de datos químicas conectadas. (#3815)
- Consultas de modelos de cáncer de DepMap y CCLE para datos de dependencia de líneas celulares. (#3818)
- Búsqueda de similitud de estructuras de PDB a partir de un identificador de estructura. (#3828)
- Descubrimiento de citas de Semantic Scholar en Literature, con una clave de API opcional para límites de tasa más altos. (#3791)
- Archivos adjuntos complementarios de múltiples fuentes con progreso de descarga por archivo, extracción de archivos comprimidos de los archivos seleccionados y vistas previas por tipo de archivo, incluidos documentos de Word. (#3787)
- Importación mediante arrastrar y soltar de PDF y archivos bibliográficos en la biblioteca Literature, además de descargas de adjuntos desde la vista de detalle de referencia. (#3776)
- Exportación de los resultados de Smart Screening como CSV, cubriendo todos los candidatos con veredictos finales, decisiones manuales, razones y probabilidades del modelo. (#3822)
- Exportación e importación de paquetes de sesión `.science` desde la CLI sin interfaz y desde sesiones web locales. (#3801)
- Opción de disposición centrada en el contenido para PDF traducidos, desactivada de forma predeterminada y recordada por edición de traducción. (#3637)
- Restricciones de acceso a carpetas del notebook, activadas de forma predeterminada en nuevas instalaciones, que confinan la ejecución del notebook y del shell a carpetas autorizadas. (#3800)
- Las herramientas de archivos locales pueden enumerar los directorios autorizados bajo demanda, de modo que los agentes reutilizan las concesiones de carpeta existentes en lugar de volver a preguntar. (#3767)
- Los modelos del proveedor Kimi K3.1 Pro están disponibles para su selección. (#3835)

## 🔧 Improvements

- Las transferencias de paquetes de sesión mueven más datos de forma predeterminada, y la importación omite las pasadas de verificación repetidas, de modo que los archivos grandes terminan antes. (#3782, #3780)
- El análisis de anotaciones y estructura de PDF es más rápido en documentos grandes. (#3825, #3831)
- Los cambios de Specialist muestran progreso mientras se carga el nuevo especialista. (#3778)
- Los editores de ajustes bloquean sus campos mientras guardan y protegen los borradores sin guardar en las pantallas de Memory, Tags y credenciales. (#3781, #3849)

## 🐛 Bug Fixes

- Windows: el registro del protocolo `open-science` está restaurado, el host del notebook se reconstruye antes del arranque en configuraciones de desarrollo, y los paquetes de sesión recalculan el hash del contenido correctamente en Windows. (#3777, #3843, #3829)
- La recuperación de sesiones ahora sobrevive a los fallos de modelo, y los archivos de conversación dañados pueden eliminarse en lugar de bloquear la recuperación. (#3740, #3804)
- El cambio de Specialist se recupera de ciertos rechazos del proveedor sin perder la conversación, y los fallos de capacidad se distinguen de los enlaces no disponibles. (#3772, #3796)
- El compositor cambia correctamente entre detener y envío en cola. (#3768)
- Paquetes de sesión: el código de investigación ya no provoca falsos positivos de credenciales, y la exportación se reanuda correctamente tras un reconocimiento de contenido sensible. (#3817, #3846)
- Sandbox de red del notebook: las aprobaciones persisten entre reinicios, se aceptan reglas comodín y entrada de URL, el enrutamiento por proxy nativo está activado, y los límites del sistema de archivos y del proxy se mantienen aplicados. (#3830, #3826, #3827, #3841)
- El análisis del notebook conserva el linaje a través de efectos científicos encadenados, los códigos de salida del shell con signo sobreviven, las sondas de protección ya no ralentizan el arranque de la sesión, y las búsquedas del shell permanecen dentro del sandbox del sistema de archivos. (#3812, #3851, #3839, #3788)
- El manejo de PDF excluye el texto recortado y las referencias de figura envueltas del análisis de estructura, robustece la propiedad de figuras, tablas y lector, y simplifica las vistas previas de una sola página. (#3795, #3814, #3816)
- La recuperación de escritorio resuelve defectos reproducidos de título, reintento y protección. (#3823)
- Los argumentos de la sonda de suscripción de Claude se conservan en los ajustes. (#3837)
- Los servicios no relacionados se excluyen de la limpieza de procesos del runtime. (#3797)
- Las importaciones del navegador conservan los reintentos a través de la suspensión. (#3770)
