/* =========================================================================
   admin.js — CRM privado de Whitemoon Fincas
   =========================================================================
   Todo lo que hay aquí se ejecuta con el JWT del administrador, no con la
   clave anon: la RLS sólo abre las tablas a quien tiene perfil activo en
   fincas_perfiles. Por eso este fichero puede hacer SELECT e INSERT
   directos contra PostgREST sin una capa de Edge Functions por medio, y por
   eso el rastro de cada cambio lo deja la propia base (triggers de
   auditoría) en vez de fiarse de que el cliente llame a nadie.

   LA EXCEPCIÓN SON LOS DATOS PROTEGIDOS
   El IBAN y los datos del presidente NO se tocan desde aquí directamente:
   viven en un esquema que la API no expone. Se piden a la Edge Function
   fincas-privado, que valida el JWT y registra la consulta. Si esa llamada
   falla, la ficha lo dice; no se inventa un hueco vacío.

   La aplicación arranca VACÍA a propósito: cada sección tiene su estado
   "aún no hay…" con lo que hay que hacer para empezar.
   ========================================================================= */

import {
  sb, FN, SUPABASE_URL, esc, EUR, ETIQUETA_URGENCIA, ETIQUETA_ESTADO,
  humaniza, fecha,
} from "./config.js";

const ESTADOS_EXP = ["nuevo", "asignado", "en_curso", "cerrado"];

const $ = (id) => document.getElementById(id);
const panel = $("panel");
const velo = $("velo");
const modalCuerpo = $("modal-cuerpo");

/* Todo lo cargado, en memoria. Son volúmenes de una administración de
   fincas: caben de sobra y evita ir a la base en cada pintada. */
const D = {
  comunidades: [], proveedores: [], expedientes: [],
  presupuestos: [], facturas: [], perfil: null,
  borradores: [], plantillas: [], autonomia: null,
};

/* Los ocho trámites de la biblioteca. El orden es el del flujo real de un
   expediente, que es como los busca quien trabaja con esto. */
const TRAMITES = [
  "solicitud_presupuesto", "recordatorio_presupuesto", "confirmacion_visita",
  "adjudicacion", "solicitud_factura", "reclamacion_factura",
  "aviso_propietario", "apertura_siniestro",
];

const ETIQUETA_DISCREPANCIA = {
  totales_no_cuadran: "Los totales no cuadran",
  factura_duplicada: "Factura duplicada",
  sin_presupuesto_aprobado: "Sin presupuesto aprobado",
  importe_distinto_presupuesto: "Importe distinto del presupuestado",
  proveedor_no_coincide: "El proveedor no coincide",
};

let seccion = "expedientes";
let comunidadAbierta = null;

/* ====================================================================== */
/* AUTENTICACIÓN                                                          */
/* ====================================================================== */

async function jwt() {
  const { data } = await sb.auth.getSession();
  return data?.session?.access_token ?? "";
}

/**
 * Entrada por clave. Este código NO valida nada: manda la clave a
 * fincas-panel-auth y espera a ver qué contesta. La comprobación vive en el
 * servidor, contra un Secret o su hash bcrypt, y lo que vuelve es una sesión
 * real de Supabase Auth. A partir de ahí el CRM funciona bajo RLS igual que
 * con cualquier otro login: si alguien se saltara este formulario a la
 * fuerza, seguiría sin tener sesión y no leería una fila.
 */
async function entrarConClave(ev) {
  ev.preventDefault();
  const btn = $("clave-btn");
  const err = $("login-error");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Comprobando…";

  try {
    const r = await fetch(FN("fincas-panel-auth"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clave: $("clave").value }),
    }).then((x) => x.json());

    if (!r?.ok || !r.session?.access_token) {
      err.textContent = r?.error ?? "No se ha podido comprobar la clave.";
      err.hidden = false;
      return;
    }

    const { error } = await sb.auth.setSession({
      access_token: r.session.access_token,
      refresh_token: r.session.refresh_token,
    });
    if (error) {
      err.textContent = "La sesión no se ha podido establecer: " + error.message;
      err.hidden = false;
      return;
    }
    $("clave").value = "";
    await arranca();
  } catch (e) {
    console.warn("[crm] acceso:", e);
    err.textContent = "No se ha podido conectar. Inténtalo de nuevo.";
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
}

async function entrar(ev) {
  ev.preventDefault();
  const btn = $("login-btn");
  const err = $("login-error");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Entrando…";

  const { data, error } = await sb.auth.signInWithPassword({
    email: $("login-email").value.trim(),
    password: $("login-pass").value,
  });

  btn.disabled = false;
  btn.textContent = "Entrar";

  if (error || !data?.session) {
    err.textContent = "Email o contraseña incorrectos.";
    err.hidden = false;
    return;
  }
  await arranca();
}

async function salir() {
  await sb.auth.signOut();
  location.reload();
}

/**
 * Estar autenticado no basta: hace falta perfil activo. Un usuario de
 * Supabase Auth sin fila en fincas_perfiles no ve nada — la RLS le
 * devolvería listas vacías, así que es mejor decírselo claramente que
 * dejarle delante de un CRM fantasma.
 */
async function perfilActivo() {
  const { data, error } = await sb
    .from("fincas_perfiles")
    .select("user_id, email, nombre, rol")
    .limit(1);
  if (error || !data?.length) return null;
  return data[0];
}

/* ====================================================================== */
/* CARGA DE DATOS                                                         */
/* ====================================================================== */

async function cargaTodo() {
  const [comus, provs, exps, pres, facs, borr, plan, auto] = await Promise.all([
    sb.from("fincas_comunidades").select("*").order("nombre"),
    sb.from("fincas_proveedores").select("*").order("nombre"),
    sb.from("fincas_expedientes")
      .select("*, fincas_inmuebles(puerta, propietario_nombre), fincas_protocolos(pasos)")
      .order("created_at", { ascending: false }),
    sb.from("fincas_presupuestos")
      .select("*, fincas_expedientes(ref, tipo, comunidad_id, estado)")
      .order("created_at", { ascending: false }),
    sb.from("fincas_facturas").select("*").order("created_at", { ascending: false }),
    sb.from("fincas_comunicaciones")
      .select("*, fincas_expedientes(ref)")
      .eq("estado", "borrador")
      .order("created_at", { ascending: false }),
    sb.from("fincas_plantillas_email").select("*").order("tipo_tramite"),
    sb.from("fincas_config_autonomia").select("*").is("comunidad_id", null).limit(1),
  ]);

  for (const r of [comus, provs, exps, pres, facs, borr, plan, auto]) {
    if (r.error) console.warn("[crm] carga:", r.error.message);
  }

  D.borradores = borr.data ?? [];
  D.plantillas = plan.data ?? [];
  D.autonomia = (auto.data ?? [])[0] ?? null;

  D.comunidades = comus.data ?? [];
  D.proveedores = provs.data ?? [];
  D.expedientes = exps.data ?? [];
  D.presupuestos = pres.data ?? [];
  D.facturas = facs.data ?? [];

  $("c-expedientes").textContent = D.expedientes.filter((e) => e.estado !== "cerrado").length;
  $("c-presupuestos").textContent = D.presupuestos.filter((p) => p.estado === "pendiente").length;
  $("c-facturacion").textContent = D.facturas.filter((f) => f.estado === "borrador").length;
  $("c-contable").textContent = D.facturas.filter((f) => f.estado === "revisar").length;
  $("c-correos").textContent = D.borradores.length;
  $("c-comunidades").textContent = D.comunidades.length;
  $("c-proveedores").textContent = D.proveedores.length;
}

const comunidadDe = (id) => D.comunidades.find((c) => c.id === id) ?? null;
const nombreComunidad = (id) => comunidadDe(id)?.nombre ?? "—";

/* ====================================================================== */
/* MODAL                                                                  */
/* ====================================================================== */

function abreModal(html) {
  modalCuerpo.innerHTML = html;
  velo.hidden = false;
}
function cierraModal() {
  velo.hidden = true;
  modalCuerpo.innerHTML = "";
}

/* ====================================================================== */
/* SECCIÓN · EXPEDIENTES                                                  */
/* ====================================================================== */

function pintaExpedientes() {
  if (!D.expedientes.length) {
    panel.innerHTML = cabecera("Expedientes", "Incidencias abiertas por el agente o por el equipo.") + `
      <div class="vacio">
        <strong>Aún no hay expedientes</strong>
        <p>Se abrirán solos cuando un vecino escriba en el chat de la web y el
        agente identifique su comunidad. Para que eso funcione, antes hay que
        dar de alta al menos una comunidad, un proveedor con email y un
        protocolo.</p>
      </div>`;
    return;
  }

  const columnas = ESTADOS_EXP.map((estado) => {
    const propios = D.expedientes.filter((e) => e.estado === estado);
    const pila = propios.length
      ? propios.map(tarjetaExp).join("")
      : '<p style="font-size:12px;color:var(--muted);padding:10px 2px">Vacío</p>';
    return `<div class="columna">
      <div class="columna-cab">
        <h3>${esc(ETIQUETA_ESTADO[estado])}</h3>
        <span class="cuenta" style="font-size:11px;color:var(--muted)">${propios.length}</span>
      </div>
      <div class="pila">${pila}</div>
    </div>`;
  }).join("");

  panel.innerHTML =
    cabecera("Expedientes", "Incidencias abiertas por el agente o por el equipo.") +
    `<div class="kanban">${columnas}</div>`;
}

