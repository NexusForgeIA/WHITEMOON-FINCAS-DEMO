# Whitemoon Fincas

MVP de administración de fincas de **WhiteMoon Agencia IA**: una web pública
donde el vecino cuenta su incidencia en chat libre, y un CRM privado donde el
administrador lleva comunidades, proveedores, expedientes, presupuestos y
facturación.

- **Web y chat del vecino:** https://nexusforgeia.github.io/WHITEMOON-FINCAS-DEMO/
- **CRM (acceso administrador):** https://nexusforgeia.github.io/WHITEMOON-FINCAS-DEMO/admin.html

> **Arranca vacío.** No hay datos de ejemplo. Cada sección del CRM tiene su
> estado "aún no hay…" explicando qué hacer para empezar.

---

## ⚠ Lo que falta por enchufar

Esto está construido y desplegado, pero hay tres cosas que dependen de
decisiones o cuentas que todavía no existen. Sin ellas el sistema funciona,
pero el circuito de correo se queda a medias — y lo dice, no lo disimula.

| Qué | Dónde se pone | Estado | Sin ello |
|---|---|---|---|
| `RESEND_API_KEY` | Supabase → Edge Functions → Secrets | ❌ pendiente | La petición al proveedor se registra en el timeline como `pendiente` y `fincas-enviar-email` devuelve 503. El expediente se abre igual. |
| Dominio remitente | Secret `FINCAS_FROM_EMAIL` | ❌ por definir | Se usa `onboarding@resend.dev`, que **sólo entrega al email de la cuenta de Resend**. Para escribir a proveedores reales hace falta un dominio verificado en Resend (`Whitemoon Fincas <avisos@tu-dominio>`). |
| Cloudflare Email Routing | Secrets `FINCAS_INBOUND_TOKEN` + `FINCAS_INBOUND_EMAIL`, y el Worker | ❌ pendiente | `fincas-inbound` responde 503 y rechaza todo. Los presupuestos por correo no entran en la bandeja. Ver `infra/cloudflare-email-worker.js`. |

> ### ⚠ El correo ENTRANTE está validado por simulación, no con recepción real
>
> Conviene decirlo con todas las letras antes de enseñárselo a nadie: del
> circuito de entrada está probado que **la puerta cierra** (`fincas-inbound`
> devuelve 503 sin `FINCAS_INBOUND_TOKEN` y 401 con un token que no cuadra) y
> que **la bandeja y la cola de aprobación funcionan** — pero eso último se
> comprobó insertando a mano la fila que la función habría creado, no
> recibiendo un correo de verdad.
>
> Lo que **no** está probado con un mensaje real: el parseo del MIME en el
> Worker de Cloudflare, el enganche al expediente por la referencia del
> asunto, y la subida del PDF adjunto a Storage. Eso sólo se puede verificar
> con el dominio enrutado; hasta entonces es código escrito y desplegado, no
> código ejercitado.
>
> **Cómo comprobarlo cuando esté enchufado:** abre un expediente desde el
> chat, responde al correo desde la cuenta del proveedor sin tocar el asunto,
> y mira que aparezca en la bandeja ligado a su `EXP-AAAA-NNNN`, con el PDF
> descargable desde la ficha.

Ya configurado y funcionando: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`.

### Pasos para cerrar el correo

1. **Resend.** Crear cuenta, verificar el dominio elegido (registros SPF/DKIM
   que da Resend), generar API key. Poner en Supabase:
   `RESEND_API_KEY` y `FINCAS_FROM_EMAIL="Whitemoon Fincas <avisos@dominio>"`.
2. **Cloudflare Email Routing.** Verificar el dominio (MX + TXT), crear un
   Worker con `infra/cloudflare-email-worker.js`, y enrutar
   `presupuestos@dominio` → ese Worker.
3. **Secreto compartido.** Inventar un valor largo y ponerlo *en los dos
   sitios*: variable `FINCAS_INBOUND_TOKEN` del Worker y secret
   `FINCAS_INBOUND_TOKEN` de Supabase. Añadir también
   `FINCAS_INBOUND_EMAIL=presupuestos@dominio` para que el Reply-To de las
   peticiones apunte ahí.

---

## Cómo funciona el circuito

```
Vecino escribe en el chat
   │  no hay selector de comunidad: Nora la pregunta
   ▼
