import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* =========================================================================
   fincas-inbound — respuestas de los proveedores que entran por correo
   =========================================================================
   La recibe el Worker de Cloudflare Email Routing (ver infra/cloudflare-
   email-worker.js y el README). Cuando un proveedor responde a la petición
   de presupuesto, este endpoint:

     1. saca la referencia EXP-AAAA-NNNN del ASUNTO,
     2. engancha el correo a ese expediente,
     3. guarda el PDF adjunto en Storage,
     4. crea el presupuesto en estado 'pendiente' — que es lo que hace que
        aparezca en la bandeja y en la cola de aprobación,
     5. avisa al equipo por Telegram.

   NADA SE APRUEBA SOLO. Este endpoint mete el presupuesto en la cola; la
   decisión la toma una persona en el CRM.

   POR QUÉ EL ASUNTO Y NO EL REMITENTE
   El remitente cambia (responde otra persona de la misma empresa, un alias,
   un reenvío). La referencia del asunto sobrevive a todo eso porque el
   cliente de correo la arrastra en el "Re:". Si aun así no aparece, se
   intenta por el email del remitente contra el último expediente abierto de
   ese proveedor, y si tampoco, el presupuesto queda sin enlazar en la
   bandeja para que lo asigne una persona: nunca se adivina.

   SEGURIDAD
   El endpoint es público por necesidad (lo llama Cloudflare), así que se
   protege con un secreto compartido en la cabecera x-fincas-inbound-token.
   Sin él, se rechaza.

   Secrets: FINCAS_INBOUND_TOKEN (obligatorio para aceptar nada).
   ========================================================================= */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const INBOUND_TOKEN = Deno.env.get("FINCAS_INBOUND_TOKEN") ?? "";
const BUCKET = "fincas-docs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-fincas-inbound-token",
};

const REF_RE = /EXP-\d{4}-\d{4}/i;

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
    console.warn("[fincas-inbound] PostgREST", path, r.status, await r.text());
    return null;
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const txt = (v: unknown, max = 500) => String(v ?? "").trim().slice(0, max);

/** "Nombre Apellido <a@b.com>" → "a@b.com" */
function soloEmail(v: unknown): string {
  const s = String(v ?? "");
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase().slice(0, 160);
}