function tarjetaExp(e) {
  const u = e.urgencia ?? "media";
  return `<button class="exp-card u-${esc(u)}" data-exp="${esc(e.id)}">
    <span class="alto">
      <span class="ref">${esc(e.ref)}</span>
      <span class="chip u-${esc(u)}">${esc(ETIQUETA_URGENCIA[u] ?? u)}</span>
    </span>
    <span class="tipo">${esc(humaniza(e.tipo))} · ${esc(humaniza(e.subtipo))}</span>
    <span class="pie">${esc(nombreComunidad(e.comunidad_id))} · ${esc(e.proveedor_nombre || "sin proveedor")}</span>
  </button>`;
}

async function abreFichaExpediente(id) {
  const e = D.expedientes.find((x) => x.id === id);
  if (!e) return;

  abreModal('<p class="cargando">Cargando el historial…</p>');

  const { data: comms } = await sb
    .from("fincas_comunicaciones")
    .select("*")
    .eq("expediente_id", id)
    .order("created_at", { ascending: true });

  const presus = D.presupuestos.filter((p) => p.expediente_id === id);
  const pasos = Array.isArray(e.fincas_protocolos?.pasos) ? e.fincas_protocolos.pasos : [];

  abreModal(`
    <p class="ficha-ref">${esc(e.ref)}</p>
    <p class="ficha-sub">
      ${esc(nombreComunidad(e.comunidad_id))}
      ${e.fincas_inmuebles?.puerta ? " · puerta " + esc(e.fincas_inmuebles.puerta) : ""}
      · abierto el ${esc(fecha(e.created_at))}
    </p>

    <p class="ficha-desc">${esc(e.descripcion || "Sin descripción.")}</p>

    <dl class="datos">
      <div><dt>Estado</dt><dd>
        <select id="exp-estado" style="max-width:190px">
          ${ESTADOS_EXP.map((s) => `<option value="${s}"${s === e.estado ? " selected" : ""}>${esc(ETIQUETA_ESTADO[s])}</option>`).join("")}
        </select>
      </dd></div>
      <div><dt>Urgencia</dt><dd>${esc(ETIQUETA_URGENCIA[e.urgencia] ?? e.urgencia)}</dd></div>
      <div><dt>Tipo</dt><dd>${esc(humaniza(e.tipo))} · ${esc(humaniza(e.subtipo))}</dd></div>
      <div><dt>Quien avisa</dt><dd>${esc(e.solicitante_nombre || "—")}${e.solicitante_tel ? " · " + esc(e.solicitante_tel) : ""}${e.solicitante_email ? " · " + esc(e.solicitante_email) : ""}</dd></div>
      <div><dt>Propietario</dt><dd>${esc(e.fincas_inmuebles?.propietario_nombre ?? "—")}</dd></div>
      <div><dt>Proveedor</dt><dd>${esc(e.proveedor_nombre || "—")}</dd></div>
      <div><dt>Aviso enviado</dt><dd>${e.proveedor_avisado_at ? esc(fecha(e.proveedor_avisado_at)) : "—"}</dd></div>
    </dl>

    <div class="ficha-protocolo">
      <p class="etiqueta">Protocolo citado</p>
      <p class="cita">${esc(e.protocolo_citado || "Sin protocolo citado")}</p>
      ${pasos.length ? `<ol style="margin:10px 0 0;padding-left:18px;font-size:12.5px;color:#c9c9dc">${pasos.map((p) => `<li style="margin-bottom:4px">${esc(p)}</li>`).join("")}</ol>` : ""}
    </div>

    <div class="acciones-form">
      <button class="btn-mini" id="reenviar" ${e.proveedor_nombre ? "" : "disabled"}>
        Reenviar petición al proveedor
      </button>
      <button class="btn-mini" id="guardar-estado">Guardar estado</button>
    </div>

    ${presus.length ? `
      <h3 style="font-size:14px;font-weight:600;margin:22px 0 8px">Presupuestos del expediente</h3>
      <div class="lista">${presus.map(filaPresupuesto).join("")}</div>` : ""}

    <h3 style="font-size:14px;font-weight:600;margin:22px 0 8px">Historial de comunicaciones</h3>
    ${(comms ?? []).length
      ? `<div class="timeline">${comms.map(itemTimeline).join("")}</div>`
      : `<div class="vacio"><strong>Aún no hay comunicaciones</strong>
           <p>Aquí aparecerán los correos que salgan al proveedor y sus respuestas.</p></div>`}
  `);

  $("guardar-estado").onclick = async () => {
    const nuevo = $("exp-estado").value;
    const patch = { estado: nuevo };
    if (nuevo === "cerrado") patch.cerrado_at = new Date().toISOString();
    const { error } = await sb.from("fincas_expedientes").update(patch).eq("id", id);
    if (error) return alert("No se ha podido guardar: " + error.message);
    await cargaTodo();
    cierraModal();
    render();
  };

  $("reenviar").onclick = async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = "Enviando…";
    const r = await fetch(FN("fincas-enviar-email"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await jwt()}` },
      body: JSON.stringify({ expediente_id: id }),
    }).then((x) => x.json()).catch(() => null);

    ev.target.disabled = false;
    ev.target.textContent = "Reenviar petición al proveedor";
    if (r?.ok) alert(`Correo enviado a ${r.para}`);
    else alert("No se ha podido enviar: " + (r?.error ?? "error desconocido"));
    await cargaTodo();
    abreFichaExpediente(id);
  };
}

function itemTimeline(c) {
  const icono = c.direccion === "entrante" ? "↓" : c.direccion === "saliente" ? "↑" : "•";
  const clase = c.estado === "fallido" ? "fallido" : c.direccion;
  const adj = Array.isArray(c.adjuntos) ? c.adjuntos : [];
  return `<div class="tl-item">
    <span class="tl-punto ${esc(clase)}">${icono}</span>
    <div class="tl-cuerpo">
      <p class="tl-tit">${esc(c.asunto || (c.direccion === "entrante" ? "Respuesta recibida" : "Correo enviado"))}</p>
      <p class="tl-meta">
        ${esc(fecha(c.created_at))} · ${esc(c.canal)} ·
        ${c.direccion === "entrante" ? "de " + esc(c.de_email) : "a " + esc(c.para_email || "—")}
        · <span class="chip ${c.estado === "fallido" ? "aviso" : "neutro"}">${esc(c.estado)}</span>
      </p>
      ${c.cuerpo ? `<div class="tl-txt">${esc(c.cuerpo)}</div>` : ""}
      ${adj.length ? `<p class="tl-meta" style="margin-top:6px">Adjunto: ${adj.map((a) => esc(a.nombre)).join(", ")}</p>` : ""}
      ${c.error ? `<p class="tl-err">${esc(c.error)}</p>` : ""}
    </div>
  </div>`;
}

/* ====================================================================== */
/* SECCIÓN · PRESUPUESTOS                                                 */
/* ====================================================================== */

function filaPresupuesto(p) {
  const exp = p.fincas_expedientes ?? {};
  const decidido = p.estado !== "pendiente";
  const importe = p.importe != null ? EUR.format(Number(p.importe)) : "sin importe leído";
  return `<div class="fila plano">
    <div>
      <p class="fila-tit">${esc(p.proveedor_nombre)} · ${esc(importe)}</p>
      <p class="fila-sub">
        ${esc(exp.ref ?? "sin expediente")} · ${esc(nombreComunidad(exp.comunidad_id))} ·
        entrada por ${esc(p.origen)} · ${esc(fecha(p.created_at))}
        ${p.adjunto_nombre ? " · adjunto " + esc(p.adjunto_nombre) : ""}
      </p>
    </div>
    <div class="fila-acc">
      ${p.adjunto_path ? `<button class="btn-mini" data-adjunto="${esc(p.adjunto_path)}">Ver PDF</button>` : ""}
      ${decidido
        ? `<span class="chip ${p.estado === "aprobado" ? "ok" : "aviso"}">${esc(p.estado)}${p.decidido_por ? " · " + esc(p.decidido_por) : ""}</span>`
        : `<button class="btn-mini ok" data-presu="${esc(p.id)}" data-dec="aprobado">Aprobar</button>
           <button class="btn-mini no" data-presu="${esc(p.id)}" data-dec="rechazado">Rechazar</button>`}
    </div>
  </div>`;
}

function pintaPresupuestos() {
  const cab = cabecera("Bandeja de presupuestos",
    "Lo que responden los proveedores por correo entra aquí, ligado a su expediente.");

  const aviso = `<div class="aviso-linea verde">
    <span aria-hidden="true">⚖</span>
    <p><b>La IA prepara; el administrador decide.</b> El agente pide el presupuesto y
    lo recibe, pero no lo adjudica: hasta que una persona no pulsa Aprobar, no pasa nada.</p>
  </div>`;

  if (!D.presupuestos.length) {
    panel.innerHTML = cab + aviso + `
      <div class="vacio">
        <strong>Aún no hay presupuestos</strong>
        <p>Cuando un proveedor responda al correo de petición sin cambiar el
        asunto, su respuesta y el PDF adjunto aparecerán aquí enlazados al
        expediente. Requiere tener configurado el buzón de entrada
        (Cloudflare Email Routing → fincas-inbound).</p>
      </div>`;
    return;
  }
  panel.innerHTML = cab + aviso + `<div class="lista">${D.presupuestos.map(filaPresupuesto).join("")}</div>`;
}

async function decidePresupuesto(id, decision) {
  const p = D.presupuestos.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`¿${decision === "aprobado" ? "Aprobar" : "Rechazar"} el presupuesto de ${p.proveedor_nombre}?`)) return;

  /* El filtro estado=pendiente va también en el UPDATE: si dos personas
     deciden a la vez, la segunda no pisa a la primera. */
  const { data, error } = await sb
    .from("fincas_presupuestos")
    .update({
      estado: decision,
      decidido_por: D.perfil?.email ?? "administrador",
      decidido_at: new Date().toISOString(),
    })
    .eq("id", id).eq("estado", "pendiente").select();

  if (error) return alert("No se ha podido registrar: " + error.message);
  if (!data?.length) return alert("Ese presupuesto ya había sido decidido por otra persona.");

  if (decision === "aprobado" && p.expediente_id) {
    await sb.from("fincas_expedientes").update({ estado: "en_curso" }).eq("id", p.expediente_id);
  }
  await cargaTodo();
  render();
}

/** Los adjuntos están en un bucket privado: se abre con una URL firmada. */
async function abreAdjunto(path) {
  const { data, error } = await sb.storage.from("fincas-docs").createSignedUrl(path, 120);
  if (error || !data?.signedUrl) return alert("No se ha podido abrir el documento.");
  window.open(data.signedUrl, "_blank", "noopener");
}

/* ====================================================================== */
/* SECCIÓN · FACTURACIÓN                                                  */
/* ====================================================================== */

function pintaFacturacion() {
  const cab = cabecera("Facturación",
    "Facturas y certificados de deuda. Nacen como borrador y esperan aprobación.");

  const aviso = `<div class="aviso-linea verde">
    <span aria-hidden="true">🧾</span>
    <p><b>Nada se emite solo.</b> Un borrador no vale como documento: sólo cuenta
    cuando una persona lo aprueba, y esa decisión queda en la auditoría con su nombre.</p>
  </div>`;

  const form = `<div class="caja">
    <h3>Nuevo borrador</h3>
    <p class="sub">Se guarda en estado borrador. Aprobarlo es un segundo paso deliberado.</p>
    <div class="rejilla">
      <div class="campo">
        <label for="f-comunidad">Comunidad</label>
        <select id="f-comunidad">${opcionesComunidad()}</select>
      </div>
      <div class="campo">
        <label for="f-tipo">Tipo</label>
        <select id="f-tipo">
          <option value="factura">Factura</option>
          <option value="certificado_deuda">Certificado de deuda</option>
        </select>
      </div>
      <div class="campo ancho">
        <label for="f-concepto">Concepto</label>
        <input id="f-concepto" type="text" maxlength="200" placeholder="Derrama extraordinaria ascensor">
      </div>
      <div class="campo">
        <label for="f-importe">Importe (€)</label>
        <input id="f-importe" type="number" step="0.01" min="0" value="0">
      </div>
      <div class="campo">
        <label for="f-periodo">Periodo</label>
        <input id="f-periodo" type="text" maxlength="40" placeholder="2026 T1">
      </div>
    </div>
    <div class="acciones-form">
      <button class="btn btn-p" id="f-crear" ${D.comunidades.length ? "" : "disabled"}>Crear borrador</button>
    </div>
    ${D.comunidades.length ? "" : '<p class="ayuda" style="margin-top:10px;color:var(--muted);font-size:12px">Da de alta una comunidad primero.</p>'}
  </div>`;

  const lista = D.facturas.length
    ? `<div class="lista">${D.facturas.map(filaFactura).join("")}</div>`
    : `<div class="vacio">
         <strong>Aún no hay facturas ni certificados</strong>
         <p>Crea el primer borrador arriba. Mientras esté en borrador no es un
         documento emitido: es una propuesta esperando decisión.</p>
       </div>`;

  panel.innerHTML = cab + aviso + form + lista;

  const crear = $("f-crear");
  if (crear) crear.onclick = creaFactura;
}

function filaFactura(f) {
  const decidido = f.estado !== "borrador";
  return `<div class="fila plano">
    <div>
      <p class="fila-tit">
        ${esc(f.tipo === "factura" ? "Factura" : "Certificado de deuda")} · ${esc(f.concepto)}
      </p>
      <p class="fila-sub">
        ${esc(nombreComunidad(f.comunidad_id))} · ${esc(EUR.format(Number(f.importe) || 0))}
        ${f.periodo ? " · " + esc(f.periodo) : ""} · ${esc(fecha(f.created_at))}
      </p>
    </div>
    <div class="fila-acc">
      ${decidido
        ? `<span class="chip ${f.estado === "aprobada" ? "ok" : "aviso"}">${esc(f.estado)}${f.decidido_por ? " · " + esc(f.decidido_por) : ""}</span>`
        : `<span class="chip neutro">borrador</span>
           <button class="btn-mini ok" data-fac="${esc(f.id)}" data-dec="aprobada">Aprobar</button>
           <button class="btn-mini no" data-fac="${esc(f.id)}" data-dec="rechazada">Rechazar</button>`}
    </div>
  </div>`;
}

async function creaFactura() {
  const concepto = $("f-concepto").value.trim();
  if (!concepto) return alert("Pon un concepto.");
  const { error } = await sb.from("fincas_facturas").insert({
    comunidad_id: $("f-comunidad").value,
    tipo: $("f-tipo").value,
    concepto,
    importe: Number($("f-importe").value) || 0,
    periodo: $("f-periodo").value.trim(),
    estado: "borrador",
  });
  if (error) return alert("No se ha podido crear: " + error.message);
  await cargaTodo();
  render();
}

async function decideFactura(id, decision) {
  const f = D.facturas.find((x) => x.id === id);
  if (!f) return;
  if (!confirm(`¿${decision === "aprobada" ? "Aprobar" : "Rechazar"} "${f.concepto}"?`)) return;

  const { data, error } = await sb.from("fincas_facturas").update({
    estado: decision,
    decidido_por: D.perfil?.email ?? "administrador",
    decidido_at: new Date().toISOString(),
  }).eq("id", id).eq("estado", "borrador").select();

  if (error) return alert("No se ha podido registrar: " + error.message);
  if (!data?.length) return alert("Ese documento ya había sido decidido.");

  avisaEquipo({
    tipo: "aprobacion",
    concepto: `${f.tipo === "factura" ? "Factura" : "Certificado"} ${decision}`,
    comunidad: nombreComunidad(f.comunidad_id),
    detalle: `${f.concepto} · ${EUR.format(Number(f.importe) || 0)}`,
  });
  await cargaTodo();
  render();
}

function avisaEquipo(payload) {
  fetch(FN("fincas-notify"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((e) => console.warn("[crm] aviso:", e));
}

/* ====================================================================== */
/* SECCIÓN · COMUNIDADES                                                  */
/* ====================================================================== */

function opcionesComunidad(sel = "") {
  return D.comunidades
    .map((c) => `<option value="${esc(c.id)}"${c.id === sel ? " selected" : ""}>${esc(c.nombre)}</option>`)
    .join("");
}

function pintaComunidades() {
  if (comunidadAbierta) return pintaDetalleComunidad(comunidadAbierta);

  const cab = cabecera("Comunidades", "Las fincas que administras. Cada una con su protocolo.");

  const alta = `<div class="caja">
    <h3>Alta de comunidad</h3>
    <p class="sub">Lo mínimo para empezar: nombre y dirección. El resto se rellena luego.</p>
    <div class="rejilla">
      <div class="campo"><label for="c-nombre">Nombre</label>
        <input id="c-nombre" type="text" maxlength="120" placeholder="C.P. Serrano 118"></div>
      <div class="campo"><label for="c-direccion">Dirección</label>
        <input id="c-direccion" type="text" maxlength="200" placeholder="C/ Serrano 118, Madrid"></div>
      <div class="campo"><label for="c-cif">CIF</label>
        <input id="c-cif" type="text" maxlength="20" placeholder="H12345678"></div>
    </div>

    <div class="caja caja-protegida" style="margin:16px 0 0">
      <h3>Presidente de la comunidad <span class="protegido">🔐 Dato protegido</span></h3>
      <p class="sub">
        Datos personales de un vecino. No se guardan con el resto de la ficha:
        van al esquema protegido, el mismo que el IBAN, y sólo los ve el equipo.
        El asistente de IA no tiene forma de llegar a ellos. Los tres son opcionales.
      </p>
      <div class="rejilla">
        <div class="campo"><label for="c-pres">Presidente</label>
          <input id="c-pres" type="text" maxlength="160" placeholder="Marta Iglesias Cano"></div>
        <div class="campo"><label for="c-pres-tel">Teléfono del presidente</label>
          <input id="c-pres-tel" type="tel" maxlength="40" placeholder="600 100 103"></div>
        <div class="campo ancho"><label for="c-pres-email">Email del presidente</label>
          <input id="c-pres-email" type="email" maxlength="160" placeholder="presidente@ejemplo.es"></div>
      </div>
    </div>

    <div class="acciones-form"><button class="btn btn-p" id="c-crear">Dar de alta</button></div>
  </div>`;

  const lista = D.comunidades.length
    ? `<div class="lista">${D.comunidades.map((c) => `
        <button class="fila" data-comunidad="${esc(c.id)}">
          <div>
            <p class="fila-tit">${esc(c.nombre)}</p>
            <p class="fila-sub">${esc(c.direccion)}${c.cif ? " · " + esc(c.cif) : ""}</p>
          </div>
          <div class="fila-acc"><span class="chip neutro">Abrir ficha</span></div>
        </button>`).join("")}</div>`
    : `<div class="vacio">
         <strong>Aún no hay comunidades</strong>
         <p>Da de alta la primera arriba. Sin comunidades, el agente no puede
         identificar de dónde llama un vecino y escalará todo a administración.</p>
       </div>`;

  panel.innerHTML = cab + alta + lista;
  $("c-crear").onclick = creaComunidad;
}

/**
 * El alta va en dos escrituras a propósito, no por descuido.
 *
 * La ficha de la comunidad se inserta contra la tabla pública, con el JWT
 * del administrador y bajo RLS. Los datos del presidente son personales y NO
 * pasan por ahí: van por fincas-privado, que los mete en el esquema que la
 * API no expone. Guardarlos juntos sería más cómodo y dejaría el teléfono
 * de un vecino en una tabla que lee todo el equipo y que el agente sí tiene
 * a tiro.
 *
 * Si la segunda escritura falla, la comunidad ya está creada: se avisa y se
 * dice dónde terminar de rellenarlo, en vez de dejarlo en silencio.
 */
async function creaComunidad() {
  const nombre = $("c-nombre").value.trim();
  const direccion = $("c-direccion").value.trim();
  if (!nombre || !direccion) return alert("Nombre y dirección son obligatorios.");

  const { data, error } = await sb.from("fincas_comunidades").insert({
    nombre, direccion, cif: $("c-cif").value.trim(),
  }).select();
  if (error) return alert("No se ha podido crear: " + error.message);

  const creada = data?.[0];
  const presidente = {
    presidente_nombre: $("c-pres").value.trim(),
    presidente_telefono: $("c-pres-tel").value.trim(),
    presidente_email: $("c-pres-email").value.trim(),
  };

  if (creada && Object.values(presidente).some(Boolean)) {
    const r = await fetch(FN("fincas-privado"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await jwt()}` },
      body: JSON.stringify({ accion: "guardar", comunidad_id: creada.id, ...presidente }),
    }).then((x) => x.json()).catch(() => null);

    if (!r?.ok) {
      alert("La comunidad se ha creado, pero no se han podido guardar los datos del " +
            "presidente. Ábrela y vuelve a intentarlo desde su ficha.");
    }
  }

  await cargaTodo();
  render();
}

