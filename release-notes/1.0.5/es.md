## ✨ Highlights

- **Los conectores científicos llegan a las API nativas de las fuentes.** Europe PMC incorpora búsqueda booleana directa, básica y por resumen con paginación explícita, junto con nuevos metadatos de genes HGNC, rangos de enriquecimiento de ChEA3, conversiones y ortología de bioDBnet, consultas al grafo de conocimiento RDF de Cellosaurus, similitud de STR y descubrimiento oficial de archivos para NHANES, PhysioNet, openFDA y CTD; todo es opt-in y devuelve URL oficiales con procedencia en lugar de descargas opacas. Las consultas y los identificadores que envíes —términos de búsqueda, nombres de genes, DOI— se transmiten a los servicios públicos correspondientes, y las fuentes con acceso restringido se enumeran únicamente con instrucciones oficiales de acceso; la aplicación nunca afirma tu autorización. (#3869)
- **Sigue el progreso de lectura en la biblioteca Literature.** Las referencias pueden marcarse como No leído, En progreso o Lectura finalizada; el estado aparece en una columna dedicada, se edita en línea o desde la página de detalles, se actualiza en bloque entre páginas y exclusiones, y filtra la biblioteca con recuentos coherentes y ámbito de selección. (#3897, #3907)
- **Los paquetes de sesión funcionan en el navegador.** Las implementaciones web locales pueden exportar un paquete `.science` como descarga e importar uno a través de un selector de carga, sin necesidad de recurrir a la CLI al trabajar completamente en el navegador. Un paquete exportado contiene las conversaciones, los archivos, los registros del notebook y la procedencia que seleccionaste, y las transferencias en el navegador se ejecutan entre tu navegador y tu propio servicio local. (#3911)
- **El tiempo de vida del servicio sigue tu intención.** Mantener la aplicación abierta o ejecutar `open-science start` mantiene vivo el servicio local; cerrar una ventana ya no lo detiene ni interrumpe el trabajo en segundo plano no relacionado. `stop` sin argumentos libera tu retención, y `stop --force` solicita el apagado de todo el servicio. Mientras una retención está activa, el servicio y su trabajo en segundo plano siguen ejecutándose hasta que liberes la retención o fuerces el apagado. (#3769)

## 🚀 New Features

- La página de inicio incorpora una galería de casos de uso: explora ejemplos publicados, abre sus detalles e importa un paquete de sesión verificado con progreso de descarga y cancelación. (#3901)
- Puntos de entrada manuales para actualizaciones: enlaces persistentes de descarga e instrucciones en Ajustes y las superficies de actualización, más un comando de solo lectura que revela el instalador confirmado. (#3902)
- Ajustes → Acerca de enlaza a la política de seguridad del proyecto. (#3906)
- Los directorios autorizados se muestran como una lista compacta de carpetas con insignias de lectura/escritura y descripciones emergentes del momento de la concesión, en lugar de JSON en bruto. (#3871)

## 🔧 Improvements

- Los informes DOCX conservan los estilos de tabla, bordes y diseño de página previstos durante la generación y la vista previa, y hay disponible bajo demanda un flujo de conversión de Markdown a DOCX mantenido y basado en plantillas. (#3811)
- Los resultados de la comprobación de publicación presentan una única acción breve con atribución a Crossref y hora de la última comprobación. (#3896)
- La página de detalles de referencia consolida las etiquetas y el tipo en el encabezado, eliminando las explicaciones repetitivas. (#3910)
- Las superficies de paquete de sesión importado y de replay eliminan los diagnósticos redundantes y otorgan a sus acciones límites coherentes y visibles. (#3908)
- Las solicitudes de R gestionadas en Windows para paquetes de Bioconductor ahora explican la ruta explícita de BiocManager en lugar de fallar con un error genérico de Conda. (#3918)

## 🐛 Bug Fixes

- Las sesiones de acceso completo admiten destinos de red pública sin diálogos de aprobación, y bajar de nivel de Full cierra las conexiones existentes. (#3898)
- Ajustes → Red refleja inmediatamente las concesiones de dominios globales realizadas desde los diálogos de aprobación. (#3900)
- Los runtimes de OpenCode 2.x vuelven a arrancar y funcionar, manteniendo la ruta de la 1.x. (#3903)
- Los notebooks de macOS encuentran herramientas de CLI cuyo runtime de Node reside fuera del PATH heredado de la aplicación. (#3916)
- Los chats en Windows ya no esperan a la configuración de protección antes de que se inicie una solicitud al proveedor. (#3922)
- Los notebooks leen los archivos de referencia de skill gestionados por la aplicación sin diálogo de acceso a carpetas. (#3920)
- Al contraer grupos de herramientas se conserva tu posición de lectura. (#3873)
- Las tablas Markdown anchas revelan su barra de desplazamiento al pasar el cursor y con el foco del teclado. (#3875)