/** Busca en el cuerpo un importe en euros, para adelantar trabajo al admin. */
function importeDe(texto: string): number | null {
  const m = texto.match(/(\d{1,3}(?:[.\s]\d{3})*|\d+)(?:,(\d{1,2}))?\s*(?:€|eur\b|euros\b)/i);
  if (!m) return null;
  const entero = m[1].replace(/[.\s]/g, "");
  const dec = m[2] ?? "0";
  const n = Number(`${entero}.${dec.padEnd(2, "0")}`);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function subirAdjunto(ref: string, nombre: string, base64: string, tipo: string) {
  try {
    const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const limpio = nombre.replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "adjunto.pdf";
    const ruta = `presupuestos/${ref}/${Date.now()}-${limpio}`;
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${ruta}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": tipo || "application/pdf",
        "x-upsert": "true",
      },
      body: bin,
    });
    if (!r.ok) {
      console.warn("[fincas-inbound] storage", r.status, await r.text());
      return null;
    }
    return { ruta, nombre: limpio };
  } catch (e) {
    console.warn("[fincas-inbound] adjunto ilegible:", e);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...CORS, "Content-Type": "application/json" },
    });

  if (!SUPABASE_URL || !SERVICE_KEY) return json({ ok: false, error: "servicio no configurado" }, 500);

  /* Sin token configurado el buzón queda cerrado a propósito: es preferible
     perder un correo a aceptar cualquier POST de internet como si fuera un
     presupuesto de un proveedor. */
  if (!INBOUND_TOKEN) {
    console.warn("[fincas-inbound] falta FINCAS_INBOUND_TOKEN: se rechaza todo");
    return json({ ok: false, error: "buzón no configurado" }, 503);
  }
  if (req.headers.get("x-fincas-inbound-token") !== INBOUND_TOKEN) {
    return json({ ok: false, error: "no autorizado" }, 401);
  }

  try {
    const c = await req.json().catch(() => ({}));
    const asunto = txt((c as any).subject ?? (c as any).asunto, 300);
    const de = soloEmail((c as any).from ?? (c as any).de);
    const para = soloEmail((c as any).to ?? (c as any).para);
    const cuerpo = txt((c as any).text ?? (c as any).cuerpo, 8000);
    const adjuntos = Array.isArray((c as any).attachments) ? (c as any).attachments : [];

    if (!de) return json({ ok: false, error: "falta el remitente" }, 400);

    /* 1 · Enlazar. Primero por la referencia del asunto. */
    let exp: any = null;
    const m = `${asunto} ${cuerpo}`.match(REF_RE);
    if (m) {
      const filas = await db(
        `fincas_expedientes?ref=eq.${m[0].toUpperCase()}&select=id,ref,comunidad_id,proveedor_nombre`,
      );
      if (Array.isArray(filas) && filas.length) exp = filas[0];
    }

    /* Plan B: por el email del proveedor, contra su expediente abierto más
       reciente. Si hay dudas, no se fuerza: se deja sin enlazar. */
    let proveedor: any = null;
    const provs = await db(
      `fincas_proveedores?email=eq.${encodeURIComponent(de)}&select=id,nombre,email`,
    );
    if (Array.isArray(provs) && provs.length) proveedor = provs[0];

    if (!exp && proveedor) {
      const filas = await db(
        `fincas_expedientes?proveedor_nombre=eq.${encodeURIComponent(proveedor.nombre)}` +
        `&estado=in.(nuevo,asignado,en_curso)&select=id,ref,comunidad_id,proveedor_nombre` +
        `&order=created_at.desc&limit=2`,
      );
      if (Array.isArray(filas) && filas.length === 1) exp = filas[0];
    }

    /* 2 · Guardar el adjunto (el primero que parezca un documento). */
    let guardado: { ruta: string; nombre: string } | null = null;
    for (const a of adjuntos) {
      const b64 = String(a?.content ?? a?.data ?? "");
      if (!b64) continue;
      guardado = await subirAdjunto(exp?.ref ?? "sin-expediente",
        String(a?.filename ?? a?.name ?? "presupuesto.pdf"),
        b64, String(a?.contentType ?? a?.type ?? "application/pdf"));
      if (guardado) break;
    }

    /* 3 · Timeline. */
    await db("fincas_comunicaciones", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        expediente_id: exp?.id ?? null,
        comunidad_id: exp?.comunidad_id ?? null,
        direccion: "entrante", canal: "email", estado: "recibido",
        de_email: de, para_email: para, asunto,
        cuerpo: cuerpo.slice(0, 4000),
        proveedor_id: proveedor?.id ?? null,
        adjuntos: guardado ? [{ nombre: guardado.nombre, path: guardado.ruta }] : [],
      }),
    });

    /* 4 · A la bandeja de presupuestos, en 'pendiente'. Sólo si va ligado a
       un expediente: la tabla lo exige y, sobre todo, un presupuesto suelto
       no significa nada. Si no se pudo enlazar, queda el correo en el
       timeline general y el aviso al equipo. */
    let presupuesto: any = null;
    if (exp) {
      const creado = await db("fincas_presupuestos", {
        method: "POST",
        body: JSON.stringify({
          expediente_id: exp.id,
          proveedor_nombre: proveedor?.nombre ?? de,
          importe: importeDe(`${asunto} ${cuerpo}`),
          partidas: [], estado: "pendiente", origen: "email",
          remitente_email: de, asunto,
          adjunto_path: guardado?.ruta ?? "", adjunto_nombre: guardado?.nombre ?? "",
          cuerpo: cuerpo.slice(0, 4000),
        }),
      });
      presupuesto = Array.isArray(creado) && creado.length ? creado[0] : null;
    }

    /* 5 · Avisar al equipo. */
    fetch(`${SUPABASE_URL}/functions/v1/fincas-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tipo: "presupuesto",
        ref: exp?.ref ?? "sin enlazar",
        proveedor: proveedor?.nombre ?? de,
        importe: presupuesto?.importe ?? null,
        adjunto: guardado?.nombre ?? "",
      }),
    }).catch((e) => console.warn("[fincas-inbound] aviso:", e));

    return json({
      ok: true,
      enlazado: Boolean(exp),
      ref: exp?.ref ?? null,
      presupuesto_id: presupuesto?.id ?? null,
      adjunto: guardado?.nombre ?? null,
    });
  } catch (e) {
    console.warn("[fincas-inbound] error:", e);
    return json({ ok: false, error: "error inesperado" }, 500);
  }
});