async function pintaDetalleComunidad(id) {
  const c = comunidadDe(id);
  if (!c) { comunidadAbierta = null; return pintaComunidades(); }

  panel.innerHTML = `
    <div class="panel-cab">
      <div>
        <button class="btn-mini" id="volver">← Comunidades</button>
        <h2 style="margin-top:12px">${esc(c.nombre)}</h2>
        <p>${esc(c.direccion)}</p>
      </div>
    </div>
    <div id="det"><p class="cargando">Cargando la ficha…</p></div>`;

  $("volver").onclick = () => { comunidadAbierta = null; render(); };

  const [inms, prots, docs] = await Promise.all([
    sb.from("fincas_inmuebles").select("*").eq("comunidad_id", id).order("puerta"),
    sb.from("fincas_protocolos").select("*").eq("comunidad_id", id).order("categoria"),
    sb.from("fincas_documentos").select("*").eq("comunidad_id", id).order("created_at", { ascending: false }),
  ]);

  const inmuebles = inms.data ?? [];
  const protocolos = prots.data ?? [];
  const documentos = docs.data ?? [];

  $("det").innerHTML = `
    ${bloqueProtegido()}
    ${bloqueProtocolos(protocolos)}
    ${bloqueInmuebles(inmuebles)}
    ${bloqueDocumentos(documentos)}`;

  cargaDatosProtegidos(id);
  enganchaFichaComunidad(id);
}

