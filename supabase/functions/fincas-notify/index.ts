import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* =========================================================================
   fincas-notify — aviso por Telegram de la demo de administración de fincas
   =========================================================================
   Sigue el patrón [x]-notify del proyecto. El expediente y el parte al
   proveedor ya los ha escrito fincas-chat; esta función SOLO manda el aviso
   por Telegram, manteniendo el token EXCLUSIVAMENTE en el servidor.

   Recibe (POST): { ref, comunidad, puerta, subtipo, proveedor }
   Manda: "🏢 EXP-… · {comunidad} {puerta} · {subtipo} · {proveedor} avisado"

   El cliente envía con navigator.sendBeacon y un Blob
   "text/plain;charset=UTF-8" — NO application/json: ese tipo dispararía un
   preflight CORS que sendBeacon no puede hacer, Chrome descartaría el POST
   y sendBeacon devolvería true igual. El cuerpo sigue siendo JSON, así que
   req.json() lo parsea sin problema (no mira el Content-Type), y si aun así
   fallara se reintenta leyéndolo como texto.

   Secrets (nunca en cliente):
     - TELEGRAM_BOT_TOKEN
     - TELEGRAM_CHAT_ID

   Regla del proyecto: si el envío falla → console.warn, nunca interrumpe nada.
   ========================================================================= */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    try {
      payload = JSON.parse(await req.text());
    } catch {
      payload = {};
    }
  }

  const data = (payload.args ?? payload) as Record<string, unknown>;
  const ref = String(data.ref ?? "").trim();
  const comunidad = String(data.comunidad ?? "").trim();
  const puerta = String(data.puerta ?? "").trim();
  const subtipo = String(data.subtipo ?? "").trim();
  const proveedor = String(data.proveedor ?? "").trim();

  // Sin referencia de expediente no hay nada que avisar.
  if (!ref) {
    return json({ ok: false, error: "aviso incompleto" }, 400);
  }

  const donde = [comunidad, puerta].filter(Boolean).join(" ");
  const message =
    `🏢 ${ref} · ${donde || "comunidad sin identificar"} · ` +
    `${subtipo || "incidencia"} · ${proveedor || "proveedor"} avisado\n` +
    `(demo WhiteMoon — aviso al proveedor simulado)`;

  let notified = false;
  try {
    const tgToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const tgChat = Deno.env.get("TELEGRAM_CHAT_ID");
    if (tgToken && tgChat) {
      const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: tgChat, text: message }),
      });
      notified = r.ok;
      if (!r.ok) {
        console.warn("[fincas-notify] Telegram falló:", r.status, await r.text());
      }
    } else {
      console.warn("[fincas-notify] sin TELEGRAM_BOT_TOKEN/CHAT_ID, mensaje:", message);
    }
  } catch (e) {
    console.warn("[fincas-notify] error enviando Telegram:", e);
  }

  return json({ ok: true, notified });
});
