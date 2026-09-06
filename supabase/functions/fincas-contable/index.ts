import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* =========================================================================
   fincas-contable — el Contable IA de Whitemoon Fincas
   =========================================================================
   Ayuda al equipo de contabilidad a meter facturas, cotejarlas con lo
   presupuestado y dejar preparado lo que haga falta. NO aprueba, NO paga y
   NO ve un IBAN en su vida.

   QUÉ HACE EL MODELO Y QUÉ NO
   El modelo LEE: de un texto de factura saca número, fecha, base, IVA y
   proveedor. Eso es comprensión de lenguaje y se le da bien.
   El modelo NO CALCULA: la comprobación de que base + IVA = total la hace
   `compruebaTotales()`, aquí abajo, en TypeScript. Los modelos fallan
   sumando, y una factura mal cuadrada que pasa por buena es dinero que
   sale mal. Si el modelo escribe un total, se ignora: vale el calculado.

   BARRERAS, TODAS EN CÓDIGO
     · Ninguna herramienta lee ni escribe datos bancarios. El esquema
       fincas_privado no está en la lista blanca de rutas, así que ni con un
       despiste futuro se llega.
     · Ninguna herramienta ejecuta un pago. `preparar_borrador_pago` deja
       una propuesta en la cola y ahí se queda hasta que una persona la
       apruebe. No hay integración bancaria en ningún sitio de este
       proyecto.
     · Ninguna herramienta pone una factura en 'aprobada'. Como mucho la
       deja en 'borrador' (cuadra todo) o en 'revisar' (algo no cuadra).
       Aprobar es un botón del CRM que pulsa una persona.
     · Si falta un dato o algo no cuadra → 'revisar' + aviso a Telegram. No
       se rellena a ojo ni se da por bueno.

   verify_jwt: false pero con puerta propia: exige JWT de alguien con perfil
   activo. Esto no lo usa un vecino.
   ========================================================================= */

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MODELO = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1400;
const MAX_HISTORIAL = 14;
const MAX_VUELTAS = 6;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

/* Lista blanca. fincas_privado_* no está, ni lo estará. */
const TABLAS_PERMITIDAS = new Set([
  "fincas_facturas",
  "fincas_presupuestos",
  "fincas_expedientes",
  "fincas_comunidades",
  "fincas_inmuebles",
  "fincas_proveedores",
  "fincas_comunicaciones",
  "fincas_auditoria",
]);
const RPC_PERMITIDAS = new Set(["fincas_decidir_autonomia"]);

const SYSTEM = `Eres el Contable IA de Whitemoon Fincas, una administración de fincas. Ayudas al equipo de contabilidad con las facturas de los proveedores.

QUÉ HACES
- Lees facturas y sacas sus datos: número, fecha, proveedor, base imponible, IVA y total.
- Las cotejas con el presupuesto aprobado del expediente.
- Preparas borradores: de pago y de certificados de deuda.
- Explicas en dos frases qué has encontrado.

QUÉ NO HACES, NUNCA
- No apruebas facturas. Eso lo hace una persona en el CRM.
- No pagas nada. No tienes forma de hacerlo y no la pidas.
- No ves ni pides IBAN, cuentas bancarias ni datos del presidente. Si te los mencionan, di que esos datos no están a tu alcance y sigue.
- No calculas de cabeza. Para comprobar si base + IVA da el total, llama SIEMPRE a comprobar_totales. Si escribes tú un número que no venga de una herramienta, estás inventando.

CÓMO TRABAJAS
- Para meter una factura: primero comprobar_totales con lo que hayas leído, y después extraer_factura para guardarla.
- Si la factura da el tipo de IVA pero no la cuota en euros, NO mandes cuota 0: omite el campo y deja que se calcule.
- Después de guardar, llama a cotejar_con_presupuesto: es lo que detecta si el importe no coincide, si no hay presupuesto aprobado, si la factura está duplicada o si el proveedor no es el que hizo el presupuesto.
- Si algo no cuadra o falta un dato, dilo claramente. La factura se queda en "revisar" y el equipo recibe un aviso. NO intentes arreglarlo tú ni rellenar el hueco a ojo.
- Si te falta el expediente o la comunidad, pregunta. No adivines.

SI TE PREGUNTAN POR EL SISTEMA
- La contabilidad y la gestión las lleva el propio sistema de la administración: facturas, presupuestos, expedientes y comunidades están todos aquí. No dependemos de ningún ERP ni programa externo.
- Si preguntan por integrar un software de terceros, di que se estudia como proyecto aparte y que lo vea el equipo. No prometas nada.

CÓMO HABLAS
- Máximo 4 frases. Directo, de contabilidad: cifras y hechos.
- Cuando haya discrepancias, enuméralas tal cual te las devuelve la herramienta.`;