function bloqueProtegido() {
  return `<div class="caja caja-protegida">
    <h3>Presidente y datos bancarios <span class="protegido">🔐 Dato protegido</span></h3>
    <p class="sub">
      Guardados en un esquema aparte que la API no expone y al que el agente de IA
      no tiene ninguna herramienta para llegar. Cada consulta queda auditada.
    </p>
    <div id="prot-box"><p class="cargando">Comprobando permisos…</p></div>
  </div>`;
}

async function cargaDatosProtegidos(id) {
  const box = $("prot-box");
  const r = await fetch(FN("fincas-privado"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await jwt()}` },
    body: JSON.stringify({ accion: "leer", comunidad_id: id }),
  }).then((x) => x.json()).catch(() => null);

  if (!r?.ok) {
    box.innerHTML = `<p class="tl-err">No se han podido cargar los datos protegidos${r?.error ? ": " + esc(r.error) : "."}</p>`;
    return;
  }
  const d = r.datos ?? {};
  box.innerHTML = `
    <div class="rejilla">
      <div class="campo"><label for="p-pres">Presidente</label>
        <input id="p-pres" type="text" maxlength="160" value="${esc(d.presidente_nombre)}"></div>
      <div class="campo"><label for="p-pres-tel">Teléfono del presidente</label>
        <input id="p-pres-tel" type="tel" maxlength="40" value="${esc(d.presidente_telefono)}"></div>
      <div class="campo"><label for="p-pres-email">Email del presidente</label>
        <input id="p-pres-email" type="email" maxlength="160" value="${esc(d.presidente_email)}"></div>
      <div class="campo"><label for="p-iban">IBAN de la comunidad</label>
        <input id="p-iban" type="text" maxlength="40" value="${esc(d.iban)}" placeholder="ES00 0000 0000 0000 0000 0000"></div>
      <div class="campo ancho"><label for="p-notas">Notas internas</label>
        <input id="p-notas" type="text" maxlength="200" value="${esc(d.notas)}"></div>
    </div>
    <div class="acciones-form"><button class="btn-mini ok" id="p-guardar">Guardar datos protegidos</button></div>`;

  $("p-guardar").onclick = async (ev) => {
    ev.target.disabled = true;
    const res = await fetch(FN("fincas-privado"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await jwt()}` },
      body: JSON.stringify({
        accion: "guardar", comunidad_id: id,
        presidente_nombre: $("p-pres").value,
        presidente_telefono: $("p-pres-tel").value,
        presidente_email: $("p-pres-email").value,
        iban: $("p-iban").value,
        notas: $("p-notas").value,
      }),
    }).then((x) => x.json()).catch(() => null);
    ev.target.disabled = false;
    alert(res?.ok ? "Guardado." : "No se ha podido guardar.");
  };
}

function bloqueProtocolos(protocolos) {
  const lista = protocolos.length
    ? `<div class="lista">${protocolos.map((p) => `
        <div class="fila plano">
          <div>
            <p class="fila-tit">${esc(humaniza(p.categoria))} · ${esc(humaniza(p.subtipo))}</p>
            <p class="fila-sub">${esc(p.proveedor_nombre)} · urgencia ${esc(p.urgencia_default)} · ${esc(p.cita_fuente)}</p>
          </div>
          <div class="fila-acc">
            <span class="chip neutro">${(Array.isArray(p.pasos) ? p.pasos.length : 0)} pasos</span>
            <button class="btn-mini no" data-borra-prot="${esc(p.id)}">Borrar</button>
          </div>
        </div>`).join("")}</div>`
    : `<div class="vacio">
         <strong>Aún no hay protocolos</strong>
         <p>Sin protocolo, el agente no puede decidir a quién avisar y escalará
         la incidencia a una persona. Define al menos ascensores y fontanería.</p>
       </div>`;

  return `<div class="caja">
    <h3>Protocolos de esta comunidad</h3>
    <p class="sub">Qué se hace ante cada caso y a quién se avisa. Es lo que consulta el agente.</p>
    ${lista}
    <div class="rejilla" style="margin-top:16px">
      <div class="campo"><label for="pr-cat">Categoría</label>
        <input id="pr-cat" type="text" maxlength="40" placeholder="ascensores" list="cats">
        <datalist id="cats">
          <option value="ascensores"><option value="fontaneria"><option value="electricidad">
          <option value="cerrajeria"><option value="limpieza"><option value="jardineria">
        </datalist></div>
      <div class="campo"><label for="pr-sub">Subtipo</label>
        <input id="pr-sub" type="text" maxlength="40" placeholder="parado"></div>
      <div class="campo"><label for="pr-prov">Proveedor asignado</label>
        <select id="pr-prov">
          ${D.proveedores.length
            ? D.proveedores.map((p) => `<option value="${esc(p.id)}">${esc(p.nombre)}${p.email ? "" : " (sin email)"}</option>`).join("")
            : '<option value="">— da de alta un proveedor primero —</option>'}
        </select></div>
      <div class="campo"><label for="pr-urg">Urgencia por defecto</label>
        <select id="pr-urg">
          <option value="critica">Crítica</option><option value="alta" selected>Alta</option>
          <option value="media">Media</option><option value="baja">Baja</option>
        </select></div>
      <div class="campo ancho"><label for="pr-cita">Cita de la fuente</label>
        <input id="pr-cita" type="text" maxlength="200"
               placeholder="Manual de incidencias · §3.1 Ascensores — avería sin atrapados">
        <span class="ayuda">Es lo que el agente dirá al vecino. Sé específico con la sección.</span></div>
      <div class="campo ancho"><label for="pr-pasos">Pasos (uno por línea)</label>
        <textarea id="pr-pasos" placeholder="Confirmar si hay personas atrapadas.&#10;Avisar al mantenedor de guardia."></textarea></div>
      <div class="campo ancho"><label for="pr-claves">Palabras clave</label>
        <input id="pr-claves" type="text" maxlength="300"
               placeholder="ascensor elevador parado averiado no funciona bloqueado">
        <span class="ayuda">Alimentan la búsqueda de texto: lo que diría un vecino sin usar la palabra técnica.</span></div>
    </div>
    <div class="acciones-form">
      <button class="btn btn-p" id="pr-crear" ${D.proveedores.length ? "" : "disabled"}>Añadir protocolo</button>
    </div>
  </div>`;
}

