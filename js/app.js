// Bootstrap de la página: pantalla de login, nav lateral, y montaje de la
// página seleccionada. Cada página vive en js/pages/*.js y expone
// { render(container) }.
const PAGINAS = {
  "🏠 Resumen": { modulo: () => PaginaResumen, disponible: true },
  "📊 Análisis": { modulo: () => PaginaAnalisis, disponible: true },
  "📋 Presupuesto": { modulo: () => PaginaPresupuesto, disponible: true },
  "🏦 Deudas": { modulo: () => PaginaDeudas, disponible: true },
  "📈 Inversiones": { modulo: () => PaginaInversiones, disponible: true },
  "🏢 Estados Financieros": { modulo: () => PaginaEstadosFinancieros, disponible: true },
  "💰 Ingresos": { modulo: () => PaginaIngresos, disponible: true },
  "💳 Egresos": { modulo: () => PaginaEgresos, disponible: true },
  "🧾 Facturación Electrónica": { modulo: () => PaginaFacturacion, disponible: true },
  "📑 Declaraciones de Renta": { modulo: () => PaginaDeclaraciones, disponible: true },
};

function construirNav() {
  const nav = document.getElementById("nav-paginas");
  nav.innerHTML = "";
  Object.entries(PAGINAS).forEach(([nombre, info]) => {
    const btn = document.createElement("button");
    btn.textContent = nombre + (info.disponible ? "" : " (próximamente)");
    btn.className = "nav-btn";
    btn.disabled = !info.disponible;
    btn.addEventListener("click", () => seleccionarPagina(nombre));
    nav.appendChild(btn);
  });
}

function seleccionarPagina(nombre) {
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("activo", b.textContent.startsWith(nombre)));
  const info = PAGINAS[nombre];
  const contenedor = document.getElementById("contenido");
  if (!info || !info.disponible) {
    contenedor.innerHTML = `<p>Esta sección todavía no está portada a la versión web.</p>`;
    return;
  }
  info.modulo().render(contenedor);
}

function mostrarApp() {
  document.getElementById("pantalla-login").style.display = "none";
  document.getElementById("app").style.display = "flex";
  construirNav();
  seleccionarPagina("🏠 Resumen");
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-login").addEventListener("click", () => Auth.signIn());
  document.getElementById("btn-logout").addEventListener("click", () => {
    Auth.signOut();
    document.getElementById("app").style.display = "none";
    document.getElementById("pantalla-login").style.display = "flex";
  });
  Auth.init(mostrarApp);
});
