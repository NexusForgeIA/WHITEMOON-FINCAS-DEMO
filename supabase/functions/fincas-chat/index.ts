import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* =========================================================================
   fincas-chat — Nora, la agente de Whitemoon Fincas
   =========================================================================
   Atiende al vecino en chat libre. No hay selector de comunidad, ni
   botones, ni respuestas preparadas: Nora tiene que averiguar de qué
   comunidad le hablan preguntando, como haría una persona en la centralita.

   QUÉ DECIDE EL MODELO Y QUÉ NO
   El modelo (claude-haiku-4-5-20251001) entiende, pregunta y clasifica.
   El proveedor, la urgencia, los pasos y la cita salen de
   fincas_protocolos y fincas_documentos, siempre filtrados por la comunidad
   identificada. Si no hay protocolo, NO improvisa: escala a administración.

   RAG SIN EMBEDDINGS
     1. protocolos ESTRUCTURADOS por comunidad (categoría + subtipo), y
     2. búsqueda de texto de Postgres (tsvector español) sobre esos
        protocolos y sobre la normativa que el administrador haya subido.

   LOS DATOS BANCARIOS NO ESTÁN A SU ALCANCE
   Tres cosas, no una:
     a) IBAN y presidente viven en el esquema `fincas_privado`, que
        PostgREST no expone y que además lleva RLS activada sin políticas.
     b) Nora no tiene ninguna herramienta que los mencione.
     c) El cliente de base de datos de ESTA función lleva una LISTA BLANCA
        (TABLAS_PERMITIDAS / RPC_PERMITIDAS). Cualquier ruta que no esté en
        ella se rechaza antes de salir a la red, aunque el código futuro se
        despiste. Los presupuestos y las facturas tampoco están: el agente
        no adjudica ni factura.

   Contrato HTTP
   -------------
   POST { mensaje, contexto?: {comunidad_id, inmueble_id}, historial? }
   200  { reply, contexto, protocolo, normativa, expediente, escalado }

   Secrets: ANTHROPIC_API_KEY. SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY las
   inyecta la plataforma.
   ========================================================================= */

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MODELO = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1200;
const MAX_HISTORIAL = 16;
const MAX_VUELTAS = 6;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const CAIDA =
  "Ahora mismo no puedo seguir la conversación. Vuelve a intentarlo en un " +
  "momento o escribe a la administración.";

/* ------------------------------------------------- la lista blanca real */

const TABLAS_PERMITIDAS = new Set([
  "fincas_comunidades",
  "fincas_inmuebles",
  "fincas_protocolos",
  "fincas_expedientes",
  "fincas_comunicaciones",
  "fincas_auditoria",
]);

const RPC_PERMITIDAS = new Set([
  "fincas_buscar_comunidad",
  "fincas_buscar_protocolo",
  "fincas_buscar_normativa",
]);

