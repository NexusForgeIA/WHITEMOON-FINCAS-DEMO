/* =========================================================================
   panel.js — panel del administrador
   =========================================================================
   Tres piezas:

     1. Kanban de expedientes por estado, con realtime sobre
        fincas_expedientes: lo que abre el agente en la otra pestaña aparece
        aquí sin recargar.
     2. Ficha del expediente, con el PROTOCOLO CITADO destacado: de qué
        comunidad y de qué sección del manual salió la decisión.
     3. Cola de aprobación de presupuestos. Los botones NO escriben en la
        base directamente —anon no tiene permiso de UPDATE—: llaman a la
        Edge Function fincas-presupuesto, que valida, escribe con service
        role y deja rastro en fincas_auditoria.
   ========================================================================= */

import { sb, FN, esc, EUR, ETIQUETA_URGENCIA, ETIQUETA_ESTADO, humaniza, fecha }
  from "./config.js";

const ESTADOS = ["nuevo", "asignado", "en_curso", "cerrado"];

const kanban    = document.getElementById("kanban");
const cola      = document.getElementById("cola-aprobacion");
const velo      = document.getElementById("velo");
const cuerpo    = document.getElementById("ficha-cuerpo");
const punto     = document.getElementById("punto-vivo");
const estadoRT  = document.getElementById("estado-realtime");

/* Índices en memoria: la lista completa y el mapa por id, para que abrir una
   ficha no tenga que volver a consultar. */
let expedientes = [];
const comunidades = new Map();
let recienLlegados = new Set();
let iniciado = false;

/* -------------------------------------------------------------- kanban */

function tarjetaExpediente(e) {
  const urg = e.urgencia ?? "media";
  const nuevo = recienLlegados.has(e.id) ? " nueva" : "";
  return `
    <button class="expediente-card u-${esc(urg)}${nuevo}" data-id="${esc(e.id)}">
      <span class="card-alto">
        <span class="card-ref">${esc(e.ref)}</span>
        <span class="chip u-${esc(urg)}">${esc(ETIQUETA_URGENCIA[urg] ?? urg)}</span>
      </span>
      <span class="card-tipo">${esc(humaniza(e.tipo))} · ${esc(humaniza(e.subtipo))}</span>
      <span class="card-pie">
        <span class="chip-comunidad">${esc(comunidades.get(e.comunidad_id) ?? "—")}</span>
        ${esc(e.proveedor_nombre ?? "sin proveedor")}
      </span>
    </button>`;
}

function pintaKanban() {
  kanban.innerHTML = ESTADOS.map((estado) => {
    const propios = expedientes.filter((e) => e.estado === estado);
    const pila = propios.length
      ? propios.map(tarjetaExpediente).join("")
      : '<p class="col-vacia">Sin expedientes</p>';
    return `
      <div class="columna">
        <div class="columna-cabecera">
          <h3>${esc(ETIQUETA_ESTADO[estado])}</h3>
          <span class="contador">${propios.length}</span>
        </div>
        <div class="pila">${pila}</div>
      </div>`;
  }).join("");
}

/* --------------------------------------------------------------- ficha */

