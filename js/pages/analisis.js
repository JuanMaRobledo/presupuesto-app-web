// Puerto (solo lectura, salvo Balance Mensual) de render_analisis()
// (app_presupuesto.py): Categorías, Esenciales/No Esenciales, Evolución, Año
// vs. Año, Movimientos y Balance Mensual (esta última con escritura — mueve
// el selector de mes en la hoja 'Balance Mensual' del Sheet, mismo protocolo
// que Presupuesto). Evolución y Año vs. Año leen 'Resumen Mensual' -- puerto
// de read_resumen_mensual() (sheets_backend.py), confirmado el orden real de
// columnas contra el Sheet (ver RESUMEN_MENSUAL_COLS).

const PaginaAnalisis = (() => {
  const EGRESO_COLS = [
    "PeriodoExtracto", "FechaCompra", "Comercio", "Moneda", "Cuotas", "ValorTotal",
    "ValorCargado", "SaldoPendiente", "Categoria", "Reembolsable", "Notas",
  ];
  // Puerto del encabezado real de 'Resumen Mensual'!B5:G30 (fila 5).
  const RESUMEN_MENSUAL_COLS = [
    "Mes", "IngresosGanados", "GastosPersonales", "DeudasObligaciones", "AhorroInversiones", "DisponibleMes",
  ];
  const RESUMEN_MENSUAL_LABELS = {
    IngresosGanados: "Ingresos ganados", GastosPersonales: "Gastos personales",
    DeudasObligaciones: "Deudas y obligaciones", AhorroInversiones: "Ahorro e inversiones",
    DisponibleMes: "Disponible del mes",
  };
  // Puerto de CATEGORIAS_ESENCIALES/CATEGORIAS_NO_ESENCIALES/CATEGORIAS_NO_CONSUMO
  // y clasificar_esencial() (cuenta_formatos.py).
  const CATEGORIAS_ESENCIALES = new Set([
    "Mercado y Supermercado", "Salud", "Seguros", "Vivienda y Servicios", "Transporte",
    "Educación y Profesional", "Servicio doméstico", "Cuidado Personal", "Apoyo familiar",
  ]);
  const CATEGORIAS_NO_ESENCIALES = new Set([
    "Restaurantes y Domicilios", "Entretenimiento", "Viajes", "Tecnología y Suscripciones",
    "Mascotas", "Compras Online / Varios", "Otros",
  ]);
  const CATEGORIAS_NO_CONSUMO = new Set(["Inversiones", "Ahorro"]);
  function clasificarEsencial(categoria) {
    if (CATEGORIAS_ESENCIALES.has(categoria)) return "Esencial";
    if (CATEGORIAS_NO_ESENCIALES.has(categoria)) return "No esencial";
    if (CATEGORIAS_NO_CONSUMO.has(categoria)) return "No consumo (ahorro/inversión)";
    return "Sin clasificar";
  }

  let chartCategorias = null;
  let chartTopCategorias = null;
  let chartEsenciales = null;
  let chartEvolucion = null;
  let chartAnioVsAnio = null;
  let mesBalanceAplicado = null;

  function render(container) {
    container.innerHTML = `
      <h1>📊 Análisis</h1>
      <p class="caption">Cómo va tu gasto visto desde distintos ángulos.</p>
      <div class="tabs" id="tabs-analisis">
        <button class="tab-btn activo" data-tab="categorias">Categorías</button>
        <button class="tab-btn" data-tab="esenciales">Esenciales / No Esenciales</button>
        <button class="tab-btn" data-tab="evolucion">Evolución</button>
        <button class="tab-btn" data-tab="anio_vs_anio">Año vs. Año</button>
        <button class="tab-btn" data-tab="movimientos">Movimientos</button>
        <button class="tab-btn" data-tab="balance">Balance Mensual</button>
      </div>
      <div id="panel-analisis">Cargando datos del Sheet…</div>
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
        else if (activo === "esenciales") await renderEsenciales(panel);
        else if (activo === "evolucion") await renderEvolucion(panel);
        else if (activo === "anio_vs_anio") await renderAnioVsAnio(panel);
        else if (activo === "movimientos") await renderMovimientos(panel);
        else await renderBalanceMensual(panel);
      } catch (err) {
        panel.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
        console.error(err);
      }
    }

    renderTab();
  }

  // ---------------------------------------------------------------------
  async function cargarResumenMensual() {
    const raw = await SheetsApi.batchGet(["resumen_mensual"]);
    return filasAObjetos(raw.resumen_mensual, RESUMEN_MENSUAL_COLS);
  }

  // Puerto de render_evolucion() (app_presupuesto.py).
  async function renderEvolucion(panel) {
    const dfMes = await cargarResumenMensual();
    if (!dfMes.length) {
      panel.innerHTML = "<p>Todavía no hay suficientes meses cargados para la evolución mensual.</p>";
      return;
    }
    const anios = [...new Set(dfMes.map((f) => f.Mes.slice(0, 4)).filter((y) => /^\d{4}$/.test(y)))].sort((a, b) => b - a);
    panel.innerHTML = `
      <h4>Evolución mensual</h4>
      <p class="caption">Vista <strong>efectivo real</strong>: el gasto de tarjeta de cada mes es el que
      efectivamente se pagó ese mes (no el de las compras hechas ese mes) — Visa/Mastercard se cuentan un mes
      después de la fecha de corte, cuando se paga. Efectivo ya sale en su propio mes.</p>
      <select id="ev_anio"></select>
      <canvas id="ev_chart" height="200"></canvas>
      <details><summary>Ver tabla</summary>
        <div class="tabla-scroll"><table class="tabla" id="ev_tabla"></table></div>
      </details>
    `;
    const anioSel = panel.querySelector("#ev_anio");
    anioSel.add(new Option("(todos)", "(todos)"));
    anios.forEach((a) => anioSel.add(new Option(a, a)));

    const cols = RESUMEN_MENSUAL_COLS.slice(1);
    function actualizar() {
      const f = anioSel.value === "(todos)" ? dfMes : dfMes.filter((x) => x.Mes.startsWith(anioSel.value));
      if (chartEvolucion) chartEvolucion.destroy();
      chartEvolucion = new Chart(panel.querySelector("#ev_chart").getContext("2d"), {
        type: "line",
        data: {
          labels: f.map((x) => x.Mes),
          datasets: cols.map((c, i) => ({
            label: RESUMEN_MENSUAL_LABELS[c], data: f.map((x) => toNumber(x[c])),
            borderColor: PALETA[i % PALETA.length], backgroundColor: PALETA[i % PALETA.length],
            fill: false, tension: 0.1,
          })),
        },
        options: { responsive: true, scales: { x: { type: "category" }, y: { ticks: { callback: (v) => fmtMoneda(v) } } } },
      });
      panel.querySelector("#ev_tabla").innerHTML = `
        <thead><tr><th>Mes</th>${cols.map((c) => `<th>${RESUMEN_MENSUAL_LABELS[c]}</th>`).join("")}</tr></thead>
        <tbody>${f.map((x) => `<tr><td>${x.Mes}</td>${cols.map((c) => `<td>${fmtMoneda(toNumber(x[c]))}</td>`).join("")}</tr>`).join("")}</tbody>
      `;
    }
    anioSel.addEventListener("change", actualizar);
    actualizar();
  }

  // Puerto de render_anio_vs_anio() (app_presupuesto.py).
  async function renderAnioVsAnio(panel) {
    const dfMesTodo = await cargarResumenMensual();
    const hoyStr = new Date().toISOString().slice(0, 7);
    const dfMes = dfMesTodo.filter((f) => f.Mes <= hoyStr).map((f) => ({
      ...f, _anio: parseInt(f.Mes.slice(0, 4), 10), _mesNum: parseInt(f.Mes.slice(5, 7), 10),
    }));
    if (!dfMes.length) {
      panel.innerHTML = "<p>Todavía no hay suficientes meses cargados para comparar años.</p>";
      return;
    }
    const cols = RESUMEN_MENSUAL_COLS.slice(1);
    const aniosDisp = [...new Set(dfMes.map((f) => f._anio))].sort((a, b) => a - b);
    const aniosDefault = new Set(aniosDisp.length >= 2 ? aniosDisp.slice(-2) : aniosDisp);

    panel.innerHTML = `
      <h4>Año vs. Año</h4>
      <p class="caption">Vista <strong>efectivo real</strong> (igual que Evolución): compará el mismo mes entre
      distintos años para ver si vas mejor o peor que antes, no solo si vas mejor o peor que el mes pasado.</p>
      <select id="av_metrica"></select>
      <div id="av_anios">${aniosDisp.map((a) => `
        <label class="checkbox-row"><input type="checkbox" value="${a}" ${aniosDefault.has(a) ? "checked" : ""}> ${a}</label>
      `).join("")}</div>
      <div id="av_contenido"></div>
    `;
    const metricaSel = panel.querySelector("#av_metrica");
    cols.forEach((c) => metricaSel.add(new Option(RESUMEN_MENSUAL_LABELS[c], c)));
    const anioChecks = [...panel.querySelectorAll("#av_anios input")];

    function actualizar() {
      const contenido = panel.querySelector("#av_contenido");
      const metrica = metricaSel.value;
      const aniosSel = anioChecks.filter((c) => c.checked).map((c) => Number(c.value));
      if (!aniosSel.length) {
        contenido.innerHTML = "<p>Elegí al menos un año.</p>";
        if (chartAnioVsAnio) { chartAnioVsAnio.destroy(); chartAnioVsAnio = null; }
        return;
      }
      const f = dfMes.filter((x) => aniosSel.includes(x._anio));
      contenido.innerHTML = `<canvas id="av_chart" height="220"></canvas><div class="tabla-scroll"><table class="tabla" id="av_tabla"></table></div>
        <p class="caption">La variación compara cada año contra el anterior de esta misma tabla (no
        necesariamente el año calendario inmediatamente anterior, si no elegiste años consecutivos).</p>`;

      const aniosOrdenados = [...aniosSel].sort((a, b) => a - b);
      if (chartAnioVsAnio) chartAnioVsAnio.destroy();
      chartAnioVsAnio = new Chart(contenido.querySelector("#av_chart").getContext("2d"), {
        type: "bar",
        data: {
          labels: Object.values(MESES_NOMBRE),
          datasets: aniosOrdenados.map((a, i) => ({
            label: String(a),
            data: Object.keys(MESES_NOMBRE).map((m) => {
              const fila = f.find((x) => x._anio === a && x._mesNum === Number(m));
              return fila ? toNumber(fila[metrica]) : null;
            }),
            backgroundColor: PALETA[i % PALETA.length],
          })),
        },
        options: { responsive: true, plugins: { title: { display: true, text: RESUMEN_MENSUAL_LABELS[metrica] } },
          scales: { y: { ticks: { callback: (v) => fmtMoneda(v) } } } },
      });

      let anterior = null;
      const filasTot = aniosOrdenados.map((a) => {
        const total = f.filter((x) => x._anio === a).reduce((s, x) => s + toNumber(x[metrica]), 0);
        const variacion = anterior !== null ? `${((total - anterior) / Math.abs(anterior) * 100).toFixed(0)}%` : "-";
        anterior = total;
        return { anio: a, total, variacion };
      });
      contenido.querySelector("#av_tabla").innerHTML = `
        <thead><tr><th>Año</th><th>Total ${RESUMEN_MENSUAL_LABELS[metrica]}</th><th>Variación</th></tr></thead>
        <tbody>${filasTot.map((r) => `<tr><td>${r.anio}</td><td>${fmtMoneda(r.total)}</td><td>${r.variacion}</td></tr>`).join("")}</tbody>
      `;
    }
    metricaSel.addEventListener("change", actualizar);
    anioChecks.forEach((c) => c.addEventListener("change", actualizar));
    actualizar();
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
      <details class="panel-colapsable">
        <summary>Ver tabla de categorías</summary>
        <div class="panel-colapsable-body">
          <div class="tabla-scroll">
            <table class="tabla">
              <thead><tr><th>Categoría</th><th>Gasto Real</th></tr></thead>
              <tbody>${filas.map((f) => `<tr><td>${f.categoria}</td><td>${fmtMoneda(f.gasto)}</td></tr>`).join("")}</tbody>
            </table>
          </div>
        </div>
      </details>
    `;
    if (chartCategorias) chartCategorias.destroy();
    chartCategorias = new Chart(panel.querySelector("#chart_categorias").getContext("2d"), {
      type: "bar",
      data: { labels: filas.map((f) => f.categoria), datasets: [{ label: "Gasto Real", data: filas.map((f) => f.gasto), backgroundColor: "#1d4ed8" }] },
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
        .map(([mon, val]) => mon === "USD" ? fmtUsd(val) : fmtMoneda(val))
        .join(" · ");
      panel.querySelector("#mv_resumen").textContent =
        `${f.length.toLocaleString("en-US")} de ${movs.length.toLocaleString("en-US")} movimientos — suma: ${resumenTotales}`;

      panel.querySelector("#mv_tabla").innerHTML = `
        <thead><tr><th>Fuente</th><th>Periodo</th><th>Concepto</th><th>Categoría</th><th>Moneda</th><th>Valor</th><th>Presupuestar</th></tr></thead>
        <tbody>${f.slice(0, 1000).map((x) => `<tr><td>${x.Fuente}</td><td>${x.Periodo ?? ""}</td>
          <td>${x.Concepto ?? ""}</td><td>${x.Categoria ?? ""}</td><td>${x.Moneda}</td>
          <td>${x.Moneda === "USD" ? fmtUsd(x.Valor) : fmtMoneda(x.Valor)}</td>
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
          data: { labels: topCat.map((c) => c[0]), datasets: [{ label: "Valor", data: topCat.map((c) => c[1]), backgroundColor: "#dc2626" }] },
          options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } },
            scales: { x: { ticks: { callback: (v) => fmtMoneda(v) } } } },
        });
      }
    }

    [fuenteSel, catSel, anioSel, mesSel, ocultarChk].forEach((el) => el.addEventListener("change", actualizar));
    busquedaInput.addEventListener("input", actualizar);
    actualizar();
  }

  // ---------------------------------------------------------------------
  // Esenciales / No Esenciales
  // ---------------------------------------------------------------------
  async function cargarClasificacionEsencial() {
    const raw = await SheetsApi.batchGet(["clasificacion_esencial"]);
    const map = {};
    for (const r of raw.clasificacion_esencial || []) {
      if (r && r[0] && r[1]) map[r[0]] = r[1];
    }
    return map;
  }

  async function renderEsenciales(panel) {
    const [movs, clasifOverride] = await Promise.all([cargarMovimientos(), cargarClasificacionEsencial()]);
    const clasificar = (categoria) => clasifOverride[categoria] || clasificarEsencial(categoria);

    const gasto = movs
      .filter((m) => m.Valor < 0 && m.Moneda === "COP" && m._presupuestar && m.Fuente !== "Colilla (descuento)")
      .map((m) => ({ ...m, Valor: Math.abs(m.Valor), Clasificacion: clasificar(m.Categoria) }))
      .filter((m) => m.Clasificacion !== "No consumo (ahorro/inversión)");

    if (!gasto.length) {
      panel.innerHTML = "<p>Todavía no hay gasto de consumo para clasificar.</p>";
      return;
    }
    const gastoConPeriodo = gasto.map((m) => {
      const [anio, mes] = extraerAnioMes(m.Periodo);
      return { ...m, _anio: anio, _mes: mes };
    });

    panel.innerHTML = `
      <h4>Gasto esencial vs. no esencial</h4>
      <p class="caption">Incluye solo gasto de consumo real en pesos (Visa/Mastercard en COP y Egresos -
      Efectivo, sin los movimientos "(no presupuestar)"). No incluye compras en USD, descuentos de nómina ni
      Ahorro/Inversiones. La clasificación de cada categoría se lee de la hoja 'Categorías Esenciales' del
      Sheet — editala ahí directamente para corregirla.</p>
      <div class="row"><select id="es_anio"></select><select id="es_mes"></select></div>
      <div id="es_contenido"></div>
    `;
    const anioSel = panel.querySelector("#es_anio");
    const mesSel = panel.querySelector("#es_mes");
    anioSel.add(new Option("(todos)", "(todos)"));
    [...new Set(gastoConPeriodo.map((m) => m._anio).filter(Boolean))].sort((a, b) => b - a)
      .forEach((a) => anioSel.add(new Option(a, a)));
    mesSel.add(new Option("(todos)", "(todos)"));
    for (let m = 1; m <= 12; m++) mesSel.add(new Option(`${String(m).padStart(2, "0")} - ${MESES_NOMBRE[m]}`, m));

    function actualizar() {
      let f = gastoConPeriodo;
      if (anioSel.value !== "(todos)") f = f.filter((x) => x._anio === Number(anioSel.value));
      if (mesSel.value !== "(todos)") f = f.filter((x) => x._mes === Number(mesSel.value));
      const contenido = panel.querySelector("#es_contenido");
      if (!f.length) {
        contenido.innerHTML = "<p>No hay gasto para ese año/mes.</p>";
        if (chartEsenciales) { chartEsenciales.destroy(); chartEsenciales = null; }
        return;
      }

      const porClasif = {};
      for (const x of f) porClasif[x.Clasificacion] = (porClasif[x.Clasificacion] || 0) + x.Valor;
      const totalGasto = Object.values(porClasif).reduce((s, v) => s + v, 0);

      contenido.innerHTML = `
        <div class="metric-row">
          ${["Esencial", "No esencial", "Sin clasificar"].map((c) => {
            const v = porClasif[c] || 0;
            const pct = totalGasto ? (v / totalGasto * 100) : 0;
            return metric(`${c} (${pct.toFixed(0)}%)`, fmtMoneda(v));
          }).join("")}
        </div>
        <canvas id="es_chart" height="200"></canvas>
        <details class="panel-colapsable">
          <summary>Detalle por categoría</summary>
          <div class="panel-colapsable-body">
            <div class="tabla-scroll"><table class="tabla" id="es_tabla"></table></div>
          </div>
        </details>
        <div id="es_aviso_sin_clasificar"></div>
      `;

      if (chartEsenciales) chartEsenciales.destroy();
      const clasifPresentes = Object.keys(porClasif);
      chartEsenciales = new Chart(contenido.querySelector("#es_chart").getContext("2d"), {
        type: "doughnut",
        data: { labels: clasifPresentes, datasets: [{ data: clasifPresentes.map((c) => porClasif[c]), backgroundColor: PALETA }] },
        options: { responsive: true },
      });

      const porCatClasif = {};
      for (const x of f) {
        const key = `${x.Clasificacion}|||${x.Categoria}`;
        porCatClasif[key] = (porCatClasif[key] || 0) + x.Valor;
      }
      const detalle = Object.entries(porCatClasif)
        .map(([key, v]) => { const [clasif, cat] = key.split("|||"); return { clasif, cat, v }; })
        .sort((a, b) => a.clasif.localeCompare(b.clasif) || b.v - a.v);
      contenido.querySelector("#es_tabla").innerHTML = `
        <thead><tr><th>Clasificación</th><th>Categoría</th><th>Valor</th></tr></thead>
        <tbody>${detalle.map((d) => `<tr><td>${d.clasif}</td><td>${d.cat}</td><td>${fmtMoneda(d.v)}</td></tr>`).join("")}</tbody>
      `;

      if (porClasif["Sin clasificar"]) {
        const catsSinClasificar = [...new Set(f.filter((x) => x.Clasificacion === "Sin clasificar").map((x) => x.Categoria))].sort();
        contenido.querySelector("#es_aviso_sin_clasificar").innerHTML =
          `<div class="aviso">⚠️ Categorías sin clasificar todavía (avisame si son esenciales o no): ${catsSinClasificar.join(", ")}</div>`;
      }
    }
    anioSel.addEventListener("change", actualizar);
    mesSel.addEventListener("change", actualizar);
    actualizar();
  }

  // ---------------------------------------------------------------------
  // Balance Mensual
  // ---------------------------------------------------------------------
  function celdaBalance(vals, fila, col) {
    const row = (fila - 6 >= 0 && fila - 6 < vals.length) ? (vals[fila - 6] || []) : [];
    return row[col - 1] !== undefined ? row[col - 1] : null;
  }

  function tablaBalance(vals, filaIni, filaFin) {
    const filas = [];
    for (let f = filaIni; f <= filaFin; f++) {
      const nombre = celdaBalance(vals, f, 1);
      if (nombre) filas.push({ nombre, valor: toNumber(celdaBalance(vals, f, 2)) });
    }
    return filas;
  }

  function parseBalanceMensual(vals) {
    return {
      ingresosBrutos: toNumber(celdaBalance(vals, 6, 2)),
      egresosTarjetasEfectivo: toNumber(celdaBalance(vals, 6, 7)),
      descuentosNomina: toNumber(celdaBalance(vals, 6, 12)),
      balance: toNumber(celdaBalance(vals, 6, 17)),
      egresosPorMetodo: tablaBalance(vals, 14, 16),
      descuentosPorCategoria: tablaBalance(vals, 35, 42),
      ingresosPorFuente: tablaBalance(vals, 60, 61),
    };
  }

  // Puerto de _egresos_consumo_mes() (app_presupuesto.py): a diferencia de
  // read_balance_mensual() (que viene desplazado por la fórmula de la hoja
  // según el corte de tarjeta), esto cuenta cada compra en el mes en que se
  // hizo de verdad (Fecha Compra), no en el que se paga.
  async function egresosConsumoMes(mesStr) {
    const anioObj = Number(mesStr.slice(0, 4));
    const mesObj = Number(mesStr.slice(5, 7));
    const raw = await SheetsApi.batchGet(["efectivo_detalle", "visa_detalle", "mc_detalle"]);
    let total = 0;
    const filas = [];
    for (const [rango, nombre] of [["efectivo_detalle", "Efectivo"], ["visa_detalle", "Visa"], ["mc_detalle", "Mastercard"]]) {
      const detalle = filasAObjetos(raw[rango], EGRESO_COLS, ["FechaCompra"]);
      let valor = 0;
      for (const f of detalle) {
        if (f.Moneda !== "COP" || esNoPresupuestar(f.Categoria)) continue;
        const [a, m] = extraerAnioMes(f.FechaCompra);
        if (a === anioObj && m === mesObj) valor += toNumber(f.ValorCargado);
      }
      filas.push({ nombre, valor });
      total += valor;
    }
    return { total, filas };
  }

  async function renderBalanceMensual(panel) {
    panel.innerHTML = `
      <h4>Balance Mensual</h4>
      <p class="caption">Vista efectivo real: todo lo que se paga e ingresa efectivamente este mes. El egreso
      de tarjeta se cuenta en el mes en que realmente se paga (no el mes del extracto) — el efectivo se cuenta
      en su propio mes. No se suman los meses entre sí.</p>
      <div class="row"><select id="bal_anio"></select><select id="bal_mes"></select></div>
      <div id="bal_contenido">Cargando…</div>
    `;
    const hoy = new Date();
    const selAnio = panel.querySelector("#bal_anio");
    const selMes = panel.querySelector("#bal_mes");
    for (let a = 2023; a <= 2032; a++) selAnio.add(new Option(a, a));
    selAnio.value = hoy.getFullYear();
    for (let m = 1; m <= 12; m++) selMes.add(new Option(MESES_NOMBRE[m], m));
    selMes.value = hoy.getMonth() + 1;
    selAnio.addEventListener("change", () => renderBalanceContenido(panel));
    selMes.addEventListener("change", () => renderBalanceContenido(panel));

    await renderBalanceContenido(panel);
  }

  async function renderBalanceContenido(panel) {
    const contenido = panel.querySelector("#bal_contenido");
    const anio = Number(panel.querySelector("#bal_anio").value);
    const mesNum = Number(panel.querySelector("#bal_mes").value);
    const mesStr = `${anio}-${String(mesNum).padStart(2, "0")}`;
    contenido.innerHTML = "Cargando…";
    try {
      const claveMes = `${anio}-${mesNum}`;
      if (mesBalanceAplicado !== claveMes) {
        await SheetsApi.batchUpdateRanges([
          { range: "'Balance Mensual'!E4", values: [[anio]] },
          { range: "'Balance Mensual'!G4", values: [[MESES_NOMBRE[mesNum]]] },
        ]);
        mesBalanceAplicado = claveMes;
      }
      const raw = await SheetsApi.batchGet(["balance_mensual"]);
      const datos = parseBalanceMensual(raw.balance_mensual || []);

      contenido.innerHTML = `
        <div class="row">
          <label><input type="radio" name="bal_vista" value="efectivo" checked> 💳 Efectivo real (mes en que se paga)</label>
          <label><input type="radio" name="bal_vista" value="consumo"> 🛍️ Consumo (mes en que se compra)</label>
        </div>
        <div id="bal_metricas"></div>
        <div class="col-3" id="bal_tablas"></div>
      `;
      const radios = contenido.querySelectorAll('input[name="bal_vista"]');

      async function actualizarVista() {
        const vista = [...radios].find((r) => r.checked).value;
        let egresosMostrar, tablaMetodoMostrar, balanceMostrar, etiquetaEgresos;
        if (vista === "consumo") {
          contenido.querySelector("#bal_metricas").innerHTML = "Calculando…";
          const { total, filas } = await egresosConsumoMes(mesStr);
          egresosMostrar = total;
          tablaMetodoMostrar = filas;
          balanceMostrar = datos.ingresosBrutos - total - datos.descuentosNomina;
          etiquetaEgresos = "Gasto de consumo (tarjetas + efectivo)";
        } else {
          egresosMostrar = datos.egresosTarjetasEfectivo;
          tablaMetodoMostrar = datos.egresosPorMetodo.map((f) => ({ nombre: f.nombre, valor: f.valor }));
          balanceMostrar = datos.balance;
          etiquetaEgresos = "Egresos (tarjetas + efectivo)";
        }

        contenido.querySelector("#bal_metricas").innerHTML = `
          <div class="metric-row">
            ${metric("Ingresos brutos", fmtMoneda(datos.ingresosBrutos))}
            ${metric(etiquetaEgresos, fmtMoneda(egresosMostrar))}
            ${metric("Descuentos de nómina", fmtMoneda(datos.descuentosNomina))}
            ${metric("Balance del mes", fmtMoneda(balanceMostrar))}
          </div>
        `;

        contenido.querySelector("#bal_tablas").innerHTML = `
          <div>
            <h5>Egresos por método de pago</h5>
            <table class="tabla"><thead><tr><th>Método</th><th>Valor</th></tr></thead>
              <tbody>${tablaMetodoMostrar.map((f) => `<tr><td>${f.nombre}</td><td>${fmtMoneda(f.valor)}</td></tr>`).join("")}</tbody>
            </table>
          </div>
          <div>
            <h5>Descuentos de nómina por categoría</h5>
            <table class="tabla"><thead><tr><th>Categoría</th><th>Valor</th></tr></thead>
              <tbody>${datos.descuentosPorCategoria.map((f) => `<tr><td>${f.nombre}</td><td>${fmtMoneda(f.valor)}</td></tr>`).join("")}</tbody>
            </table>
          </div>
          <div>
            <h5>Ingresos por fuente</h5>
            <table class="tabla"><thead><tr><th>Fuente</th><th>Valor</th></tr></thead>
              <tbody>${datos.ingresosPorFuente.map((f) => `<tr><td>${f.nombre}</td><td>${fmtMoneda(f.valor)}</td></tr>`).join("")}</tbody>
            </table>
          </div>
        `;
      }
      radios.forEach((r) => r.addEventListener("change", actualizarVista));
      await actualizarVista();
    } catch (err) {
      contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
      console.error(err);
    }
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  // Misma paleta categórica que px.defaults.color_discrete_sequence
  // (app_presupuesto.py) -- arranca con el mismo azul de .metric-value,
  // para que los gráficos de categorías se sientan parte de la misma app
  // en las dos versiones.
  const PALETA = ["#1d4ed8", "#d97706", "#0d9488", "#dc2626", "#7c3aed", "#65a30d", "#0891b2", "#be185d", "#4b5563"];

  return { render };
})();
