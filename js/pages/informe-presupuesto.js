// Puerto de render_informe_presupuesto() (app_presupuesto.py): informe
// ejecutivo de lectura corrida que junta en un solo lugar lo que hoy está
// repartido entre 🏠 Resumen, 📊 Análisis y 📋 Presupuesto. Reusa
// IngresosGastosPeriodo.calcular() (js/ingresos-gastos.js), la misma pieza
// central que ya usan Resumen y Estados Financieros, para no reimplementar
// la categorización de gasto real ni el cruce de "Inversiones" contra la
// plataforma real.
const PaginaInformePresupuesto = (() => {
  // Puerto de CATEGORIAS_ESENCIALES/CATEGORIAS_NO_ESENCIALES/CATEGORIAS_NO_CONSUMO
  // y clasificar_esencial() (cuenta_formatos.py) -- mismo criterio que
  // js/pages/analisis.js (no exportado ahí, se duplica acá).
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

  const RESUMEN_MENSUAL_COLS = [
    "Mes", "IngresosGanados", "GastosPersonales", "DeudasObligaciones", "AhorroInversiones", "DisponibleMes",
  ];

  const charts = {};

  async function render(container) {
    container.innerHTML = `
      <h1>📊 Informe de Presupuesto, Ingresos y Gastos</h1>
      <p class="caption">Resumen ejecutivo de tu mes/año: cuánto entró, cuánto salió, tasa de ahorro, gasto
      esencial vs. no esencial y cómo vas contra el presupuesto. Vista devengado (cada movimiento en su propia
      fecha), salvo la evolución mensual, que es efectivo real.</p>
      <div class="campo">
        <label>Alcance del informe:</label>
        <div class="radio-row" id="ip-alcance-radios">
          <label><input type="radio" name="ip-alcance" value="total" checked> Total histórico</label>
          <label><input type="radio" name="ip-alcance" value="anio"> Un año</label>
          <label><input type="radio" name="ip-alcance" value="mes"> Un mes</label>
        </div>
        <div id="ip-selectores" class="row" style="display:none;">
          <select id="ip-sel-anio"></select>
          <select id="ip-sel-mes" style="display:none;"></select>
        </div>
      </div>
      <div id="ip-contenido">Cargando datos del Sheet…</div>
    `;
    const contenido = container.querySelector("#ip-contenido");

    let base, resumenMensual, presupuesto, clasifOverride;
    try {
      const [b, rawExtra] = await Promise.all([
        IngresosGastosPeriodo.cargarDatosBase(),
        SheetsApi.batchGet(["resumen_mensual", "presupuesto", "clasificacion_esencial"]),
      ]);
      base = b;
      resumenMensual = filasAObjetos(rawExtra.resumen_mensual, RESUMEN_MENSUAL_COLS);
      presupuesto = parsePresupuestoCategorias(rawExtra.presupuesto || []);
      clasifOverride = {};
      for (const r of rawExtra.clasificacion_esencial || []) {
        if (r && r[0] && r[1]) clasifOverride[r[0]] = r[1];
      }
    } catch (err) {
      contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
      console.error(err);
      return;
    }

    const hoy = new Date();
    const anios = []; for (let a = 2023; a < 2033; a++) anios.push(a);
    const selectoresDiv = container.querySelector("#ip-selectores");
    const selAnio = container.querySelector("#ip-sel-anio");
    const selMes = container.querySelector("#ip-sel-mes");
    anios.forEach((a) => selAnio.add(new Option(a, a, a === hoy.getFullYear(), a === hoy.getFullYear())));
    for (let m = 1; m <= 12; m++) selMes.add(new Option(MESES_NOMBRE[m], m, m === hoy.getMonth() + 1, m === hoy.getMonth() + 1));

    function actualizarSelectores() {
      const alcance = container.querySelector('input[name="ip-alcance"]:checked').value;
      selectoresDiv.style.display = alcance === "total" ? "none" : "flex";
      selMes.style.display = alcance === "mes" ? "" : "none";
    }
    function coincideActual() {
      const alcance = container.querySelector('input[name="ip-alcance"]:checked').value;
      if (alcance === "total") return () => true;
      const anioSel = Number(selAnio.value);
      if (alcance === "anio") return (anio) => anio === anioSel;
      const mesSel = Number(selMes.value);
      return (anio, mes) => anio === anioSel && mes === mesSel;
    }

    function renderTodo() {
      actualizarSelectores();
      const coincide = coincideActual();
      const d = IngresosGastosPeriodo.calcular(base, coincide);
      renderInforme(contenido, base, d, resumenMensual, presupuesto, clasifOverride, coincide);
    }

    container.querySelectorAll('input[name="ip-alcance"]').forEach((r) => r.addEventListener("change", renderTodo));
    selAnio.addEventListener("change", renderTodo);
    selMes.addEventListener("change", renderTodo);
    renderTodo();
  }

  // Puerto (solo lectura) de parsePresupuesto() (js/pages/presupuesto.js) --
  // NO escribe el selector de mes B5, a diferencia de 📋 Presupuesto: usa
  // el mes que ya esté seleccionado ahí ("cambialo ahí si querés ver otro").
  function parsePresupuestoCategorias(vals) {
    const categorias = [];
    for (let n = 8; n <= 25; n++) {
      const row = vals[n - 5] || [];
      if (row[0]) categorias.push({ categoria: row[0], presupuesto: toNumber(row[1]), gastoReal: toNumber(row[2]) });
    }
    return categorias;
  }

  function moneyMd(v) { return fmtMoneda(v); }

  function renderInforme(contenido, base, d, resumenMensual, presupuesto, clasifOverride, coincide) {
    const ahorroGasto = d.gasto_ahorro;
    const ahorroNomina = d.descuento_ahorro + d.descuento_fondo_empleados;
    const ahorroTotal = d.gasto_inversiones + ahorroGasto + ahorroNomina;
    const deudaNomina = d.descuento_deuda_nomina;
    const gastoConsumo = d.gasto_operativo + d.descuentosNomina - ahorroNomina - deudaNomina;
    const totalEgresos = gastoConsumo + ahorroTotal + deudaNomina;
    const disponibleEfectivo = d.totalIngresos - totalEgresos;
    const totalAhorrado = disponibleEfectivo + ahorroTotal;
    const tasaAhorro = d.totalIngresos ? (totalAhorrado / d.totalIngresos * 100) : 0;
    const deudaPendiente = base.deudas.reduce((s, f) => s + toNumber(f.SaldoActual), 0);

    let html = `
      <p>Con el alcance elegido entraron <strong>${moneyMd(d.totalIngresos)}</strong>. De ahí,
      <strong>${moneyMd(gastoConsumo)}</strong> se consumió y <strong>${moneyMd(ahorroTotal)}</strong> se fue a
      ahorro e inversión (no es gasto, sigue siendo tuyo) — entre lo que quedó líquido y lo ahorrado/invertido,
      <strong>no gastaste el ${tasaAhorro.toFixed(0)}%</strong> de lo que ganaste.</p>
      <div class="metric-row">
        ${metric("Ingresos totales", fmtMoneda(d.totalIngresos))}
        ${metric("Gasto de consumo", fmtMoneda(gastoConsumo))}
      </div>
      <div class="metric-row">
        ${metric("Disponible en efectivo", fmtMoneda(disponibleEfectivo))}
        ${metric("Tasa de ahorro (efectivo + ahorro + inversión)", `${tasaAhorro.toFixed(0)}%`)}
      </div>
      <p><strong>Ahorro e inversión, discriminado por origen</strong></p>
      <div class="metric-row">
        ${metric("Inversiones", fmtMoneda(d.gasto_inversiones))}
        ${metric("Ahorro (efectivo/tarjeta)", fmtMoneda(ahorroGasto))}
      </div>
      <div class="metric-row">
        ${metric("Ahorro vía nómina", fmtMoneda(ahorroNomina))}
        ${metric("Deuda pendiente hoy", fmtMoneda(deudaPendiente))}
      </div>
      <p class="caption">"Tasa de ahorro" = (efectivo disponible + Inversiones + Ahorro, sea de tarjeta/efectivo
      o vía nómina) / ingresos. Si solo te interesa el efectivo disponible en la cuenta corriente, esa es
      "Disponible en efectivo" arriba.</p>
      ${IngresosGastosPeriodo.renderDesgloseInversiones(d)}
    `;
    if (deudaNomina > 0) {
      html += `<p class="caption">Aparte, ${moneyMd(deudaNomina)} de este alcance se fue a cuotas de deuda
        descontadas directo de la nómina (leasing habitacional / préstamo del Fondo de Empleados) — tampoco es
        consumo, pero no se suma a la tasa de ahorro porque cada cuota mezcla capital e interés.</p>`;
    }
    if (d.ingreso_cesantias > 0) {
      html += `<p class="caption">De los ingresos, ${moneyMd(d.ingreso_cesantias)} son de la categoría
        Cesantías (intereses o retiro del fondo) — ya están incluidos en "Ingresos totales".</p>`;
    }

    html += `
      <details class="panel-colapsable" open>
        <summary>Ingresos</summary>
        <div class="panel-colapsable-body">
          <div class="metric-row">
            ${metric("Colillas de pago", fmtMoneda(d.ingresosColillas))}
            ${metric("Otros ingresos", fmtMoneda(d.otrosIngresos))}
          </div>
          <canvas id="ip_chart_ingresos"></canvas>
        </div>
      </details>
    `;

    html += `
      <details class="panel-colapsable" open>
        <summary>Gastos</summary>
        <div class="panel-colapsable-body">
          <div class="metric-row">
            ${metric("Gasto de consumo (sin inversiones ni ahorro)", fmtMoneda(d.gasto_operativo))}
            ${metric("Descuentos de nómina", fmtMoneda(d.descuentosNomina))}
            ${metric("Aportes a inversión", fmtMoneda(d.gasto_inversiones))}
          </div>
          <canvas id="ip_chart_gastos"></canvas>
          ${d.gastoSinCategorizar > 0 ? (() => {
            const pctOtros = d.gastoReal ? (d.gastoSinCategorizar / d.gastoReal * 100) : 0;
            return `<div class="aviso">⚠️ ${moneyMd(d.gastoSinCategorizar)} (${pctOtros.toFixed(0)}% del gasto)
              está en la categoría genérica "Otros" — revisalo en 📊 Análisis → Movimientos.</div>`;
          })() : ""}
        </div>
      </details>
    `;

    html += `
      <details class="panel-colapsable" open>
        <summary>Esencial vs. no esencial</summary>
        <div class="panel-colapsable-body" id="ip_esenciales"></div>
      </details>
      <details class="panel-colapsable" open>
        <summary>Evolución mensual (efectivo real, últimos 12 meses)</summary>
        <div class="panel-colapsable-body" id="ip_evolucion"></div>
      </details>
      <details class="panel-colapsable" open>
        <summary>Presupuesto vs. real</summary>
        <div class="panel-colapsable-body" id="ip_presupuesto"></div>
      </details>
    `;

    contenido.innerHTML = html;

    renderIngresosChart(contenido.querySelector("#ip_chart_ingresos"), d.ingresosPorCategoria);
    renderGastosChart(contenido.querySelector("#ip_chart_gastos"), d.gastoPorCategoria);
    renderEsenciales(contenido.querySelector("#ip_esenciales"), base, clasifOverride, coincide);
    renderEvolucion(contenido.querySelector("#ip_evolucion"), resumenMensual);
    renderPresupuestoVsReal(contenido.querySelector("#ip_presupuesto"), presupuesto);
  }

  function renderIngresosChart(canvas, ingresosPorCategoria) {
    const entradas = Object.entries(ingresosPorCategoria).sort((a, b) => b[1] - a[1]);
    if (!entradas.length) { canvas.replaceWith(document.createTextNode("(sin datos)")); return; }
    canvas.height = Math.max(140, 32 * entradas.length);
    charts.ingresos?.destroy();
    charts.ingresos = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: { labels: entradas.map((e) => e[0]), datasets: [{ data: entradas.map((e) => e[1]), backgroundColor: "#1d4ed8" }] },
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } } },
    });
  }

  function renderGastosChart(canvas, gastoPorCategoria) {
    const entradas = Object.entries(gastoPorCategoria).filter(([k]) => k !== "Inversiones" && k !== "Ahorro").sort((a, b) => b[1] - a[1]);
    if (!entradas.length) { canvas.replaceWith(document.createTextNode("(sin datos)")); return; }
    canvas.height = Math.max(180, 30 * entradas.length);
    charts.gastos?.destroy();
    charts.gastos = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: { labels: entradas.map((e) => e[0]), datasets: [{ data: entradas.map((e) => e[1]), backgroundColor: "#dc2626" }] },
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } } },
    });
  }

  function renderEsenciales(div, base, clasifOverride, coincide) {
    const clasificar = (categoria) => clasifOverride[categoria] || clasificarEsencial(categoria);
    const gasto = [];
    for (const bloque of [base.efectivoDetalle, base.visaDetalle, base.mcDetalle]) {
      for (const f of bloque) {
        const [anio, mes] = extraerAnioMes(f.FechaCompra);
        if (!coincide(anio, mes) || f.Moneda !== "COP" || esNoPresupuestar(f.Categoria)) continue;
        const clasificacion = clasificar(f.Categoria);
        if (clasificacion === "No consumo (ahorro/inversión)") continue;
        gasto.push({ valor: toNumber(f.ValorCargado), clasificacion, categoria: f.Categoria });
      }
    }
    if (!gasto.length) { div.innerHTML = '<p class="caption">No hay gasto de consumo clasificable en este alcance.</p>'; return; }
    const porClasif = {};
    for (const g of gasto) porClasif[g.clasificacion] = (porClasif[g.clasificacion] || 0) + g.valor;
    const totalClas = Object.values(porClasif).reduce((s, v) => s + v, 0);
    const filas = ["Esencial", "No esencial", "Sin clasificar"].map((c) => {
      const v = porClasif[c] || 0;
      const pct = totalClas ? (v / totalClas * 100) : 0;
      return metric(c, `${fmtMoneda(v)} (${pct.toFixed(0)}%)`);
    });
    div.innerHTML = `<div class="metric-row">${filas.join("")}</div>`;
    const sinClasificarCats = [...new Set(gasto.filter((g) => g.clasificacion === "Sin clasificar").map((g) => g.categoria))].sort();
    if (sinClasificarCats.length) {
      div.insertAdjacentHTML("beforeend", `<p class="caption">Sin clasificar todavía: ${sinClasificarCats.join(", ")}
        — editalo en la hoja "Categorías Esenciales".</p>`);
    }
  }

  function renderEvolucion(div, resumenMensual) {
    const filas = resumenMensual.filter((f) => toNumber(f.IngresosGanados) !== 0).slice(-12);
    if (!filas.length) { div.innerHTML = "<p>Todavía no hay suficientes meses cargados para la evolución mensual.</p>"; return; }
    div.innerHTML = `
      <canvas id="ip_chart_evolucion" height="160"></canvas>
      <canvas id="ip_chart_tasa" height="140"></canvas>
    `;
    charts.evolucion?.destroy();
    charts.evolucion = new Chart(div.querySelector("#ip_chart_evolucion").getContext("2d"), {
      type: "bar",
      data: {
        labels: filas.map((f) => f.Mes),
        datasets: [
          { label: "Ingresos ganados", data: filas.map((f) => toNumber(f.IngresosGanados)), backgroundColor: "#1d4ed8" },
          { label: "Gastos personales", data: filas.map((f) => toNumber(f.GastosPersonales)), backgroundColor: "#dc2626" },
          { label: "Disponible del mes", data: filas.map((f) => toNumber(f.DisponibleMes)), backgroundColor: "#0d9488" },
        ],
      },
      options: { responsive: true, scales: { x: { type: "category" }, y: { ticks: { callback: (v) => fmtMoneda(v) } } } },
    });
    const tasas = filas.map((f) => (toNumber(f.IngresosGanados) ? (toNumber(f.DisponibleMes) / toNumber(f.IngresosGanados) * 100) : 0));
    charts.tasa?.destroy();
    charts.tasa = new Chart(div.querySelector("#ip_chart_tasa").getContext("2d"), {
      type: "line",
      data: { labels: filas.map((f) => f.Mes), datasets: [{ label: "Tasa de ahorro %", data: tasas, borderColor: "#7c3aed", backgroundColor: "#7c3aed", tension: 0.1 }] },
      options: { responsive: true, scales: { x: { type: "category" } } },
    });
  }

  function renderPresupuestoVsReal(div, presupuesto) {
    const catsConMeta = presupuesto.filter((c) => c.presupuesto > 0);
    if (!catsConMeta.length) { div.innerHTML = "<p>Todavía no definiste metas de presupuesto por categoría — hacelo en 📋 Presupuesto.</p>"; return; }
    const totalMeta = catsConMeta.reduce((s, c) => s + c.presupuesto, 0);
    const totalRealMeta = catsConMeta.reduce((s, c) => s + c.gastoReal, 0);
    const pctUsado = totalMeta ? (totalRealMeta / totalMeta * 100) : 0;
    let html = `
      <div class="metric-row">
        ${metric("Presupuestado (categorías con meta)", fmtMoneda(totalMeta))}
        ${metric("Gasto real de esas categorías", fmtMoneda(totalRealMeta))}
        ${metric("% del presupuesto usado", `${pctUsado.toFixed(0)}%`)}
      </div>
    `;
    const pasadas = catsConMeta.filter((c) => c.gastoReal > c.presupuesto);
    if (pasadas.length) {
      const textos = pasadas.map((c) => `${c.categoria} (${moneyMd(c.gastoReal - c.presupuesto)} de más)`);
      html += `<div class="aviso">Te pasaste del presupuesto en: ${textos.join(", ")}</div>`;
    } else {
      html += `<div class="aviso" style="background:var(--success-bg);color:var(--success-text);">No te pasaste del presupuesto en ninguna categoría con meta definida.</div>`;
    }
    html += `<p class="caption">Corresponde al mes actualmente seleccionado en 📋 Presupuesto — cambialo ahí si
      querés ver otro mes (no depende del alcance elegido arriba).</p>`;
    div.innerHTML = html;
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