function bloqueInmuebles(inmuebles) {
  const lista = inmuebles.length
    ? `<div class="lista">${inmuebles.map((i) => `
        <div class="fila plano">
          <div>
            <p class="fila-tit">${esc(i.puerta)} · ${esc(i.propietario_nombre)}</p>
            <p class="fila-sub">${esc(i.propietario_tel || "sin teléfono")}${i.propietario_email ? " · " + esc(i.propietario_email) : ""}</p>
          </div>
          <div class="fila-acc"><button class="btn-mini no" data-borra-inm="${esc(i.id)}">Borrar</button></div>
        </div>`).join("")}</div>`
    : `<div class="vacio">
         <strong>Aún no hay propietarios dados de alta</strong>
         <p>No es obligatorio: el agente puede abrir el expediente sin inmueble.
         Pero con ellos, identifica la vivienda y el propietario al vuelo.</p>
       </div>`;

  return `<div class="caja">
    <h3>Propietarios e inmuebles</h3>
    <p class="sub">Viviendas de la finca y a quién pertenecen.</p>
    ${lista}
    <div class="rejilla" style="margin-top:16px">
      <div class="campo"><label for="in-puerta">Puerta</label>
        <input id="in-puerta" type="text" maxlength="20" placeholder="3C"></div>
      <div class="campo"><label for="in-nombre">Propietario</label>
        <input id="in-nombre" type="text" maxlength="120"></div>
      <div class="campo"><label for="in-tel">Teléfono</label>
        <input id="in-tel" type="text" maxlength="40"></div>
      <div class="campo"><label for="in-email">Email</label>
        <input id="in-email" type="email" maxlength="160"></div>
    </div>
    <div class="acciones-form"><button class="btn btn-p" id="in-crear">Añadir inmueble</button></div>
  </div>`;
}

function bloqueDocumentos(documentos) {
  const lista = documentos.length
    ? `<div class="lista">${documentos.map((d) => `
        <div class="fila plano">
          <div>
            <p class="fila-tit">${esc(d.titulo)}</p>
            <p class="fila-sub">
              ${esc(humaniza(d.tipo))} · ${esc(fecha(d.created_at))} ·
              ${d.texto ? `${d.texto.length.toLocaleString("es-ES")} caracteres indexados` : "sin texto indexado"}
            </p>
          </div>
          <div class="fila-acc">
            ${d.archivo_path ? `<button class="btn-mini" data-adjunto="${esc(d.archivo_path)}">Ver PDF</button>` : ""}
            <button class="btn-mini no" data-borra-doc="${esc(d.id)}">Borrar</button>
          </div>
        </div>`).join("")}</div>`
    : `<div class="vacio">
         <strong>Aún no hay documentos</strong>
         <p>Sube los estatutos, el reglamento o las actas en PDF. El texto se
         extrae en tu navegador y se indexa para que el agente pueda citarlos
         cuando un vecino pregunte por la normativa de <em>esta</em> finca.</p>
       </div>`;

  return `<div class="caja">
    <h3>Documentos y normativa</h3>
    <p class="sub">Se indexan por texto (español) y sólo se consultan para esta comunidad.</p>
    ${lista}
    <div class="rejilla" style="margin-top:16px">
      <div class="campo"><label for="doc-tit">Título</label>
        <input id="doc-tit" type="text" maxlength="160" placeholder="Estatutos de la comunidad"></div>
      <div class="campo"><label for="doc-tipo">Tipo</label>
        <select id="doc-tipo">
          <option value="normativa">Normativa</option><option value="acta">Acta</option>
          <option value="contrato">Contrato</option><option value="seguro">Seguro</option>
          <option value="otro">Otro</option>
        </select></div>
      <div class="campo ancho"><label for="doc-file">Archivo PDF</label>
        <input id="doc-file" type="file" accept="application/pdf">
        <span class="ayuda" id="doc-estado">El texto se extrae aquí, en tu navegador. El PDF se guarda en un bucket privado.</span></div>
    </div>
    <div class="acciones-form"><button class="btn btn-p" id="doc-subir">Subir documento</button></div>
  </div>`;
}

function enganchaFichaComunidad(id) {
  $("pr-crear")?.addEventListener("click", async () => {
    const prov = D.proveedores.find((p) => p.id === $("pr-prov").value);
    if (!prov) return alert("Elige un proveedor.");
    const cat = $("pr-cat").value.trim().toLowerCase();
    const sub = $("pr-sub").value.trim().toLowerCase();
    if (!cat || !sub) return alert("Categoría y subtipo son obligatorios.");
    const pasos = $("pr-pasos").value.split("\n").map((s) => s.trim()).filter(Boolean);

    const { error } = await sb.from("fincas_protocolos").insert({
      comunidad_id: id, categoria: cat, subtipo: sub,
      proveedor_nombre: prov.nombre, proveedor_tel: prov.tel ?? "",
      urgencia_default: $("pr-urg").value,
      pasos, cita_fuente: $("pr-cita").value.trim() || `Protocolo interno · ${humaniza(cat)}`,
      palabras_clave: $("pr-claves").value.trim(),
    });
    if (error) return alert("No se ha podido crear: " + error.message);
    pintaDetalleComunidad(id);
  });

  $("in-crear")?.addEventListener("click", async () => {
    const puerta = $("in-puerta").value.trim();
    const nombre = $("in-nombre").value.trim();
    if (!puerta || !nombre) return alert("Puerta y propietario son obligatorios.");
    const { error } = await sb.from("fincas_inmuebles").insert({
      comunidad_id: id, puerta, propietario_nombre: nombre,
      propietario_tel: $("in-tel").value.trim(),
      propietario_email: $("in-email").value.trim(),
    });
    if (error) return alert("No se ha podido crear: " + error.message);
    pintaDetalleComunidad(id);
  });

  $("doc-subir")?.addEventListener("click", () => subeDocumento(id));
  // Los borrados de esta ficha los recoge el manejador global de clics: si se
  // engancharan aquí habría que acordarse de soltarlos en cada repintado.
}

/**
 * Sube el PDF y extrae su texto EN EL NAVEGADOR con pdf.js. Se hace aquí y
 * no en el servidor por una razón práctica: no hace falta un parser de PDF
 * en Deno ni un servicio externo, y el administrador ve al momento cuánto
 * texto se ha podido leer. Si el PDF es un escaneo sin capa de texto, se
 * dice — no se guarda un documento que luego no encontraría nadie.
 */
async function subeDocumento(comunidadId) {
  const input = $("doc-file");
  const estado = $("doc-estado");
  const titulo = $("doc-tit").value.trim();
  const file = input.files?.[0];

  if (!titulo) return alert("Pon un título.");
  if (!file) return alert("Elige un PDF.");

  estado.textContent = "Extrayendo el texto…";
  let texto = "";
  try {
    const pdfjs = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs";
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const partes = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const c = await p.getTextContent();
      partes.push(c.items.map((it) => it.str).join(" "));
    }
    texto = partes.join("\n").replace(/\s+/g, " ").trim();
  } catch (e) {
    console.warn("[crm] pdf.js:", e);
    estado.textContent = "No se ha podido leer el texto del PDF. Se guardará el archivo sin indexar.";
  }

  estado.textContent = "Subiendo el archivo…";
  const ruta = `normativa/${comunidadId}/${Date.now()}-${file.name.replace(/[^\w.\-]+/g, "_")}`;
  const { error: errUp } = await sb.storage.from("fincas-docs").upload(ruta, file, {
    contentType: "application/pdf", upsert: true,
  });
  if (errUp) {
    estado.textContent = "Error al subir: " + errUp.message;
    return;
  }

  const { error } = await sb.from("fincas_documentos").insert({
    comunidad_id: comunidadId, tipo: $("doc-tipo").value, titulo,
    archivo_path: ruta, archivo_nombre: file.name, texto,
    indexable: texto.length > 0,
  });
  if (error) {
    estado.textContent = "Error al guardar: " + error.message;
    return;
  }
  pintaDetalleComunidad(comunidadId);
}

/* ====================================================================== */
/* SECCIÓN · PROVEEDORES                                                  */
/* ====================================================================== */

function pintaProveedores() {
  const cab = cabecera("Proveedores",
    "A quién se avisa. El email es lo que hace que la petición de presupuesto salga de verdad.");

  const alta = `<div class="caja">
    <h3>Alta de proveedor</h3>
    <p class="sub">Sin email no se le puede pedir presupuesto: el agente avisará de que falta.</p>
    <div class="rejilla">
      <div class="campo"><label for="pv-nombre">Nombre</label>
        <input id="pv-nombre" type="text" maxlength="140" placeholder="Ascensores OTIS — contrato Serrano"></div>
      <div class="campo"><label for="pv-esp">Especialidad</label>
        <input id="pv-esp" type="text" maxlength="60" placeholder="ascensores"></div>
      <div class="campo"><label for="pv-contacto">Persona de contacto</label>
        <input id="pv-contacto" type="text" maxlength="120" placeholder="Marta Ruiz, jefa de servicio">
        <span class="ayuda">Con quién se habla en esa empresa. Opcional.</span></div>
      <div class="campo"><label for="pv-email">Email</label>
        <input id="pv-email" type="email" maxlength="160" placeholder="avisos@proveedor.es"></div>
      <div class="campo"><label for="pv-tel">Teléfono</label>
        <input id="pv-tel" type="text" maxlength="40"></div>
      <div class="campo"><label for="pv-zona">Zona</label>
        <input id="pv-zona" type="text" maxlength="80" placeholder="Madrid centro"></div>
      <div class="campo"><label for="pv-comunidad">Comunidad de alta</label>
        <select id="pv-comunidad">${opcionesComunidad()}</select></div>
    </div>
    <div class="acciones-form">
      <button class="btn btn-p" id="pv-crear" ${D.comunidades.length ? "" : "disabled"}>Dar de alta</button>
    </div>
    ${D.comunidades.length ? "" : '<p style="margin-top:10px;color:var(--muted);font-size:12px">Da de alta una comunidad primero.</p>'}
  </div>`;

  const lista = D.proveedores.length
    ? `<div class="lista">${D.proveedores.map((p) => `
        <div class="fila plano">
          <div>
            <p class="fila-tit">${esc(p.nombre)}</p>
            <p class="fila-sub">
              ${esc(p.especialidad || "sin especialidad")} ·
              ${p.email ? esc(p.email) : "⚠ sin email"} ·
              ${esc(nombreComunidad(p.comunidad_id))}
            </p>
            ${p.contacto_nombre || p.tel || p.zona ? `<p class="fila-sub">
              ${[p.contacto_nombre ? "Contacto: " + esc(p.contacto_nombre) : "",
                 p.tel ? esc(p.tel) : "",
                 p.zona ? esc(p.zona) : ""].filter(Boolean).join(" · ")}
            </p>` : ""}
          </div>
          <div class="fila-acc">
            ${p.email ? '<span class="chip ok">correo listo</span>' : '<span class="chip aviso">falta email</span>'}
            <button class="btn-mini no" data-borra-prov="${esc(p.id)}">Borrar</button>
          </div>
        </div>`).join("")}</div>`
    : `<div class="vacio">
         <strong>Aún no hay proveedores</strong>
         <p>Da de alta el mantenedor de ascensores, el fontanero y el
         electricista de cada finca. Son los que recibirán la petición de
         presupuesto por correo.</p>
       </div>`;

  panel.innerHTML = cab + alta + lista;
  const b = $("pv-crear");
  if (b) b.onclick = creaProveedor;
}

