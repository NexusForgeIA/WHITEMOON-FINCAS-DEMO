import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* =========================================================================
   fincas-enviar-email — correo REAL al proveedor, vía Resend
   =========================================================================
   Manda la petición de presupuesto al email del proveedor asignado por el
   protocolo del expediente, y lo anota en fincas_comunicaciones para que
   aparezca en el timeline de la ficha. Esto no es una simulación: si hay
   RESEND_API_KEY y dominio, el correo sale.

   EL ASUNTO ES LA CLAVE DE VUELTA
   El asunto lleva la referencia entre corchetes — "[EXP-2026-0001] …" — y
   el Reply-To apunta al buzón de entrada. Cuando el proveedor responde,
   fincas-inbound lee esa referencia del asunto y engancha la respuesta al
   expediente correcto. Sin eso, las respuestas llegarían huérfanas.

   QUIÉN PUEDE LLAMARLA
   Un endpoint que manda correo desde tu dominio no puede quedar abierto.
   Se admite de dos maneras y sólo dos:
     · cabecera x-fincas-internal con la service role key — así la llama
       fincas-chat desde el propio servidor;
     · Authorization: Bearer <JWT> de un usuario con perfil activo — así la
       llama el CRM cuando el administrador reenvía a mano.

   Secrets:
     RESEND_API_KEY    (pendiente de dar de alta — ver README)
     FINCAS_FROM_EMAIL remitente, p.ej. "Whitemoon Fincas <avisos@tu-dominio>"
     FINCAS_INBOUND_EMAIL  buzón de respuestas para el Reply-To
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

/**
 * `actor` viaja como cabecera para que la auditoría sepa quién escribe: el
 * agente cuando el envío lo dispara la conversación, y nadie (=> 'servicio')
 * cuando lo dispara el administrador desde el CRM. No se pasa el email del
 * admin porque estas escrituras las hace la función con service role, no él.
 */
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
 * ¿Quien llama tiene derecho a mandar correo desde nuestro dominio?
 * Devuelve además QUIÉN es, porque de eso depende cómo firma la auditoría:
 *   "agente"  la conversación, vía fincas-chat (cabecera interna)
 *   "staff"   un administrador reenviando desde el CRM (su JWT)
 *   null      nadie: se rechaza
 */
