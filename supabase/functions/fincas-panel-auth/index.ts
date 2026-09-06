import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* =========================================================================
   fincas-panel-auth — entrada al panel con una sola clave
   =========================================================================
   El CRM no está enlazado desde la web y se entra con una clave, sin
   usuario. Lo que hace que esto sea seguro y no un adorno es DÓNDE se
   comprueba esa clave: aquí, en el servidor, y qué devuelve si encaja.

   NO ES UN CANDADO DE JAVASCRIPT
   Un gate de cliente sería inútil: bastaría con abrir las herramientas del
   navegador y saltárselo, y detrás hay IBAN y datos de propietarios. Aquí
   la clave no se compara nunca en el navegador. Si es correcta, esta
   función crea una SESIÓN REAL de Supabase Auth para el usuario del panel
   y se la devuelve al cliente. A partir de ahí el CRM funciona con ese JWT
   y todo lo que lee o escribe pasa por RLS, igual que si hubiera entrado
   con email y contraseña. Sin clave válida no hay sesión, y sin sesión
   `anon` no lee una sola fila.

   CÓMO SE CREA LA SESIÓN SIN SABER NINGUNA CONTRASEÑA
   Con la API de administración de Auth: se genera un enlace mágico para el
   usuario del panel y se canjea aquí mismo por un par de tokens. El
   usuario `panel@whitemoon.es` tiene una contraseña aleatoria que no
   conoce nadie —ni este código—, así que la única forma de entrar como él
   es pasando por esta puerta.

   DÓNDE VIVE LA CLAVE
   En el Secret `FINCAS_PANEL_KEY` si está puesto. Si no, en un hash bcrypt
   en `fincas_panel_acceso`, tabla con RLS y sin políticas que sólo alcanza
   service_role. De un hash no se saca la clave. En el repositorio no está
   ni una cosa ni la otra.

   FUERZA BRUTA
   Una sola clave se puede probar a lo bestia, así que se cuentan los fallos
   por huella de origen: a partir de 8 en 15 minutos se cierra la puerta
   durante ese rato. Cada intento, acierte o falle, queda anotado.
   ========================================================================= */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const PANEL_KEY = Deno.env.get("FINCAS_PANEL_KEY") ?? "";
const USUARIO_POR_DEFECTO = "panel@whitemoon.es";

const MAX_FALLOS = 8;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

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
    console.warn("[fincas-panel-auth] PostgREST", path, r.status, await r.text());
    return null;
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

/** Identifica al que llama para contar sus fallos. No es infalible —una IP
    se cambia— pero para de golpe el caso normal: alguien probando claves. */
function huella(req: Request): string {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  return (ip || req.headers.get("cf-connecting-ip") || "desconocido").slice(0, 60);
}

/** Comparación en tiempo constante, para no filtrar por cuánto tarda. */
function igualSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

/**
 * Crea una sesión real para el usuario del panel. Dos pasos de la API de
 * administración: generar un enlace mágico y canjearlo aquí mismo, sin que
 * el enlace llegue a salir de este servidor.
 */
async function creaSesion(email: string) {
  const enlace = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "magiclink", email }),
  });

  if (!enlace.ok) {
    console.warn("[fincas-panel-auth] generate_link", enlace.status, await enlace.text());
    return null;
  }
  const datos = await enlace.json();
  const hashed = datos?.hashed_token ?? datos?.properties?.hashed_token;
  if (!hashed) {
    console.warn("[fincas-panel-auth] generate_link sin hashed_token:", JSON.stringify(datos).slice(0, 300));
    return null;
  }

  /* El canje admite dos formas según la versión de GoTrue. Se prueban las
     dos antes de darse por vencido: es una diferencia de contrato, no un
     problema de credenciales. */
  const intentos = [
    { token_hash: hashed, type: "magiclink" },
    { token: hashed, type: "magiclink", email },
  ];

  for (const cuerpo of intentos) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: "POST",
      headers: {
        apikey: ANON_KEY || SERVICE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cuerpo),
    });
    if (r.ok) {
      const s = await r.json();
      if (s?.access_token && s?.refresh_token) return s;
      console.warn("[fincas-panel-auth] verify sin tokens:", JSON.stringify(s).slice(0, 200));
    } else {
      console.warn("[fincas-panel-auth] verify", r.status, (await r.text()).slice(0, 200));
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...CORS, "Content-Type": "application/json" },
    });

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ ok: false, error: "servicio no configurado" }, 500);
  }

  const quien = huella(req);

  try {
    const cuerpo = await req.json().catch(() => ({}));
    const clave = String((cuerpo as any).clave ?? "").trim().slice(0, 200);

    /* 1 · ¿Está esta huella castigada? */
    const fallos = await db("rpc/fincas_panel_fallos", {
      method: "POST", body: JSON.stringify({ p_huella: quien }),
    });
    if (typeof fallos === "number" && fallos >= MAX_FALLOS) {
      console.warn("[fincas-panel-auth] bloqueado por intentos:", quien, fallos);
      return json({
        ok: false,
        error: "Demasiados intentos fallidos. Vuelve a probar dentro de 15 minutos.",
      }, 429);
    }

    if (!clave) return json({ ok: false, error: "Falta la clave." }, 400);

    /* 2 · Comprobar la clave. Nunca en el cliente, nunca comparando strings
           a ojo si viene del Secret. */
    let email: string | null = null;
    if (PANEL_KEY) {
      if (igualSeguro(clave, PANEL_KEY)) email = USUARIO_POR_DEFECTO;
    } else {
      // Sin Secret, contra el hash bcrypt de la base.
      const r = await db("rpc/fincas_panel_verificar", {
        method: "POST", body: JSON.stringify({ p_clave: clave }),
      });
      if (typeof r === "string" && r) email = r;
    }

    if (!email) {
      await db("rpc/fincas_panel_anota", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ p_huella: quien, p_exito: false }),
      });
      await db("fincas_auditoria", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          actor: "servicio", accion: "panel_acceso_denegado",
          entidad: "fincas_panel_acceso", detalle: { huella: quien },
        }),
      });
      // Un poco de espera: hace incómoda la fuerza bruta y no molesta a nadie
      // que teclee la clave bien.
      await new Promise((r) => setTimeout(r, 600));
      return json({ ok: false, error: "Clave incorrecta." }, 401);
    }

    /* 3 · Clave correcta: sesión real de Supabase Auth. */
    const sesion = await creaSesion(email);
    if (!sesion) {
      return json({ ok: false, error: "No se ha podido abrir la sesión. Inténtalo de nuevo." }, 502);
    }

    await db("rpc/fincas_panel_anota", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ p_huella: quien, p_exito: true }),
    });
    await db("fincas_auditoria", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        actor: email, accion: "panel_acceso_concedido",
        entidad: "fincas_panel_acceso", detalle: { huella: quien },
      }),
    });

    return json({
      ok: true,
      session: {
        access_token: sesion.access_token,
        refresh_token: sesion.refresh_token,
        expires_in: sesion.expires_in,
        expires_at: sesion.expires_at,
        token_type: sesion.token_type ?? "bearer",
      },
      usuario: email,
    });
  } catch (e) {
    console.warn("[fincas-panel-auth] error:", e);
    return json({ ok: false, error: "error inesperado" }, 500);
  }
});