function abreFicha(id) {
  const e = expedientes.find((x) => x.id === id);
  if (!e) return;

  const pasos = Array.isArray(e.fincas_protocolos?.pasos) ? e.fincas_protocolos.pasos : [];

  cuerpo.innerHTML = `
    <p class="ficha-ref" id="ficha-ref">${esc(e.ref)}</p>
    <p class="ficha-sub">
      ${esc(comunidades.get(e.comunidad_id) ?? "—")}
      ${e.fincas_inmuebles?.puerta ? " · puerta " + esc(e.fincas_inmuebles.puerta) : ""}
      · abierto el ${esc(fecha(e.created_at))}
    </p>

    <p class="ficha-desc">${esc(e.descripcion ?? "Sin descripción.")}</p>

    <dl class="datos">
      <div><dt>Estado</dt><dd>${esc(ETIQUETA_ESTADO[e.estado] ?? e.estado)}</dd></div>
      <div><dt>Urgencia</dt><dd>${esc(ETIQUETA_URGENCIA[e.urgencia] ?? e.urgencia)}</dd></div>
      <div><dt>Tipo</dt><dd>${esc(humaniza(e.tipo))} · ${esc(humaniza(e.subtipo))}</dd></div>
      <div><dt>Propietario</dt><dd>${esc(e.fincas_inmuebles?.propietario_nombre ?? "—")}</dd></div>
      <div><dt>Proveedor</dt><dd>${esc(e.proveedor_nombre ?? "—")}</dd></div>
      <div><dt>Teléfono</dt><dd>${esc(e.proveedor_tel ?? "—")}</dd></div>
      <div><dt>Aviso enviado</dt><dd>${
        e.proveedor_avisado_at ? esc(fecha(e.proveedor_avisado_at)) + " (simulado)" : "—"
      }</dd></div>
    </dl>

    <div class="ficha-protocolo">
      <p class="etiqueta-bloque">Protocolo citado</p>
      <p class="cita">${esc(e.protocolo_citado ?? "Sin protocolo citado")}</p>
      ${pasos.length ? `<ol class="pasos">${pasos.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>` : ""}
    </div>`;

  velo.hidden = false;
}

/* ------------------------------------------------------ cola aprobación */

function tarjetaPresupuesto(p) {
  const partidas = Array.isArray(p.partidas) ? p.partidas : [];
  const exp = p.fincas_expedientes ?? {};
  const decidido = p.estado !== "pendiente";

  const lado = decidido
    ? `<div class="sello ${esc(p.estado)}">
         ${p.estado === "aprobado" ? "Aprobado" : "Rechazado"}
         ${p.decidido_por ? "<br>por " + esc(p.decidido_por) : ""}
       </div>`
    : `<div class="acciones">
         <button class="btn-aprobar"  data-id="${esc(p.id)}" data-decision="aprobado">Aprobar</button>
         <button class="btn-rechazar" data-id="${esc(p.id)}" data-decision="rechazado">Rechazar</button>
       </div>`;

  return `
    <article class="presupuesto${decidido ? " decidido" : ""}" data-presupuesto="${esc(p.id)}">
      <div class="presupuesto-info">
        <h3>${esc(p.proveedor_nombre)}</h3>
        <p class="presupuesto-meta">
          ${esc(exp.ref ?? "")} · ${esc(comunidades.get(exp.comunidad_id) ?? "")}
          · ${esc(humaniza(exp.tipo))}
        </p>
        <div class="partidas">
          ${partidas.map((it) => `
            <div class="partida">
              <span>${esc(it.concepto)}</span>
              <span>${esc(EUR.format(Number(it.importe) || 0))}</span>
            </div>`).join("")}
        </div>
        <p class="importe">${esc(EUR.format(Number(p.importe) || 0))}</p>
      </div>
      ${lado}
    </article>`;
}

async function cargaPresupuestos() {
  const { data, error } = await sb
    .from("fincas_presupuestos")
    .select("id, proveedor_nombre, importe, partidas, estado, decidido_por, decidido_at, " +
            "fincas_expedientes ( ref, tipo, comunidad_id )")
    .order("created_at", { ascending: false });

  if (error) {
    console.warn("[panel] presupuestos:", error);
    cola.innerHTML = '<p class="cola-vacia">No se han podido cargar los presupuestos.</p>';
    return;
  }
  cola.innerHTML = (data ?? []).length
    ? data.map(tarjetaPresupuesto).join("")
    : '<p class="cola-vacia">No hay presupuestos en cola.</p>';
}

/** Decide un presupuesto. La escritura la hace la Edge Function, no el
    navegador: aquí no hay ni un UPDATE. */
async function decide(id, decision, boton) {
  const fila = cola.querySelector(`[data-presupuesto="${CSS.escape(id)}"]`);
  fila?.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const original = boton.textContent;
  boton.textContent = "…";

  try {
    const r = await fetch(FN("fincas-presupuesto"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presupuesto_id: id, decision, actor: "administrador" }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error ?? "decisión rechazada");
    await Promise.all([cargaPresupuestos(), cargaExpedientes()]);
  } catch (e) {
    console.warn("[panel] no se ha podido decidir:", e);
    boton.textContent = original;
    fila?.querySelectorAll("button").forEach((b) => (b.disabled = false));
    alert("No se ha podido registrar la decisión. Inténtalo de nuevo.");
  }
}

/* ---------------------------------------------------------------- datos */

async function cargaExpedientes() {
  const { data, error } = await sb
    .from("fincas_expedientes")
    .select("id, ref, comunidad_id, tipo, subtipo, urgencia, estado, descripcion, " +
            "protocolo_citado, proveedor_nombre, proveedor_tel, proveedor_avisado_at, created_at, " +
            "fincas_inmuebles ( puerta, propietario_nombre ), fincas_protocolos ( pasos )")
    .order("created_at", { ascending: false });

  if (error) {
    console.warn("[panel] expedientes:", error);
    return;
  }
  expedientes = data ?? [];
  pintaKanban();
}

/* ------------------------------------------------------------- realtime */

function conectaRealtime() {
  sb.channel("fincas-demo")
    .on("postgres_changes",
        { event: "*", schema: "public", table: "fincas_expedientes" },
        (payload) => {
          /* Un expediente recién llegado se marca para que destelle en el
             kanban: en la reunión, eso es lo que se ve. */
          if (payload.eventType === "INSERT" && payload.new?.id) {
            recienLlegados.add(payload.new.id);
            setTimeout(() => recienLlegados.delete(payload.new.id), 4000);
          }
          cargaExpedientes();
        })
    .on("postgres_changes",
        { event: "*", schema: "public", table: "fincas_presupuestos" },
        () => cargaPresupuestos())
    .subscribe((estado) => {
      const vivo = estado === "SUBSCRIBED";
      punto.classList.toggle("vivo", vivo);
      estadoRT.textContent = vivo ? "conectado" : "sin conexión en vivo";
    });
}

/* ------------------------------------------------------------- arranque */

export async function iniciaPanel() {
  if (iniciado) {
    /* Al volver a la pestaña se refresca, por si el chat ha abierto algo
       mientras el realtime estaba dormido. */
    cargaExpedientes();
    cargaPresupuestos();
    return;
  }
  iniciado = true;

  const { data: comus } = await sb.from("fincas_comunidades").select("id, nombre");
  for (const c of comus ?? []) comunidades.set(c.id, c.nombre);

  kanban.addEventListener("click", (ev) => {
    const card = ev.target.closest(".expediente-card");
    if (card) abreFicha(card.dataset.id);
  });

  cola.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-decision]");
    if (b) decide(b.dataset.id, b.dataset.decision, b);
  });

  const cierra = () => { velo.hidden = true; };
  document.getElementById("cerrar-ficha").addEventListener("click", cierra);
  velo.addEventListener("click", (ev) => { if (ev.target === velo) cierra(); });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !velo.hidden) cierra();
  });

  await Promise.all([cargaExpedientes(), cargaPresupuestos()]);
  conectaRealtime();
}