async function creaProveedor() {
  const nombre = $("pv-nombre").value.trim();
  if (!nombre) return alert("El nombre es obligatorio.");
  const { error } = await sb.from("fincas_proveedores").insert({
    comunidad_id: $("pv-comunidad").value,
    nombre,
    especialidad: $("pv-esp").value.trim(),
    contacto_nombre: $("pv-contacto").value.trim(),
    email: $("pv-email").value.trim(),
    tel: $("pv-tel").value.trim(),
    zona: $("pv-zona").value.trim(),
  });
  if (error) return alert("No se ha podido crear: " + error.message);
  await cargaTodo();
  render();
}

/* ====================================================================== */
/* SECCIÓN · AUDITORÍA                                                    */
/* ====================================================================== */

async function pintaAuditoria() {
  panel.innerHTML = cabecera("Auditoría", "Quién hizo qué. Append-only: no se puede editar ni borrar.") +
    '<p class="cargando">Cargando…</p>';

  const { data } = await sb.from("fincas_auditoria")
    .select("*").order("created_at", { ascending: false }).limit(200);

  const filas = (data ?? []).map((a) => `
    <div class="fila plano">
      <div>
        <p class="fila-tit">${esc(a.accion)} · ${esc(a.entidad)}</p>
        <p class="fila-sub">${esc(a.actor)} · ${esc(fecha(a.created_at))}
          ${a.detalle?.ref ? " · " + esc(a.detalle.ref) : ""}
          ${a.detalle?.estado_despues ? ` · ${esc(a.detalle.estado_antes)} → ${esc(a.detalle.estado_despues)}` : ""}
        </p>
      </div>
      <div class="fila-acc">
        <span class="chip ${a.actor === "agente-ia" ? "neutro" : "ok"}">${a.actor === "agente-ia" ? "IA" : "persona"}</span>
      </div>
    </div>`).join("");

  panel.innerHTML = cabecera("Auditoría", "Quién hizo qué. Append-only: no se puede editar ni borrar.") +
    `<div class="aviso-linea verde">
       <span aria-hidden="true">🔒</span>
       <p><b>Este registro no se puede modificar.</b> UPDATE, DELETE y TRUNCATE están
       bloqueados por la base de datos, no por la aplicación.</p>
     </div>` +
    (filas
      ? `<div class="lista">${filas}</div>`
      : `<div class="vacio"><strong>Aún no hay movimientos</strong>
           <p>Cada alta, cambio de estado o decisión aparecerá aquí sola.</p></div>`);
}

/* ====================================================================== */
/* RENDER Y EVENTOS                                                       */
/* ====================================================================== */

function cabecera(titulo, sub) {
  return `<div class="panel-cab"><div><h2>${esc(titulo)}</h2><p>${esc(sub)}</p></div></div>`;
}

function render() {
  if (seccion === "expedientes") return pintaExpedientes();
  if (seccion === "presupuestos") return pintaPresupuestos();
  if (seccion === "facturacion") return pintaFacturacion();
  if (seccion === "contable") return pintaContable();
  if (seccion === "correos") return pintaCorreos();
  if (seccion === "plantillas") return pintaPlantillas();
  if (seccion === "autonomia") return pintaAutonomia();
  if (seccion === "comunidades") return pintaComunidades();
  if (seccion === "proveedores") return pintaProveedores();
  if (seccion === "auditoria") return pintaAuditoria();
}

document.addEventListener("click", async (ev) => {
  const nav = ev.target.closest(".nav-btn");
  if (nav) {
    seccion = nav.dataset.seccion;
    comunidadAbierta = null;
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("activo", b === nav));
    return render();
  }

  const exp = ev.target.closest("[data-exp]");
  if (exp) return abreFichaExpediente(exp.dataset.exp);

  const comu = ev.target.closest("[data-comunidad]");
  if (comu) { comunidadAbierta = comu.dataset.comunidad; return render(); }

  const presu = ev.target.closest("[data-presu]");
  if (presu) return decidePresupuesto(presu.dataset.presu, presu.dataset.dec);

  const fac = ev.target.closest("[data-fac]");
  if (fac) return decideFactura(fac.dataset.fac, fac.dataset.dec);

  const adj = ev.target.closest("[data-adjunto]");
  if (adj) return abreAdjunto(adj.dataset.adjunto);

  const bprov = ev.target.closest("[data-borra-prov]");
  if (bprov && confirm("¿Borrar este proveedor?")) {
    await sb.from("fincas_proveedores").delete().eq("id", bprov.dataset.borraProv);
    await cargaTodo();
    return render();
  }

  /* Borrados dentro de la ficha de comunidad. Van aquí y no en la ficha para
     que sigan funcionando después de cada repintado. */
  const bp = ev.target.closest("[data-borra-prot]");
  if (bp && confirm("¿Borrar este protocolo?")) {
    await sb.from("fincas_protocolos").delete().eq("id", bp.dataset.borraProt);
    return pintaDetalleComunidad(comunidadAbierta);
  }
  const bi = ev.target.closest("[data-borra-inm]");
  if (bi && confirm("¿Borrar este inmueble?")) {
    await sb.from("fincas_inmuebles").delete().eq("id", bi.dataset.borraInm);
    return pintaDetalleComunidad(comunidadAbierta);
  }
  const bd = ev.target.closest("[data-borra-doc]");
  if (bd && confirm("¿Borrar este documento?")) {
    await sb.from("fincas_documentos").delete().eq("id", bd.dataset.borraDoc);
    return pintaDetalleComunidad(comunidadAbierta);
  }

  /* Correos en borrador y plantillas. */
  const env = ev.target.closest("[data-enviar]");
  if (env) return enviaBorrador(env.dataset.enviar);

  const desc = ev.target.closest("[data-descartar]");
  if (desc) return descartaBorrador(desc.dataset.descartar);

  const gp = ev.target.closest("[data-guardar-plantilla]");
  if (gp) return guardaPlantilla(gp.dataset.guardarPlantilla);

  const ap = ev.target.closest("[data-activar-plantilla]");
  if (ap) return alternaPlantilla(ap.dataset.activarPlantilla);
});

$("cerrar-modal").onclick = cierraModal;
velo.addEventListener("click", (ev) => { if (ev.target === velo) cierraModal(); });
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !velo.hidden) cierraModal(); });
$("salir").onclick = salir;
$("form-clave").addEventListener("submit", entrarConClave);
$("form-login").addEventListener("submit", entrar);
$("ver-email").addEventListener("click", (ev) => {
  ev.preventDefault();
  const f = $("form-login");
  f.hidden = !f.hidden;
});


/* ====================================================================== */
/* SECCIÓN · CONTABLE IA                                                  */
/* ====================================================================== */

/**
 * Las discrepancias son lo primero que tiene que ver quien abre esto. No
 * son un detalle de la fila: son el motivo por el que la fila está ahí.
 */
function pintaDiscrepancias(f) {
  const ds = Array.isArray(f.discrepancias) ? f.discrepancias : [];
  if (!ds.length) return "";
  return `<div class="discrepancias">
    ${ds.map((d) => `<p class="discrepancia">
        <span class="chip aviso">${esc(ETIQUETA_DISCREPANCIA[d.codigo] ?? d.codigo)}</span>
        ${esc(d.detalle)}
      </p>`).join("")}
  </div>`;
}

function filaFacturaContable(f) {
  const decidido = f.estado === "aprobada" || f.estado === "rechazada";
  const pago = f.pago_propuesto && f.pago_propuesto.fecha_propuesta;
  return `<article class="factura-card ${f.estado === "revisar" ? "revisar" : ""}">
    <div class="factura-info">
      <p class="fila-tit">
        ${esc(f.numero || "sin número")} · ${esc(f.proveedor_nombre || "sin proveedor")}
        <span class="chip ${f.estado === "revisar" ? "aviso" : f.estado === "aprobada" ? "ok" : "neutro"}">${esc(f.estado)}</span>
      </p>
      <p class="fila-sub">
        ${esc(nombreComunidad(f.comunidad_id))}
        ${f.fecha_factura ? " · " + esc(fecha(f.fecha_factura, false)) : ""}
        ${f.origen === "contable-ia" ? " · leída por el Contable IA" : ""}
        ${pago ? " · pago propuesto para el " + esc(fecha(f.pago_propuesto.fecha_propuesta, false)) : ""}
      </p>
      <p class="factura-cifras">
        <span>Base <b>${esc(EUR.format(Number(f.base) || 0))}</b></span>
        <span>IVA ${f.iva_porcentaje != null ? esc(f.iva_porcentaje) + "%" : ""}
          <b>${esc(EUR.format(Number(f.iva_importe) || 0))}</b></span>
        <span class="total">Total <b>${esc(EUR.format(Number(f.total ?? f.importe) || 0))}</b></span>
      </p>
      ${pintaDiscrepancias(f)}
    </div>
    <div class="fila-acc">
      ${decidido
        ? `<span class="chip ${f.estado === "aprobada" ? "ok" : "aviso"}">${esc(f.estado)}${f.decidido_por ? " · " + esc(f.decidido_por) : ""}</span>`
        : `<button class="btn-mini ok" data-fac="${esc(f.id)}" data-dec="aprobada">Aprobar</button>
           <button class="btn-mini no" data-fac="${esc(f.id)}" data-dec="rechazada">Rechazar</button>`}
    </div>
  </article>`;
}

