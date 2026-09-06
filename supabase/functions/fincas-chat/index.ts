import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* =========================================================================
   fincas-chat — Nora, la agente IA de la demo de administración de fincas
   =========================================================================
   Nora CONVERSA y CLASIFICA. Nora NO DECIDE el proveedor.

   El proveedor, la urgencia y los pasos NO salen del modelo: salen de
   fincas_protocolos, la tabla de protocolos de CADA comunidad. El modelo
   (claude-haiku-4-5-20251001) entiende lo que escribe el vecino, identifica
   la comunidad y el caso, y llama a la herramienta. Lo que devuelve la
   herramienta es lo que manda.

   AQUÍ NO HAY EMBEDDINGS. El "RAG" de protocolos son dos cosas:
     1. datos ESTRUCTURADOS por comunidad (categoría + subtipo), y
     2. búsqueda de texto de Postgres (tsvector español) para las dudas
        libres, cuando el vecino no usa la palabra exacta.

   EL AISLAMIENTO ENTRE COMUNIDADES
   --------------------------------
   Es la propiedad que vende esta demo, así que no se confía en el prompt.
   Se sostiene sobre tres cosas, en este orden:

     a) fincas_buscar_protocolo(p_comunidad, p_consulta) lleva el filtro
        `where comunidad_id = p_comunidad` CABLEADO en SQL. Si p_comunidad
        es nulo, la comparación es nula y devuelve 0 filas: falla cerrada.
        No existe forma de pedir "todos los protocolos".

     b) Esta función mantiene una `comunidadActiva` de servidor. La
        herramienta buscar_protocolo declara `comunidad_id` en su esquema
        (el modelo lo ve y lo rellena), pero antes de tocar la base se
        COMPARA con la comunidad activa y, si no coincide, se rechaza la
        llamada y se le devuelve el error al modelo. Que el modelo se
        equivoque de comunidad es un error recuperable, no una fuga.

     c) La comunidad activa sólo se fija de dos maneras: el selector de la
        web, o resolver un inmueble real con buscar_inmueble. Nunca por
        deducción del modelo.

   Contrato HTTP
   -------------
   POST  { mensaje: string,
           comunidad_id?: uuid,                       // selector de la web
           contexto?: { comunidad_id, inmueble_id },  // eco del turno anterior
           historial?: [{ role, content }] }

   200   { reply, contexto, protocolo, expediente, aviso }

   `protocolo`   el protocolo aplicado en este turno, tal cual sale de la BD.
   `expediente`  { ref, id, ... } si en este turno se ha abierto uno.
   `aviso`       payload listo para fincas-notify, si se ha dado parte al
                 proveedor. Lo dispara el cliente (assets/js/chat.js).

   Secrets: ANTHROPIC_API_KEY. SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY las
   inyecta la plataforma.

   verify_jwt: false — la llama un navegador anónimo desde GitHub Pages.
   ========================================================================= */

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MODELO = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1200;
const MAX_HISTORIAL = 14;
const MAX_VUELTAS = 5;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const CAIDA =
  "Ahora mismo no puedo seguir la conversación. Llama a la administración " +
  "o escríbenos por WhatsApp al 643 199 580 y te atendemos.";

