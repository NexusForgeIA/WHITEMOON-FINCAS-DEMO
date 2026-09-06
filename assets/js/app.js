/* =========================================================================
   app.js — arranque y conmutador de vistas
   =========================================================================
   El panel se inicia sólo la primera vez que se abre su pestaña: así la
   demo carga rápido y el realtime no se conecta hasta que hace falta.
   ========================================================================= */

import { iniciaChat } from "./chat.js";
import { iniciaPanel } from "./panel.js";

const pestanas = [...document.querySelectorAll(".pestana")];
const vistas = {
  chat:  document.getElementById("vista-chat"),
  panel: document.getElementById("vista-panel"),
};

function muestra(nombre) {
  for (const b of pestanas) {
    const activa = b.dataset.vista === nombre;
    b.classList.toggle("activa", activa);
    b.setAttribute("aria-selected", String(activa));
  }
  for (const [clave, seccion] of Object.entries(vistas)) {
    const activa = clave === nombre;
    seccion.classList.toggle("activa", activa);
    seccion.hidden = !activa;
  }
  if (nombre === "panel") iniciaPanel();
}

for (const b of pestanas) {
  b.addEventListener("click", () => muestra(b.dataset.vista));
}

iniciaChat();