async function autorizado(req: Request): Promise<"agente" | "staff" | null> {
  if (req.headers.get("x-fincas-internal") === SERVICE_KEY && SERVICE_KEY) return "agente";

  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!jwt || jwt === SERVICE_KEY) return null;

  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!u?.id) return null;

  const perfil = await db(`fincas_perfiles?user_id=eq.${u.id}&activo=is.true&select=user_id`);
  return Array.isArray(perfil) && perfil.length ? "staff" : null;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function cuerpoPeticion(exp: any, comunidad: any, pasos: string[]) {
  const donde = [comunidad?.nombre, comunidad?.direccion].filter(Boolean).join(" · ");
  const listaPasos = pasos.length
    ? `<p style="margin:18px 0 6px;font-weight:600">Protocolo de la comunidad</p>
       <ol style="margin:0;padding-left:18px;color:#333">
         ${pasos.map((p) => `<li style="margin-bottom:4px">${esc(p)}</li>`).join("")}
       </ol>`
    : "";

  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#111;max-width:620px">
  <p>Buenos días,</p>
  <p>Os solicitamos presupuesto para la siguiente incidencia:</p>
  <table style="border-collapse:collapse;margin:16px 0;font-size:14px">
    <tr><td style="padding:4px 14px 4px 0;color:#666">Expediente</td><td style="padding:4px 0"><strong>${esc(exp.ref)}</strong></td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666">Comunidad</td><td style="padding:4px 0">${esc(donde)}</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666">Incidencia</td><td style="padding:4px 0">${esc(exp.tipo)} · ${esc(exp.subtipo)}</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666">Urgencia</td><td style="padding:4px 0">${esc(exp.urgencia)}</td></tr>
  </table>
  <p style="margin:0 0 6px;font-weight:600">Descripción</p>
  <p style="margin:0;color:#333">${esc(exp.descripcion || "Sin descripción.")}</p>
  ${listaPasos}
  <p style="margin-top:22px">Respondiendo a este correo con vuestro presupuesto adjunto,
  entra directamente en el expediente. Por favor, <strong>no cambiéis el asunto</strong>:
  la referencia ${esc(exp.ref)} es la que lo enlaza.</p>
  <p style="margin-top:22px;color:#666;font-size:13px">
    Whitemoon Fincas · Administración de fincas<br>
    Este correo se ha generado desde el expediente ${esc(exp.ref)}.
  </p>
</div>`;
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
  const actor = quien === "agente" ? "agente-ia" : "";

  try {
    const cuerpo = await req.json().catch(() => ({}));
    const expedienteId = String((cuerpo as any).expediente_id ?? "").trim();
    if (!UUID_RE.test(expedienteId)) {
      return json({ ok: false, error: "expediente_id no válido" }, 400);
    }

    const exps = await db(
      `fincas_expedientes?id=eq.${expedienteId}&select=*,fincas_comunidades(nombre,direccion),fincas_protocolos(pasos,cita_fuente)`,
    );
    const exp = Array.isArray(exps) && exps.length ? exps[0] : null;
    if (!exp) return json({ ok: false, error: "expediente no encontrado" }, 404);

    /* El destinatario NO viene en la petición: se busca el proveedor que el
       protocolo asignó a ESE expediente. Quien llama no elige a quién se
       escribe. */
    const provs = await db(
      `fincas_proveedores?nombre=eq.${encodeURIComponent(exp.proveedor_nombre ?? "")}&activo=is.true&select=id,nombre,email`,
    );
    const prov = Array.isArray(provs) && provs.length ? provs[0] : null;
    const para = (prov?.email ?? "").trim();

    const comunidad = exp.fincas_comunidades ?? null;
    const pasos = Array.isArray(exp.fincas_protocolos?.pasos) ? exp.fincas_protocolos.pasos : [];
    const asunto = `[${exp.ref}] Petición de presupuesto — ${comunidad?.nombre ?? "comunidad"}`;
    const html = cuerpoPeticion(exp, comunidad, pasos);

    /* Se anota SIEMPRE, salga o no salga el correo. Un timeline que sólo
       registra los éxitos no sirve para nada. */
    const anota = (estado: string, error = "") =>
      db("fincas_comunicaciones", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          expediente_id: exp.id, comunidad_id: exp.comunidad_id,
          direccion: "saliente", canal: "email", estado,
          de_email: FROM_EMAIL, para_email: para, asunto,
          cuerpo: `Petición de presupuesto a ${exp.proveedor_nombre ?? "proveedor"}.`,
          proveedor_id: prov?.id ?? null, error,
        }),
      }, actor);

    if (!prov) {
      await anota("fallido", `El proveedor "${exp.proveedor_nombre ?? ""}" no está dado de alta o está inactivo.`);
      return json({ ok: false, error: "el proveedor del protocolo no está dado de alta" }, 422);
    }
    if (!para) {
      await anota("fallido", `El proveedor ${prov.nombre} no tiene email.`);
      return json({ ok: false, error: `el proveedor ${prov.nombre} no tiene email` }, 422);
    }
    if (!RESEND_API_KEY) {
      await anota("pendiente", "Falta RESEND_API_KEY: el correo queda encolado, no enviado.");
      console.warn("[fincas-enviar-email] sin RESEND_API_KEY. Destinatario:", para);
      return json({ ok: false, error: "falta RESEND_API_KEY", pendiente: true, para }, 503);
    }

    const envio = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [para],
        subject: asunto,
        html,
        ...(INBOUND_EMAIL ? { reply_to: INBOUND_EMAIL } : {}),
      }),
    });

    if (!envio.ok) {
      const detalle = (await envio.text()).slice(0, 400);
      console.warn("[fincas-enviar-email] Resend", envio.status, detalle);
      await anota("fallido", `Resend ${envio.status}: ${detalle}`);
      return json({ ok: false, error: "el proveedor de correo ha rechazado el envío", detalle }, 502);
    }

    await anota("enviado");
    await db(`fincas_expedientes?id=eq.${exp.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ estado: "asignado", proveedor_avisado_at: new Date().toISOString() }),
    }, actor);

    return json({ ok: true, ref: exp.ref, para, asunto });
  } catch (e) {
    console.warn("[fincas-enviar-email] error:", e);
    return json({ ok: false, error: "error inesperado" }, 500);
  }
});
