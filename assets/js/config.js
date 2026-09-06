/* =========================================================================
   config.js — configuración y utilidades comunes de la demo
   =========================================================================
   La clave anon es pública por diseño: con RLS activo sólo puede hacer
   SELECT sobre las tablas fincas_*, que contienen datos ficticios de
   demostración. NINGUNA escritura pasa por aquí: los expedientes los crea
   fincas-chat y las decisiones sobre presupuestos las escribe
   fincas-presupuesto, ambas con service role en el servidor.
   ========================================================================= */

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/+esm";

export const SUPABASE_URL = "https://mlaqtniujnvfxcvcourm.supabase.co";
export const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYXF0bml1am52ZnhjdmNvdXJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MzUyMzIsImV4cCI6MjA5MzQxMTIzMn0." +
  "Neh7VUS8ADsxf0DPab0JoJyGXOAXnLIaXzXbKzj2BGs";

export const FN = (nombre) => `${SUPABASE_URL}/functions/v1/${nombre}`;

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: false },
});

/* ------------------------------------------------------------ utilidades */

/** Escapa antes de meter cualquier dato en innerHTML. */
export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** El modelo se escapa a veces a las negritas de markdown; aquí se hablan
    frases, no se pintan formatos, así que se quitan. */
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

/** "fuga_zonas_comunes" → "Fuga zonas comunes" */
export function humaniza(s) {
  const t = String(s ?? "").replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

export function fecha(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-ES", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
