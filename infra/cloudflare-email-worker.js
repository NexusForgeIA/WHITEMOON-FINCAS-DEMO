/* =========================================================================
   Worker de Cloudflare Email Routing → fincas-inbound
   =========================================================================
   Cloudflare Email Routing puede entregar el correo a un Worker en vez de
   reenviarlo a un buzón. Este Worker lee el mensaje, saca el asunto, el
   remitente y el primer adjunto, y se lo pasa a la Edge Function
   fincas-inbound, que es quien lo engancha al expediente.

   POR QUÉ AQUÍ Y NO EN SUPABASE
   Porque el correo llega como MIME crudo por un stream, no como JSON. Este
   Worker es el traductor. Deja el JSON ya masticado para que la Edge
   Function no tenga que parsear MIME.

   CÓMO SE DESPLIEGA
   -----------------
   1. En Cloudflare: Websites → tu dominio → Email → Email Routing.
      Verifica el dominio (añade los registros MX y TXT que te da).
   2. Workers & Pages → Create → Worker. Pega este fichero.
   3. En el Worker, Settings → Variables:
        FINCAS_INBOUND_URL   = https://mlaqtniujnvfxcvcourm.supabase.co/functions/v1/fincas-inbound
        FINCAS_INBOUND_TOKEN = <el mismo valor que el secret de Supabase>
   4. Email Routing → Routes → Create address:
        presupuestos@tu-dominio  →  Send to a Worker  →  este worker.
   5. En Supabase, Edge Functions → Secrets:
        FINCAS_INBOUND_TOKEN = <ese mismo valor>
        FINCAS_INBOUND_EMAIL = presupuestos@tu-dominio
      (así el Reply-To de las peticiones apunta a este buzón)

   DEPENDENCIA
   `postal-mime` parsea el MIME. En el editor del Worker basta con dejar el
   import: Cloudflare lo resuelve desde npm al desplegar.
   ========================================================================= */

import PostalMime from "postal-mime";

/** Límite defensivo: un adjunto de 30 MB no cabe en una Edge Function y no
    es un presupuesto, es un problema. Se recorta y se avisa en el cuerpo. */
const MAX_ADJUNTO = 8 * 1024 * 1024;

function aBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  // A trozos: btoa con un array enorme revienta la pila de argumentos.
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

export default {
  async email(message, env) {
    const parser = new PostalMime();
    const correo = await parser.parse(await new Response(message.raw).arrayBuffer());

    const adjuntos = [];
    for (const a of correo.attachments ?? []) {
      const contenido = a.content instanceof ArrayBuffer
        ? a.content
        : new TextEncoder().encode(String(a.content ?? "")).buffer;
      if (contenido.byteLength > MAX_ADJUNTO) continue;
      adjuntos.push({
        filename: a.filename || "adjunto.pdf",
        contentType: a.mimeType || "application/pdf",
        content: aBase64(contenido),
      });
      // Con el primero basta: el presupuesto es uno.
      if (adjuntos.length >= 1) break;
    }

    const payload = {
      subject: correo.subject ?? "",
      from: correo.from?.address ?? message.from,
      to: message.to,
      text: correo.text ?? correo.html?.replace(/<[^>]+>/g, " ") ?? "",
      attachments: adjuntos,
    };

    const r = await fetch(env.FINCAS_INBOUND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-fincas-inbound-token": env.FINCAS_INBOUND_TOKEN,
      },
      body: JSON.stringify(payload),
    });

    /* Si Supabase falla, NO se descarta el correo: se rebota para que
       Cloudflare lo reintente o quede constancia en el remitente. Perder en
       silencio el presupuesto de un proveedor sería lo peor que podría
       hacer este Worker. */
    if (!r.ok) {
      const detalle = await r.text().catch(() => "");
      console.error("fincas-inbound respondió", r.status, detalle);
      message.setReject("No se ha podido procesar el mensaje. Inténtalo de nuevo.");
    }
  },
};
