## ✨ Aspectos destacados

- **Detalles de sesión generados y editables.** Las sesiones nuevas reciben un título y una descripción generados automáticamente a partir del primer mensaje, y puede editarlos en cualquier momento. Las tarjetas de Inicio ahora muestran de qué trata cada sesión en lugar de primeras líneas truncadas. (#1721)
- **Información de uso por llamada.** Cuando el framework proporciona suficientes datos, se registran los tokens y la proporción de la ventana de contexto de cada llamada al modelo. La vista Llamadas del diálogo Ventana de contexto se convierte en un gráfico por llamada con detalles fijados y agrupación por turno, modelo o framework. (#1718, #1734, #1740)
- **Importación y exportación de configuraciones de cliente MCP.** Importe el JSON estándar `mcpServers` que usan otros hosts MCP; los archivos con varios servidores permiten elegir uno. Exporte un conector de Open Science o una configuración de cliente MCP; las credenciales y cabeceras exportadas siempre se sustituyen por marcadores `${NAME}`. (#1698)
- **Rehacer borradores del editor.** El atajo estándar para rehacer (`Cmd/Ctrl+Shift+Z`) vuelve a aplicar el estado de borrador deshecho más recientemente y completa el historial unificado que comparten el texto, el texto pegado y los archivos adjuntos. (#1699, #1694)

## 🚀 Nuevas funciones

- **Detalles de sesión generados y editables**: un intento de generación por sesión mediante un ejecutor restringido sin acceso a herramientas, un diálogo de edición con contadores de caracteres que sustituye una generación en curso y un modelo configurable para los detalles de sesión. (#1721)
- **Detalles de uso por llamada al modelo**: registros de llamadas validados y persistidos por turno, con modos Turnos y Llamadas y agrupación en el diálogo Ventana de contexto. (#1718)
- **Gráfico de ventana de contexto por llamada**: barras apiladas de entrada, caché y salida por llamada, un resumen de tres métricas, un panel de detalles fijado, una paleta atenuada del sistema de diseño y filas por turno; la proyección del historial se difiere hasta que se abre el diálogo. (#1734, #1740, #1745)
- **Transferencia de configuración MCP**: importación y exportación de configuraciones estándar de cliente MCP con marcadores de credenciales, selección entre varios servidores y diagnósticos claros para formatos no compatibles. (#1698)
- **Historial para rehacer borradores del editor**, con restauración del cursor y gestión del ciclo de vida de cargas preparadas. (#1699, #1694)
- **Diagnósticos correlacionados de solicitudes HTTP**: cada solicitud web y de tarea recibe un identificador de correlación que vincula los registros de comandos, sesiones y ejecuciones, incluidos los rechazos en los límites. (#1703)

## 🔧 Mejoras

- Zhipu AI (GLM) incorpora el modelo GLM-4.5-Air. (#1762)
- Zhipu AI (GLM) incorpora el modelo GLM-5.3. (#1766)
- Las descargas se validan y los enlaces externos se clasifican de forma coherente antes de abrirse. (#1744)
- Todas las conexiones de red, incluidas las descargas y las solicitudes iniciadas por procesos secundarios, respetan de forma uniforme el modo de proxy configurado. (#1753)
- El cálculo del historial de la ventana de contexto se aplaza hasta que se abre el diálogo, se agrupan las ráfagas de actualización de las instantáneas de notificaciones y se pospone la exploración inicial de las habilidades del usuario, lo que reduce el tiempo de arranque. (#1745, #1702, #1700)
- La persistencia de vistas previas de archivos evita lecturas y escrituras redundantes. (#1747)
- Los errores MCP de Codex registran sus causas subyacentes para agilizar el diagnóstico. (#1736)
- Las importaciones de habilidades de GitHub bloqueadas se pueden cancelar. (#1714)

## 🐛 Correcciones de errores

- **El historial de conversaciones** permanece intacto cuando varios procesos escriben a la vez: se exige la propiedad del grafo antes de las escrituras con autoridad, se conservan los identificadores de framework desconocidos y se validan las proyecciones. (#1746, #1722, #1726)
- **Los turnos interrumpidos** conservan sus registros de uso y las sesiones interrumpidas de Codex se reanudan sin errores por datos vacíos. (#1738, #1706)
- **La computación remota** cancela las aprobaciones pendientes de las sesiones eliminadas y las tareas de sondeo durante el cierre, además de reforzar la coordinación de los trabajos remotos. (#1716, #1737, #1724)
- **Los conectores** conservan las entradas de identificadores escalares, validan los argumentos de las herramientas incluidas, limitan los recursos consumidos al analizar respuestas y restringen las URL de autorización OAuth. (#1754, #1725, #1720, #1695)
- **Los proveedores** orientan los errores de conexión hacia la configuración, y la finalización de artefactos de Responses produce diagnósticos en lugar de fallar silenciosamente. (#1723, #1756)
- **El editor y la cola** ocultan el marcador de posición durante la composición IME e informan de la duración transitoria de la cola. (#1739, #1713)
- **Notebook** documenta la carga de módulos CommonJS, compacta los errores de REPL en el contexto de estado y evita conflictos entre actualizaciones simultáneas de la configuración del entorno de ejecución. (#1755, #1751, #1707)
- **La delegación** valida las solicitudes de delegación antes de admitirlas y aísla los prompts de inferencia restringidos. (#1735, #1732)
- **Las sesiones y los proyectos** conservan las marcas de tiempo de actividad al archivarse, las marcas de tiempo de actualización monotónicas, el ciclo de vida persistido del envío al revisor y las preguntas de aclaración estructuradas en los planes de sesión. (#1719, #1711, #1709, #1701)
- **El acceso remoto** refuerza la autorización de emparejamiento. (#1729)
- **El renderizador** recupera el estado asíncrono de trabajos y proveedores y refuerza las interacciones con el ciclo de vida y los archivos. (#1728, #1743)
- **Elicitation** impone invariantes del esquema para que los formularios de respuesta personalizados sigan siendo válidos. (#1742)
- **Los recursos** aplican límites a los proveedores y a las operaciones con archivos. (#1731)
