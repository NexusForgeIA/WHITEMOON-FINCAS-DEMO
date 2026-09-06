import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* =========================================================================
   fincas-presupuesto — RETIRADA
   =========================================================================
   En la demo anterior esta función aprobaba y rechazaba presupuestos con
   service role y verify_jwt:false, porque entonces no había login: el panel
   era público y los datos, ficticios.

   En el MVP hay Supabase Auth, RLS y triggers de auditoría, así que el CRM
   escribe directamente contra la base con el JWT del administrador y el
   rastro lo deja la propia base. Esta función se quedaba sin uso.

   Un endpoint sin uso que aprueba gastos con service role y sin
   autenticación no es código muerto: es una puerta abierta. Cualquiera que
   conociera la URL podría haber aprobado un presupuesto. Por eso no se ha
   dejado "por si acaso" — se ha vaciado.

   No se puede borrar una Edge Function desde la API de despliegue, así que
   se sustituye por esto: responde 410 Gone y no toca la base.
   ========================================================================= */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  console.warn("[fincas-presupuesto] llamada a un endpoint retirado desde", req.headers.get("origin") ?? "origen desconocido");

  return new Response(
    JSON.stringify({
      ok: false,
      error: "Endpoint retirado. Los presupuestos se deciden en el CRM, autenticado.",
    }),
    { status: 410, headers: { ...CORS, "Content-Type": "application/json" } },
  );
});