const SYSTEM = `Eres Nora, la agente de IA de una administración de fincas. Atiendes a propietarios y vecinos. Esto es una DEMO de WhiteMoon Agencia IA.

REGLA NÚMERO UNO: LA COMUNIDAD PRIMERO
- Antes de aplicar NINGÚN protocolo tienes que saber de qué comunidad se trata.
- Cada comunidad tiene sus propios proveedores y su propio protocolo. Lo que vale en una NO vale en la otra.
- MIRA SIEMPRE el bloque CONTEXTO que va al final de estas instrucciones. Si ahí aparece una comunidad activa, YA LA SABES: no la preguntes nunca, úsala tal cual y sigue directamente con la incidencia.
- Sólo si el CONTEXTO dice que todavía no la sabes, pregúntala. Si te dicen la puerta ("el 3C de Madrid 2"), llama a buscar_inmueble para resolverla.
- Nunca supongas la comunidad por el tipo de avería, por el nombre del vecino ni por lo que recuerdes de otra conversación.

CÓMO HABLAS
- Máximo 3 frases por respuesta. Tono tranquilo y directo, de portería, no de folleto.
- UNA sola pregunta por mensaje. Nunca encadenes preguntas.
- Nada de listas ni negritas: hablas, no rellenas formularios.

ASCENSORES
- Si la incidencia es de ascensor, tu PRIMERA pregunta después de saber la comunidad es si hay alguien atrapado dentro. Siempre. Sin excepciones.
- En ese MISMO turno, además de preguntar, llama ya a buscar_protocolo para tener delante el protocolo de esa comunidad. Preguntar y consultar no se estorban.
- Si hay personas atrapadas es un atrapamiento (subtipo "atrapamiento"): urgencia crítica.
- Si no hay nadie dentro es una avería (subtipo "parado").
- No abras el expediente hasta que te contesten si hay alguien dentro: el subtipo depende de esa respuesta.

EL PROTOCOLO MANDA
- El proveedor, la urgencia y los pasos SIEMPRE salen de buscar_protocolo. Nunca de tu cabeza.
- NUNCA inventes ni cambies un nombre de proveedor, un teléfono ni un plazo. Si no lo ha dicho la herramienta, no existe.
- SIEMPRE dices en qué protocolo te apoyas nombrando su referencia tal cual la devuelve la herramienta en cita_fuente, con su sección (por ejemplo "§3.1 Ascensores"). Copiar la referencia, no parafrasearla.
- Si buscar_protocolo no devuelve nada para el caso, NO improvises: dile que ese caso no está cubierto por el protocolo de su comunidad y que lo escalas al equipo de la administración para que lo revise una persona. Nada más.

ABRIR EXPEDIENTE
- Con la comunidad identificada y el protocolo encontrado, llama a crear_expediente.
- Después llama a crear_parte_proveedor para dar parte al proveedor que asigna el protocolo.
- Cierra dando la referencia del expediente (EXP-AAAA-NNNN) y el protocolo aplicado, en una frase.

LO QUE ESTÁ SIMULADO
- El aviso al proveedor y la sincronización con NetFincas están SIMULADOS en esta demo. Si te preguntan, lo dices sin rodeos.
- No des importes, ni presupuestos, ni fechas de reparación: eso lo confirma el administrador.`;

const HERRAMIENTAS = [
  {
    name: "buscar_inmueble",
    description:
      "Resuelve una comunidad y, si se indica, un inmueble concreto. Úsala en cuanto sepas " +
      "de qué comunidad habla el vecino. Acepta el nombre de la comunidad tal cual lo diga " +
      "('Madrid 2') y opcionalmente la puerta ('3C'). Fija la comunidad activa de la conversación.",
    input_schema: {
      type: "object",
      properties: {
        comunidad: { type: "string", description: "Nombre de la comunidad tal como lo ha dicho la persona." },
        puerta: { type: "string", description: "Puerta o vivienda, por ejemplo '3C'. Cadena vacía si no la ha dicho." },
      },
      required: ["comunidad"],
    },
  },
  {
    name: "buscar_protocolo",
    description:
      "Devuelve el protocolo de ESA comunidad para el caso descrito: proveedor asignado, " +
      "urgencia, pasos y cita de la fuente. Sólo consulta la comunidad activa. " +
      "Pasa categoria y subtipo si los tienes claros; si no, pasa la frase del vecino en consulta " +
      "y se busca por texto. Si devuelve lista vacía, ese caso NO está cubierto: escala al equipo.",
    input_schema: {
      type: "object",
      properties: {
        comunidad_id: { type: "string", description: "Identificador de la comunidad activa." },
        categoria: { type: "string", description: "ascensores, fontaneria, electricidad… Cadena vacía si no lo tienes claro." },
        subtipo: { type: "string", description: "parado, atrapamiento, fuga_zonas_comunes… Cadena vacía si no lo tienes claro." },
        consulta: { type: "string", description: "La frase del vecino, para buscar por texto cuando no sabes la categoría." },
      },
      required: ["comunidad_id"],
    },
  },
  {
    name: "crear_expediente",
    description:
      "Abre el expediente en el CRM y devuelve su referencia EXP-AAAA-NNNN. " +
      "Llámala sólo cuando tengas comunidad identificada y protocolo encontrado.",
    input_schema: {
      type: "object",
      properties: {
        comunidad_id: { type: "string", description: "Comunidad activa." },
        protocolo_id: { type: "string", description: "Id del protocolo devuelto por buscar_protocolo." },
        inmueble_id: { type: "string", description: "Id del inmueble si se ha resuelto. Cadena vacía si no." },
        descripcion: { type: "string", description: "Qué ha contado el vecino, en una o dos frases." },
        urgencia: { type: "string", description: "critica, alta, media o baja. Si dudas, deja vacío y manda la del protocolo." },
      },
      required: ["comunidad_id", "protocolo_id", "descripcion"],
    },
  },
  {
    name: "crear_parte_proveedor",
    description:
      "Da parte al proveedor que ASIGNA EL PROTOCOLO del expediente (no eliges tú a quién se avisa) " +
      "y pasa el expediente a estado asignado.",
    input_schema: {
      type: "object",
      properties: {
        expediente_id: { type: "string", description: "Id del expediente devuelto por crear_expediente." },
      },
      required: ["expediente_id"],
    },
  },
];

