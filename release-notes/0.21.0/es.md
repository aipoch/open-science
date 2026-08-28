## ✨ Lo más destacado

- **Marco de agente CodeBuddy.** Un cuarto marco de agente seleccionable se suma a Claude Code, OpenCode y Codex: se instala y gestiona desde los ajustes sin un inicio de sesión aparte, funciona con los proveedores de modelos que ya haya configurado, y las habilidades, Notebooks y conectores se enrutan por el mismo entorno gestionado por la aplicación. (#1831, #1849)
- **Anotaciones.** Seleccione texto en la conversación, la actividad de herramientas o las vistas previas de archivos — o un punto en una imagen — y envíelo al agente como contexto. Las anotaciones persisten entre reinicios, se conservan al editar y reenviar, y aparecen como tarjetas en la conversación. (#1815, #1821, #1826, #1837)
- **Catálogos de OpenCode ampliados.** OpenCode Go pasa a 21 modelos y OpenCode Zen a 40, incluidas las últimas familias Claude, GPT, Grok, GLM, DeepSeek, Kimi y Qwen, con metadatos de endpoint, ventana de contexto y razonamiento por modelo. (#1807)
- **Marcadores de cambios de configuración.** Cuando el marco, el modelo o el esfuerzo de razonamiento de una sesión cambia entre turnos, la conversación muestra un separador discreto con la nueva configuración, de modo que las respuestas posteriores tienen una razón visible por qué se leen distinto. (#1825, #1833)

## 🚀 Novedades

- **Marco de agente CodeBuddy** — entorno ACP gestionado por la aplicación, con versión fijada y sin inicio de sesión; se adaptan el redireccionamiento de sesiones, los cambios de modelo y esfuerzo, la compactación, la entrada de imágenes y el uso por llamada, mientras las habilidades, Notebooks y conectores se mantienen en el enrutamiento de la aplicación. (#1831, #1849)
- **Anotaciones de texto e imagen** — anote selecciones en las superficies de conversación, actividad, aclaración y vista previa de archivos; las anotaciones conservan su origen, se revelan a demanda, sobreviven a ediciones y reenvíos, y se serializan en los mensajes del agente y de los chats laterales. (#1815, #1821, #1826, #1837)
- **Catálogos de modelos OpenCode Go y Zen ampliados**, con una anulación de endpoint por modelo para que los modelos con protocolos mixtos se conecten correctamente. (#1807)
- **Autenticación SSH por contraseña en Windows** para hosts de cómputo remoto, con credenciales cifradas en el almacenamiento seguro de Windows. (#1805)
- **Marcadores de cambios de configuración del agente** en la cronología de la conversación. (#1825, #1833)
- **Las filas de carga de habilidades muestran el documento** — al expandir una carga completada se muestran sus instrucciones en Markdown en lugar de JSON sin procesar. (#1812)
- **Mercado de especialistas en cuadrícula de tarjetas**, con fichas de filtrado Oficial, Comunidad y actualizaciones disponibles. (#1840)
- **Centro de mensajes de notificaciones rediseñado** — los iconos codifican a la vez qué ocurrió y si aún requiere su atención, con estados leído/no leído más claros y vistas previas de dos líneas. (#1841)
- **32 iconos de avatar de especialistas adicionales** que cubren ciencia, investigación, roles e ingeniería. (#1838)

## 🔧 Mejoras

- Las solicitudes de permisos de Chromium procedentes del renderizador se deniegan de forma predeterminada, reduciendo la superficie disponible para código de renderizador comprometido. (#1817)
- Los detalles de ejecución persistidos de los trabajos de cómputo remoto se protegen con el almacenamiento seguro del sistema operativo, con una advertencia clara cuando la protección no está disponible. (#1818)
- Los argumentos IPC de cómputo se validan estrictamente antes de usarse. (#1820)
- Los tiempos de espera de solicitudes de conectores ya no se reintentan: una solicitud detenida falla una sola vez con una explicación clara del plazo, en lugar de tres intentos de 30 segundos. (#1829)
- La cancelación de un sondeo de conector surte efecto de inmediato, sin esperar a que expire el intervalo. (#1830)
- Las sesiones del revisor limitan el tamaño de los registros capturados, evitando que una salida de herramienta desmedida ralentice la aplicación. (#1824)
- El aviso de estrella de GitHub respeta un enfriamiento entre proyectos y aparece con mucha menos frecuencia. (#1813)
- Las traducciones al japonés recibieron una revisión de terminología y coherencia. (#1823)
- El error de inicio de los ajustes usa el aviso de error estándar con reintento. (#1835)

## 🐛 Correcciones

- **Cómputo remoto** — una sesión permanece activa mientras sus trabajos remotos siguen ejecutándose, en lugar de mostrarse como completada demasiado pronto (#1803), y los fallos de despacho inesperados se registran con su causa real (#1811).
- **Artefactos** — los archivos generados por tareas/CLI y las continuaciones de delegación conservan su procedencia de ejecución y ya no fallan al finalizar. (#1802, #1810)
- **Sesiones** — las sesiones vacías de Claude creadas por ramificación se pueden eliminar (#1806), y la tarjeta flotante de sesión se alinea con su fila y permite renombrar en línea (#1843, #1845).
- **Ventana de contexto** — cuando los detalles por llamada cubren solo parte del historial tras cambiar de marco o modelo, un aviso en línea revela la cobertura en lugar de ocultar turnos en silencio. (#1828)
- **Notebook** — las carreras de ejecución en cola ya no producen resultados de ciclo de vida inconsistentes, como ejecuciones marcadas como fallidas tras una reparación correcta del entorno o interrupciones duplicadas. (#1832)
- **Planes** — una sesión restaurada que no puede leer su plan muestra un aviso visible de reintento en lugar de omitir la tarjeta del plan en silencio. (#1834)
- **Archivos** — los fallos de eliminación de acceso a directorios y de linaje de artefactos se muestran en línea con reintento en lugar de fallar en silencio. (#1842)
- **Espacio de trabajo** — las vistas previas de archivos se cierran con una sola pulsación de `Cmd/Ctrl+W` (#1804).
