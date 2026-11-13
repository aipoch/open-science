## ✨ Highlights

- **Red de Notebook en modo estricto.** Un modo Strict opcional reemplaza las ofertas de autorización con una lista blanca gestionada manualmente: una solicitud solo se permite cuando coincide con sus reglas por protocolo, nombre de host o IP y puerto; las solicitudes sin coincidencia se bloquean directamente. El modo Relaxed sigue siendo el predeterminado y conserva el comportamiento de aprobación existente. (#4253)
- **Las películas de investigación se reanudan desde puntos de control.** La generación interrumpida continúa con el trabajo validado intacto: las escenas completadas, la narración, los tiempos y la mezcla se reutilizan entre reinicios del proceso, el diálogo muestra el paso actual de cinco, y usted elige entre reanudar o generar de nuevo. (#4290)
- **Fidelidad de ida y vuelta de los PDF.** Los PDF externos recuperan figuras nativas completas, pies de figura, registros de tablas y orden de lectura, y los documentos traducidos conservan la estructura y el diseño originales en lugar de recurrir a una colocación no demostrada. (#4300, #4342, #4340, #4334, #4286)
- **Concesiones y actualizaciones más seguras en Windows.** Las concesiones de carpetas en modo protegido se validan antes de guardarse; los flujos de actualización, desinstalación y entrega se recuperan con más fiabilidad, indican qué los bloqueó y conservan sus diagnósticos. (#4217, #4305, #4327, #4328, #4337, #4346)
- **Actualización del catálogo de proveedores.** Qwen4 Max Preview se suma a Bailian Token Plans en Pekín y Singapur con una ventana de contexto de 1M, y los modelos predeterminados de las conexiones oficiales se actualizan. (#4311, #4301)

## 🚀 New Features

- Cambie la red de Notebook al modo Strict: las solicitudes deben coincidir con una lista blanca gestionada manualmente por protocolo, nombre de host o IP y puerto, y las solicitudes sin coincidencia se bloquean sin ofrecer autorización. Gestione las reglas como grupos lógicos editables con etiquetas de procedencia; los destinos integrados preexistentes se inicializan una vez y los cambios persisten. Revise las reglas inicializadas antes de confiar en el modo, ya que las solicitudes bloqueadas fallan en lugar de preguntar. (#4253)
- Reanude la generación interrumpida de una película de investigación desde puntos de control validados: los asistentes y escenas completados sobreviven a un fallo posterior, la narración y los tiempos se almacenan en caché de forma independiente de la compilación del reproductor, y el diálogo de la película muestra el paso actual de cinco con opciones explícitas de reanudar o generar de nuevo. (#4290)
- Compruebe de antemano las concesiones de carpetas de Windows en modo protegido con una verificación de ACL de solo lectura antes de guardar: las carpetas inutilizables se rechazan con su motivo antes de escribir ninguna concesión, de modo que la ejecución de Notebook ya no falla más tarde con un error oculto de inicio del kernel. (#4217)
- Seleccione Qwen4 Max Preview de Bailian Token Plans en Pekín y Singapur: ventana de contexto de 1M, entrada multimodal y esfuerzos de razonamiento low/medium/xhigh, resueltos a través del selector de región y la consola de claves existentes. (#4311)

## 🔧 Improvements

- La recuperación de la estructura de PDF externos conserva figuras completas con sus pies de figura, registros y celdas de tablas, y el orden de lectura nativo en línea en torno a texto escalado y encabezados de página. (#4300, #4342, #4340)
- Los PDF traducidos conservan la estructura y el diseño nativos: la colocación exige evidencia verificada de propiedad del destino, y el contenido original se conserva siempre que la colocación no pueda demostrarse. (#4334, #4286)
- Las importaciones de paquetes de sesión informan de su resultado: la cancelación devuelve un resultado distinto de cero, los tiempos de espera de solicitudes se marcan como no confirmados con un consejo de comprobar antes de reintentar, y los archivos que faltan o los archivos dañados reciben códigos de error distintos con un ID de correlación de registro. (#4338)
- Los modelos predeterminados de las conexiones oficiales de proveedores se actualizan a las recomendaciones actuales. (#4301)
- Las superficies de vista previa se adaptan a diseños móviles. (#4325)
- Una raíz de datos configurada puede direccionarse a través de alias registrados. (#4306)
- El CLI local mantiene intactos los perfiles de credenciales, tolera fallos de la consola y mantiene vivas las descargas de artefactos mientras llegan los datos. (#4298, #4299)

## 🐛 Bug Fixes

- Cuando el escritorio pierde su servicio local, una superficie de recuperación de toda la ventana ahora bloquea la interacción con el espacio de trabajo hasta que la conexión vuelve, manteniendo los borradores montados y restaurando el foco después. (#4323)
- Los flujos de actualización y desinstalación de Windows separan la seguridad de la actualización de la limpieza de registros, examinan los recursos físicos de instalación, eliminan los asistentes propios antes de la entrega, cancelan las comprobaciones del host con prontitud, identifican los procesos por identidad de nacimiento en lugar de solo por PID y conservan los diagnósticos de fallo. (#4305, #4327, #4328, #4337, #4346)
- Los trabajos de kernel de Windows interrumpidos se recuperan, y la redirección de stderr de PowerShell ya no se traga la salida nativa de Notebook. (#4297, #4295)
- La persistencia de sesiones evita interbloqueos de limpieza por borrado y desacopla la hidratación de inicio de los guardados activos. (#4312, #4314)
- Los errores del runtime del agente distinguen los fallos del proveedor del modelo de los fallos de ACP, las sesiones recargadas permanecen protegidas hasta la activación del prompt, y los prompts cancelados interrumpen las búsquedas de clasificación. (#4322, #4283, #4289)
- Las concesiones de carpetas guardadas no relacionadas ya no bloquean el inicio de Notebook. (#4309)
- Las vistas previas mantienen el contenido en su lugar durante las comprobaciones de versión. (#4293)
- La cancelación directa de trabajos SSH acota los intentos de cancelación no confirmados. (#4313)
- El contraste se conserva en superficies claras y oscuras, incluidos los avatares en modo oscuro, la entrada de reproducción y las transiciones de tema. (#4345, #4339, #4332)
- El escritorio se cierra tras el primer error no capturado del proceso principal en lugar de continuar en un estado roto. (#4316)
- El estado de revisión del entorno se formula de forma distinta de otros estados de revisión, y las entradas de literatura aceptan listas de paquetes LaTeX con espaciado flexible. (#4347, #4303)

## 🙏 Agradecimientos

- Gracias a [@roxi3906](https://github.com/roxi3906) por el modo de lista blanca estricto de Notebook ([#4253](https://github.com/aipoch/open-science/pull/4253)) y las correcciones de presentación de código arriesgado ([#4318](https://github.com/aipoch/open-science/pull/4318), [#4282](https://github.com/aipoch/open-science/pull/4282)).
- Gracias a [@ShuangChenyue](https://github.com/ShuangChenyue) por la comprobación previa de concesiones de carpetas de Windows ([#4217](https://github.com/aipoch/open-science/pull/4217)).
- Gracias a [@liyeshunag](https://github.com/liyeshunag) por las correcciones de perfiles de credenciales del CLI ([#4298](https://github.com/aipoch/open-science/pull/4298)) y el manejo de prompts cancelados ([#4289](https://github.com/aipoch/open-science/pull/4289)).
- Gracias a [@cyj1116](https://github.com/cyj1116) por las superficies de vista previa móviles ([#4325](https://github.com/aipoch/open-science/pull/4325)) y las correcciones de descarga de artefactos ([#4299](https://github.com/aipoch/open-science/pull/4299)), a [@wen2zhou](https://github.com/wen2zhou) por los límites de cancelación SSH ([#4313](https://github.com/aipoch/open-science/pull/4313)) y la preservación de la salida de PowerShell ([#4295](https://github.com/aipoch/open-science/pull/4295)), a [@liguohhh](https://github.com/liguohhh) por la protección de sesiones recargadas ([#4283](https://github.com/aipoch/open-science/pull/4283)), a [@nasus2002](https://github.com/nasus2002) por el análisis de literatura LaTeX ([#4303](https://github.com/aipoch/open-science/pull/4303)), a [@guch96](https://github.com/guch96) por la persistencia de sesiones ([#4314](https://github.com/aipoch/open-science/pull/4314)) y a [@daanveer-tech](https://github.com/daanveer-tech) por las actualizaciones del README ([#4292](https://github.com/aipoch/open-science/pull/4292), [#4294](https://github.com/aipoch/open-science/pull/4294), [#4324](https://github.com/aipoch/open-science/pull/4324)).