const HERRAMIENTAS = [
  {
    name: "comprobar_totales",
    description:
      "Comprueba de forma DETERMINISTA que base + IVA = total. Hazlo SIEMPRE antes de " +
      "guardar una factura. Puedes pasar el IVA como porcentaje, como importe, o ambos. " +
      "Devuelve el total calculado; si no coincide con el declarado, lo dice.",
    input_schema: {
      type: "object",
      properties: {
        base: { type: "number", description: "Base imponible en euros." },
        iva_porcentaje: { type: "number", description: "Tipo de IVA, por ejemplo 21. Omite si no aparece." },
        iva_importe: { type: "number", description: "Cuota de IVA en euros. OMITE el campo si la factura no da la cuota; no mandes 0." },
        total_declarado: { type: "number", description: "El total que pone la factura." },
      },
      required: ["base"],
    },
  },
  {
    name: "extraer_factura",
    description:
      "Guarda la factura leída. Queda en 'revisar' si algo no cuadra y en 'borrador' si " +
      "todo cuadra — nunca aprobada. Requiere la comunidad; el expediente es muy " +
      "recomendable porque sin él no se puede cotejar con el presupuesto.",
    input_schema: {
      type: "object",
      properties: {
        comunidad_id: { type: "string" },
        expediente_id: { type: "string", description: "Vacío si la factura no va contra un expediente." },
        proveedor_nombre: { type: "string" },
        numero: { type: "string", description: "Número de factura." },
        fecha_factura: { type: "string", description: "Fecha en formato AAAA-MM-DD." },
        concepto: { type: "string" },
        base: { type: "number" },
        iva_porcentaje: { type: "number" },
        iva_importe: { type: "number", description: "Cuota de IVA en euros. OMITE el campo si no aparece; no mandes 0." },
        total_declarado: { type: "number" },
        pdf_ref: { type: "string", description: "Ruta del PDF en Storage, si la hay." },
      },
      required: ["comunidad_id", "proveedor_nombre", "base"],
    },
  },
  {
    name: "cotejar_con_presupuesto",
    description:
      "Compara la factura con el presupuesto aprobado de su expediente y marca las " +
      "discrepancias: importe distinto del presupuestado, sin presupuesto aprobado, " +
      "factura duplicada o proveedor que no coincide. Deja la factura en 'revisar' si " +
      "encuentra algo.",
    input_schema: {
      type: "object",
      properties: { factura_id: { type: "string" } },
      required: ["factura_id"],
    },
  },
  {
    name: "preparar_borrador_pago",
    description:
      "Deja preparada una PROPUESTA de pago en la cola de aprobación. No paga nada ni " +
      "puede hacerlo: no hay integración bancaria ni acceso a cuentas. La propuesta " +
      "espera a que una persona apruebe la factura.",
    input_schema: {
      type: "object",
      properties: {
        factura_id: { type: "string" },
        fecha_propuesta: { type: "string", description: "AAAA-MM-DD. Vacío para 30 días desde hoy." },
        nota: { type: "string" },
      },
      required: ["factura_id"],
    },
  },
  {
    name: "generar_certificado_deuda",
    description:
      "Prepara un certificado de deuda en BORRADOR para un propietario de una comunidad. " +
      "No se emite: queda en la cola hasta que una persona lo apruebe.",
    input_schema: {
      type: "object",
      properties: {
        comunidad_id: { type: "string" },
        inmueble_id: { type: "string", description: "Vivienda del propietario. Vacío si no se ha localizado." },
        propietario: { type: "string", description: "Nombre del propietario." },
        importe: { type: "number", description: "Deuda pendiente en euros." },
        periodo: { type: "string", description: "Periodo al que corresponde, por ejemplo '2026 T1'." },
      },
      required: ["comunidad_id", "propietario", "importe"],
    },
  },
];

type Bloque = { type: string; [k: string]: unknown };
type Mensaje = { role: "user" | "assistant"; content: unknown };

/* ------------------------------------------------- acceso a datos */

