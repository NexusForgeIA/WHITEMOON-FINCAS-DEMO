import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* =========================================================================
   fincas-presupuesto — decisión del administrador sobre un presupuesto
   =========================================================================
   La IA prepara; el administrador decide. Esta función es el único camino
   por el que un presupuesto cambia de estado, y por eso existe:

     · anon NO tiene policy de UPDATE en fincas_presupuestos, así que el
       panel no puede escribir por su cuenta ni aunque alguien toque el JS
       desde la consola del navegador;
     · aquí se usa service role, se valida la transición y se deja rastro
       en fincas_auditoria, que es append-only por trigger;
     · el actor que se registra es siempre una PERSONA ("administrador"),
       nunca el agente: en el histórico se ve quién adjudicó.

   Sólo se permite decidir sobre presupuestos en estado "pendiente". Un
   presupuesto ya decidido no se re-decide: se devuelve 409 y no se toca.

   Contrato HTTP
   -------------
   POST  { presupuesto_id: uuid, decision: "aprobado" | "rechazado", actor?: string }
   200   { ok: true, presupuesto }
   409   { ok: false, error }  ya estaba decidido

   verify_jwt: false — demo pública. En producción esto iría detrás del
   login del administrador; aquí se documenta y se deja abierto a propósito.
   ========================================================================= */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    console.warn("[fincas-presupuesto] PostgREST", path, r.status, await r.text());
    return null;
  }
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.warn("[fincas-presupuesto] faltan variables de entorno");
    return json({ ok: false, error: "servicio no disponible" }, 500);
  }

  try {
    const cuerpo = await req.json().catch(() => ({}));
    const id = String((cuerpo as any).presupuesto_id ?? "").trim();
    const decision = String((cuerpo as any).decision ?? "").trim().toLowerCase();
    const actor = String((cuerpo as any).actor ?? "administrador").trim().slice(0, 60) ||
      "administrador";

    if (!UUID_RE.test(id)) {
      return json({ ok: false, error: "presupuesto_id no válido" }, 400);
    }
    if (decision !== "aprobado" && decision !== "rechazado") {
      return json({ ok: false, error: "decision debe ser aprobado o rechazado" }, 400);
    }

    const filas = await db(
      `fincas_presupuestos?id=eq.${id}&select=id,estado,importe,proveedor_nombre,expediente_id`,
    );
    const actual = Array.isArray(filas) && filas.length ? filas[0] : null;
    if (!actual) {
      return json({ ok: false, error: "presupuesto no encontrado" }, 404);
    }
    if (actual.estado !== "pendiente") {
      return json(
        { ok: false, error: `ese presupuesto ya está ${actual.estado}`, presupuesto: actual },
        409,
      );
    }

    /* El filtro estado=eq.pendiente va TAMBIÉN en el UPDATE: si dos personas
       deciden a la vez, la segunda no pisa a la primera. */
    const actualizado = await db(`fincas_presupuestos?id=eq.${id}&estado=eq.pendiente`, {
      method: "PATCH",
      body: JSON.stringify({
        estado: decision,
        decidido_por: actor,
        decidido_at: new Date().toISOString(),
      }),
    });
    const fila = Array.isArray(actualizado) && actualizado.length ? actualizado[0] : null;
    if (!fila) {
      return json({ ok: false, error: "el presupuesto ya había sido decidido" }, 409);
    }

    /* Un presupuesto aprobado pone el expediente en curso. Rechazarlo no
       cierra nada: el expediente sigue vivo esperando otra oferta. */
    if (decision === "aprobado") {
      await db(`fincas_expedientes?id=eq.${fila.expediente_id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ estado: "en_curso" }),
      });
    }

    await db("fincas_auditoria", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        actor,
        accion: `presupuesto_${decision}`,
        entidad: "fincas_presupuestos",
        detalle: {
          presupuesto_id: fila.id,
          expediente_id: fila.expediente_id,
          importe: fila.importe,
          proveedor: fila.proveedor_nombre,
        },
      }),
    });

    return json({ ok: true, presupuesto: fila });
  } catch (e) {
    console.warn("[fincas-presupuesto] error:", e);
    return json({ ok: false, error: "error inesperado" }, 500);
  }
});
