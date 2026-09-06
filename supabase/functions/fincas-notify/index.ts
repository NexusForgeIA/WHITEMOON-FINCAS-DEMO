import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* =========================================================================
   fincas-notify — avisos internos por Telegram
   =========================================================================
   Patrón [x]-notify del proyecto. El token vive SÓLO en Secrets; el cliente
   nunca lo ve. Aquí no se decide nada ni se escribe en la base: sólo se
   avisa al equipo de que hay algo que mirar.

   Tipos de aviso:
     expediente   nuevo expediente abierto por el agente
     presupuesto  ha entrado un presupuesto por correo
     escalado     el agente no ha podido resolverlo y lo pasa a una persona
     aprobacion   algo espera decisión humana (factura o certificado)

   El cliente puede enviar con navigator.sendBeacon y un Blob
   "text/plain;charset=UTF-8" — NO application/json: ese tipo dispararía un
   preflight CORS que sendBeacon no puede hacer, Chrome descartaría el POST
   y sendBeacon devolvería true igual. El cuerpo sigue siendo JSON, así que
   req.json() lo parsea sin problema, y si aun así fallara se reintenta
   leyéndolo como texto.

   Regla del proyecto: si el envío falla → console.warn, nunca interrumpe nada.
   ========================================================================= */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function componeMensaje(d: Record<string, unknown>): string {
  const s = (k: string) => String(d[k] ?? "").trim();
  const tipo = s("tipo") || "aviso";

  if (tipo === "presupuesto") {
    const importe = d.importe != null && d.importe !== ""
      ? ` · ${Number(d.importe).toLocaleString("es-ES", { style: "currency", currency: "EUR" })}`
      : "";
    const adj = s("adjunto") ? ` · adjunto: ${s("adjunto")}` : "";
    return `📩 Presupuesto recibido · ${s("ref") || "sin enlazar"} · ` +
           `${s("proveedor") || "proveedor"}${importe}${adj}\n` +
           `Pendiente de aprobación en el CRM.`;
  }

  if (tipo === "escalado") {
    return `⚠️ Escalado a administración · ${s("ref") || "sin expediente"} · ` +
           `${s("comunidad") || "comunidad sin identificar"}\n` +
           `${s("motivo") || "El agente no ha podido resolverlo."}` +
           (s("contacto") ? `\nContacto: ${s("contacto")}` : "");
  }

  if (tipo === "aprobacion") {
    return `🧾 Pendiente de aprobar · ${s("concepto") || "documento"} · ` +
           `${s("comunidad") || ""}\n${s("detalle") || ""}`.trim();
  }

  // expediente (por defecto)
  const donde = [s("comunidad"), s("puerta")].filter(Boolean).join(" ");
  const urg = s("urgencia") ? ` · urgencia ${s("urgencia")}` : "";
  return `🏢 ${s("ref") || "Nuevo expediente"} · ${donde || "comunidad sin identificar"} · ` +
         `${s("subtipo") || "incidencia"}${urg}\n` +
         `Proveedor asignado: ${s("proveedor") || "sin asignar"}`;
}

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
  const message = componeMensaje(data);

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
