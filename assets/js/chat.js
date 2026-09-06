/* =========================================================================
   chat.js — chat libre del vecino
   =========================================================================
   Chat vacío y sin botones: el vecino escribe lo que quiera. No hay
   selector de comunidad ni frases sugeridas — es el agente quien pregunta.

   Lo que este fichero pinta aparte del texto son datos que el modelo NO
   escribe: el protocolo aplicado (con la comunidad y la sección del manual
   de la que sale), el documento citado y la referencia del expediente.
   Todo eso viaja en campos propios de la respuesta y viene de la base de
   datos. Si el modelo se inventara un proveedor, la tarjeta lo desmentiría.
   ========================================================================= */

import { FN, esc, limpiaTexto, ETIQUETA_URGENCIA, humaniza } from "./config.js";

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

  const cards = {
    protocolo: document.getElementById("card-protocolo"),
    normativa: document.getElementById("card-normativa"),
    expediente: document.getElementById("card-expediente"),
  };

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
      '<span class="quien">Nora</span><span class="escribiendo"><i></i><i></i><i></i></span>';
    hilo.appendChild(div);
    hilo.scrollTop = hilo.scrollHeight;
    return div;
  }

  function pintaProtocolo(p) {
    const c = cards.protocolo;
    if (!c || !p) return;
    document.getElementById("prot-titulo").textContent =
      `${humaniza(p.categoria)} · ${humaniza(p.subtipo)}`;
    document.getElementById("prot-cita").textContent = p.cita_fuente ?? "";
    document.getElementById("prot-comunidad").textContent = p.comunidad ?? "—";
    document.getElementById("prot-proveedor").textContent = p.proveedor_nombre ?? "—";
    document.getElementById("prot-urgencia").textContent =
      ETIQUETA_URGENCIA[p.urgencia_default] ?? humaniza(p.urgencia_default);
    c.hidden = false;
  }

  function pintaNormativa(d) {
    const c = cards.normativa;
    if (!c || !d) return;
    document.getElementById("norm-titulo").textContent = d.titulo ?? "";
    // El extracto viene de ts_headline, que marca los términos con <b>. Se
    // pinta como texto: aquí no entra HTML de la base.
    document.getElementById("norm-extracto").textContent =
      String(d.extracto ?? "").replace(/<\/?b>/g, "");
    c.hidden = false;
  }

  function pintaExpediente(e) {
    const c = cards.expediente;
    if (!c || !e?.ref) return;
    document.getElementById("exp-ref").textContent = e.ref;
    document.getElementById("exp-detalle").textContent =
      [e.comunidad, e.puerta, humaniza(e.subtipo), e.proveedor_nombre]
        .filter(Boolean).join(" · ");
    c.hidden = false;
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
      burbuja("Nora", reply, "ia");
      historial.push({ role: "assistant", content: reply });

      if (data.contexto) contexto = data.contexto;
      if (data.protocolo) pintaProtocolo(data.protocolo);
      if (data.normativa) pintaNormativa(data.normativa);
      if (data.expediente) pintaExpediente(data.expediente);
      if (data.escalado) {
        burbuja("", data.escalado.ref
          ? `Escalado al equipo · ${data.escalado.ref}`
          : "Escalado al equipo de administración.", "sistema");
      }
    } catch (e) {
      console.warn("[chat] fallo:", e);
      esperando.remove();
      burbuja("Nora",
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

  burbuja("Nora",
    "Hola, soy Nora, de Whitemoon Fincas. Cuéntame qué ha pasado y te ayudo.",
    "ia");
}
