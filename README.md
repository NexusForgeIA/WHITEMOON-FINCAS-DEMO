# WHITEMOON-FINCAS-DEMO

Demo comercial de **WhiteMoon Agencia IA** para administradores de fincas:
un agente que atiende al propietario aplicando **el protocolo de SU comunidad**,
y un panel CRM donde el administrador ve los expedientes y decide sobre los
presupuestos.

**Demo en vivo:** https://nexusforgeia.github.io/WHITEMOON-FINCAS-DEMO/

> Datos ficticios. NetFincas y la telefonía están **simulados** y así se
> anuncia en la propia página.

---

## La prueba que se enseña en la reunión

Escribe **la misma frase** —"el ascensor está parado"— en las dos comunidades:

| Comunidad | Proveedor que se activa | Protocolo citado |
|---|---|---|
| Madrid 1 | Ascensores **OTIS** — contrato Madrid 1 | *Manual de incidencias · Comunidad Madrid 1 · §3.1 Ascensores* |
| Madrid 2 | Ascensores **DELTA** — contrato Madrid 2 | *Manual de incidencias · Comunidad Madrid 2 · §4.2 Ascensores* |

Mismo texto, misma IA, respuesta distinta: porque la decisión no la toma el
modelo, la toma la tabla de protocolos de esa comunidad.

---

## Sin embeddings

No hay vectores, ni Voyage, ni base vectorial. El "RAG" de protocolos son dos
cosas mucho más baratas y mucho más auditables:

1. **Datos estructurados por comunidad** — `fincas_protocolos` guarda, para
   cada comunidad, cada categoría y cada subtipo: proveedor asignado,
   teléfono, urgencia por defecto, pasos y la cita del manual.
2. **Búsqueda de texto de Postgres** (`tsvector` en español, índice GIN) para
   cuando el vecino no usa la palabra exacta: "se ha quedado tirado el
   elevador" encuentra igualmente el protocolo de ascensores.

Claude (`claude-haiku-4-5-20251001`) hace lo que sabe hacer: conversar,
clasificar y llamar a las herramientas. Lo que se le enseña al usuario —el
proveedor, el teléfono, la cita— sale de la base de datos, no del modelo.

---

## Cómo se garantiza que una comunidad no ve la otra

Tres capas, de dentro afuera. No se confía en el prompt.

1. **SQL.** `fincas_buscar_protocolo(p_comunidad, p_consulta)` lleva
   `where comunidad_id = p_comunidad` cableado. Si llega nulo, la comparación
   es nula y devuelve **cero filas**: falla cerrada. No existe una forma de
   pedir "todos los protocolos".
2. **Servidor.** `fincas-chat` mantiene una `comunidadActiva`. La herramienta
   `buscar_protocolo` declara `comunidad_id` en su esquema, pero antes de
   tocar la base se compara con la comunidad activa: si no coincide, se
   **rechaza la llamada**, se le devuelve el error al modelo y queda anotado
   en `fincas_auditoria` como `protocolo_denegado`.
3. **Al releer.** Al abrir el expediente, el protocolo se vuelve a leer
   filtrando por comunidad, y la cita y el proveedor que se guardan salen de
   esa fila — nunca de lo que haya dicho el modelo.

La comunidad activa sólo se fija de dos maneras: el selector de la web, o
resolver un inmueble real con `buscar_inmueble`. Nunca por deducción.

Las dos funciones de la demo llevan además `search_path = pg_catalog, public`
fijo. Tener el filtro por comunidad cableado no serviría de nada si
`fincas_protocolos` pudiera resolverse a otra tabla porque quien llama tenga
otro esquema por delante en su search_path.

---

## La IA prepara; el administrador decide

Los presupuestos entran en estado `pendiente` y se quedan ahí. El agente **no
adjudica ni emite**. Aprobar o rechazar:

- lo hace una persona desde el panel,
- se escribe por la Edge Function `fincas-presupuesto` con service role
  (el rol `anon` **no tiene policy de UPDATE**: aunque alguien manipule el JS
  desde la consola del navegador, no puede aprobar nada),
- y queda registrado en `fincas_auditoria`, que es **append-only** por trigger:
  `UPDATE` y `DELETE` levantan excepción incluso con service role.

---

## Arquitectura

```
index.html                     una sola página, dos vistas
assets/css/estilo.css          paleta WhiteMoon, sin frameworks
assets/js/config.js            cliente Supabase (anon) + utilidades
assets/js/chat.js              vista del propietario
assets/js/panel.js             kanban, ficha y cola de aprobación (realtime)
assets/js/app.js               conmutador de vistas
supabase/migrations/           esquema, RLS y seed
supabase/functions/            las tres Edge Functions
```

### Base de datos (proyecto `mlaqtniujnvfxcvcourm`)

| Tabla | Para qué |
|---|---|
| `fincas_comunidades` | las dos comunidades de la demo |
| `fincas_inmuebles` | viviendas y propietarios |
| `fincas_protocolos` | **el corazón**: qué hace cada comunidad ante cada caso |
| `fincas_proveedores` | catálogo por comunidad |
| `fincas_expedientes` | incidencias, con `ref` EXP-AAAA-NNNN |
| `fincas_presupuestos` | cola de aprobación (`pendiente`/`aprobado`/`rechazado`) |
| `fincas_auditoria` | append-only, quién hizo qué |

RLS activo en todas: `anon` sólo puede `SELECT`. Todas las escrituras van por
Edge Functions con service role.

### Edge Functions (`verify_jwt: false`, CORS abierto)

| Función | Qué hace |
|---|---|
| `fincas-chat` | Claude + 4 herramientas: `buscar_inmueble`, `buscar_protocolo`, `crear_expediente`, `crear_parte_proveedor` |
| `fincas-notify` | aviso por Telegram: `🏢 EXP-… · {comunidad} {puerta} · {subtipo} · {proveedor} avisado` |
| `fincas-presupuesto` | única vía por la que un presupuesto cambia de estado |

Secrets (nunca en el repo ni en el cliente): `ANTHROPIC_API_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

---

## Guion de la demo

1. **Chat del propietario**, comunidad **Madrid 1** → "el ascensor está
   parado". Nora pregunta si hay alguien atrapado y la tarjeta lateral ya
   enseña el protocolo de Madrid 1 con OTIS.
2. Responder "no, no hay nadie dentro". Se abre el expediente
   `EXP-AAAA-NNNN`, se da parte a OTIS y se cita la sección del manual.
3. Cambiar el selector a **Madrid 2** y repetir *la misma frase*. Ahora es
   **DELTA** y la cita es la del manual de Madrid 2.
4. Probar un caso sin protocolo ("plaga de cucarachas"): Nora **no se lo
   inventa**, lo escala al equipo.
5. **Panel del administrador**: los expedientes recién abiertos aparecen en
   el kanban en tiempo real. Abrir la ficha y enseñar el *protocolo citado*.
6. Aprobar el presupuesto de 800 € y explicar que la IA nunca adjudica sola.

---

WhiteMoon Agencia IA · Majadahonda, Madrid · [whitemoon.es](https://whitemoon.es)
