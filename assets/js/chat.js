/* =========================================================================
   chat.js — chat libre del vecino
   =========================================================================
   Chat vacío y sin botones: el vecino escribe lo que quiera. No hay
   selector de comunidad ni frases sugeridas — es el agente quien pregunta.

   Aquí NO se pinta nada interno. La respuesta de la Edge Function trae
   además el protocolo aplicado, el documento citado y la ficha del
   expediente, pero eso es información de gestión y su sitio es el panel: en
   la web pública el propietario ve la conversación y poco más. Si algún día
   vuelve a hacer falta enseñar la referencia, ya viene dentro del texto que
   escribe el asistente.
   ========================================================================= */

import { FN, esc, limpiaTexto } from "./config.js";

const hilo = document.getElementById("hilo");
const form = document.getElementById("form-chat");
const entrada = document.getElementById("entrada");
const btn = document.getElementById("btn-enviar");

if (hilo && form) iniciar();

function iniciar() {
  /* El contexto es el eco que devuelve el servidor con la comunidad y el
     inmueble ya resueltos; se le devuelve tal cual en el turno siguiente. */
  let historial = [];
  let contexto = { comunidad_id: null, inmueble_id: null };
  let enVuelo = false;

  function burbuja(quien, texto, clase) {
    const div = document.createElement("div");
    div.className = `burbuja ${clase}`;
    div.innerHTML = quien
      ? `<span class="quien">${esc(quien)}</span>${esc(texto)}`
      : esc(texto);
    hilo.appendChild(div);
    hilo.scrollTop = hilo.scrollHeight;
    return div;
  }

  function puntitos() {
    const div = document.createElement("div");
    div.className = "burbuja ia";
    div.innerHTML =
      '<span class="quien">Asistente</span><span class="escribiendo"><i></i><i></i><i></i></span>';
    hilo.appendChild(div);
    hilo.scrollTop = hilo.scrollHeight;
    return div;
  }

  async function envia(texto) {
    if (enVuelo || !texto.trim()) return;
    enVuelo = true;
    btn.disabled = true;
    entrada.value = "";

    burbuja("Tú", texto, "yo");
    historial.push({ role: "user", content: texto });
    const esperando = puntitos();

    try {
      const r = await fetch(FN("fincas-chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mensaje: texto,
          contexto,
          historial: historial.slice(0, -1),
        }),
      });
      const data = await r.json();

      esperando.remove();
      const reply = limpiaTexto(data.reply);
      burbuja("Asistente", reply, "ia");
      historial.push({ role: "assistant", content: reply });

      if (data.contexto) contexto = data.contexto;
      if (data.escalado) {
        burbuja("", "Lo hemos pasado al equipo de administración.", "sistema");
      }
    } catch (e) {
      console.warn("[chat] fallo:", e);
      esperando.remove();
      burbuja("Asistente",
        "No he podido conectar con la administración. Inténtalo otra vez en un momento.",
        "ia");
    } finally {
      enVuelo = false;
      btn.disabled = false;
      entrada.focus();
    }
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    envia(entrada.value);
  });

  burbuja("Asistente",
    "Hola, soy el asistente de Whitemoon Fincas. Cuéntame qué ha pasado y te ayudo.",
    "ia");
}