function rutaPermitida(path: string): boolean {
  const limpio = path.replace(/^\/+/, "");
  if (limpio.startsWith("rpc/")) return RPC_PERMITIDAS.has(limpio.slice(4).split("?")[0]);
  return TABLAS_PERMITIDAS.has(limpio.split("?")[0]);
}

async function db(path: string, init: RequestInit = {}): Promise<any> {
  if (!rutaPermitida(path)) {
    console.warn("[fincas-contable] ruta BLOQUEADA por la lista blanca:", path);
    return null;
  }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      "x-fincas-actor": "agente-ia",
      ...((init.headers ?? {}) as Record<string, string>),
    },
  });
  if (!r.ok) {
    console.warn("[fincas-contable] PostgREST", path, r.status, await r.text());
    return null;
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function esStaff(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!jwt || jwt === SERVICE_KEY) return null;
  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!u?.id) return null;
  // fincas_perfiles no está en la lista blanca a propósito: la comprobación
  // de permisos va por su propia consulta, no por el cliente del agente.
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/fincas_perfiles?user_id=eq.${u.id}&activo=is.true&select=email`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  ).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  return Array.isArray(r) && r.length ? String(r[0].email ?? u.email ?? "contabilidad") : null;
}

function avisa(payload: Record<string, unknown>) {
  fetch(`${SUPABASE_URL}/functions/v1/fincas-notify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((e) => console.warn("[fincas-contable] aviso:", e));
}

/* ============================================================= */
/* LA ARITMÉTICA. Aquí, en TypeScript, y en ningún otro sitio.    */
/* ============================================================= */

/** Redondeo a 2 decimales sin arrastrar el ruido binario de los float. */
const dos = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/**
 * compruebaTotales — la comprobación que el modelo NO hace.
 *
 * Acepta el IVA como porcentaje, como importe o como ambos, porque las
 * facturas vienen de las dos maneras. Si vienen los dos y no concuerdan,
 * eso ya es una discrepancia por sí sola.
 *
 * Tolerancia de 1 céntimo: los redondeos legítimos de una factura pueden
 * separarse eso, y marcar como sospechoso un céntimo sería ruido.
 */
function compruebaTotales(
  base: unknown, ivaPct: unknown, ivaImp: unknown, totalDecl: unknown,
) {
  const notas: string[] = [];
  const b = num(base);
  if (b === null || b < 0) {
    return { ok: false, notas: ["La base imponible no es un número válido."], base: null,
             iva_porcentaje: null, iva_importe: null, total_calculado: null,
             total_declarado: num(totalDecl), diferencia: null };
  }

  let pct = num(ivaPct);
  let cuota = num(ivaImp);

  if (pct === null && cuota === null) {
    notas.push("No consta el IVA: ni tipo ni cuota. Se toma cuota 0 y hay que revisarlo.");
    cuota = 0;
    pct = 0;
  } else if (cuota === null) {
    cuota = dos(b * (pct as number) / 100);
  } else if (pct === null) {
    pct = b > 0 ? dos(cuota / b * 100) : 0;
  } else {
    const esperada = dos(b * pct / 100);
    /* Una factura con tipo 21% y cuota 0 € no existe. Cuando llegan las dos
       cosas y la cuota es cero, no es una contradicción de la factura: es
       que quien la leyó no encontró la cuota y mandó 0 por defecto. Se
       toma la del tipo y sigue el control de verdad, que es cuadrar contra
       el total declarado. Marcar esto como sospechoso haría saltar la
       alarma en casi todas las facturas reales, y una alarma que salta
       siempre no la mira nadie. */
    if (pct > 0 && cuota === 0 && esperada > 0) {
      cuota = esperada;
    } else if (Math.abs(esperada - cuota) > 0.01) {
      notas.push(
        `El tipo de IVA (${pct}%) sobre la base daría ${esperada.toFixed(2)} €, ` +
        `pero la cuota declarada es ${cuota.toFixed(2)} €.`,
      );
    }
  }

  const total = dos(b + (cuota as number));
  const decl = num(totalDecl);
  const dif = decl === null ? null : dos(total - decl);

  if (decl !== null && Math.abs(dif as number) > 0.01) {
    notas.push(
      `El total no cuadra: base ${b.toFixed(2)} € + IVA ${(cuota as number).toFixed(2)} € = ` +
      `${total.toFixed(2)} €, y la factura dice ${decl.toFixed(2)} €.`,
    );
  }

  return {
    ok: notas.length === 0,
    notas,
    base: dos(b),
    iva_porcentaje: pct === null ? null : dos(pct),
    iva_importe: dos(cuota as number),
    total_calculado: total,
    total_declarado: decl,
    diferencia: dif,
  };
}