/* ------------------------------------------------------------------ tipos */

type Bloque = { type: string; [k: string]: unknown };
type Mensaje = { role: "user" | "assistant"; content: unknown };

/* -------------------------------------------------------------- PostgREST */

async function db(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...((init.headers ?? {}) as Record<string, string>),
    },
  });
  if (!r.ok) {
    console.warn("[fincas-chat] PostgREST", path, r.status, await r.text());
    return null;
  }
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

/** Registra en la auditoría. Nunca rompe el flujo si falla. */
async function auditar(accion: string, entidad: string, detalle: unknown) {
  try {
    await db("fincas_auditoria", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ actor: "agente-ia", accion, entidad, detalle }),
    });
  } catch (e) {
    console.warn("[fincas-chat] auditoría falló:", e);
  }
}

/* ---------------------------------------------------------------- helpers */

function saneaHistorial(bruto: unknown): Mensaje[] {
  const lista = Array.isArray(bruto) ? bruto : [];
  const limpios: Mensaje[] = [];
  for (const m of lista) {
    const rol = (m as { role?: unknown })?.role;
    const txt = (m as { content?: unknown })?.content;
    if (rol !== "user" && rol !== "assistant") continue;
    if (typeof txt !== "string") continue;
    const t = txt.trim().slice(0, 2000);
    if (!t) continue;
    limpios.push({ role: rol, content: t });
  }
  const recorte = limpios.slice(-MAX_HISTORIAL);
  while (recorte.length && recorte[0].role !== "user") recorte.shift();
  return recorte;
}

function textoDe(bloques: unknown): string {
  if (!Array.isArray(bloques)) return "";
  return bloques
    .filter((b: Bloque) => b?.type === "text")
    .map((b: Bloque) => String(b.text ?? ""))
    .join("\n")
    .trim();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

const URGENCIAS = ["critica", "alta", "media", "baja"];

/**
 * respuestaDeRespaldo — qué decir cuando el modelo no ha dejado texto.
 * Se construye con los datos REALES del turno, no con una disculpa genérica.
 */
function respuestaDeRespaldo(exp: any, prot: any): string {
  if (exp?.ref) {
    return `He abierto el expediente ${exp.ref} y he dado parte a ` +
      `${exp.proveedor_nombre ?? "el proveedor asignado"}, según ${exp.protocolo_citado ?? "el protocolo de tu comunidad"}.`;
  }
  if (prot?.cita_fuente) {
    return `Según ${prot.cita_fuente}, en tu comunidad este caso lo atiende ` +
      `${prot.proveedor_nombre}. Cuéntame un poco más y abro el expediente.`;
  }
  return CAIDA;
}

async function llamaAnthropic(mensajes: Mensaje[], system: string) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: MAX_TOKENS,
      system,
      tools: HERRAMIENTAS,
      messages: mensajes,
    }),
  });
  if (!r.ok) {
    console.warn("[fincas-chat] Anthropic", r.status, await r.text());
    return null;
  }
  return await r.json();
}

