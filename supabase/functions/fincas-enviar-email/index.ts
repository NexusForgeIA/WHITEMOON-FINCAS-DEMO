import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* =========================================================================
   fincas-enviar-email — biblioteca de correos por trámite + autonomía
   =========================================================================
   Un correo sale de aquí sólo si tres cosas están claras: qué trámite es,
   qué plantilla le corresponde y si ese trámite puede ir solo o necesita
   que lo mire una persona.

   QUIÉN DECIDE QUÉ
     · El agente elige el TRÁMITE (es lo que sabe hacer: entender la
       situación y clasificarla).
     · La PLANTILLA la resuelve la base (fincas_plantilla), con override por
       comunidad si lo hay.
     · El TEXTO lo rellena este código sustituyendo {{variables}} con datos
       del expediente. El modelo no redacta el correo que sale.
     · Si va solo o no lo decide fincas_decidir_autonomia, una función SQL.
       Ni el prompt ni esta función opinan: preguntan y obedecen.

   VARIABLES SIN RELLENAR = NO SALE
   Si alguna {{variable}} que usa la plantilla se queda vacía, el correo
   pasa a borrador aunque el motor dijera AUTO. Un correo con un hueco donde
   debería ir el nombre del proveedor es peor que no mandar nada.

   ACCIONES
     (por defecto)               preparar y, si procede, enviar
     accion: "enviar_borrador"   un admin aprueba un borrador y sale

   Secrets: RESEND_API_KEY, FINCAS_FROM_EMAIL, FINCAS_INBOUND_EMAIL.
   ========================================================================= */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_EMAIL = Deno.env.get("FINCAS_FROM_EMAIL") ??
  "Whitemoon Fincas <onboarding@resend.dev>";
const INBOUND_EMAIL = Deno.env.get("FINCAS_INBOUND_EMAIL") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-fincas-internal",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Variables que pueden faltar sin que eso estropee el correo. */
const OPCIONALES = new Set(["puerta", "solicitante_tel", "descripcion", "numero_factura"]);

const EUR = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });

async function db(path: string, init: RequestInit = {}, actor = ""): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(actor ? { "x-fincas-actor": actor } : {}),
      ...((init.headers ?? {}) as Record<string, string>),
    },
  });
  if (!r.ok) {
    console.warn("[fincas-enviar-email] PostgREST", path, r.status, await r.text());
    return null;
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

/**
 * ¿Quién llama? De esto depende cómo firma la auditoría y si puede aprobar
 * borradores: sólo una persona aprueba.
 */
async function autorizado(req: Request): Promise<{ tipo: "agente" | "staff"; email: string } | null> {
  if (req.headers.get("x-fincas-internal") === SERVICE_KEY && SERVICE_KEY) {
    return { tipo: "agente", email: "agente-ia" };
  }
  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!jwt || jwt === SERVICE_KEY) return null;

  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!u?.id) return null;

  const perfil = await db(`fincas_perfiles?user_id=eq.${u.id}&activo=is.true&select=email`);
  if (!Array.isArray(perfil) || !perfil.length) return null;
  return { tipo: "staff", email: String(perfil[0].email ?? u.email ?? "administrador") };
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/**
 * Sustituye {{variables}} y devuelve además cuáles se han quedado vacías.
 * Determinista y sin modelo de por medio: lo que sale es la plantilla que
 * escribió una persona con los datos que hay en la base.
 */
function renderiza(plantilla: string, vars: Record<string, string>) {
  const faltantes = new Set<string>();
  const texto = plantilla.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, clave: string) => {
    const k = clave.toLowerCase();
    const v = (vars[k] ?? "").trim();
    if (!v && !OPCIONALES.has(k)) faltantes.add(k);
    return v;
  });
  return { texto, faltantes: [...faltantes] };
}