/** Resumen por comunidad: lo que se le enseña al presidente en una junta. */
function resumenPorComunidad() {
  const porC = new Map();
  for (const f of D.facturas) {
    const k = f.comunidad_id;
    if (!porC.has(k)) porC.set(k, { revisar: 0, borrador: 0, aprobada: 0, total: 0 });
    const r = porC.get(k);
    if (r[f.estado] !== undefined) r[f.estado]++;
    if (f.estado === "aprobada") r.total += Number(f.total ?? f.importe) || 0;
  }
  if (!porC.size) return "";
  return `<div class="caja">
    <h3>Resumen por comunidad</h3>
    <p class="sub">Facturas aprobadas y lo que queda pendiente de mirar.</p>
    <div class="lista">
      ${[...porC.entries()].map(([id, r]) => `
        <div class="fila plano">
          <div>
            <p class="fila-tit">${esc(nombreComunidad(id))}</p>
            <p class="fila-sub">
              ${r.revisar} para revisar · ${r.borrador} en borrador · ${r.aprobada} aprobadas
            </p>
          </div>
          <div class="fila-acc"><b>${esc(EUR.format(r.total))}</b></div>
        </div>`).join("")}
    </div>
  </div>`;
}

/**
 * Avisos de vencimiento. Dos cosas distintas y ambas importan: un pago
 * propuesto cuya fecha ya pasó, y una factura que lleva demasiado tiempo
 * esperando a que alguien la mire.
 */
function avisosVencimiento() {
  const hoy = new Date().toISOString().slice(0, 10);
  const limite = new Date(Date.now() - 15 * 864e5).toISOString();

  const vencidas = D.facturas.filter((f) =>
    f.estado !== "rechazada" && f.estado !== "aprobada" &&
    f.pago_propuesto?.fecha_propuesta && f.pago_propuesto.fecha_propuesta < hoy);
  const estancadas = D.facturas.filter((f) =>
    (f.estado === "revisar" || f.estado === "borrador") && f.created_at < limite);

  if (!vencidas.length && !estancadas.length) return "";
  const linea = (f, aviso) => `<p class="discrepancia">
      <span class="chip aviso">${esc(aviso)}</span>
      ${esc(f.numero || "sin número")} · ${esc(f.proveedor_nombre)} ·
      ${esc(EUR.format(Number(f.total ?? f.importe) || 0))} · ${esc(nombreComunidad(f.comunidad_id))}
    </p>`;
  return `<div class="aviso-linea ambar" style="display:block">
    <p style="font-weight:600;margin-bottom:8px">Vencimientos y facturas paradas</p>
    ${vencidas.map((f) => linea(f, "Pago propuesto vencido")).join("")}
    ${estancadas.map((f) => linea(f, "Lleva más de 15 días sin decidir")).join("")}
  </div>`;
}

function pintaContable() {
  const facturas = D.facturas.filter((f) => f.tipo === "factura");
  const paraRevisar = facturas.filter((f) => f.estado === "revisar");
  const resto = facturas.filter((f) => f.estado !== "revisar");

  const asistente = `<div class="caja">
    <h3>Asistente contable</h3>
    <p class="sub">
      Pega el texto de una factura y la lee, la cuadra y la coteja con el presupuesto.
      No aprueba, no paga y no ve datos bancarios.
    </p>
    <div class="campo">
      <label for="ct-texto">Texto de la factura</label>
      <textarea id="ct-texto" style="min-height:120px"
        placeholder="Factura A-2026-118, fecha 12/03/2026, Ascensores Delta, base imponible 700,00 €, IVA 21% 147,00 €, total 847,00 €. Expediente EXP-2026-0001."></textarea>
    </div>
    <div class="acciones-form">
      <button class="btn btn-p" id="ct-enviar">Analizar</button>
    </div>
    <div id="ct-respuesta"></div>
  </div>`;

  panel.innerHTML =
    cabecera("Contable IA", "Facturas de proveedores: leídas, cuadradas y cotejadas.") +
    `<div class="aviso-linea verde">
       <span aria-hidden="true">🧮</span>
       <p><b>La aritmética la hace el código, no el modelo.</b> El Contable IA lee la
       factura, pero base + IVA = total lo comprueba TypeScript. Si no cuadra, la
       factura queda en <em>revisar</em> y salta el aviso.</p>
     </div>` +
    avisosVencimiento() +
    asistente +
    (paraRevisar.length
      ? `<h3 style="font-size:15px;font-weight:600;margin:24px 0 10px">
           Para revisar <span class="chip aviso">${paraRevisar.length}</span></h3>
         <div class="lista">${paraRevisar.map(filaFacturaContable).join("")}</div>`
      : "") +
    (resto.length
      ? `<h3 style="font-size:15px;font-weight:600;margin:24px 0 10px">Resto de facturas</h3>
         <div class="lista">${resto.map(filaFacturaContable).join("")}</div>`
      : "") +
    (facturas.length ? "" : `
      <div class="vacio">
        <strong>Aún no hay facturas</strong>
        <p>Pega arriba el texto de una factura de proveedor y el Contable IA la
        dará de alta. Si algo no cuadra con el presupuesto aprobado del
        expediente, la dejará marcada para revisar en vez de darla por buena.</p>
      </div>`) +
    resumenPorComunidad();

  $("ct-enviar").onclick = hablaConContable;
}

async function hablaConContable() {
  const salida = $("ct-respuesta");
  const texto = $("ct-texto").value.trim();
  if (!texto) return alert("Pega el texto de la factura.");

  const btn = $("ct-enviar");
  btn.disabled = true;
  btn.textContent = "Analizando…";
  salida.innerHTML = '<p class="cargando">El Contable IA está leyendo la factura…</p>';

  /* Se le da el catálogo de comunidades y expedientes abiertos para que
     pueda resolver referencias sin adivinar. */
  const contexto = [
    "Comunidades dadas de alta (usa el id exacto):",
    ...D.comunidades.map((c) => `- ${c.nombre} (${c.direccion}) -> comunidad_id ${c.id}`),
    "",
    "Expedientes abiertos:",
    ...D.expedientes.filter((e) => e.estado !== "cerrado")
      .map((e) => `- ${e.ref} · ${nombreComunidad(e.comunidad_id)} · proveedor ${e.proveedor_nombre || "—"} -> expediente_id ${e.id}`),
  ].join("\n");

  let html = "";
  try {
    const r = await fetch(FN("fincas-contable"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await jwt()}` },
      body: JSON.stringify({ mensaje: `${contexto}\n\nFACTURA A PROCESAR:\n${texto}` }),
    }).then((x) => x.json());

    html = r?.reply
      ? `<div class="ficha-desc" style="margin-top:14px">${esc(r.reply)}</div>`
      : `<p class="tl-err">${esc(r?.error ?? "No se ha podido analizar.")}</p>`;
  } catch (e) {
    console.warn("[crm] contable:", e);
    html = '<p class="tl-err">No se ha podido conectar con el Contable IA.</p>';
  }

  await cargaTodo();
  if (seccion === "contable") {
    pintaContable();
    $("ct-respuesta").innerHTML = html;
  }
}

/* ====================================================================== */
/* SECCIÓN · CORREOS EN BORRADOR                                          */
/* ====================================================================== */

function pintaCorreos() {
  const cab = cabecera("Correos",
    "Los que el agente ha dejado preparados porque no podía mandarlos solo.");

  const aviso = `<div class="aviso-linea verde">
    <span aria-hidden="true">✉</span>
    <p><b>Un correo llega aquí por tres motivos:</b> el trámite implica dinero o es
    legal, falta algún dato por rellenar, o no hay destinatario. El motivo concreto
    va escrito en cada uno.</p>
  </div>`;

  if (!D.borradores.length) {
    panel.innerHTML = cab + aviso + `
      <div class="vacio">
        <strong>No hay correos esperando</strong>
        <p>Cuando el agente prepare un correo que no puede mandar solo, aparecerá
        aquí con su motivo, listo para revisar y enviar.</p>
      </div>`;
    return;
  }

  panel.innerHTML = cab + aviso + `<div class="lista">${D.borradores.map((c) => {
    const d = c.decision ?? {};
    return `<article class="factura-card">
      <div class="factura-info">
        <p class="fila-tit">${esc(c.asunto)}</p>
        <p class="fila-sub">
          ${esc(c.fincas_expedientes?.ref ?? "sin expediente")} ·
          ${esc(humaniza(c.tramite))} · para ${esc(c.para_email || "sin destinatario")} ·
          ${esc(fecha(c.created_at))}
        </p>
        <p class="discrepancia" style="margin-top:8px">
          <span class="chip aviso">${esc(d.categoria ?? "revisión")}</span>${esc(c.error)}
        </p>
        <details style="margin-top:10px">
          <summary style="cursor:pointer;font-size:12.5px;color:var(--muted)">Ver el correo</summary>
          <div class="tl-txt" style="max-height:none">${esc(c.cuerpo)}</div>
        </details>
      </div>
      <div class="fila-acc">
        <button class="btn-mini ok" data-enviar="${esc(c.id)}"
          ${c.para_email ? "" : "disabled"}>Aprobar y enviar</button>
        <button class="btn-mini no" data-descartar="${esc(c.id)}">Descartar</button>
      </div>
    </article>`;
  }).join("")}</div>`;
}

async function enviaBorrador(id) {
  if (!confirm("¿Aprobar y enviar este correo?")) return;
  const r = await fetch(FN("fincas-enviar-email"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await jwt()}` },
    body: JSON.stringify({ accion: "enviar_borrador", comunicacion_id: id }),
  }).then((x) => x.json()).catch(() => null);

  if (!r?.ok) alert("No se ha podido enviar: " + (r?.error ?? "error desconocido"));
  await cargaTodo();
  render();
}