/* ---------------------------------------------------------------- helpers */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const txt = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function saneaHistorial(bruto: unknown): Mensaje[] {
  const lista = Array.isArray(bruto) ? bruto : [];
  const limpios: Mensaje[] = [];
  for (const m of lista) {
    const rol = (m as any)?.role;
    const cont = (m as any)?.content;
    if ((rol !== "user" && rol !== "assistant") || typeof cont !== "string") continue;
    const t = cont.trim().slice(0, 4000);
    if (t) limpios.push({ role: rol, content: t });
  }
  const rec = limpios.slice(-MAX_HISTORIAL);
  while (rec.length && rec[0].role !== "user") rec.shift();
  return rec;
}

function textoDe(bloques: unknown): string {
  if (!Array.isArray(bloques)) return "";
  return bloques.filter((b: Bloque) => b?.type === "text")
    .map((b: Bloque) => String(b.text ?? "")).join("\n").trim();
}

async function llamaAnthropic(mensajes: Mensaje[]) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODELO, max_tokens: MAX_TOKENS, system: SYSTEM,
      tools: HERRAMIENTAS, messages: mensajes,
    }),
  });
  if (!r.ok) {
    console.warn("[fincas-contable] Anthropic", r.status, await r.text());
    return null;
  }
  return await r.json();
}

/* ============================================================= */
/* COTEJO — también en código, no en el prompt.                   */
/* ============================================================= */

async function cotejaFactura(facturaId: string) {
  const fs = await db(`fincas_facturas?id=eq.${facturaId}&select=*`);
  const f = Array.isArray(fs) && fs.length ? fs[0] : null;
  if (!f) return { ok: false, error: "factura no encontrada" };

  const discrepancias: { codigo: string; detalle: string }[] = [];

  // 1 · Duplicada: mismo proveedor y mismo número.
  if (f.numero) {
    const dup = await db(
      `fincas_facturas?numero=eq.${encodeURIComponent(f.numero)}` +
      `&proveedor_nombre=eq.${encodeURIComponent(f.proveedor_nombre ?? "")}` +
      `&id=neq.${f.id}&select=id,created_at`,
    );
    if (Array.isArray(dup) && dup.length) {
      discrepancias.push({
        codigo: "factura_duplicada",
        detalle: `Ya hay ${dup.length} factura(s) con el número ${f.numero} de ${f.proveedor_nombre}.`,
      });
    }
  }

  // 2, 3 y 4 · Contra el presupuesto aprobado del expediente.
  if (!f.expediente_id) {
    discrepancias.push({
      codigo: "sin_presupuesto_aprobado",
      detalle: "La factura no está ligada a ningún expediente, así que no hay presupuesto con el que compararla.",
    });
  } else {
    const ps = await db(
      `fincas_presupuestos?expediente_id=eq.${f.expediente_id}&estado=eq.aprobado` +
      `&select=id,importe,proveedor_nombre&order=decidido_at.desc&limit=1`,
    );
    const p = Array.isArray(ps) && ps.length ? ps[0] : null;

    if (!p) {
      discrepancias.push({
        codigo: "sin_presupuesto_aprobado",
        detalle: "El expediente no tiene ningún presupuesto aprobado.",
      });
    } else {
      if (p.importe != null && f.total != null) {
        const dif = dos(Number(f.total) - Number(p.importe));
        if (Math.abs(dif) > 0.01) {
          discrepancias.push({
            codigo: "importe_distinto_presupuesto",
            detalle: `Presupuestado ${Number(p.importe).toFixed(2)} € y facturado ` +
              `${Number(f.total).toFixed(2)} €: ${dif > 0 ? "+" : ""}${dif.toFixed(2)} €.`,
          });
        }
      }
      const pn = txt(p.proveedor_nombre).toLowerCase();
      const fn = txt(f.proveedor_nombre).toLowerCase();
      if (pn && fn && pn !== fn) {
        discrepancias.push({
          codigo: "proveedor_no_coincide",
          detalle: `El presupuesto lo dio "${p.proveedor_nombre}" y la factura viene de "${f.proveedor_nombre}".`,
        });
      }
    }
  }

  // Las notas aritméticas guardadas al extraer también cuentan.
  const previas = Array.isArray(f.discrepancias) ? f.discrepancias : [];
  const aritmeticas = previas.filter((d: any) => d?.codigo === "totales_no_cuadran");
  const todas = [...aritmeticas, ...discrepancias];

  const estado = todas.length ? "revisar" : "borrador";
  await db(`fincas_facturas?id=eq.${f.id}&estado=in.(borrador,revisar)`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ discrepancias: todas, estado }),
  });

  return { ok: true, estado, discrepancias: todas, factura: { id: f.id, numero: f.numero, total: f.total } };
}

