/* =========================================================================
   chat.js — vista del propietario
   =========================================================================
   Habla con fincas-chat y pinta dos cosas que el modelo NO escribe:

     · la tarjeta "Protocolo aplicado", con la comunidad, el proveedor y la
       cita del manual, tal cual salen de fincas_protocolos;
     · la tarjeta del expediente, con la referencia real de la base.

   Esa separación es el argumento de venta de la demo: el texto lo redacta
   Claude, pero los datos que se enseñan vienen de la base de datos. Si el
   modelo se inventara un proveedor, la tarjeta lo desmentiría.

   El aviso al proveedor se manda a fincas-notify con sendBeacon y un Blob
   "text/plain": application/json dispararía un preflight CORS que sendBeacon
   no puede hacer.
   ========================================================================= */

import { sb, FN, esc, limpiaTexto, ETIQUETA_URGENCIA, humaniza } from "./config.js";

const hilo        = document.getElementById("hilo");
const form        = document.getElementById("form-chat");
const entrada     = document.getElementById("entrada");
const btnEnviar   = document.getElementById("btn-enviar");
const selector    = document.getElementById("sel-comunidad");
const sugerencias = document.getElementById("sugerencias");

const tProtocolo  = document.getElementById("tarjeta-protocolo");
const tExpediente = document.getElementById("tarjeta-expediente");
const tVacia      = document.getElementById("tarjeta-vacia");

/* Estado de la conversación. `contexto` es el eco que devuelve el servidor
   con la comunidad y el inmueble ya resueltos; se le devuelve tal cual en el
   turno siguiente para que no vuelva a preguntarlo. */
let historial = [];
let contexto = { comunidad_id: null, inmueble_id: null };
let enVuelo = false;

/* ------------------------------------------------------------- burbujas */

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

/* --------------------------------------------------------- ficha lateral */

function pintaProtocolo(p) {
  if (!p) return;
  tVacia.hidden = true;
  tProtocolo.hidden = false;

  document.getElementById("prot-titulo").textContent =
    `${humaniza(p.categoria)} · ${humaniza(p.subtipo)}`;
  document.getElementById("prot-cita").textContent = p.cita_fuente ?? "";
  document.getElementById("prot-comunidad").textContent = p.comunidad ?? "—";
  document.getElementById("prot-proveedor").textContent = p.proveedor_nombre ?? "—";
  document.getElementById("prot-tel").textContent = p.proveedor_tel ?? "—";
  document.getElementById("prot-urgencia").textContent =
    ETIQUETA_URGENCIA[p.urgencia_default] ?? humaniza(p.urgencia_default);

  const ol = document.getElementById("prot-pasos");
  ol.innerHTML = "";
  for (const paso of Array.isArray(p.pasos) ? p.pasos : []) {
    const li = document.createElement("li");
    li.textContent = paso;
    ol.appendChild(li);
  }
}

function pintaExpediente(e) {
  if (!e?.ref) return;
  tVacia.hidden = true;
  tExpediente.hidden = false;
  document.getElementById("exp-ref").textContent = e.ref;
  document.getElementById("exp-detalle").textContent =
    [e.comunidad, e.puerta, humaniza(e.subtipo), e.proveedor_nombre]
      .filter(Boolean).join(" · ");
}

/* -------------------------------------------------------------- avisos */

/** Aviso a Telegram. Nunca bloquea ni rompe nada si falla. */
function avisa(aviso) {
  if (!aviso) return;
  try {
    const blob = new Blob([JSON.stringify(aviso)], { type: "text/plain;charset=UTF-8" });
    navigator.sendBeacon(FN("fincas-notify"), blob);
  } catch (e) {
    console.warn("[chat] no se pudo mandar el aviso:", e);
  }
}

/* --------------------------------------------------------------- envío */

async function envia(texto) {
  if (enVuelo || !texto.trim()) return;
  enVuelo = true;
  btnEnviar.disabled = true;
  entrada.value = "";

  burbuja("Tú", texto, "yo");
  historial.push({ role: "user", content: texto });
  const esperando = puntitos();

  /* El selector manda mientras haya algo elegido; si el vecino lo deja en
     blanco, la comunidad la resuelve el agente por lo que se escriba. */
  const elegida = selector.value || null;

  try {
    const r = await fetch(FN("fincas-chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mensaje: texto,
        comunidad_id: elegida ?? contexto.comunidad_id,
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
    if (data.expediente) pintaExpediente(data.expediente);
    if (data.aviso) {
      avisa(data.aviso);
      burbuja("", "Parte enviado al proveedor (simulado en esta demo).", "sistema");
    }
  } catch (e) {
    console.warn("[chat] fallo:", e);
    esperando.remove();
    burbuja(
      "Nora",
      "No he podido conectar con la administración. Inténtalo otra vez en un momento.",
      "ia",
    );
  } finally {
    enVuelo = false;
    btnEnviar.disabled = false;
    entrada.focus();
  }
}

/* --------------------------------------------------------------- arranque */

/** Cambiar de comunidad empieza conversación nueva: mezclar el hilo de una
    comunidad con el protocolo de otra sería justo lo que esta demo niega. */
function reinicia(motivo) {
  historial = [];
  contexto = { comunidad_id: selector.value || null, inmueble_id: null };
  hilo.innerHTML = "";
  tProtocolo.hidden = true;
  tExpediente.hidden = true;
  tVacia.hidden = false;
  if (motivo) burbuja("", motivo, "sistema");
  burbuja(
    "Nora",
    selector.value
      ? "Hola, soy Nora, de la administración. Cuéntame qué ha pasado."
      : "Hola, soy Nora, de la administración. Cuéntame qué ha pasado y de qué comunidad me llamas.",
    "ia",
  );
}

export async function iniciaChat() {
  /* Las comunidades se leen de la base con la clave anon: el selector no
     lleva nada cableado en el HTML. */
  const { data, error } = await sb
    .from("fincas_comunidades")
    .select("id, nombre, direccion")
    .order("nombre");

  if (error) {
    console.warn("[chat] no se han podido cargar las comunidades:", error);
  } else {
    for (const c of data ?? []) {
      const op = document.createElement("option");
      op.value = c.id;
      op.textContent = `${c.nombre} — ${c.direccion}`;
      selector.appendChild(op);
    }
  }

  selector.addEventListener("change", () => {
    const etiqueta = selector.options[selector.selectedIndex].textContent;
    reinicia(selector.value ? `Conversación nueva desde ${etiqueta}` : "Conversación nueva");
  });

  sugerencias.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-frase]");
    if (b) envia(b.dataset.frase);
  });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    envia(entrada.value);
  });

  reinicia();
}
