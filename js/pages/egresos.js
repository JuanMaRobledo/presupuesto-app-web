// Puerto de _render_egreso_tab() (app_presupuesto.py) para las 3 hojas de
// egresos (Efectivo, Visa, Mastercard) — tabla con búsqueda/filtros +
// tendencia por período + gasto por categoría y mes.
//
// TODAVÍA NO portado: gestionar extractos (agregar/eliminar resumen o
// compra puntual — son operaciones de escritura, fuera de alcance de esta
// primera versión de solo lectura), "ver un extracto puntual" (cupo/saldo/
// pago de un corte), y el detalle de compras en USD de Mastercard.

const PaginaEgresos = (() => {
  const EGRESO_COLS = [
    "PeriodoExtracto", "FechaCompra", "Comercio", "Moneda", "Cuotas", "ValorTotal",
    "ValorCargado", "SaldoPendiente", "Categoria", "Reembolsable", "Notas",
  ];
  const BLOQUES = [
    { key: "efectivo_detalle", titulo: "Egresos - Efectivo", esTarjeta: false },
    { key: "visa_detalle", titulo: "Egresos - Tarjeta Visa 7497", esTarjeta: true },
    { key: "mc_detalle", titulo: "Egresos - Mastercard 5922", esTarjeta: true },
  ];
  const charts = {}; // bloqueKey -> {periodo: Chart, categoria: Chart} — para destruir antes de re-renderizar

  let datosCache = null;

  async function cargarDatos() {
    if (datosCache) return datosCache;
    const raw = await SheetsApi.batchGet(["efectivo_detalle", "visa_detalle", "mc_detalle"]);
    datosCache = {
      efectivo_detalle: filasAObjetos(raw.efectivo_detalle, EGRESO_COLS),
      visa_detalle: filasAObjetos(raw.visa_detalle, EGRESO_COLS),
      mc_detalle: filasAObjetos(raw.mc_detalle, EGRESO_COLS),
    };
    return datosCache;
  }

  function render(container) {
    container.innerHTML = `
      <h1>💳 Egresos</h1>
      <p class="caption">Movimientos de Efectivo, Visa y Mastercard tal como están en el Sheet, con
      búsqueda y filtros — solo lectura por ahora.</p>
      <div class="tabs" id="tabs-egresos"></div>
      <div id="panel-egresos">Cargando datos del Sheet…</div>
    `;

    const tabsDiv = container.querySelector("#tabs-egresos");
    const panel = container.querySelector("#panel-egresos");
    let activo = BLOQUES[0].key;

    BLOQUES.forEach((b) => {
      const btn = document.createElement("button");
      btn.textContent = b.titulo;
      btn.className = "tab-btn";
      btn.addEventListener("click", () => {
        activo = b.key;
        [...tabsDiv.children].forEach((c) => c.classList.toggle("activo", c === btn));
        renderBloque();
      });
      tabsDiv.appendChild(btn);
    });
    tabsDiv.children[0].classList.add("activo");

    async function renderBloque() {
      const bloqueInfo = BLOQUES.find((b) => b.key === activo);
      panel.innerHTML = "Cargando datos del Sheet…";
      try {
        const datos = await cargarDatos();
        renderTabla(panel, bloqueInfo, datos[activo]);
      } catch (err) {
        panel.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
        console.error(err);
      }
    }

    renderBloque();
  }

  function renderTabla(panel, bloqueInfo, filasOriginal) {
    const { key: blockKey, titulo, esTarjeta } = bloqueInfo;
    if (!filasOriginal.length) {
      panel.innerHTML = `<p>Todavía no hay movimientos cargados en ${titulo}.</p>`;
      return;
    }

    const filas = filasOriginal.map((f) => {
      const [anio, mes] = extraerAnioMes(f.FechaCompra);
      const out = { ...f, _anio: anio, _mes: mes, _presupuestar: !esNoPresupuestar(f.Categoria) };
      if (esTarjeta) {
        const [anioExt, mesExt] = extraerAnioMes(f.PeriodoExtracto);
        out._anioExtracto = anioExt;
        out._mesExtracto = mesExt;
      }
      return out;
    });

    const idp = `eg_${blockKey}`;
    panel.innerHTML = `
      <h4>${titulo}</h4>
      ${esTarjeta ? `<p class="caption">El filtro de Año/Mes de abajo es por la fecha real de la compra
        ('Fecha Compra'), no por 'Periodo Extracto' del corte.</p>` : ""}
      <label class="checkbox-row"><input type="checkbox" id="${idp}_ocultar" checked>
        Ocultar movimientos de conciliación (no presupuestar)</label>
      ${esTarjeta ? `
        <div class="radio-row">
          <label><input type="radio" name="${idp}_vista" value="consumo" checked> 🛍️ Consumo (mes en que se compra)</label>
          <label><input type="radio" name="${idp}_vista" value="efectivo"> 💳 Efectivo real (mes en que se paga)</label>
        </div>` : ""}
      <input type="text" id="${idp}_busqueda" placeholder="🔍 Buscar en comercio / concepto" class="input-texto" />
      <div class="row">
        <select id="${idp}_cat"></select>
        <select id="${idp}_anio"></select>
        <select id="${idp}_mes"></select>
      </div>
      <p class="caption" id="${idp}_resumen"></p>
      <div class="tabla-scroll"><table class="tabla" id="${idp}_tabla"></table></div>
      <div id="${idp}_graficos"></div>
    `;

    const catSel = panel.querySelector(`#${idp}_cat`);
    const anioSel = panel.querySelector(`#${idp}_anio`);
    const mesSel = panel.querySelector(`#${idp}_mes`);
    const ocultarChk = panel.querySelector(`#${idp}_ocultar`);
    const busquedaInput = panel.querySelector(`#${idp}_busqueda`);

    const categorias = [...new Set(filas.map((f) => f.Categoria).filter(Boolean))].sort();
    catSel.add(new Option("(todas)", "(todas)"));
    categorias.forEach((c) => catSel.add(new Option(c, c)));
    const anios = [...new Set(filas.map((f) => f._anio).filter(Boolean))].sort((a, b) => b - a);
    anioSel.add(new Option("(todos)", "(todos)"));
    anios.forEach((a) => anioSel.add(new Option(a, a)));
    mesSel.add(new Option("(todos)", "(todos)"));
    for (let m = 1; m <= 12; m++) mesSel.add(new Option(`${String(m).padStart(2, "0")} - ${MESES_NOMBRE[m]}`, m));

    function actualizar() {
      const ocultar = ocultarChk.checked;
      const busqueda = busquedaInput.value.trim().toLowerCase();
      const catFiltro = catSel.value;
      const anioFiltro = anioSel.value;
      const mesFiltro = mesSel.value;
      const vistaEl = esTarjeta ? panel.querySelector(`input[name="${idp}_vista"]:checked`) : null;
      const efectivoMode = !!vistaEl && vistaEl.value === "efectivo";

      let filtradas = filas;
      if (ocultar) filtradas = filtradas.filter((f) => f._presupuestar);
      if (busqueda) filtradas = filtradas.filter((f) => String(f.Comercio || "").toLowerCase().includes(busqueda));
      if (catFiltro !== "(todas)") filtradas = filtradas.filter((f) => f.Categoria === catFiltro);

      let caption = "";
      if (efectivoMode && anioFiltro !== "(todos)" && mesFiltro !== "(todos)") {
        const corte = shiftMes(`${anioFiltro}-${String(mesFiltro).padStart(2, "0")}`, -1);
        const [anioCorte, mesCorte] = corte.split("-").map(Number);
        filtradas = filtradas.filter((f) => f._anioExtracto === anioCorte && f._mesExtracto === mesCorte);
        caption = `Mostrando el corte de <strong>${MESES_NOMBRE[mesCorte]} ${anioCorte}</strong> — es el que
          se paga en ${MESES_NOMBRE[mesFiltro]} ${anioFiltro}.`;
      } else {
        if (anioFiltro !== "(todos)") filtradas = filtradas.filter((f) => f._anio === Number(anioFiltro));
        if (mesFiltro !== "(todos)") filtradas = filtradas.filter((f) => f._mes === Number(mesFiltro));
      }

      const totalF = filtradas.reduce((s, f) => s + toNumber(f.ValorCargado), 0);
      panel.querySelector(`#${idp}_resumen`).innerHTML =
        `${filtradas.length.toLocaleString("en-US")} de ${filas.length.toLocaleString("en-US")}
         movimientos — suma cargada este período: ${fmtMoneda(totalF)}. ${caption}`;

      renderFilaTabla(panel.querySelector(`#${idp}_tabla`), filtradas);
      renderGraficos(panel.querySelector(`#${idp}_graficos`), blockKey, filtradas, efectivoMode);
    }

    [catSel, anioSel, mesSel, ocultarChk].forEach((el) => el.addEventListener("change", actualizar));
    busquedaInput.addEventListener("input", actualizar);
    if (esTarjeta) {
      panel.querySelectorAll(`input[name="${idp}_vista"]`).forEach((r) => r.addEventListener("change", actualizar));
    }

    actualizar();
  }

  function renderFilaTabla(tablaEl, filas) {
    const cols = ["PeriodoExtracto", "FechaCompra", "Comercio", "Moneda", "Cuotas", "ValorTotal",
      "ValorCargado", "SaldoPendiente", "Categoria", "Reembolsable", "Notas"];
    const labels = ["Periodo Extracto", "Fecha Compra", "Comercio / Concepto", "Moneda", "Cuotas",
      "Valor Total", "Valor Cargado", "Saldo Pendiente", "Categoría", "Reembolsable", "Notas"];
    const filasLimitadas = filas.slice(0, 1000);
    tablaEl.innerHTML = `
      <thead><tr>${labels.map((l) => `<th>${l}</th>`).join("")}</tr></thead>
      <tbody>${filasLimitadas.map((f) => `<tr>${cols.map((c) => {
        const v = f[c];
        const esValor = c === "ValorTotal" || c === "ValorCargado" || c === "SaldoPendiente";
        return `<td>${esValor ? fmtMoneda(toNumber(v)) : (v ?? "")}</td>`;
      }).join("")}</tr>`).join("")}</tbody>
    `;
    if (filas.length > filasLimitadas.length) {
      const nota = document.createElement("p");
      nota.className = "caption";
      nota.textContent = `Mostrando los primeros 1.000 de ${filas.length.toLocaleString("en-US")} movimientos — angostá el filtro para ver el resto.`;
      tablaEl.after(nota);
    }
  }

  const PALETA = ["#d64545", "#4573d6", "#45a06a", "#d69a45", "#8a56c9", "#45b8c9", "#c9457e", "#a3a3a3"];

  function renderGraficos(div, blockKey, filas, efectivoMode) {
    const cop = filas.filter((f) => f.Moneda === "COP");
    div.innerHTML = "";
    if (charts[blockKey]?.periodo) charts[blockKey].periodo.destroy();
    if (charts[blockKey]?.categoria) charts[blockKey].categoria.destroy();
    if (!cop.length) return;

    const etiquetaPeriodo = efectivoMode ? "mes de pago" : "mes de compra";
    const periodoDe = (f) => {
      if (efectivoMode) {
        const base = `${f._anioExtracto}-${String(f._mesExtracto).padStart(2, "0")}`;
        return shiftMes(base, 1);
      }
      return `${f._anio}-${String(f._mes).padStart(2, "0")}`;
    };

    const sumaPorPeriodo = {};
    const sumaPorPeriodoCat = {};
    const categoriasSet = new Set();
    for (const f of cop) {
      const p = periodoDe(f);
      const v = toNumber(f.ValorCargado);
      sumaPorPeriodo[p] = (sumaPorPeriodo[p] || 0) + v;
      const cat = f.Categoria || "(sin categoría)";
      categoriasSet.add(cat);
      sumaPorPeriodoCat[p] = sumaPorPeriodoCat[p] || {};
      sumaPorPeriodoCat[p][cat] = (sumaPorPeriodoCat[p][cat] || 0) + v;
    }
    const periodos = Object.keys(sumaPorPeriodo).sort();
    const categorias = [...categoriasSet].sort();

    div.innerHTML = `
      <h5>Tendencia por período (${etiquetaPeriodo})</h5>
      <canvas id="canvas_periodo_${blockKey}" height="90"></canvas>
      <h5>Gasto por categoría y por mes (${etiquetaPeriodo})</h5>
      <canvas id="canvas_categoria_${blockKey}" height="120"></canvas>
    `;

    const ctxP = div.querySelector(`#canvas_periodo_${blockKey}`).getContext("2d");
    const chartPeriodo = new Chart(ctxP, {
      type: "bar",
      data: { labels: periodos, datasets: [{ label: "Valor Cargado", data: periodos.map((p) => sumaPorPeriodo[p]), backgroundColor: "#d64545" }] },
      options: { responsive: true, plugins: { legend: { display: false } },
        scales: { y: { ticks: { callback: (v) => fmtMoneda(v) } } } },
    });

    const ctxC = div.querySelector(`#canvas_categoria_${blockKey}`).getContext("2d");
    const chartCategoria = new Chart(ctxC, {
      type: "bar",
      data: {
        labels: periodos,
        datasets: categorias.map((cat, i) => ({
          label: cat,
          data: periodos.map((p) => sumaPorPeriodoCat[p]?.[cat] || 0),
          backgroundColor: PALETA[i % PALETA.length],
        })),
      },
      options: {
        responsive: true,
        scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (v) => fmtMoneda(v) } } },
      },
    });

    charts[blockKey] = { periodo: chartPeriodo, categoria: chartCategoria };
  }

  return { render };
})();
