/* =========================================================================
   config.js — configuración y utilidades comunes
   =========================================================================
   La clave anon es pública por diseño, pero desde el MVP ya NO abre nada:
   la RLS es estricta y anon no tiene ninguna policy sobre las tablas
   fincas_*. Sirve para dos cosas: identificar el proyecto ante la API y
   permitir el login del administrador. Todo lo que se lee del CRM se lee
   con el JWT de ese administrador.
   ========================================================================= */

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/+esm";

export const SUPABASE_URL = "https://mlaqtniujnvfxcvcourm.supabase.co";
export const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYXF0bml1am52ZnhjdmNvdXJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MzUyMzIsImV4cCI6MjA5MzQxMTIzMn0." +
  "Neh7VUS8ADsxf0DPab0JoJyGXOAXnLIaXzXbKzj2BGs";

export const FN = (nombre) => `${SUPABASE_URL}/functions/v1/${nombre}`;

/** Cliente con sesión persistente: el admin no quiere volver a entrar al
    recargar. En la landing no se usa la sesión para nada. */
export const sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/* ------------------------------------------------------------ utilidades */

export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** El modelo se escapa a veces a las negritas de markdown; aquí se hablan
    frases, no se pintan formatos. */
export function limpiaTexto(t) {
  return String(t ?? "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*/g, "").trim();
}

export const EUR = new Intl.NumberFormat("es-ES", {
  style: "currency", currency: "EUR", maximumFractionDigits: 2,
});

export const ETIQUETA_URGENCIA = {
  critica: "Crítica", alta: "Alta", media: "Media", baja: "Baja",
};
export const ETIQUETA_ESTADO = {
  nuevo: "Nuevo", asignado: "Asignado", en_curso: "En curso", cerrado: "Cerrado",
};

/* Las categorías y subtipos se guardan como slugs ASCII para que el modelo
   los escriba sin fallar y para que el tsvector no dependa de tildes. Al
   pintarlos hay que devolverles el castellano. */
const ETIQUETA_SLUG = {
  ascensores: "Ascensores",
  fontaneria: "Fontanería",
  electricidad: "Electricidad",
  limpieza: "Limpieza",
  cerrajeria: "Cerrajería",
  jardineria: "Jardinería",
  consulta: "Consulta",
  parado: "Parado",
  atrapamiento: "Atrapamiento",
  sin_protocolo: "Sin protocolo",
  fuga_zonas_comunes: "Fuga en zonas comunes",
  apagon_zonas_comunes: "Apagón en zonas comunes",
};

export function humaniza(s) {
  const clave = String(s ?? "").trim();
  if (ETIQUETA_SLUG[clave]) return ETIQUETA_SLUG[clave];
  const t = clave.replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

export function fecha(iso, conHora = true) {
  if (!iso) return "";
  const opts = conHora
    ? { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { day: "2-digit", month: "2-digit", year: "numeric" };
  return new Date(iso).toLocaleString("es-ES", opts);
}
