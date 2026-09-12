// Puerto (parcial, solo lectura) de render_analisis() (app_presupuesto.py):
// por ahora solo las sub-secciones Categorías y Movimientos.
//
// TODAVÍA NO portado: Esenciales/No Esenciales, Evolución, Año vs. Año y
// Balance Mensual (esta última además necesita escritura — mueve un
// selector de mes en la hoja 'Balance Mensual' del Sheet).

const PaginaAnalisis = (() => {
  const EGRESO_COLS = [
    "PeriodoExtracto", "FechaCompra", "Comercio", "Moneda", "Cuotas", "ValorTotal",
    "ValorCargado", "SaldoPendiente", "Categoria", "Reembolsable", "Notas",
  ];
  let chartCategorias = null;
  let chartTopCategorias = null;

  function render(container) {
    container.innerHTML = `
      <h1>📊 Análisis</h1>
      <p class="caption">Cómo va tu gasto visto desde distintos ángulos.</p>
      <div class="tabs" id="tabs-analisis">
        <button class="tab-btn activo" data-tab="categorias">Categorías</button>
        <button class="tab-btn" data-tab="movimientos">Movimientos</button>
      </div>
      <div id="panel-analisis">Cargando datos del Sheet…</div>
      <div class="aviso">⚠️ Todavía no portadas: Esenciales/No Esenciales, Evolución, Año vs. Año y Balance
      Mensual — usá <a href="https://presupuesto-app-jmr.streamlit.app" target="_blank" rel="noopener">la
      versión de Streamlit</a> para eso mientras tanto.</div>
    `;
    const tabsDiv = container.querySelector("#tabs-analisis");
    const panel = container.querySelector("#panel-analisis");
    let activo = "categorias";

    tabsDiv.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        activo = btn.dataset.tab;
        tabsDiv.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("activo", b === btn));
        renderTab();
      });
    });

    async function renderTab() {
      panel.innerHTML = "Cargando datos del Sheet…";
      try {
        if (activo === "categorias") await renderCategorias(panel);
        else await renderMovimientos(panel);
      } catch (err) {
        panel.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
        console.error(err);
      }
    }

    renderTab();
  }

  // ---------------------------------------------------------------------
  async function renderCategorias(panel) {
    const raw = await SheetsApi.batchGet(["resumen_categorias"]);
    const filas = (raw.resumen_categorias || [])
      .filter((r) => r && r[0])
      .map((r) => ({ categoria: r[0], gasto: toNumber(r.length >= 4 ? r[3] : r[r.length - 1]) }))
      .filter((f) => f.gasto > 0)
      .sort((a, b) => b.gasto - a.gasto);

    if (!filas.length) {
      panel.innerHTML = "<p>Todavía no hay gastos cargados para graficar por categoría.</p>";
      return;
    }
    panel.innerHTML = `
      <h4>Gasto real por categoría</h4>
      <p class="caption">Vista devengado: total histórico por categoría, cada compra contada en su propia
      fecha.</p>
      <canvas id="chart_categorias" height="${Math.max(320, 24 * filas.length)}"></canvas>
      <div class="tabla-scroll">
        <table class="tabla">
          <thead><tr><th>Categoría</th><th>Gasto Real</th></tr></thead>
          <tbody>${filas.map((f) => `<tr><td>${f.categoria}</td><td>${fmtMoneda(f.gasto)}</td></tr>`).join("")}</tbody>
        </table>
      </div>
    `;
    if (chartCategorias) chartCategorias.destroy();
    chartCategorias = new Chart(panel.querySelector("#chart_categorias").getContext("2d"), {
      type: "bar",
      data: { labels: filas.map((f) => f.categoria), datasets: [{ label: "Gasto Real", data: filas.map((f) => f.gasto), backgroundColor: "#4573d6" }] },
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } },
        scales: { x: { ticks: { callback: (v) => fmtMoneda(v) } } } },
    });
  }

  // ---------------------------------------------------------------------
  async function cargarMovimientos() {
    const raw = await SheetsApi.batchGet([
      "colillas_devengos", "colillas_descuentos", "visa_detalle", "mc_detalle", "mc_detalle_usd",
      "efectivo_detalle", "otros_ingresos",
    ]);
    const movs = [];

    for (const f of filasAObjetos(raw.colillas_devengos, ["Periodo", "Concepto", "Categoria", "Valor"])) {
      movs.push({ Fuente: "Colilla (devengo)", Periodo: f.Periodo, Concepto: f.Concepto, Categoria: f.Categoria, Moneda: "COP", Valor: toNumber(f.Valor) });
    }
    for (const f of filasAObjetos(raw.colillas_descuentos, ["Periodo", "Concepto", "Categoria", "Valor"])) {
      movs.push({ Fuente: "Colilla (descuento)", Periodo: f.Periodo, Concepto: f.Concepto, Categoria: f.Categoria, Moneda: "COP", Valor: -toNumber(f.Valor) });
    }
    for (const f of filasAObjetos(raw.visa_detalle, EGRESO_COLS, ["FechaCompra"])) {
      movs.push({ Fuente: "Visa ****7497", Periodo: f.FechaCompra, Concepto: f.Comercio, Categoria: f.Categoria, Moneda: "COP", Valor: -toNumber(f.ValorCargado) });
    }
    for (const f of filasAObjetos(raw.mc_detalle, EGRESO_COLS, ["FechaCompra"])) {
      movs.push({ Fuente: "Mastercard ****5922", Periodo: f.FechaCompra, Concepto: f.Comercio, Categoria: f.Categoria, Moneda: "COP", Valor: -toNumber(f.ValorCargado) });
    }
    for (const f of filasAObjetos(raw.mc_detalle_usd, EGRESO_COLS, ["FechaCompra"])) {
      movs.push({ Fuente: "Mastercard ****5922 (USD)", Periodo: f.FechaCompra, Concepto: f.Comercio, Categoria: f.Categoria, Moneda: "USD", Valor: -toNumber(f.ValorCargado) });
    }
    for (const f of filasAObjetos(raw.efectivo_detalle, EGRESO_COLS, ["FechaCompra"])) {
      movs.push({ Fuente: "Cuenta de ahorros", Periodo: f.FechaCompra, Concepto: f.Comercio, Categoria: f.Categoria, Moneda: "COP", Valor: -toNumber(f.ValorCargado) });
    }
    for (const f of filasAObjetos(raw.otros_ingresos, ["Fecha", "Concepto", "Categoria", "Valor", "Notas"], ["Fecha"])) {
      movs.push({ Fuente: "Otros ingresos", Periodo: f.Fecha, Concepto: f.Concepto, Categoria: f.Categoria, Moneda: "COP", Valor: toNumber(f.Valor) });
    }

    for (const m of movs) m._presupuestar = !esNoPresupuestar(m.Categoria);
    movs.sort((a, b) => periodoSortValue(b.Periodo) - periodoSortValue(a.Periodo));
    return movs.slice(0, 5000);
  }

  async function renderMovimientos(panel) {
    const movs = await cargarMovimientos();
    if (!movs.length) {
      panel.innerHTML = "<p>Todavía no hay movimientos cargados.</p>";
      return;
    }
    const movsConPeriodo = movs.map((m) => {
      const [anio, mes] = extraerAnioMes(m.Periodo);
      return { ...m, _anio: anio, _mes: mes };
    });

    panel.innerHTML = `
      <h4>Movimientos</h4>
      <p class="caption">Vista devengado: cada movimiento en su propia fecha (fecha de compra en tarjetas, no
      fecha de pago).</p>
      <label class="checkbox-row"><input type="checkbox" id="mv_ocultar" checked>
        Ocultar movimientos de conciliación (no presupuestar)</label>
      <input type="text" id="mv_busqueda" placeholder="🔍 Buscar en concepto" class="input-texto" />
      <div class="row">
        <select id="mv_fuente"></select>
        <select id="mv_cat"></select>
        <select id="mv_anio"></select>
        <select id="mv_mes"></select>
      </div>
      <p class="caption" id="mv_resumen"></p>
      <div class="tabla-scroll"><table class="tabla" id="mv_tabla"></table></div>
      <h5>Top categorías de gasto (según el filtro de arriba)</h5>
      <canvas id="chart_top_cat" height="140"></canvas>
    `;

    const fuenteSel = panel.querySelector("#mv_fuente");
    const catSel = panel.querySelector("#mv_cat");
    const anioSel = panel.querySelector("#mv_anio");
    const mesSel = panel.querySelector("#mv_mes");
    const ocultarChk = panel.querySelector("#mv_ocultar");
    const busquedaInput = panel.querySelector("#mv_busqueda");

    fuenteSel.add(new Option("(todas)", "(todas)"));
    [...new Set(movsConPeriodo.map((m) => m.Fuente))].sort().forEach((f) => fuenteSel.add(new Option(f, f)));
    catSel.add(new Option("(todas)", "(todas)"));
    [...new Set(movsConPeriodo.map((m) => m.Categoria).filter(Boolean))].sort().forEach((c) => catSel.add(new Option(c, c)));
    anioSel.add(new Option("(todos)", "(todos)"));
    [...new Set(movsConPeriodo.map((m) => m._anio).filter(Boolean))].sort((a, b) => b - a).forEach((a) => anioSel.add(new Option(a, a)));
    mesSel.add(new Option("(todos)", "(todos)"));
    for (let m = 1; m <= 12; m++) mesSel.add(new Option(`${String(m).padStart(2, "0")} - ${MESES_NOMBRE[m]}`, m));

    function actualizar() {
      let f = movsConPeriodo;
      if (ocultarChk.checked) f = f.filter((x) => x._presupuestar);
      const busqueda = busquedaInput.value.trim().toLowerCase();
      if (busqueda) f = f.filter((x) => String(x.Concepto || "").toLowerCase().includes(busqueda));
      if (fuenteSel.value !== "(todas)") f = f.filter((x) => x.Fuente === fuenteSel.value);
      if (catSel.value !== "(todas)") f = f.filter((x) => x.Categoria === catSel.value);
      if (anioSel.value !== "(todos)") f = f.filter((x) => x._anio === Number(anioSel.value));
      if (mesSel.value !== "(todos)") f = f.filter((x) => x._mes === Number(mesSel.value));

      const totalesPorMoneda = {};
      for (const x of f) totalesPorMoneda[x.Moneda] = (totalesPorMoneda[x.Moneda] || 0) + x.Valor;
      const resumenTotales = Object.entries(totalesPorMoneda)
        .map(([mon, val]) => mon === "USD" ? `US$ ${val.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : fmtMoneda(val))
        .join(" · ");
      panel.querySelector("#mv_resumen").textContent =
        `${f.length.toLocaleString("en-US")} de ${movs.length.toLocaleString("en-US")} movimientos — suma: ${resumenTotales}`;

      panel.querySelector("#mv_tabla").innerHTML = `
        <thead><tr><th>Fuente</th><th>Periodo</th><th>Concepto</th><th>Categoría</th><th>Moneda</th><th>Valor</th><th>Presupuestar</th></tr></thead>
        <tbody>${f.slice(0, 1000).map((x) => `<tr><td>${x.Fuente}</td><td>${x.Periodo ?? ""}</td>
          <td>${x.Concepto ?? ""}</td><td>${x.Categoria ?? ""}</td><td>${x.Moneda}</td>
          <td>${x.Moneda === "USD" ? "US$ " + x.Valor.toLocaleString("en-US", { minimumFractionDigits: 2 }) : fmtMoneda(x.Valor)}</td>
          <td>${x._presupuestar ? "Sí" : "No"}</td></tr>`).join("")}</tbody>
      `;

      const gastoCop = f.filter((x) => x.Moneda === "COP" && x.Valor < 0);
      const porCat = {};
      for (const x of gastoCop) porCat[x.Categoria] = (porCat[x.Categoria] || 0) + Math.abs(x.Valor);
      const topCat = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 12);

      if (chartTopCategorias) chartTopCategorias.destroy();
      const canvas = panel.querySelector("#chart_top_cat");
      if (topCat.length) {
        chartTopCategorias = new Chart(canvas.getContext("2d"), {
          type: "bar",
          data: { labels: topCat.map((c) => c[0]), datasets: [{ label: "Valor", data: topCat.map((c) => c[1]), backgroundColor: "#d64545" }] },
          options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } },
            scales: { x: { ticks: { callback: (v) => fmtMoneda(v) } } } },
        });
      }
    }

    [fuenteSel, catSel, anioSel, mesSel, ocultarChk].forEach((el) => el.addEventListener("change", actualizar));
    busquedaInput.addEventListener("input", actualizar);
    actualizar();
  }

  return { render };
})();