/* --------------------------------------------------------------- servidor */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  const caida = (contexto: unknown = null) =>
    json({ reply: CAIDA, contexto, protocolo: null, expediente: null, aviso: null });

  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    console.warn("[fincas-chat] faltan secrets");
    return caida();
  }

  try {
    const cuerpo = await req.json().catch(() => ({}));
    const mensaje = String((cuerpo as any).mensaje ?? "").trim().slice(0, 2000);
    const ctxEntrada = ((cuerpo as any).contexto ?? {}) as Record<string, unknown>;

    /* ---- Estado de servidor de esta conversación -----------------------
       La comunidad activa entra por el selector de la web o por el eco del
       turno anterior; a partir de ahí sólo la cambia buscar_inmueble. */
    let comunidadActiva: string | null = null;
    let comunidadNombre = "";
    let inmuebleActivo: string | null = null;
    let puertaActiva = "";

    const idPropuesto = esUuid((cuerpo as any).comunidad_id)
      ? String((cuerpo as any).comunidad_id)
      : esUuid(ctxEntrada.comunidad_id)
      ? String(ctxEntrada.comunidad_id)
      : null;

    if (idPropuesto) {
      const filas = await db(`fincas_comunidades?id=eq.${idPropuesto}&select=id,nombre`);
      if (Array.isArray(filas) && filas.length) {
        comunidadActiva = filas[0].id;
        comunidadNombre = filas[0].nombre;
      }
    }
    if (comunidadActiva && esUuid(ctxEntrada.inmueble_id)) {
      const filas = await db(
        `fincas_inmuebles?id=eq.${ctxEntrada.inmueble_id}&comunidad_id=eq.${comunidadActiva}&select=id,puerta`,
      );
      if (Array.isArray(filas) && filas.length) {
        inmuebleActivo = filas[0].id;
        puertaActiva = filas[0].puerta;
      }
    }

    const mensajes = saneaHistorial((cuerpo as any).historial);
    if (mensaje) mensajes.push({ role: "user", content: mensaje });
    while (mensajes.length && mensajes[0].role !== "user") mensajes.shift();

    if (!mensajes.length) {
      return json({
        reply:
          "Hola, soy Nora, de la administración. Cuéntame qué ha pasado y de qué comunidad me llamas.",
        contexto: { comunidad_id: comunidadActiva, inmueble_id: inmuebleActivo },
        protocolo: null, expediente: null, aviso: null,
      });
    }

    /* Al modelo se le dice lo que YA está resuelto, para que no lo pregunte
       otra vez ni se lo invente. */
    let system = SYSTEM;
    if (comunidadActiva) {
      system += `\n\nCONTEXTO
- LA COMUNIDAD YA ESTÁ IDENTIFICADA: "${comunidadNombre}", comunidad_id = ${comunidadActiva}.
- NO preguntes de qué comunidad se trata. Ya lo sabes. Usa ese comunidad_id en todas las herramientas.`;
      if (inmuebleActivo) {
        system += `\n- El inmueble también está identificado: puerta ${puertaActiva}, inmueble_id = ${inmuebleActivo}. Tampoco lo preguntes.`;
      }
    } else {
      system += `\n\nCONTEXTO
- Todavía NO sabes la comunidad. Averíguala antes de nada.`;
    }

    /* Lo que este turno haya producido de verdad, contra la base de datos. */
    let protocoloAplicado: unknown = null;
    let expedienteCreado: any = null;
    let aviso: unknown = null;

    /* El modelo suele preguntar Y llamar a la herramienta en el MISMO turno
       ("¿hay alguien atrapado?" + buscar_protocolo). Ese texto va en la misma
       respuesta que el tool_use, así que hay que guardarlo: si en la vuelta
       final ya no dice nada —porque la pregunta ya la hizo— es lo que el
       vecino tiene que leer. Sin esto la pregunta se perdía. */
    let textoParcial = "";

    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
      const data = await llamaAnthropic(mensajes, system);
      if (!data) {
        return caida({ comunidad_id: comunidadActiva, inmueble_id: inmuebleActivo });
      }

      if (data.stop_reason !== "tool_use") {
        /* Si el modelo se queda sin texto (típicamente stop_reason
           "max_tokens" cortándole a mitad de una llamada a herramienta) NO se
           suelta el mensaje de caída: el trabajo contra la base de datos sí se
           ha hecho, y decir "no puedo atenderte" sería mentir. Se responde con
           lo que consta. */
        return json({
          reply: textoDe(data.content) || textoParcial ||
            respuestaDeRespaldo(expedienteCreado, protocoloAplicado),
          contexto: { comunidad_id: comunidadActiva, inmueble_id: inmuebleActivo },
          protocolo: protocoloAplicado,
          expediente: expedienteCreado,
          aviso,
        });
      }

      const dicho = textoDe(data.content);
      if (dicho) textoParcial = dicho;

      mensajes.push({ role: "assistant", content: data.content });

      const resultados: unknown[] = [];
      for (const bloque of data.content as Bloque[]) {
        if (bloque.type !== "tool_use") continue;
        const args = (bloque.input ?? {}) as Record<string, unknown>;
        let salida: unknown;

        /* ----------------------------------------------- buscar_inmueble */
        if (bloque.name === "buscar_inmueble") {
          const nombre = String(args.comunidad ?? "").trim().slice(0, 120);
          const puerta = String(args.puerta ?? "").trim().slice(0, 20);

          if (!nombre) {
            salida = { ok: false, error: "Falta el nombre de la comunidad." };
          } else {
            const comus = await db(
              `fincas_comunidades?nombre=ilike.${encodeURIComponent("%" + nombre + "%")}&select=id,nombre,direccion`,
            );
            if (!Array.isArray(comus) || comus.length === 0) {
              salida = {
                ok: false,
                error: `No encuentro ninguna comunidad que se llame "${nombre}". Las comunidades de esta demo son Madrid 1 y Madrid 2.`,
              };
            } else if (comus.length > 1) {
              salida = {
                ok: false,
                error:
                  "Ese nombre encaja con varias comunidades: " +
                  comus.map((c: any) => c.nombre).join(", ") +
                  ". Pregunta cuál es.",
                candidatas: comus.map((c: any) => c.nombre),
              };
            } else {
              /* Cambiar de comunidad reinicia el inmueble: no se arrastra
                 un 3C de la comunidad anterior. */
              const c = comus[0];
              if (c.id !== comunidadActiva) {
                inmuebleActivo = null;
                puertaActiva = "";
              }
              comunidadActiva = c.id;
              comunidadNombre = c.nombre;

              let inmueble: any = null;
              if (puerta) {
                const inms = await db(
                  `fincas_inmuebles?comunidad_id=eq.${c.id}&puerta=ilike.${encodeURIComponent(puerta)}&select=id,puerta,propietario_nombre`,
                );
                if (Array.isArray(inms) && inms.length) {
                  inmueble = inms[0];
                  inmuebleActivo = inmueble.id;
                  puertaActiva = inmueble.puerta;
                }
              }
              salida = {
                ok: true,
                comunidad_id: c.id,
                comunidad: c.nombre,
                direccion: c.direccion,
                inmueble: inmueble
                  ? {
                      inmueble_id: inmueble.id,
                      puerta: inmueble.puerta,
                      propietario: inmueble.propietario_nombre,
                    }
                  : null,
                nota:
                  puerta && !inmueble
                    ? `No hay ninguna puerta "${puerta}" dada de alta en ${c.nombre}. Puedes seguir sin inmueble.`
                    : undefined,
              };
            }
          }

          /* ---------------------------------------------- buscar_protocolo */
        } else if (bloque.name === "buscar_protocolo") {
          const pedida = String(args.comunidad_id ?? "").trim();

          if (!comunidadActiva) {
            salida = {
              ok: false,
              error: "Todavía no hay comunidad identificada. Llama antes a buscar_inmueble.",
            };
          } else if (pedida && pedida !== comunidadActiva) {
            /* El guardia. El modelo ha pedido protocolos de OTRA comunidad:
               se rechaza y queda registrado. Nunca se sirve. */
            await auditar("protocolo_denegado", "fincas_protocolos", {
              comunidad_activa: comunidadActiva,
              comunidad_pedida: pedida,
            });
            salida = {
              ok: false,
              error:
                "No puedes consultar los protocolos de otra comunidad. " +
                `La comunidad activa es ${comunidadNombre} (${comunidadActiva}).`,
            };
          } else {
            const categoria = String(args.categoria ?? "").trim();
            const subtipo = String(args.subtipo ?? "").trim();
            const consulta = [categoria, subtipo, String(args.consulta ?? "")]
              .map((s) => s.trim())
              .filter(Boolean)
              .join(" ");

            const filas = await db("rpc/fincas_buscar_protocolo", {
              method: "POST",
              body: JSON.stringify({
                p_comunidad: comunidadActiva,
                p_consulta: consulta || null,
              }),
            });

            /* Cinturón y tirantes: la función SQL ya filtra, pero se vuelve
               a comprobar aquí antes de dejar salir una sola fila. */
            const limpias = (Array.isArray(filas) ? filas : []).filter(
              (p: any) => p.comunidad_id === comunidadActiva,
            );

            if (!limpias.length) {
              salida = {
                ok: true,
                protocolos: [],
                nota: `No hay protocolo para ese caso en ${comunidadNombre}. Escala al equipo de la administración: no inventes proveedor.`,
              };
            } else {
              protocoloAplicado = { ...limpias[0], comunidad: comunidadNombre };
              salida = { ok: true, comunidad: comunidadNombre, protocolos: limpias };
            }
          }

          /* ---------------------------------------------- crear_expediente */
        } else if (bloque.name === "crear_expediente") {
          const pedida = String(args.comunidad_id ?? "").trim();

          if (!comunidadActiva) {
            salida = { ok: false, error: "No hay comunidad identificada todavía." };
          } else if (pedida && pedida !== comunidadActiva) {
            salida = { ok: false, error: "No puedes abrir expedientes en otra comunidad." };
          } else if (!esUuid(args.protocolo_id)) {
            salida = { ok: false, error: "Falta el protocolo_id que devuelve buscar_protocolo." };
          } else {
            /* El protocolo se relee de la base filtrando otra vez por
               comunidad: la cita y el proveedor que acaban en el expediente
               salen de la fila real, no de lo que diga el modelo. */
            const prots = await db(
              `fincas_protocolos?id=eq.${args.protocolo_id}&comunidad_id=eq.${comunidadActiva}` +
                `&select=id,categoria,subtipo,proveedor_nombre,proveedor_tel,urgencia_default,cita_fuente`,
            );
            const p = Array.isArray(prots) && prots.length ? prots[0] : null;

            if (!p) {
              salida = { ok: false, error: "Ese protocolo no pertenece a la comunidad activa." };
            } else {
              const urg = String(args.urgencia ?? "").trim().toLowerCase();
              const fila = {
                comunidad_id: comunidadActiva,
                inmueble_id: esUuid(args.inmueble_id) ? args.inmueble_id : inmuebleActivo,
                tipo: p.categoria,
                subtipo: p.subtipo,
                urgencia: URGENCIAS.includes(urg) ? urg : p.urgencia_default,
                estado: "nuevo",
                descripcion: String(args.descripcion ?? "").trim().slice(0, 1000),
                protocolo_id: p.id,
                protocolo_citado: p.cita_fuente,
                proveedor_nombre: p.proveedor_nombre,
                proveedor_tel: p.proveedor_tel,
              };
              const creado = await db("fincas_expedientes", {
                method: "POST",
                body: JSON.stringify(fila),
              });
              const exp = Array.isArray(creado) && creado.length ? creado[0] : null;

              if (!exp) {
                salida = { ok: false, error: "No se ha podido abrir el expediente." };
              } else {
                expedienteCreado = { ...exp, comunidad: comunidadNombre, puerta: puertaActiva };
                await auditar("expediente_creado", "fincas_expedientes", {
                  ref: exp.ref,
                  comunidad: comunidadNombre,
                  protocolo: p.cita_fuente,
                });
                salida = {
                  ok: true,
                  expediente_id: exp.id,
                  referencia: exp.ref,
                  urgencia: exp.urgencia,
                  proveedor_asignado: p.proveedor_nombre,
                  protocolo_citado: p.cita_fuente,
                };
              }
            }
          }

          /* ------------------------------------------ crear_parte_proveedor */
        } else if (bloque.name === "crear_parte_proveedor") {
          if (!esUuid(args.expediente_id)) {
            salida = { ok: false, error: "Falta el expediente_id." };
          } else if (!comunidadActiva) {
            salida = { ok: false, error: "No hay comunidad identificada." };
          } else {
            const exps = await db(
              `fincas_expedientes?id=eq.${args.expediente_id}&comunidad_id=eq.${comunidadActiva}` +
                `&select=id,ref,proveedor_nombre,proveedor_tel,subtipo,inmueble_id`,
            );
            const exp = Array.isArray(exps) && exps.length ? exps[0] : null;

            if (!exp) {
              salida = { ok: false, error: "Ese expediente no es de la comunidad activa." };
            } else if (!exp.proveedor_nombre) {
              salida = { ok: false, error: "El expediente no tiene proveedor asignado por protocolo." };
            } else {
              await db(`fincas_expedientes?id=eq.${exp.id}`, {
                method: "PATCH",
                headers: { Prefer: "return=minimal" },
                body: JSON.stringify({
                  estado: "asignado",
                  proveedor_avisado_at: new Date().toISOString(),
                }),
              });

              let puerta = puertaActiva;
              if (!puerta && esUuid(exp.inmueble_id)) {
                const inms = await db(`fincas_inmuebles?id=eq.${exp.inmueble_id}&select=puerta`);
                if (Array.isArray(inms) && inms.length) puerta = inms[0].puerta;
              }

              await auditar("parte_proveedor", "fincas_expedientes", {
                ref: exp.ref,
                proveedor: exp.proveedor_nombre,
                comunidad: comunidadNombre,
              });

              /* El aviso lo dispara el cliente contra fincas-notify. */
              aviso = {
                ref: exp.ref,
                comunidad: comunidadNombre,
                puerta,
                subtipo: exp.subtipo,
                proveedor: exp.proveedor_nombre,
              };

              salida = {
                ok: true,
                proveedor_avisado: exp.proveedor_nombre,
                telefono: exp.proveedor_tel,
                referencia: exp.ref,
                nota:
                  "Aviso al proveedor SIMULADO en esta demo: se registra el parte, no se hace la llamada real.",
              };
            }
          }
        } else {
          salida = { ok: false, error: "Herramienta desconocida." };
        }

        resultados.push({
          type: "tool_result",
          tool_use_id: bloque.id,
          content: JSON.stringify(salida),
        });
      }

      mensajes.push({ role: "user", content: resultados });
    }

    console.warn("[fincas-chat] agotadas las vueltas de herramienta");
    return json({
      reply: textoParcial || respuestaDeRespaldo(expedienteCreado, protocoloAplicado),
      contexto: { comunidad_id: comunidadActiva, inmueble_id: inmuebleActivo },
      protocolo: protocoloAplicado,
      expediente: expedienteCreado,
      aviso,
    });
  } catch (e) {
    console.warn("[fincas-chat] error:", e);
    return caida();
  }
});
