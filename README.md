# Equipo Volta · Calendario de tareas del personal

Web de tareas del equipo de Volta Baterías (Ángel, Fernando, Fernando Molleja y Jaime).

- **Hosting:** Netlify.
- **Base de datos:** Airtable, en la base **«Equipo Volta · Tareas»**.

## Qué hace

- **Entrada con código de 6 dígitos.** Cada trabajador solo ve sus tareas. El administrador ve a todo el equipo, crea, edita y arrastra tareas, y cambia los ajustes.
- **Carga de trabajo sobre 40 h semanales**, con un diagrama de plazos que se puede arrastrar.
- **Datos de cada tarea:** prioridad, estado, adjuntos, descripción dictada por voz y tareas repetitivas semanales.
- **Reunión semanal:** acta con acuerdos que se convierten en tareas. Se ve en la hora de Venezuela para Fernando Molleja.
- **PDF de tareas** por persona o de todo el equipo.
- **Botón «✨ Ordenar con IA»**, opcional: reescribe lo dictado como objetivo, pasos, material y precauciones.

## Estructura

```
public/index.html            La web (una sola página)
public/volta-adapter.js      Conecta la página con las funciones de Netlify
netlify/functions/login.mjs  Comprueba el código de 6 dígitos y abre la sesión
netlify/functions/api.mjs    Lee y guarda tareas, repetitivas, actas y ajustes en Airtable
netlify/functions/upload.mjs Sube los adjuntos a Airtable (máx. 4 MB por archivo)
netlify/functions/ai.mjs     IA opcional con la API de Claude
netlify/lib/common.mjs       Código compartido
```

Las comprobaciones de seguridad se hacen en el servidor:

- Los códigos se validan en la función `login`.
- Un trabajador solo recibe sus propias tareas.
- Solo el código de administrador puede guardar cambios.
- El token de Airtable nunca llega al navegador.

## Desplegar en Netlify (una sola vez)

1. En Netlify: **Add new site → Import an existing project → GitHub** y elige `Jaimencinas/CalendarioPersonal`. No hace falta tocar nada de la compilación; `netlify.toml` ya lo indica todo.
2. En **Site configuration → Environment variables**, añade:

   | Variable | Valor |
   |---|---|
   | `AIRTABLE_TOKEN` | Token personal de Airtable (ver abajo) |
   | `AIRTABLE_BASE_ID` | `app2awOrdZtQ3XmSO` (base «Equipo Volta · Tareas») |
   | `SESSION_SECRET` | Una frase larga y aleatoria (por ejemplo, 40 caracteres cualesquiera) |
   | `ANTHROPIC_API_KEY` | *(Opcional)* Clave de la API de Claude para el botón «Ordenar con IA» |
   | `ANTHROPIC_MODEL` | *(Opcional)* Por defecto `claude-sonnet-5-5` |

3. **Deploys → Trigger deploy**. Al terminar, abre la URL del sitio y entra con tu código.

### Token de Airtable

En airtable.com/create/tokens, crea un token con:

- **Permisos (scopes):** `data.records:read` y `data.records:write`.
- **Acceso:** solo la base **«Equipo Volta · Tareas»**.

### Si cambias `SESSION_SECRET`

Todas las sesiones abiertas se cierran y todo el mundo tiene que volver a meter su código.

## Códigos de acceso

Son los mismos que en la versión de Claude. Se cambian desde la web: **Ajustes → Códigos de acceso**, con el código de administrador. En Airtable se guardan como huellas cifradas, en la tabla `Config`, fila `codigos`. No se pueden leer ni editar a mano.

## Tablas de Airtable

- **Tareas:** Título, Trabajador, Estado, Prioridad, Desde, Hasta, Horas, Descripción, Adjuntos, Reunión, Repetitiva.
- **Repetitivas:** tareas semanales que se eligen al crear una tarea.
- **Reuniones:** una fila por fecha con el acta.
- **Archivos:** almacén temporal de lo que se sube desde la web. Se puede vaciar de vez en cuando.
- **Config:** `reunion` (día, hora, duración y nota de la reunión) y `codigos`.

Se pueden editar tareas directamente en Airtable. La web las recoge en menos de un minuto o al recargar.

## Notas

- **Dictado:** funciona en Google Chrome y Microsoft Edge, porque usa el reconocimiento de voz del navegador.
- **Actualización de datos:** la web recarga los datos cada minuto y al volver a la pestaña.
- **Adjuntos:** máximo 4 MB por archivo, por el límite de Netlify Functions.

## Probar en local

```bash
npm i -g netlify-cli
netlify dev   # usa las mismas variables de entorno (netlify env:import o un .env)
```