const SYSTEM = `Eres Nora, la agente de IA de Whitemoon Fincas, una administración de fincas. Atiendes por chat a vecinos y propietarios.

LO PRIMERO: DE QUÉ COMUNIDAD ME HABLAS
- No hay ningún selector. No sabes desde dónde escriben hasta que lo averiguas preguntando.
- Si no sabes la comunidad, tu primera pregunta es la dirección del edificio o el nombre de la comunidad. Con eso llamas a buscar_comunidad.
- Si buscar_comunidad devuelve varias, pregunta cuál de ellas es, nombrándolas.
- Si no devuelve ninguna, dilo claramente y ofrece escalar a administración con escalar_a_administracion. NO te inventes que la has encontrado.
- Nunca supongas la comunidad por el tipo de avería ni por nada que no sea la respuesta del vecino.

CÓMO HABLAS
- Máximo 3 frases por respuesta. Tono tranquilo y de portería: cercano, directo, sin folleto.
- UNA sola pregunta por mensaje. Nunca encadenes preguntas.
- Nada de listas ni negritas: estás hablando.

ASCENSORES
- Si la incidencia es de ascensor, en cuanto sepas la comunidad pregunta si hay alguien atrapado dentro. Siempre.
- Con personas atrapadas es un atrapamiento y la urgencia es crítica. Sin nadie dentro es una avería.
- Aunque sea un atrapamiento, pide el piso y la letra en el mismo mensaje en que confirmas el contacto; es una sola pregunta y no retrasa el aviso.

EL PROTOCOLO MANDA
- El proveedor, la urgencia y los pasos SIEMPRE salen de buscar_protocolo. Nunca de tu cabeza.
- NUNCA inventes un nombre de proveedor, un teléfono, un plazo ni un importe. Si no lo ha dicho una herramienta, no existe.
- Cuando apliques un protocolo, di su referencia tal cual la devuelve la herramienta en cita_fuente, con su sección.
- Para dudas que no son una avería ("¿puedo tender en el balcón?", "¿cuándo es la junta?") usa consultar_normativa sobre los documentos de esa comunidad, y cita el documento.
- Si no hay protocolo ni normativa para el caso, NO improvises: llama a escalar_a_administracion y dile al vecino que lo revisa una persona del equipo.

ABRIR EXPEDIENTE
- Antes de abrir expediente pide el nombre y un teléfono o email de contacto del vecino. Sin contacto no se puede hacer seguimiento.
- Pregunta también el piso y la letra de la vivienda (p. ej. 1C) y llama a buscar_inmueble para vincular la vivienda al expediente: así el parte queda ligado a su propietario. Hazlo ANTES de crear_expediente. Si el vecino no la sabe, o es una urgencia con personas en peligro y no conviene demorarse, abre el expediente igual sin vivienda.
- Con comunidad, protocolo y contacto, llama a crear_expediente.
- Después llama a avisar_proveedor: eso manda el correo real al proveedor que asigna el protocolo.
- Cierra dando la referencia del expediente y diciendo a quién se ha avisado.

LO QUE NO HACES
- No das importes, ni presupuestos, ni fechas de reparación: los confirma la administración.
- No tienes acceso a datos bancarios, IBAN ni datos del presidente de la comunidad. Si te los piden, di que esos datos los lleva la administración y que tú no los ves.
- No apruebas gastos ni emites facturas.

SI TE PREGUNTAN POR EL SISTEMA
- La gestión la lleva el propio sistema de la administración: expedientes, protocolos, proveedores y comunicaciones están todos aquí. No dependemos de ningún programa externo.
- No entres en detalles técnicos con el vecino ni nombres herramientas. Con decir que lo lleva nuestro sistema y volver a su incidencia, basta.`;