/* --------------------------------------------------------------- servidor */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...CORS, "Content-Type": "application/json" },
    });

  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    return json({ ok: false, error: "servicio no configurado" }, 500);
  }

  const actor = await esStaff(req);
  if (!actor) return json({ ok: false, error: "no autorizado" }, 401);

  try {
    const c = await req.json().catch(() => ({}));
    const mensaje = txt((c as any).mensaje, 8000);
    const mensajes = saneaHistorial((c as any).historial);
    if (mensaje) mensajes.push({ role: "user", content: mensaje });
    while (mensajes.length && mensajes[0].role !== "user") mensajes.shift();

    if (!mensajes.length) {
      return json({
        reply: "Pásame el texto de una factura y la reviso: número, base, IVA y total, " +
               "y la coteje con el presupuesto del expediente.",
        facturas: [],
      });
    }

    const tocadas: any[] = [];
    let textoParcial = "";

    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
      const data = await llamaAnthropic(mensajes);
      if (!data) return json({ ok: false, error: "el modelo no responde" }, 503);

      if (data.stop_reason !== "tool_use") {
        return json({
          ok: true,
          reply: textoDe(data.content) || textoParcial || "Listo.",
          facturas: tocadas,
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

        /* ------------------------------------------- comprobar_totales */
        if (bloque.name === "comprobar_totales") {
          salida = compruebaTotales(
            args.base, args.iva_porcentaje, args.iva_importe, args.total_declarado,
          );

        /* --------------------------------------------- extraer_factura */
        } else if (bloque.name === "extraer_factura") {
          if (!esUuid(args.comunidad_id)) {
            salida = { ok: false, error: "Falta la comunidad. Pregúntala, no la adivines." };
          } else {
            const cuentas = compruebaTotales(
              args.base, args.iva_porcentaje, args.iva_importe, args.total_declarado,
            );
            if (cuentas.base === null) {
              salida = { ok: false, error: "La base imponible no es un número válido." };
            } else {
              /* Se guarda el total CALCULADO, no el que dijo el modelo. */
              const discrepancias = cuentas.notas.length
                ? [{ codigo: "totales_no_cuadran", detalle: cuentas.notas.join(" ") }]
                : [];
              const fecha = txt(args.fecha_factura, 10);
              const creado = await db("fincas_facturas", {
                method: "POST",
                body: JSON.stringify({
                  comunidad_id: args.comunidad_id,
                  expediente_id: esUuid(args.expediente_id) ? args.expediente_id : null,
                  tipo: "factura",
                  proveedor_nombre: txt(args.proveedor_nombre, 140),
                  numero: txt(args.numero, 60),
                  fecha_factura: FECHA_RE.test(fecha) ? fecha : null,
                  concepto: txt(args.concepto, 200),
                  base: cuentas.base,
                  iva_porcentaje: cuentas.iva_porcentaje,
                  iva_importe: cuentas.iva_importe,
                  total: cuentas.total_calculado,
                  importe: cuentas.total_calculado,
                  pdf_ref: txt(args.pdf_ref, 300),
                  origen: "contable-ia",
                  estado: discrepancias.length ? "revisar" : "borrador",
                  discrepancias,
                }),
              });
              const f = Array.isArray(creado) && creado.length ? creado[0] : null;
              if (!f) {
                salida = { ok: false, error: "No se ha podido guardar la factura." };
              } else {
                tocadas.push(f);
                if (discrepancias.length) {
                  avisa({ tipo: "aprobacion", concepto: "Factura para revisar",
                          detalle: `${f.numero || "sin número"} · ${f.proveedor_nombre} · ${cuentas.notas.join(" ")}` });
                }
                salida = {
                  ok: true, factura_id: f.id, estado: f.estado,
                  total_guardado: cuentas.total_calculado,
                  notas: cuentas.notas,
                  siguiente: "Llama ahora a cotejar_con_presupuesto con este factura_id.",
                };
              }
            }
          }

        /* ------------------------------------ cotejar_con_presupuesto */
        } else if (bloque.name === "cotejar_con_presupuesto") {
          if (!esUuid(args.factura_id)) {
            salida = { ok: false, error: "factura_id no válido." };
          } else {
            const r = await cotejaFactura(String(args.factura_id));
            if (r.ok && r.discrepancias?.length) {
              avisa({
                tipo: "aprobacion", concepto: "Factura con discrepancias",
                detalle: r.discrepancias.map((d: any) => d.detalle).join(" · "),
              });
            }
            salida = r;
          }

        /* ------------------------------------- preparar_borrador_pago */
        } else if (bloque.name === "preparar_borrador_pago") {
          if (!esUuid(args.factura_id)) {
            salida = { ok: false, error: "factura_id no válido." };
          } else {
            const fs = await db(`fincas_facturas?id=eq.${args.factura_id}&select=*`);
            const f = Array.isArray(fs) && fs.length ? fs[0] : null;
            if (!f) {
              salida = { ok: false, error: "factura no encontrada" };
            } else if (f.estado === "rechazada") {
              salida = { ok: false, error: "Esa factura está rechazada: no se prepara pago." };
            } else {
              const fecha = txt(args.fecha_propuesta, 10);
              const propuesta = FECHA_RE.test(fecha)
                ? fecha
                : new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
              await db(`fincas_facturas?id=eq.${f.id}`, {
                method: "PATCH", headers: { Prefer: "return=minimal" },
                body: JSON.stringify({
                  pago_propuesto: {
                    importe: f.total, fecha_propuesta: propuesta,
                    nota: txt(args.nota, 300), preparado_por: "agente-ia",
                    requiere_aprobacion: true, ejecutado: false,
                  },
                }),
              });
              avisa({ tipo: "aprobacion", concepto: "Propuesta de pago preparada",
                      detalle: `${f.numero || "sin número"} · ${f.proveedor_nombre} · ${f.total ?? "?"} € · para el ${propuesta}` });
              salida = {
                ok: true, factura_id: f.id, fecha_propuesta: propuesta,
                estado_factura: f.estado,
                nota: "Es una PROPUESTA en la cola. No se ha pagado nada: esta herramienta " +
                      "no ejecuta pagos ni tiene acceso a datos bancarios. Tiene que aprobarlo una persona.",
              };
            }
          }

        /* --------------------------------- generar_certificado_deuda */
        } else if (bloque.name === "generar_certificado_deuda") {
          const importe = num(args.importe);
          if (!esUuid(args.comunidad_id)) {
            salida = { ok: false, error: "Falta la comunidad." };
          } else if (importe === null || importe <= 0) {
            salida = { ok: false, error: "El importe de la deuda no es válido. Pregúntalo." };
          } else {
            const creado = await db("fincas_facturas", {
              method: "POST",
              body: JSON.stringify({
                comunidad_id: args.comunidad_id,
                inmueble_id: esUuid(args.inmueble_id) ? args.inmueble_id : null,
                tipo: "certificado_deuda",
                concepto: `Certificado de deuda · ${txt(args.propietario, 120)}`,
                importe: dos(importe), total: dos(importe),
                periodo: txt(args.periodo, 40),
                estado: "borrador", origen: "contable-ia",
              }),
            });
            const f = Array.isArray(creado) && creado.length ? creado[0] : null;
            if (!f) {
              salida = { ok: false, error: "No se ha podido crear el certificado." };
            } else {
              tocadas.push(f);
              avisa({ tipo: "aprobacion", concepto: "Certificado de deuda en borrador",
                      detalle: `${txt(args.propietario, 120)} · ${dos(importe).toFixed(2)} €` });
              salida = { ok: true, certificado_id: f.id, estado: "borrador",
                         nota: "Queda en borrador. No se emite hasta que una persona lo apruebe." };
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

    return json({ ok: true, reply: textoParcial || "Lo he dejado anotado.", facturas: tocadas });
  } catch (e) {
    console.warn("[fincas-contable] error:", e);
    return json({ ok: false, error: "error inesperado" }, 500);
  }
});