fincas-chat  ── buscar_comunidad ─→ identifica la finca
             ── buscar_protocolo ─→ protocolo ESTRUCTURADO de ESA comunidad
             ── consultar_normativa → FTS sobre los PDF de ESA comunidad
             ── crear_expediente  ─→ EXP-AAAA-NNNN
             ── avisar_proveedor  ─→ fincas-enviar-email (Resend)
   │                                        │
   │                                        ▼
   │                            correo real al proveedor
   │                            asunto: [EXP-2026-0001] …
   ▼                                        │
Telegram: nuevo expediente                  ▼
                                  el proveedor responde
                                            │
                        Cloudflare Email Routing → Worker
                                            ▼
                                    fincas-inbound
                              · engancha por la referencia del asunto
                              · guarda el PDF en Storage
                              · crea el presupuesto en 'pendiente'
                              · Telegram: presupuesto recibido
                                            ▼
                            Bandeja del CRM → el admin aprueba
```

Si en cualquier punto falta el dato, **el agente escala a administración en
vez de inventarlo**.

---

## Autonomía por niveles

Hasta dónde llega el agente solo no lo decide su prompt: lo decide
`fincas_decidir_autonomia()`, una función SQL a la que se le pregunta y se le
obedece.

| Situación | Qué pasa |
|---|---|
| Trámite **operativo** sin importe | va solo |
| Trámite de **dinero** o **legal** | lo aprueba una persona |
| …marcado **de confianza** y por **debajo** del umbral | va solo |
| Trámite desconocido, importe que falta, cualquier duda | lo aprueba una persona |

Falla cerrada a propósito, y arranca cerrada del todo: umbral 0 € y ningún
trámite de confianza. Que la máquina gaste dinero sola tiene que ser una
decisión explícita, no el valor por defecto. Se configura en **CRM →
Autonomía**, global o por comunidad.

El **importe no lo pone quien llama**: se deriva de la factura o del
presupuesto aprobado, y sólo para los trámites que comprometen dinero. Si
viniera en la petición, bastaría con mandar `importe: 1` para colar una
adjudicación por debajo del umbral.

---

## Biblioteca de correos por trámite

Ocho plantillas editables en **CRM → Plantillas**. El agente elige *cuál*
toca; el texto lo escribió una persona y las `{{variables}}` las rellena el
código con datos del expediente.

| Trámite | Categoría |
|---|---|
| `solicitud_presupuesto` · `recordatorio_presupuesto` · `confirmacion_visita` · `solicitud_factura` · `aviso_propietario` | operativo |
| `adjudicacion` · `reclamacion_factura` | dinero |
| `apertura_siniestro` | legal |

Si alguna variable se queda vacía, **el correo no sale aunque el motor dijera
que sí**: pasa a borrador. Un correo con un hueco donde debería ir el nombre
del proveedor es peor que no mandar nada. Los borradores esperan en
**CRM → Correos**, cada uno con el motivo escrito.

---

## Contable IA

`fincas-contable` lee facturas de proveedor, las cuadra y las coteja. Cinco
herramientas y ninguna más:

| Herramienta | Qué hace |
|---|---|
| `comprobar_totales` | **la aritmética, en TypeScript**: base + IVA = total |
| `extraer_factura` | guarda lo leído, en `revisar` o `borrador`, nunca aprobada |
| `cotejar_con_presupuesto` | marca duplicados, sin presupuesto, importe distinto, proveedor que no coincide |
| `preparar_borrador_pago` | deja una **propuesta** en la cola; no paga |
| `generar_certificado_deuda` | borrador; no se emite |

El modelo **lee**; el modelo **no calcula**. Si escribe un total, se ignora:
vale el que sale de `compruebaTotales()`. Los modelos fallan sumando, y una
factura mal cuadrada que pasa por buena es dinero que sale mal.

---

## Sin embeddings

El "RAG" son dos cosas, ninguna vectorial:

1. **Protocolos estructurados por comunidad** — `fincas_protocolos` guarda,
   para cada finca, cada categoría y subtipo: proveedor asignado, urgencia,
   pasos y la cita del manual.
2. **Búsqueda de texto de Postgres** (`tsvector` español, índice GIN) sobre
   esos protocolos y sobre los PDF de normativa que sube el administrador.
   El texto del PDF se extrae **en el navegador del admin** con pdf.js.

Claude (`claude-haiku-4-5-20251001`) conversa, pregunta y clasifica. Lo que se
le enseña al vecino sale de la base de datos.

---

## Seguridad

### `anon` no lee nada del CRM

RLS estricta: las tablas `fincas_*` no tienen ninguna policy para `anon`. La
clave pública sirve para identificar el proyecto y para el login, nada más.
El chat del vecino funciona porque no lee la base: habla con una Edge Function
que usa service role y sólo devuelve lo que esa conversación necesita.

El equipo entra con Supabase Auth y necesita además **fila activa en
`fincas_perfiles`**: un usuario autenticado sin perfil no ve nada.

### El IBAN está fuera del alcance de la IA

Tres cerraduras, no una:

1. **Otro esquema, y encima con RLS.** `fincas_privado.datos_comunidad` no
   está en los esquemas que expone PostgREST: no hay URL de la API que lo
   devuelva, ni con la clave anon ni con service role. Y por si algún día
   alguien añadiera el esquema a la lista expuesta, la tabla lleva **RLS
   activada sin ninguna política** — que en Postgres significa denegar a
   todos. Los únicos que siguen entrando son los que tienen `BYPASSRLS`
   (`service_role`) y el propietario, que es quien ejecuta las dos funciones
   `SECURITY DEFINER`. El camino no cambia; sólo se le ha puesto otra
   cerradura por debajo.
2. **Sin herramienta.** El agente no tiene ninguna tool que lea ni escriba
   datos bancarios. Su catálogo completo es: `buscar_comunidad`,
   `buscar_inmueble`, `buscar_protocolo`, `consultar_normativa`,
   `crear_expediente`, `avisar_proveedor`, `escalar_a_administracion`.
3. **Lista blanca en el cliente de datos.** `fincas-chat` filtra cada ruta
   contra `TABLAS_PERMITIDAS` / `RPC_PERMITIDAS` **antes** de salir a la red.
   `fincas_privado_leer`, `fincas_privado_guardar`, `fincas_presupuestos` y
   `fincas_facturas` no están en la lista: el agente tampoco puede adjudicar
   ni facturar.

El admin los ve por `fincas-privado`, que valida su JWT y **registra cada
consulta** en la auditoría (sin guardar nunca el valor).

### Auditoría append-only

`fincas_auditoria` la escriben triggers de la propia base, no el cliente.
`UPDATE`, `DELETE` **y `TRUNCATE`** están bloqueados por trigger — falla
incluso con service role.

Cada apunte dice **quién**, y distingue tres cosas distintas:

| Actor | Qué significa |
|---|---|
| `admin@…` (un email) | una persona del equipo, identificada por su perfil |
| `agente-ia` | la IA: lo abrió o lo movió el agente del chat |
| `servicio` | un proceso backend que no es la IA (por ejemplo, el correo entrante) |

El agente se identifica mandando la cabecera `x-fincas-actor: agente-ia` en
cada escritura; PostgREST la publica en el GUC `request.headers` y
`fincas_actor()` la lee. Sólo se mira cuando no hay persona detrás, y sólo se
acepta ese valor exacto: nadie puede firmar la auditoría con un nombre
inventado.

### Nada se emite solo

Presupuestos, facturas y certificados nacen en `pendiente` / `borrador` /
`revisar`. La decisión la toma una persona desde el CRM, con su email en el
registro. El `UPDATE` lleva el estado de origen en el filtro, así que dos
personas decidiendo a la vez no se pisan.

### Las cinco barreras del dinero

1. **Dinero → cola.** Ningún trámite de categoría `dinero` o `legal` sale solo
   salvo que esté marcado de confianza y quede bajo el umbral. Lo decide una
   función SQL, no el prompt.
2. **Cálculo determinista en código.** `compruebaTotales()` en TypeScript. El
   total que se guarda es el calculado, nunca el que escriba el modelo.
3. **Sin herramienta de IBAN.** El Contable IA tiene cinco herramientas y
   ninguna toca datos bancarios. `fincas_privado` no está en su lista blanca de
   rutas, y tampoco hay ninguna que ejecute un pago: no existe integración
   bancaria en el proyecto.
4. **Auditoría append-only.** Cada acción —automática o aprobada— queda con su
   actor: el email de la persona, `agente-ia` o `servicio`. `UPDATE`, `DELETE`
   y `TRUNCATE` bloqueados por trigger.
5. **"Revisar" y escalar si no cuadra.** Una discrepancia deja la factura en
   `revisar` y dispara el aviso a Telegram. No se rellena a ojo ni se da nada
   por bueno.

---

## Integrador simulado

**NetFincas** es lo único simulado, y se etiqueta donde aparece: en la web y
en el system prompt del agente, que lo dice si le preguntan. El correo, los
expedientes, los presupuestos y la facturación son reales.

---

## Arquitectura

```
index.html                  landing + chat libre del vecino
admin.html                  login + CRM privado
assets/css/base.css         tokens WhiteMoon compartidos
assets/css/landing.css      portada y chat
assets/css/admin.css        CRM
assets/js/config.js         cliente Supabase + utilidades
assets/js/landing.js        fachada animada y scroll reveal
assets/js/chat.js           chat del vecino
assets/js/admin.js          CRM completo
infra/                      Worker de Cloudflare Email Routing
supabase/migrations/        esquema, RLS, funciones
supabase/functions/         Edge Functions
```

### Tablas (proyecto `mlaqtniujnvfxcvcourm`)

| Tabla | Para qué |
|---|---|
| `fincas_perfiles` | quién es del equipo (liga a `auth.users`) |
| `fincas_comunidades` | las fincas |
| `fincas_inmuebles` | viviendas y propietarios |
| `fincas_proveedores` | con **email**, que es lo que hace real el aviso |
| `fincas_protocolos` | qué hace cada comunidad ante cada caso |
| `fincas_documentos` | normativa en PDF + texto indexado (FTS) |
| `fincas_expedientes` | incidencias, `ref` EXP-AAAA-NNNN |
| `fincas_comunicaciones` | timeline de correos enviados y recibidos |
| `fincas_presupuestos` | bandeja + cola de aprobación |
| `fincas_facturas` | facturas y certificados: base, IVA, total, discrepancias y propuesta de pago |
| `fincas_plantillas_email` | biblioteca de correos por trámite, con `{{variables}}` |
| `fincas_config_autonomia` | umbral € y trámites de confianza, global o por comunidad |
| `fincas_auditoria` | append-only; distingue persona, `agente-ia` y `servicio` |
| `fincas_privado.datos_comunidad` | **IBAN y presidente — esquema no expuesto** |

### Edge Functions

| Función | Qué hace | Puerta |
|---|---|---|
| `fincas-chat` | el agente, con lista blanca de acceso a datos | pública (la usa el vecino) |
| `fincas-enviar-email` | petición de presupuesto vía Resend | service key interna o JWT de staff |
| `fincas-inbound` | recibe la respuesta del proveedor | token compartido |
| `fincas-notify` | avisos por Telegram | pública, no lee datos |
| `fincas-contable` | el Contable IA: leer, cuadrar y cotejar facturas | JWT de staff |
| `fincas-privado` | IBAN y presidente | JWT de staff, y sólo eso |
| `fincas-presupuesto` | **retirada** — devuelve 410 | — |

---

## Primeros pasos en el CRM

1. Entrar en `admin.html`.
2. **Comunidades** → dar de alta la finca (nombre y dirección).
3. Abrir su ficha → rellenar **presidente e IBAN** (marcado como dato
   protegido) y subir los **estatutos en PDF**.
4. **Proveedores** → alta con **email**, que es lo que permite pedirle
   presupuesto.
5. Volver a la ficha de la comunidad → **añadir protocolos** (categoría,
   subtipo, proveedor, urgencia, pasos y la cita del manual).
6. Probar el chat de la web como si fueras un vecino.

---

WhiteMoon Agencia IA · Majadahonda, Madrid · [whitemoon.es](https://whitemoon.es)