const HERRAMIENTAS = [
  {
    name: "buscar_comunidad",
    description:
      "Busca la comunidad por lo que diga el vecino: nombre o dirección ('Serrano 118', " +
      "'la de Brasil'). Devuelve como mucho 5 candidatas. Úsala en cuanto tengas algo " +
      "que buscar. Si devuelve lista vacía, esa comunidad no está dada de alta.",
    input_schema: {
      type: "object",
      properties: {
        texto: { type: "string", description: "Nombre o dirección tal como lo ha escrito la persona." },
      },
      required: ["texto"],
    },
  },
  {
    name: "buscar_inmueble",
    description:
      "Localiza la vivienda dentro de la comunidad ya identificada, por su puerta ('3C'). " +
      "Opcional: el expediente se puede abrir sin inmueble.",
    input_schema: {
      type: "object",
      properties: {
        comunidad_id: { type: "string", description: "Comunidad ya identificada." },
        puerta: { type: "string", description: "Puerta o vivienda, por ejemplo '3C'." },
      },
      required: ["comunidad_id", "puerta"],
    },
  },
  {
    name: "buscar_protocolo",
    description:
      "Devuelve el protocolo de ESA comunidad para el caso descrito: proveedor asignado, " +
      "urgencia, pasos y cita de la fuente. Pasa categoria y subtipo si los tienes claros; " +
      "si no, pasa la frase del vecino en consulta. Lista vacía = no está cubierto.",
    input_schema: {
      type: "object",
      properties: {
        comunidad_id: { type: "string", description: "Comunidad ya identificada." },
        categoria: { type: "string", description: "ascensores, fontaneria, electricidad… Vacío si no lo tienes claro." },
        subtipo: { type: "string", description: "parado, atrapamiento, fuga… Vacío si no lo tienes claro." },
        consulta: { type: "string", description: "La frase del vecino, para buscar por texto." },
      },
      required: ["comunidad_id"],
    },
  },
  {
    name: "consultar_normativa",
    description:
      "Busca en los documentos y la normativa que la administración ha subido para ESA " +
      "comunidad (estatutos, actas, reglamento). Para dudas que no son una avería. " +
      "Devuelve extractos con el título del documento para poder citarlo.",
    input_schema: {
      type: "object",
      properties: {
        comunidad_id: { type: "string", description: "Comunidad ya identificada." },
        consulta: { type: "string", description: "La duda del vecino, en sus palabras." },
      },
      required: ["comunidad_id", "consulta"],
    },
  },
  {
    name: "crear_expediente",
    description:
      "Abre el expediente y devuelve su referencia EXP-AAAA-NNNN. Requiere comunidad, " +
      "protocolo encontrado y datos de contacto del vecino.",
    input_schema: {
      type: "object",
      properties: {
        comunidad_id: { type: "string" },
        protocolo_id: { type: "string", description: "Id del protocolo devuelto por buscar_protocolo." },
        inmueble_id: { type: "string", description: "Id del inmueble si se ha localizado. Vacío si no." },
        descripcion: { type: "string", description: "Qué ha contado el vecino, en una o dos frases." },
        urgencia: { type: "string", description: "critica, alta, media o baja. Vacío para usar la del protocolo." },
        solicitante_nombre: { type: "string" },
        solicitante_tel: { type: "string", description: "Vacío si no lo ha dado." },
        solicitante_email: { type: "string", description: "Vacío si no lo ha dado." },
      },
      required: ["comunidad_id", "protocolo_id", "descripcion", "solicitante_nombre"],
    },
  },
  {
    name: "avisar_proveedor",
    description:
      "Manda por correo electrónico la petición de presupuesto al proveedor que ASIGNA EL " +
      "PROTOCOLO del expediente (no eliges tú a quién). El envío es real. Deja el expediente " +
      "en estado asignado y anota el correo en el historial del expediente.",
    input_schema: {
      type: "object",
      properties: { expediente_id: { type: "string" } },
      required: ["expediente_id"],
    },
  },
  {
    name: "escalar_a_administracion",
    description:
      "Para cuando NO hay protocolo, no encuentras la comunidad, o el caso se sale de lo " +
      "que puedes resolver. Abre un expediente sin proveedor para que lo mire una persona " +
      "y avisa al equipo. Úsala en vez de improvisar.",
    input_schema: {
      type: "object",
      properties: {
        comunidad_id: { type: "string", description: "Si la conoces. Vacío si no se ha podido identificar." },
        motivo: { type: "string", description: "Por qué lo escalas, en pocas palabras." },
        descripcion: { type: "string", description: "Lo que ha contado el vecino." },
        solicitante_nombre: { type: "string" },
        solicitante_tel: { type: "string" },
        solicitante_email: { type: "string" },
      },
      required: ["motivo", "descripcion"],
    },
  },
];

/* ------------------------------------------------------------------ tipos */

type Bloque = { type: string; [k: string]: unknown };
type Mensaje = { role: "user" | "assistant"; content: unknown };

/* ----------------------------------------- cliente de base con lista blanca */

/**
 * Todo el acceso a datos del agente pasa por aquí, y aquí se comprueba que
 * la ruta esté permitida ANTES de salir a la red. No es decoración: es la
 * tercera cerradura sobre los datos bancarios, y de paso impide que el
 * agente escriba en presupuestos o facturas.
 */
function rutaPermitida(path: string): boolean {
  const limpio = path.replace(/^\/+/, "");
  if (limpio.startsWith("rpc/")) {
    return RPC_PERMITIDAS.has(limpio.slice(4).split("?")[0]);
  }
  return TABLAS_PERMITIDAS.has(limpio.split("?")[0]);
}

