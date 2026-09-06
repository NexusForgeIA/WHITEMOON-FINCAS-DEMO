import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* =========================================================================
   fincas-privado — la única puerta al IBAN y a los datos del presidente
   =========================================================================
   Estos datos viven en el esquema `fincas_privado`, que PostgREST no
   expone: no hay URL de la API que los devuelva, ni con la clave anon ni
   con service role. Se leen y se escriben a través de dos funciones SQL
   SECURITY DEFINER cuyo EXECUTE sólo tiene `service_role`.

   Esta función es quien las llama, y antes comprueba a mano que quien pide
   es un administrador con perfil activo. Es deliberadamente aburrida: lee,
   escribe, y no hace nada más.

   Por qué no lo hace el CRM directamente contra la base, como el resto:
   porque entonces la tabla tendría que estar en un esquema expuesto, y
   entonces la separación que protege estos campos del agente de IA dejaría
   de existir. El agente comparte service role con esta función; lo que no
   comparte es el código: su cliente de base lleva una lista blanca y estas
   rutas no están en ella.

   QUÉ GUARDA
   El IBAN de la comunidad y los datos del presidente: nombre, teléfono y
   email. Los tres del presidente son datos personales de un vecino, así que
   viven donde el IBAN y salen por donde el IBAN: por aquí y con JWT.

   Contrato
   --------
   POST { accion: "leer",    comunidad_id }
   POST { accion: "guardar", comunidad_id, presidente_nombre,
                             presidente_telefono, presidente_email, iban, notas }
   Cabecera obligatoria: Authorization: Bearer <JWT del admin>
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
    console.warn("[fincas-privado] PostgREST", path, r.status, await r.text());
    return null;
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

/** Devuelve el email del admin si el JWT es de alguien del equipo, o null. */
async function admin(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // La service role key NO vale como credencial de persona: aquí se exige
  // un usuario real, para que la auditoría diga quién miró el IBAN.
  if (!jwt || jwt === SERVICE_KEY) return null;

  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!u?.id) return null;

  const perfil = await db(
    `fincas_perfiles?user_id=eq.${u.id}&activo=is.true&select=email,rol`,
  );
  if (!Array.isArray(perfil) || !perfil.length) return null;
  return String(perfil[0].email ?? u.email ?? "admin");
}

const txt = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...CORS, "Content-Type": "application/json" },
    });

  if (!SUPABASE_URL || !SERVICE_KEY) return json({ ok: false, error: "servicio no configurado" }, 500);

  const actor = await admin(req);
  if (!actor) return json({ ok: false, error: "no autorizado" }, 401);

  try {
    const c = await req.json().catch(() => ({}));
    const accion = txt((c as any).accion, 20);
    const comunidadId = txt((c as any).comunidad_id, 40);
    if (!UUID_RE.test(comunidadId)) return json({ ok: false, error: "comunidad_id no válido" }, 400);

    if (accion === "leer") {
      const filas = await db("rpc/fincas_privado_leer", {
        method: "POST", body: JSON.stringify({ p_comunidad: comunidadId }),
      });
      const d = Array.isArray(filas) && filas.length ? filas[0] : null;
      // Que un admin abra la ficha protegida también se registra.
      await db("fincas_auditoria", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          actor, accion: "datos_protegidos_consultados",
          entidad: "fincas_privado.datos_comunidad",
          detalle: { comunidad_id: comunidadId },
        }),
      });
      return json({
        ok: true,
        datos: d ?? {
          presidente_nombre: "", presidente_telefono: "", presidente_email: "",
          iban: "", notas: "",
        },
      });
    }

    if (accion === "guardar") {
      await db("rpc/fincas_privado_guardar", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          p_comunidad: comunidadId,
          p_presidente_nombre: txt((c as any).presidente_nombre, 160),
          p_presidente_telefono: txt((c as any).presidente_telefono, 40),
          p_presidente_email: txt((c as any).presidente_email, 160).toLowerCase(),
          p_iban: txt((c as any).iban, 40).replace(/\s+/g, "").toUpperCase(),
          p_notas: txt((c as any).notas, 1000),
          p_actor: actor,
        }),
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: "acción no reconocida" }, 400);
  } catch (e) {
    console.warn("[fincas-privado] error:", e);
    return json({ ok: false, error: "error inesperado" }, 500);
  }
});