async function descartaBorrador(id) {
  if (!confirm("¿Descartar este borrador? Queda registrado como fallido, no se borra.")) return;
  const { error } = await sb.from("fincas_comunicaciones")
    .update({ estado: "fallido", error: "Descartado por el equipo.", aprobado_por: D.perfil?.email ?? "" })
    .eq("id", id).eq("estado", "borrador");
  if (error) return alert("No se ha podido descartar: " + error.message);
  await cargaTodo();
  render();
}

/* ====================================================================== */
/* SECCIÓN · PLANTILLAS DE CORREO                                         */
/* ====================================================================== */

function pintaPlantillas() {
  const cab = cabecera("Plantillas de correo",
    "Lo que el agente manda de verdad. El texto lo escribes tú; él sólo elige cuál toca.");

  const aviso = `<div class="aviso-linea verde">
    <span aria-hidden="true">📝</span>
    <p><b>Las {{variables}} las rellena el código</b>, no el modelo, con datos del
    expediente. Si alguna se queda vacía el correo no sale solo: pasa a borrador.
    Disponibles: ref, comunidad, direccion, puerta, propietario, tipo, subtipo,
    urgencia, descripcion, proveedor, solicitante, solicitante_tel, importe,
    numero_factura, fecha, administracion.</p>
  </div>`;

  if (!D.plantillas.length) {
    panel.innerHTML = cab + aviso +
      '<div class="vacio"><strong>No hay plantillas</strong><p>Algo ha ido mal en la carga: la biblioteca base debería traer ocho.</p></div>';
    return;
  }

  panel.innerHTML = cab + aviso + D.plantillas.map((p) => `
    <div class="caja" data-plantilla="${esc(p.id)}">
      <h3>${esc(humaniza(p.tipo_tramite))}
        <span class="chip ${p.categoria === "operativo" ? "ok" : "aviso"}">${esc(p.categoria)}</span>
        ${p.activa ? "" : '<span class="chip neutro">desactivada</span>'}
      </h3>
      <p class="sub">
        ${p.categoria === "operativo"
          ? "Puede salir solo si no lleva importe."
          : "Siempre pasa por revisión, salvo que se marque de confianza y quede bajo el umbral."}
      </p>
      <div class="rejilla">
        <div class="campo ancho">
          <label>Asunto</label>
          <input type="text" class="pl-asunto" value="${esc(p.asunto)}" maxlength="200">
        </div>
        <div class="campo ancho">
          <label>Cuerpo</label>
          <textarea class="pl-cuerpo" style="min-height:190px">${esc(p.cuerpo)}</textarea>
        </div>
        <div class="campo">
          <label>Categoría</label>
          <select class="pl-categoria">
            ${["operativo", "dinero", "legal"].map((c) =>
              `<option value="${c}"${c === p.categoria ? " selected" : ""}>${c}</option>`).join("")}
          </select>
        </div>
        <div class="campo">
          <label>Tono</label>
          <input type="text" class="pl-tono" value="${esc(p.tono)}" maxlength="40">
        </div>
      </div>
      <div class="acciones-form">
        <button class="btn-mini ok" data-guardar-plantilla="${esc(p.id)}">Guardar</button>
        <button class="btn-mini" data-activar-plantilla="${esc(p.id)}">
          ${p.activa ? "Desactivar" : "Activar"}
        </button>
      </div>
    </div>`).join("");
}

async function guardaPlantilla(id) {
  const caja = panel.querySelector(`[data-plantilla="${CSS.escape(id)}"]`);
  if (!caja) return;
  const { error } = await sb.from("fincas_plantillas_email").update({
    asunto: caja.querySelector(".pl-asunto").value.trim(),
    cuerpo: caja.querySelector(".pl-cuerpo").value,
    categoria: caja.querySelector(".pl-categoria").value,
    tono: caja.querySelector(".pl-tono").value.trim(),
    updated_at: new Date().toISOString(),
  }).eq("id", id);
  if (error) return alert("No se ha podido guardar: " + error.message);
  await cargaTodo();
  render();
}

async function alternaPlantilla(id) {
  const p = D.plantillas.find((x) => x.id === id);
  if (!p) return;
  const { error } = await sb.from("fincas_plantillas_email")
    .update({ activa: !p.activa }).eq("id", id);
  if (error) return alert("No se ha podido cambiar: " + error.message);
  await cargaTodo();
  render();
}

/* ====================================================================== */
/* SECCIÓN · AUTONOMÍA                                                    */
/* ====================================================================== */

function pintaAutonomia() {
  const cfg = D.autonomia ?? { umbral_auto_eur: 0, tramites_confianza: [], notas: "" };
  const confianza = Array.isArray(cfg.tramites_confianza) ? cfg.tramites_confianza : [];

  panel.innerHTML =
    cabecera("Autonomía", "Hasta dónde puede llegar el agente solo. Todo lo demás pasa por una persona.") + `
    <div class="aviso-linea verde" style="display:block">
      <p style="font-weight:600;margin-bottom:8px">La regla, tal cual está en el código</p>
      <ol style="margin:0;padding-left:20px;font-size:12.5px;line-height:1.8">
        <li>Trámite <b>operativo</b> y sin importe → <b>va solo</b>.</li>
        <li>Trámite de <b>dinero</b> o <b>legal</b> → <b>lo aprueba una persona</b>.</li>
        <li>…salvo que esté marcado <b>de confianza</b> Y el importe quede <b>por debajo</b>
            del umbral → entonces va solo.</li>
        <li>Cualquier otro caso —trámite desconocido, importe que falta— →
            <b>lo aprueba una persona</b>. Falla cerrada a propósito.</li>
      </ol>
      <p style="margin-top:10px;font-size:12.5px">
        Esto lo decide fincas_decidir_autonomia(), una función SQL. No está en el
        prompt del agente: se le consulta y se le obedece.
      </p>
    </div>

    <div class="caja">
      <h3>Configuración global</h3>
      <p class="sub">Vale para todas las comunidades mientras no haya un ajuste propio.</p>
      <div class="rejilla">
        <div class="campo">
          <label for="au-umbral">Umbral automático (€)</label>
          <input id="au-umbral" type="number" min="0" step="10" value="${esc(cfg.umbral_auto_eur ?? 0)}">
          <span class="ayuda">Por debajo de esta cifra, y sólo para trámites de confianza, el agente puede actuar solo. Con 0 no se automatiza nada que lleve dinero.</span>
        </div>
        <div class="campo">
          <label for="au-notas">Notas</label>
          <input id="au-notas" type="text" maxlength="200" value="${esc(cfg.notas ?? "")}">
        </div>
        <div class="campo ancho">
          <label>Trámites de confianza</label>
          <div class="tramites">
            ${TRAMITES.map((t) => {
              const p = D.plantillas.find((x) => x.tipo_tramite === t && !x.comunidad_id);
              const cat = p?.categoria ?? "operativo";
              return `<label class="tramite">
                <input type="checkbox" class="au-tramite" value="${esc(t)}"
                  ${confianza.includes(t) ? "checked" : ""}>
                <span>${esc(humaniza(t))}</span>
                <span class="chip ${cat === "operativo" ? "ok" : "aviso"}">${esc(cat)}</span>
              </label>`;
            }).join("")}
          </div>
          <span class="ayuda">Marcar uno operativo no cambia nada: ya va solo si no lleva importe. Sirve para los de dinero o legales.</span>
        </div>
      </div>
      <div class="acciones-form">
        <button class="btn btn-p" id="au-guardar">Guardar configuración</button>
      </div>
    </div>`;

  $("au-guardar").onclick = guardaAutonomia;
}

async function guardaAutonomia() {
  const tramites = [...panel.querySelectorAll(".au-tramite:checked")].map((i) => i.value);
  const patch = {
    umbral_auto_eur: Number($("au-umbral").value) || 0,
    tramites_confianza: tramites,
    notas: $("au-notas").value.trim(),
    actualizado_at: new Date().toISOString(),
    actualizado_por: D.perfil?.email ?? "administrador",
  };

  const { error } = D.autonomia
    ? await sb.from("fincas_config_autonomia").update(patch).eq("id", D.autonomia.id)
    : await sb.from("fincas_config_autonomia").insert({ ...patch, comunidad_id: null });

  if (error) return alert("No se ha podido guardar: " + error.message);
  await cargaTodo();
  render();
}

/* ====================================================================== */
/* ARRANQUE                                                               */
/* ====================================================================== */

async function arranca() {
  const { data } = await sb.auth.getSession();
  if (!data?.session) { $("login").hidden = false; $("shell").hidden = true; return; }

  const perfil = await perfilActivo();
  if (!perfil) {
    $("login").hidden = false;
    $("shell").hidden = true;
    const err = $("login-error");
    err.textContent = "Ese acceso existe pero no tiene perfil activo en el panel. Habla con la administración.";
    err.hidden = false;
    await sb.auth.signOut();
    return;
  }

  D.perfil = perfil;
  $("quien").textContent = `${perfil.nombre || perfil.email} · ${perfil.rol}`;
  $("login").hidden = true;
  $("shell").hidden = false;

  await cargaTodo();
  render();
}

arranca();