async function db(path: string, init: RequestInit = {}): Promise<any> {
  if (!rutaPermitida(path)) {
    console.warn("[fincas-chat] ruta BLOQUEADA por la lista blanca:", path);
    return null;
  }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      // Firma de quien escribe. PostgREST la publica en el GUC
      // request.headers y fincas_actor() la lee, de modo que en la auditoría
      // lo que abre el agente aparece como 'agente-ia' y no confundido con
      // el resto de procesos backend.
      "x-fincas-actor": "agente-ia",
      ...((init.headers ?? {}) as Record<string, string>),
    },
  });
  if (!r.ok) {
    console.warn("[fincas-chat] PostgREST", path, r.status, await r.text());
    return null;
  }
  const txtRes = await r.text();
  return txtRes ? JSON.parse(txtRes) : null;
}

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

/** Aviso interno por Telegram. Nunca interrumpe la conversación. */
function avisarEquipo(payload: Record<string, unknown>) {
  fetch(`${SUPABASE_URL}/functions/v1/fincas-notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((e) => console.warn("[fincas-chat] no se pudo avisar al equipo:", e));
}

/* ---------------------------------------------------------------- helpers */

function saneaHistorial(bruto: unknown): Mensaje[] {
  const lista = Array.isArray(bruto) ? bruto : [];
  const limpios: Mensaje[] = [];
  for (const m of lista) {
    const rol = (m as { role?: unknown })?.role;
    const contenido = (m as { content?: unknown })?.content;
    if (rol !== "user" && rol !== "assistant") continue;
    if (typeof contenido !== "string") continue;
    const t = contenido.trim().slice(0, 2000);
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
const txt = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

async function llamaAnthropic(mensajes: Mensaje[], system: string) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODELO, max_tokens: MAX_TOKENS, system,
      tools: HERRAMIENTAS, messages: mensajes,
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
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...CORS, "Content-Type": "application/json" },
    });

  const vacio = { protocolo: null, normativa: null, expediente: null, escalado: null };
  const caida = (contexto: unknown = null) => json({ reply: CAIDA, contexto, ...vacio });

  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    console.warn("[fincas-chat] faltan secrets");
    return caida();
  }

  try {
    const cuerpo = await req.json().catch(() => ({}));
    const mensaje = txt((cuerpo as any).mensaje, 2000);
    const ctxEntrada = ((cuerpo as any).contexto ?? {}) as Record<string, unknown>;

    /* La comunidad activa la fija SÓLO buscar_comunidad, o el eco del turno
       anterior una vez comprobado que existe. El modelo no la elige. */
    let comunidadActiva: string | null = null;
    let comunidadNombre = "";
    let inmuebleActivo: string | null = null;
    let puertaActiva = "";

    if (esUuid(ctxEntrada.comunidad_id)) {
      const filas = await db(
        `fincas_comunidades?id=eq.${ctxEntrada.comunidad_id}&activa=is.true&select=id,nombre`,
      );
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
        reply: "Hola, soy Nora, de Whitemoon Fincas. Cuéntame qué ha pasado.",
        contexto: { comunidad_id: null, inmueble_id: null }, ...vacio,
      });
    }

    let system = SYSTEM;
    if (comunidadActiva) {
      system += `\n\nCONTEXTO\n- Comunidad ya identificada: "${comunidadNombre}", comunidad_id = ${comunidadActiva}. NO la vuelvas a preguntar.`;
      if (inmuebleActivo) {
        system += `\n- Inmueble ya identificado: puerta ${puertaActiva}, inmueble_id = ${inmuebleActivo}.`;
      }
    } else {
      system += `\n\nCONTEXTO\n- Todavía NO sabes de qué comunidad te hablan. Averígualo antes de aplicar nada.`;
    }

    let protocoloAplicado: unknown = null;
    let normativaCitada: unknown = null;
    let expedienteCreado: any = null;
    let escalado: unknown = null;
    let textoParcial = "";

    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
      const data = await llamaAnthropic(mensajes, system);
      if (!data) return caida({ comunidad_id: comunidadActiva, inmueble_id: inmuebleActivo });

      if (data.stop_reason !== "tool_use") {
        return json({
          reply: textoDe(data.content) || textoParcial ||
            "Perdona, se me ha cortado. ¿Me lo repites?",
          contexto: { comunidad_id: comunidadActiva, inmueble_id: inmuebleActivo },
          protocolo: protocoloAplicado, normativa: normativaCitada,
          expediente: expedienteCreado, escalado,
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

        /* --------------------------------------------- buscar_comunidad */
        if (bloque.name === "buscar_comunidad") {
          const busca = txt(args.texto, 120);
          const filas = await db("rpc/fincas_buscar_comunidad", {
            method: "POST", body: JSON.stringify({ p_texto: busca }),
          });
          const lista = Array.isArray(filas) ? filas : [];
          if (lista.length === 1) {
            if (lista[0].id !== comunidadActiva) { inmuebleActivo = null; puertaActiva = ""; }
            comunidadActiva = lista[0].id;
            comunidadNombre = lista[0].nombre;
          }
          salida = lista.length
            ? { ok: true, comunidades: lista, fijada: lista.length === 1 ? lista[0].id : null }
            : { ok: true, comunidades: [],
                nota: "Ninguna comunidad dada de alta encaja con eso. No inventes: pregunta otra vez la dirección o escala a administración." };

        /* ---------------------------------------------- buscar_inmueble */
        } else if (bloque.name === "buscar_inmueble") {
          if (!comunidadActiva) {
            salida = { ok: false, error: "Identifica antes la comunidad con buscar_comunidad." };
          } else {
            const puerta = txt(args.puerta, 20);
            const filas = await db(
              `fincas_inmuebles?comunidad_id=eq.${comunidadActiva}&puerta=ilike.${encodeURIComponent(puerta)}&select=id,puerta,propietario_nombre`,
            );
            if (Array.isArray(filas) && filas.length) {
              inmuebleActivo = filas[0].id;
              puertaActiva = filas[0].puerta;
              salida = { ok: true, inmueble_id: filas[0].id, puerta: filas[0].puerta,
                         propietario: filas[0].propietario_nombre };
            } else {
              salida = { ok: true, inmueble: null,
                         nota: `No hay ninguna puerta "${puerta}" dada de alta en ${comunidadNombre}. Se puede seguir sin inmueble.` };
            }
          }

        /* --------------------------------------------- buscar_protocolo */
        } else if (bloque.name === "buscar_protocolo") {
          const pedida = txt(args.comunidad_id, 40);
          if (!comunidadActiva) {
            salida = { ok: false, error: "Identifica antes la comunidad con buscar_comunidad." };
          } else if (pedida && pedida !== comunidadActiva) {
            await auditar("protocolo_denegado", "fincas_protocolos",
              { comunidad_activa: comunidadActiva, comunidad_pedida: pedida });
            salida = { ok: false, error: `No puedes consultar protocolos de otra comunidad. La activa es ${comunidadNombre}.` };
          } else {
            const consulta = [txt(args.categoria, 60), txt(args.subtipo, 60), txt(args.consulta, 300)]
              .filter(Boolean).join(" ");
            const filas = await db("rpc/fincas_buscar_protocolo", {
              method: "POST",
              body: JSON.stringify({ p_comunidad: comunidadActiva, p_consulta: consulta || null }),
            });
            const limpias = (Array.isArray(filas) ? filas : [])
              .filter((p: any) => p.comunidad_id === comunidadActiva);
            if (!limpias.length) {
              salida = { ok: true, protocolos: [],
                nota: `No hay protocolo para ese caso en ${comunidadNombre}. Prueba consultar_normativa; si tampoco, escala a administración. No inventes proveedor.` };
            } else {
              protocoloAplicado = { ...limpias[0], comunidad: comunidadNombre };
              salida = { ok: true, comunidad: comunidadNombre, protocolos: limpias };
            }
          }

        /* ------------------------------------------- consultar_normativa */
        } else if (bloque.name === "consultar_normativa") {
          if (!comunidadActiva) {
            salida = { ok: false, error: "Identifica antes la comunidad." };
          } else {
            const filas = await db("rpc/fincas_buscar_normativa", {
              method: "POST",
              body: JSON.stringify({ p_comunidad: comunidadActiva, p_consulta: txt(args.consulta, 300) }),
            });
            const limpias = (Array.isArray(filas) ? filas : [])
              .filter((d: any) => d.comunidad_id === comunidadActiva);
            if (limpias.length) normativaCitada = { ...limpias[0], comunidad: comunidadNombre };
            salida = limpias.length
              ? { ok: true, documentos: limpias }
              : { ok: true, documentos: [],
                  nota: `No hay nada sobre eso en los documentos de ${comunidadNombre}. Escala a administración en vez de responder de memoria.` };
          }

        /* --------------------------------------------- crear_expediente */
        } else if (bloque.name === "crear_expediente") {
          const pedida = txt(args.comunidad_id, 40);
          if (!comunidadActiva) {
            salida = { ok: false, error: "No hay comunidad identificada." };
          } else if (pedida && pedida !== comunidadActiva) {
            salida = { ok: false, error: "No puedes abrir expedientes en otra comunidad." };
          } else if (!esUuid(args.protocolo_id)) {
            salida = { ok: false, error: "Falta el protocolo_id de buscar_protocolo." };
          } else if (!txt(args.solicitante_nombre)) {
            salida = { ok: false, error: "Falta el nombre del vecino. Pídeselo." };
          } else {
            /* El protocolo se relee filtrando otra vez por comunidad: la cita
               y el proveedor guardados salen de la fila real. */
            const prots = await db(
              `fincas_protocolos?id=eq.${args.protocolo_id}&comunidad_id=eq.${comunidadActiva}` +
              `&select=id,categoria,subtipo,proveedor_nombre,proveedor_tel,urgencia_default,cita_fuente`,
            );
            const p = Array.isArray(prots) && prots.length ? prots[0] : null;
            if (!p) {
              salida = { ok: false, error: "Ese protocolo no es de la comunidad activa." };
            } else {
              const urg = txt(args.urgencia, 20).toLowerCase();
              const creado = await db("fincas_expedientes", {
                method: "POST",
                body: JSON.stringify({
                  comunidad_id: comunidadActiva,
                  inmueble_id: esUuid(args.inmueble_id) ? args.inmueble_id : inmuebleActivo,
                  tipo: p.categoria, subtipo: p.subtipo,
                  urgencia: URGENCIAS.includes(urg) ? urg : p.urgencia_default,
                  estado: "nuevo",
                  descripcion: txt(args.descripcion, 1000),
                  protocolo_id: p.id, protocolo_citado: p.cita_fuente,
                  proveedor_nombre: p.proveedor_nombre, proveedor_tel: p.proveedor_tel,
                  solicitante_nombre: txt(args.solicitante_nombre, 120),
                  solicitante_tel: txt(args.solicitante_tel, 40),
                  solicitante_email: txt(args.solicitante_email, 160),
                }),
              });
              const exp = Array.isArray(creado) && creado.length ? creado[0] : null;
              if (!exp) {
                salida = { ok: false, error: "No se ha podido abrir el expediente." };
              } else {
                expedienteCreado = { ...exp, comunidad: comunidadNombre, puerta: puertaActiva };
                avisarEquipo({ tipo: "expediente", ref: exp.ref, comunidad: comunidadNombre,
                               puerta: puertaActiva, subtipo: exp.subtipo,
                               proveedor: p.proveedor_nombre, urgencia: exp.urgencia });
                salida = { ok: true, expediente_id: exp.id, referencia: exp.ref,
                           urgencia: exp.urgencia, proveedor_asignado: p.proveedor_nombre,
                           protocolo_citado: p.cita_fuente };
              }
            }
          }

        /* ---------------------------------------------- avisar_proveedor */
        } else if (bloque.name === "avisar_proveedor") {
          if (!esUuid(args.expediente_id) || !comunidadActiva) {
            salida = { ok: false, error: "Falta el expediente_id o la comunidad." };
          } else {
            const r = await fetch(`${SUPABASE_URL}/functions/v1/fincas-enviar-email`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-fincas-internal": SERVICE_KEY },
              body: JSON.stringify({ expediente_id: args.expediente_id, tipo: "peticion_presupuesto" }),
            }).then((x) => x.json()).catch(() => null);

            if (r?.ok) {
              salida = { ok: true, proveedor_avisado: r.para, referencia: r.ref,
                         nota: "Correo enviado de verdad al proveedor." };
            } else {
              salida = { ok: false,
                error: r?.error ?? "No se ha podido enviar el correo al proveedor.",
                nota: "Dile al vecino que el expediente queda abierto y que la administración lo cursa. No prometas que ya está avisado." };
            }
          }

        /* --------------------------------------- escalar_a_administracion */
        } else if (bloque.name === "escalar_a_administracion") {
          const comu = comunidadActiva ??
            (esUuid(args.comunidad_id) ? String(args.comunidad_id) : null);
          if (!comu) {
            /* Sin comunidad no hay expediente que valga (la tabla la exige),
               pero el equipo tiene que enterarse igual. */
            await auditar("escalado_sin_comunidad", "fincas_expedientes",
              { motivo: txt(args.motivo, 300), descripcion: txt(args.descripcion, 500),
                contacto: txt(args.solicitante_tel) || txt(args.solicitante_email) });
            avisarEquipo({ tipo: "escalado", motivo: txt(args.motivo, 200),
                           comunidad: "sin identificar",
                           contacto: `${txt(args.solicitante_nombre)} ${txt(args.solicitante_tel)}`.trim() });
            escalado = { comunidad: null, motivo: txt(args.motivo, 300) };
            salida = { ok: true, escalado: true, referencia: null,
                       nota: "Escalado sin comunidad identificada: no hay expediente, pero el equipo ya está avisado." };
          } else {
            const creado = await db("fincas_expedientes", {
              method: "POST",
              body: JSON.stringify({
                comunidad_id: comu,
                inmueble_id: inmuebleActivo,
                tipo: "consulta", subtipo: "sin_protocolo",
                urgencia: "media", estado: "nuevo",
                descripcion: txt(args.descripcion, 1000),
                protocolo_citado: "Sin protocolo aplicable — escalado por el agente",
                solicitante_nombre: txt(args.solicitante_nombre, 120),
                solicitante_tel: txt(args.solicitante_tel, 40),
                solicitante_email: txt(args.solicitante_email, 160),
              }),
            });
            const exp = Array.isArray(creado) && creado.length ? creado[0] : null;
            if (exp) {
              escalado = { ref: exp.ref, comunidad: comunidadNombre, motivo: txt(args.motivo, 300) };
              avisarEquipo({ tipo: "escalado", ref: exp.ref, comunidad: comunidadNombre,
                             motivo: txt(args.motivo, 200) });
              salida = { ok: true, escalado: true, referencia: exp.ref,
                         nota: "Expediente abierto sin proveedor para que lo revise una persona." };
            } else {
              salida = { ok: false, error: "No se ha podido registrar el escalado." };
            }
          }

        } else {
          salida = { ok: false, error: "Herramienta desconocida." };
        }

        resultados.push({
          type: "tool_result", tool_use_id: bloque.id, content: JSON.stringify(salida),
        });
      }

      mensajes.push({ role: "user", content: resultados });
    }

    console.warn("[fincas-chat] agotadas las vueltas de herramienta");
    return json({
      reply: textoParcial || "Lo tengo anotado. ¿Necesitas algo más?",
      contexto: { comunidad_id: comunidadActiva, inmueble_id: inmuebleActivo },
      protocolo: protocoloAplicado, normativa: normativaCitada,
      expediente: expedienteCreado, escalado,
    });
  } catch (e) {
    console.warn("[fincas-chat] error:", e);
    return caida();
  }
});
