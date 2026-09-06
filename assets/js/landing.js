/* =========================================================================
   landing.js — sólo lo visual de la portada
   =========================================================================
   Tres cosas y ninguna imprescindible: la fachada del hero, el aparecer con
   stagger al hacer scroll y poco más. Si este fichero fallara, la página
   seguiría siendo legible y el chat seguiría funcionando: no se cuelga nada
   de aquí.
   ========================================================================= */

/* ------------------------------------------------------------- fachada */

/**
 * Dibuja la retícula de ventanas del hero. Se genera en JS y no a mano en
 * el HTML para que los retardos sean irregulares: si todas las ventanas
 * parpadearan a la vez se leería como una animación, y lo que queremos es
 * que parezca un edificio de noche.
 */
function pintaFachada() {
  const cont = document.getElementById("fachada");
  if (!cont) return;

  const total = 9 * 8;
  const frag = document.createDocumentFragment();

  for (let i = 0; i < total; i++) {
    const v = document.createElement("span");
    v.className = "ventana";
    // Poco más de un tercio encendidas: un edificio entero iluminado
    // no parece un edificio, parece un panel.
    if (Math.random() < 0.36) {
      v.classList.add("on");
      if (Math.random() < 0.22) v.classList.add("g");
      v.style.animationDelay = `${(Math.random() * 7).toFixed(2)}s`;
      v.style.animationDuration = `${(5 + Math.random() * 5).toFixed(2)}s`;
    }
    frag.appendChild(v);
  }
  cont.appendChild(frag);
}

/* -------------------------------------------------------- scroll reveal */

function revela() {
  const elementos = [...document.querySelectorAll(".rev")];
  if (!elementos.length) return;

  // Sin IntersectionObserver (o con animaciones reducidas) se muestra todo
  // de una vez: mejor sin animación que con contenido invisible.
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) {
    elementos.forEach((el) => el.classList.add("visible"));
    return;
  }

  const obs = new IntersectionObserver((entradas) => {
    // El stagger se calcula por tanda visible, no por índice global: así el
    // retardo no crece sin control a mitad de página.
    const visibles = entradas.filter((e) => e.isIntersecting);
    visibles.forEach((e, i) => {
      const el = e.target;
      el.style.transitionDelay = `${Math.min(i * 70, 350)}ms`;
      el.classList.add("visible");
      obs.unobserve(el);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });

  elementos.forEach((el) => obs.observe(el));
}

pintaFachada();
revela();