function aHtml(cuerpo: string) {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#111;max-width:620px;white-space:pre-wrap">${esc(cuerpo)}</div>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...CORS, "Content-Type": "application/json" },
    });

  if (!SUPABASE_URL || !SERVICE_KEY) return json({ ok: false, error: "servicio no configurado" }, 500);

  const quien = await autorizado(req);
  if (!quien) return json({ ok: false, error: "no autorizado" }, 401);
  const actor = quien.tipo === "agente" ? "agente-ia" : "";

  /** Manda de verdad. Separado para que el camino de aprobar un borrador y
      el de enviar directo compartan exactamente el mismo código. */
  async function despacha(para: string, asunto: string, cuerpo: string) {
    if (!RESEND_API_KEY) {
      return { ok: false, estado: "pendiente", error: "Falta RESEND_API_KEY: el correo queda encolado, no enviado." };
    }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_EMAIL, to: [para], subject: asunto, html: aHtml(cuerpo),
        ...(INBOUND_EMAIL ? { reply_to: INBOUND_EMAIL } : {}),
      }),
    });
    if (!r.ok) {
      const detalle = (await r.text()).slice(0, 300);
      return { ok: false, estado: "fallido", error: `Resend ${r.status}: ${detalle}` };
    }
    return { ok: true, estado: "enviado", error: "" };
  }

  try {
    const c = await req.json().catch(() => ({}));
    const accion = String((c as any).accion ?? "preparar").trim();

    /* ---------------------------------------------------------------- */
    /* Aprobar un borrador y mandarlo. Sólo una persona.                 */
    /* ---------------------------------------------------------------- */
    if (accion === "enviar_borrador") {
      if (quien.tipo !== "staff") {
        return json({ ok: false, error: "sólo una persona puede aprobar un borrador" }, 403);
      }
      const id = String((c as any).comunicacion_id ?? "").trim();
      if (!UUID_RE.test(id)) return json({ ok: false, error: "comunicacion_id no válido" }, 400);

      const filas = await db(`fincas_comunicaciones?id=eq.${id}&estado=eq.borrador&select=*`);
      const com = Array.isArray(filas) && filas.length ? filas[0] : null;
      if (!com) return json({ ok: false, error: "ese borrador no existe o ya se decidió" }, 404);
      if (!com.para_email) return json({ ok: false, error: "el borrador no tiene destinatario" }, 422);

      const res = await despacha(com.para_email, com.asunto, com.cuerpo);
      await db(`fincas_comunicaciones?id=eq.${id}&estado=eq.borrador`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          estado: res.estado, error: res.error, aprobado_por: quien.email,
        }),
      });
      if (res.ok && com.expediente_id) {
        await db(`fincas_expedientes?id=eq.${com.expediente_id}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ estado: "asignado", proveedor_avisado_at: new Date().toISOString() }),
        });
      }
      return json({ ok: res.ok, estado: res.estado, error: res.error, para: com.para_email });
    }

    /* ---------------------------------------------------------------- */
    /* Preparar el correo del trámite.                                   */
    /* ---------------------------------------------------------------- */
    const expedienteId = String((c as any).expediente_id ?? "").trim();
    const tramite = String((c as any).tramite ?? "solicitud_presupuesto").trim().toLowerCase();
    const facturaId = String((c as any).factura_id ?? "").trim();
    if (!UUID_RE.test(expedienteId)) return json({ ok: false, error: "expediente_id no válido" }, 400);

    const exps = await db(
      `fincas_expedientes?id=eq.${expedienteId}` +
      `&select=*,fincas_comunidades(nombre,direccion),fincas_inmuebles(puerta,propietario_nombre,propietario_email)`,
    );
    const exp = Array.isArray(exps) && exps.length ? exps[0] : null;
    if (!exp) return json({ ok: false, error: "expediente no encontrado" }, 404);

    const plantillas = await db("rpc/fincas_plantilla", {
      method: "POST",
      body: JSON.stringify({ p_comunidad: exp.comunidad_id, p_tramite: tramite }),
    });
    const plantilla = Array.isArray(plantillas) && plantillas.length ? plantillas[0] : null;
    if (!plantilla) {
      return json({ ok: false, error: `no hay plantilla activa para el trámite "${tramite}"` }, 404);
    }

    /* El importe se DERIVA, nunca se acepta de quien llama: si viniera en la
       petición bastaría con mandar `importe: 1` para colar una adjudicación
       por debajo del umbral.

       Y sólo se deriva para los trámites que COMPROMETEN dinero. Pedir un
       presupuesto es operativo aunque el expediente ya tenga uno aprobado:
       colgarle esa cifra haría que una petición de presupuesto necesitara
       aprobación por un dinero que ese correo no gasta. */
    let importe: number | null = null;
    let factura: any = null;
    if (UUID_RE.test(facturaId)) {
      const fs = await db(`fincas_facturas?id=eq.${facturaId}&select=id,numero,total,proveedor_nombre`);
      factura = Array.isArray(fs) && fs.length ? fs[0] : null;
    }
    if (plantilla.categoria !== "operativo") {
      if (factura?.total != null) {
        importe = Number(factura.total);
      } else {
        const ps = await db(
          `fincas_presupuestos?expediente_id=eq.${exp.id}&estado=eq.aprobado&select=importe&order=decidido_at.desc&limit=1`,
        );
        if (Array.isArray(ps) && ps.length && ps[0].importe != null) importe = Number(ps[0].importe);
      }
    }

    const decisiones = await db("rpc/fincas_decidir_autonomia", {
      method: "POST",
      body: JSON.stringify({
        p_comunidad: exp.comunidad_id, p_tramite: tramite, p_importe: importe,
      }),
    });
    const decision = Array.isArray(decisiones) && decisiones.length
      ? decisiones[0]
      : { modo: "revision", motivo: "No se ha podido consultar el motor de autonomía.", categoria: "desconocido", umbral: 0 };

    /* Destinatario según el trámite. Un admin puede forzarlo; el agente no. */
    const comunidad = exp.fincas_comunidades ?? {};
    const inmueble = exp.fincas_inmuebles ?? {};
    let proveedorEmail = "";
    if (exp.proveedor_nombre) {
      const provs = await db(
        `fincas_proveedores?nombre=eq.${encodeURIComponent(exp.proveedor_nombre)}&activo=is.true&select=id,nombre,email`,
      );
      if (Array.isArray(provs) && provs.length) proveedorEmail = String(provs[0].email ?? "").trim();
    }
    const forzado = quien.tipo === "staff" ? String((c as any).para_email ?? "").trim() : "";
    const para = forzado || (tramite === "aviso_propietario"
      ? String(exp.solicitante_email || inmueble.propietario_email || "").trim()
      : proveedorEmail);

    const vars: Record<string, string> = {
      ref: exp.ref ?? "",
      comunidad: comunidad.nombre ?? "",
      direccion: comunidad.direccion ?? "",
      puerta: inmueble.puerta ? `, puerta ${inmueble.puerta}` : "",
      propietario: inmueble.propietario_nombre ?? "",
      tipo: exp.tipo ?? "",
      subtipo: exp.subtipo ?? "",
      urgencia: exp.urgencia ?? "",
      descripcion: exp.descripcion ?? "",
      proveedor: exp.proveedor_nombre ?? "",
      solicitante: exp.solicitante_nombre ?? "",
      solicitante_tel: exp.solicitante_tel ?? "",
      importe: importe !== null ? EUR.format(importe) : "",
      numero_factura: factura?.numero ?? "",
      fecha: new Date().toLocaleDateString("es-ES"),
      administracion: "Whitemoon Fincas · Administración de fincas",
    };

    const asunto = renderiza(plantilla.asunto, vars);
    const cuerpo = renderiza(plantilla.cuerpo, vars);
    const faltantes = [...new Set([...asunto.faltantes, ...cuerpo.faltantes])];

    /* Tres motivos para NO mandarlo solo, y basta con uno. */
    const motivos: string[] = [];
    if (decision.modo !== "auto") motivos.push(decision.motivo);
    if (faltantes.length) motivos.push(`Faltan datos por rellenar: ${faltantes.join(", ")}.`);
    if (!para) motivos.push("No hay destinatario: el proveedor no tiene email o no está dado de alta.");

    const registra = (estado: string, error: string) =>
      db("fincas_comunicaciones", {
        method: "POST",
        body: JSON.stringify({
          expediente_id: exp.id, comunidad_id: exp.comunidad_id,
          direccion: "saliente", canal: "email", estado,
          de_email: FROM_EMAIL, para_email: para,
          asunto: asunto.texto, cuerpo: cuerpo.texto,
          tramite, plantilla_id: plantilla.id, error,
          decision: {
            modo: decision.modo, motivo: decision.motivo,
            categoria: decision.categoria, umbral: decision.umbral,
            importe, faltantes, decidido_por: quien.email,
          },
        }),
      }, actor);

    if (motivos.length) {
      const creado = await registra("borrador", motivos.join(" "));
      const com = Array.isArray(creado) && creado.length ? creado[0] : null;
      fetch(`${SUPABASE_URL}/functions/v1/fincas-notify`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tipo: "aprobacion", concepto: `Correo en borrador · ${tramite}`,
          comunidad: comunidad.nombre ?? "", detalle: `${exp.ref} · ${motivos.join(" ")}`,
        }),
      }).catch(() => {});
      return json({
        ok: true, enviado: false, modo: "borrador", comunicacion_id: com?.id ?? null,
        motivo: motivos.join(" "), tramite, para, asunto: asunto.texto,
      });
    }

    const res = await despacha(para, asunto.texto, cuerpo.texto);
    await registra(res.estado, res.error);
    if (res.ok) {
      await db(`fincas_expedientes?id=eq.${exp.id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ estado: "asignado", proveedor_avisado_at: new Date().toISOString() }),
      }, actor);
    }

    return json({
      ok: res.ok, enviado: res.ok, modo: "auto", motivo: decision.motivo,
      tramite, para, ref: exp.ref, asunto: asunto.texto,
      ...(res.ok ? {} : { error: res.error, estado: res.estado }),
    }, res.ok ? 200 : 503);
  } catch (e) {
    console.warn("[fincas-enviar-email] error:", e);
    return json({ ok: false, error: "error inesperado" }, 500);
  }
});
