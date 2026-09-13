// Puerto de render_estados_financieros() (app_presupuesto.py): Estado de
// Resultados, Balance General, Flujo de Efectivo (con escritura — guarda el
// saldo inicial/final real de un mes) y Auditoría Anual.

const PaginaEstadosFinancieros = (() => {
  let chartPatrimonio = null;

  function render(container) {
    container.innerHTML = `
      <h1>🏢 Estados Financieros</h1>
      <p class="caption">Tus finanzas vistas como las de una empresa.</p>
      <div class="tabs" id="tabs-ef">
        <button class="tab-btn activo" data-tab="resultados">Estado de Resultados</button>
        <button class="tab-btn" data-tab="balance">Balance General</button>
        <button class="tab-btn" data-tab="flujo">Flujo de Efectivo</button>
        <button class="tab-btn" data-tab="auditoria">Auditoría Anual</button>
      </div>
      <div id="panel-ef">Cargando datos del Sheet…</div>
    `;
    const tabsDiv = container.querySelector("#tabs-ef");
    const panel = container.querySelector("#panel-ef");
    let activo = "resultados";

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
        if (activo === "resultados") await renderEstadoResultados(panel);
        else if (activo === "balance") await renderBalanceGeneral(panel);
        else if (activo === "flujo") await renderFlujoEfectivo(panel);
        else await renderAuditoriaAnual(panel);
      } catch (err) {
        panel.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
        console.error(err);
      }
    }

    renderTab();
  }

  // ---------------------------------------------------------------------
  async function renderEstadoResultados(panel) {
    panel.innerHTML = `
      <p class="caption">Ingresos menos gastos operativos del período — la "Utilidad Neta". No incluye
      aportes a Inversiones (es una compra de activo, no un gasto) ni pagos de deuda (eso va en Flujo de
      Efectivo).</p>
      <div class="campo">
        <label>Alcance:</label>
        <div class="radio-row" id="er-radios">
          <label><input type="radio" name="er_alcance" value="total" checked> Total histórico</label>
          <label><input type="radio" name="er_alcance" value="anio"> Un año</label>
          <label><input type="radio" name="er_alcance" value="mes"> Un mes</label>
        </div>
        <div id="er-selectores" class="row" style="display:none;">
          <select id="er_anio"></select>
          <select id="er_mes" style="display:none;"></select>
        </div>
      </div>
      <div id="er-contenido">Cargando…</div>
    `;
    const hoy = new Date();
    const selAnio = panel.querySelector("#er_anio");
    const selMes = panel.querySelector("#er_mes");
    for (let a = 2023; a <= 2032; a++) selAnio.add(new Option(a, a));
    selAnio.value = hoy.getFullYear();
    for (let m = 1; m <= 12; m++) selMes.add(new Option(MESES_NOMBRE[m], m));
    selMes.value = hoy.getMonth() + 1;
    const radios = panel.querySelectorAll('input[name="er_alcance"]');
    const selectoresDiv = panel.querySelector("#er-selectores");

    const datos = await IngresosGastosPeriodo.cargarDatosBase();

    function alcanceActual() { return [...radios].find((r) => r.checked).value; }
    function actualizar() {
      const alcance = alcanceActual();
      selectoresDiv.style.display = alcance === "total" ? "none" : "flex";
      selMes.style.display = alcance === "mes" ? "inline-block" : "none";
      renderContenido();
    }
    radios.forEach((r) => r.addEventListener("change", actualizar));
    selAnio.addEventListener("change", renderContenido);
    selMes.addEventListener("change", renderContenido);

    function renderContenido() {
      const alcance = alcanceActual();
      const anioSel = parseInt(selAnio.value, 10);
      const mesSel = parseInt(selMes.value, 10);
      const coincide = (anio, mes) => {
        if (alcance === "total") return true;
        if (anio === null) return false;
        if (alcance === "anio") return anio === anioSel;
        return anio === anioSel && mes === mesSel;
      };
      const d = IngresosGastosPeriodo.calcular(datos, coincide);
      const totalGastos = d.gasto_operativo + d.descuentosNomina;
      const utilidadNeta = d.totalIngresos - totalGastos;
      const tasaAhorroEr = d.totalIngresos ? (utilidadNeta / d.totalIngresos * 100) : 0;
      const ingresosCat = Object.entries(d.ingresosPorCategoria).sort((a, b) => b[1] - a[1]);
      const gastoCatSinInv = Object.entries(d.gastoPorCategoria).filter(([k]) => k !== "Inversiones").sort((a, b) => b[1] - a[1]);

      panel.querySelector("#er-contenido").innerHTML = `
        <h5>Ingresos</h5>
        <div class="metric-row">
          ${metric("Colillas de pago", fmtMoneda(d.ingresosColillas))}
          ${metric("Otros ingresos", fmtMoneda(d.otrosIngresos))}
          ${metric("Total Ingresos", fmtMoneda(d.totalIngresos))}
        </div>
        ${ingresosCat.length ? `
          <details><summary>Ver ingresos por categoría</summary>
            <table class="tabla"><thead><tr><th>Categoría</th><th>Valor</th></tr></thead>
              <tbody>${ingresosCat.map(([c, v]) => `<tr><td>${c}</td><td>${fmtMoneda(v)}</td></tr>`).join("")}</tbody>
            </table>
          </details>` : ""}

        <h5>Gastos operativos</h5>
        <div class="metric-row">
          ${metric("Gasto de consumo (sin inversiones ni ahorro)", fmtMoneda(d.gasto_operativo))}
          ${metric("Descuentos de nómina", fmtMoneda(d.descuentosNomina))}
          ${metric("Total Gastos", fmtMoneda(totalGastos))}
        </div>
        ${gastoCatSinInv.length ? `
          <details><summary>Ver gasto por categoría</summary>
            <table class="tabla"><thead><tr><th>Categoría</th><th>Valor</th></tr></thead>
              <tbody>${gastoCatSinInv.map(([c, v]) => `<tr><td>${c}</td><td>${fmtMoneda(v)}</td></tr>`).join("")}</tbody>
            </table>
          </details>` : ""}
        ${d.descuentos_sin_categorizar > 100 ? `
          <div class="aviso">⚠️ ${fmtMoneda(d.descuentos_sin_categorizar)} de los descuentos de nómina de
          este período no tiene detalle categorizado.</div>` : ""}

        <h5>Utilidad Neta del Período</h5>
        <div class="metric-row">
          ${metric("Utilidad Neta", fmtMoneda(utilidadNeta))}
          ${metric("Tasa de Ahorro", tasaAhorroEr.toFixed(0) + "%")}
        </div>
        ${utilidadNeta >= 0
          ? `<div class="ok">✅ Resultado positivo: sobraron ${fmtMoneda(utilidadNeta)} en este período
             (${tasaAhorroEr.toFixed(0)}% de los ingresos).</div>`
          : `<div class="aviso">⚠️ Resultado negativo: el gasto superó el ingreso por
             ${fmtMoneda(Math.abs(utilidadNeta))}.</div>`}
      `;
    }

    renderContenido();
  }

  // ---------------------------------------------------------------------
  async function renderBalanceGeneral(panel) {
    const raw = await SheetsApi.batchGet(["conciliacion_efectivo", "resumen_kpis", "deudas", "deuda_tarjeta_usd"]);
    const conciliacion = filasAObjetos(raw.conciliacion_efectivo, ["Mes", "SaldoInicial", "SaldoFinal", "FechaRegistro"], ["FechaRegistro"]);
    const kpis = {};
    (raw.resumen_kpis || []).forEach((row) => {
      if (row && row[0]) kpis[row[0]] = toNumber(row.length >= 4 ? row[3] : row[row.length - 1]);
    });
    const deudas = filasAObjetos(raw.deudas, [
      "Entidad", "TipoCredito", "SaldoActual", "TasaEA", "CuotaMensual", "PctPagado", "MesesRestantes", "FechaEstPago",
    ], ["FechaEstPago"]);
    const deudaUsd = (raw.deuda_tarjeta_usd || [])[0] || null;

    let saldoEfectivo = 0, mesEfectivo = null;
    if (conciliacion.length) {
      const ultimo = [...conciliacion].sort((a, b) => String(a.Mes).localeCompare(String(b.Mes))).pop();
      saldoEfectivo = toNumber(ultimo.SaldoFinal);
      mesEfectivo = ultimo.Mes;
    }
    const valorPortafolioPesos = kpis["Valor actual del portafolio de inversiones en pesos"] || 0;
    const valorPortafolioDolares = kpis["Valor actual del portafolio de inversiones en dólares"] || 0;
    const totalActivos = saldoEfectivo + valorPortafolioPesos;

    const totalPasivos = deudas.reduce((s, f) => s + toNumber(f.SaldoActual), 0);
    const cuotaMensualTotal = deudas.reduce((s, f) => s + toNumber(f.CuotaMensual), 0);
    const patrimonioNeto = totalActivos - totalPasivos;

    panel.innerHTML = `
      <p class="caption">Foto de hoy: qué tenés (Activos) menos qué debés (Pasivos) = Patrimonio Neto. No
      cambia con ningún selector de período.</p>

      <h5>Activos</h5>
      <p class="caption">${mesEfectivo ? `Efectivo: saldo final de ${mesEfectivo}.` : "Todavía no cargaste ningún saldo de cuenta en Flujo de Efectivo."}</p>
      <div class="metric-row">
        ${metric("Efectivo (cuenta de ahorros)", fmtMoneda(saldoEfectivo))}
        ${metric("Portafolio de inversiones (pesos)", fmtMoneda(valorPortafolioPesos))}
        ${metric("Total Activos", fmtMoneda(totalActivos))}
      </div>
      ${valorPortafolioDolares ? `<p class="caption">Portafolio de inversiones en dólares (aparte, no
        sumado): ${fmtUsd(valorPortafolioDolares)}</p>` : ""}
      ${(valorPortafolioPesos === 0 && valorPortafolioDolares === 0) ? `<p class="caption">El portafolio de
        inversiones da $0 porque todavía no cargaste posiciones en 📈 Inversiones.</p>` : ""}

      <h5>Pasivos</h5>
      <div class="metric-row">
        ${metric("Saldo total de deudas (pesos)", fmtMoneda(totalPasivos))}
        ${metric("Cuota mensual total", fmtMoneda(cuotaMensualTotal))}
      </div>
      ${deudaUsd && deudaUsd[0] ? `<p class="caption">${deudaUsd[0]} — deuda en dólares (aparte, no sumada):
        ${fmtUsd(toNumber(deudaUsd[2]))}. ${deudaUsd[1] || ""}</p>` : ""}

      <h5>Patrimonio Neto</h5>
      <div class="metric-row">${metric("Activos − Pasivos (pesos)", fmtMoneda(patrimonioNeto))}</div>
      <div id="be-patrimonio-tiempo"></div>
    `;

    // Guarda una foto de hoy cada vez que se abre esta pantalla (upsert por
    // fecha -- mismo protocolo que guardarConciliacionEfectivo()) y muestra
    // la serie en el tiempo si ya hay 2+ fotos. Nunca debe romper la vista
    // de hoy si el Sheet falla por lo que sea.
    try {
      await guardarSnapshotPatrimonio(totalActivos, totalPasivos);
    } catch (err) {
      console.warn("No pude guardar el snapshot de patrimonio neto:", err.message);
    }
    try {
      const rawHist = await SheetsApi.batchGet(["historial_patrimonio_neto"]);
      const historial = filasAObjetos(rawHist.historial_patrimonio_neto,
        ["Fecha", "Activos", "Pasivos", "PatrimonioNeto"], ["Fecha"]);
      if (historial.length >= 2) {
        const divTiempo = panel.querySelector("#be-patrimonio-tiempo");
        divTiempo.innerHTML = `
          <h5>Patrimonio Neto en el tiempo</h5>
          <p class="caption">Una foto por día distinto que abriste esta pantalla (no es retroactivo: arranca
          desde la primera vez que la viste). Dólares no incluidos, mismo criterio que arriba.</p>
          <canvas id="be_chart_patrimonio" height="160"></canvas>
        `;
        renderChartPatrimonio(divTiempo.querySelector("#be_chart_patrimonio"), historial);
      }
    } catch (err) {
      // Todavía no hay ninguna foto guardada (hoja recién creada en este
      // mismo render, o el snapshot de arriba falló) -- sin gráfico por ahora.
    }
  }

  // Puerto de guardar_snapshot_patrimonio() (sheets_backend.py) -- crea la
  // hoja si es la primera vez (ver SheetsApi.crearHoja()), y hace upsert
  // por fecha para no apilar fotos repetidas si se abre la pantalla varias
  // veces el mismo día.
  async function guardarSnapshotPatrimonio(activos, pasivos) {
    const fechaISO = new Date().toISOString().slice(0, 10);
    const [y, m, d] = fechaISO.split("-");
    const fechaDDMM = `${d}/${m}/${y}`;
    let filas;
    try {
      const raw = await SheetsApi.batchGet(["historial_patrimonio_neto"]);
      filas = raw.historial_patrimonio_neto || [];
    } catch (err) {
      await SheetsApi.crearHoja("Historial de Patrimonio Neto", 2000, 4);
      await SheetsApi.updateRange("'Historial de Patrimonio Neto'!A1:D1",
        [["Fecha", "Activos", "Pasivos", "Patrimonio Neto"]], "RAW");
      filas = [];
    }
    let filaExistente = null;
    for (let i = 0; i < filas.length; i++) {
      if (filas[i] && serialToText(filas[i][0]) === fechaDDMM) { filaExistente = i + 2; break; }
    }
    const valores = [fechaISO, activos, pasivos, activos - pasivos];
    if (filaExistente) {
      await SheetsApi.updateRange(`'Historial de Patrimonio Neto'!A${filaExistente}:D${filaExistente}`, [valores]);
    } else {
      await SheetsApi.appendRows(RANGOS.historial_patrimonio_neto, [valores]);
    }
  }

  function renderChartPatrimonio(canvas, historial) {
    const filas = historial
      .map((f) => ({ fechaISO: parseFechaISO(f.Fecha), activos: toNumber(f.Activos), pasivos: toNumber(f.Pasivos), neto: toNumber(f.PatrimonioNeto) }))
      .filter((f) => f.fechaISO)
      .sort((a, b) => a.fechaISO.localeCompare(b.fechaISO));
    chartPatrimonio?.destroy();
    chartPatrimonio = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        datasets: [
          { label: "Activos", data: filas.map((f) => ({ x: f.fechaISO, y: f.activos })), borderColor: "#1d4ed8", backgroundColor: "#1d4ed8", tension: 0.1 },
          { label: "Pasivos", data: filas.map((f) => ({ x: f.fechaISO, y: f.pasivos })), borderColor: "#dc2626", backgroundColor: "#dc2626", tension: 0.1 },
          { label: "Patrimonio Neto", data: filas.map((f) => ({ x: f.fechaISO, y: f.neto })), borderColor: "#0ca30c", backgroundColor: "#0ca30c", tension: 0.1 },
        ],
      },
      options: { responsive: true, parsing: false, scales: { x: { type: "category" }, y: { ticks: { callback: (v) => fmtMoneda(v) } } } },
    });
  }

  // ---------------------------------------------------------------------
  // Flujo de Efectivo
  // ---------------------------------------------------------------------
  async function renderFlujoEfectivo(panel) {
    panel.innerHTML = `
      <p class="caption">Cuánta plata entra y sale realmente de tu cuenta de ahorros en un mes — empezando por
      cuánto tenías al arrancar. Se separa en Operación (tu día a día), Inversión (aportes a plataformas de
      inversión), Financiación (cuotas de deuda pagadas automáticamente desde la cuenta) y Conciliación (pago
      automático de tarjeta, intereses/4x1000, transferencias entre tus propias cuentas — no son gasto ni
      ingreso real, pero sí mueven la plata de la cuenta).</p>
      <div class="row"><select id="fe_anio"></select><select id="fe_mes"></select></div>
      <div id="fe-contenido">Cargando…</div>
    `;
    const hoy = new Date();
    const selAnio = panel.querySelector("#fe_anio");
    const selMes = panel.querySelector("#fe_mes");
    for (let a = 2023; a <= 2032; a++) selAnio.add(new Option(a, a));
    selAnio.value = hoy.getFullYear();
    for (let m = 1; m <= 12; m++) selMes.add(new Option(MESES_NOMBRE[m], m));
    selMes.value = hoy.getMonth() + 1;

    let datos = await IngresosGastosPeriodo.cargarDatosBase();

    async function renderContenido() {
      const contenido = panel.querySelector("#fe-contenido");
      const anio = Number(selAnio.value);
      const mesNum = Number(selMes.value);
      const mesStr = `${anio}-${String(mesNum).padStart(2, "0")}`;
      contenido.innerHTML = "Cargando…";

      const existente = datos.conciliacion.find((f) => f.Mes === mesStr);
      let saldoInicialPrev, saldoFinalPrev, avisoCadena = "";
      if (existente) {
        saldoInicialPrev = toNumber(existente.SaldoInicial);
        saldoFinalPrev = toNumber(existente.SaldoFinal);
      } else {
        const { saldo, mesAncla } = IngresosGastosPeriodo.saldoInicialEncadenado(datos, anio, mesNum);
        if (saldo === null) {
          avisoCadena = `<div class="aviso">⚠️ No hay ningún saldo real guardado antes de ${mesStr} — el $0 de
            abajo es solo un valor de partida, no un cálculo. Ingresá el saldo real de tu cuenta al cierre del
            primer mes con datos (en el campo de abajo) para que la cadena de saldos arranque bien.</div>`;
          saldoInicialPrev = 0;
        } else {
          avisoCadena = `<p class="caption">Saldo inicial calculado encadenando desde el último saldo real
            guardado (${mesAncla}) más el flujo de los meses intermedios.</p>`;
          saldoInicialPrev = saldo;
        }
        saldoFinalPrev = 0;
      }

      const coincide = (anio2, mes2) => anio2 === anio && mes2 === mesNum;
      const d = IngresosGastosPeriodo.calcular(datos, coincide);
      const fe = IngresosGastosPeriodo.calcularFlujoEfectivo(datos, coincide);

      contenido.innerHTML = `
        ${avisoCadena}
        <div class="row">
          <div class="campo"><label>Saldo inicial del mes</label><br>
            <input type="number" step="any" id="fe_saldo_ini" value="${saldoInicialPrev}"></div>
          <div class="campo"><label>Saldo final del mes (según tu extracto)</label><br>
            <input type="number" step="any" id="fe_saldo_fin" value="${saldoFinalPrev}"></div>
        </div>
        <button type="button" id="fe_guardar">💾 Guardar saldos de este mes</button>
        <div class="aviso" id="fe_msg" hidden></div>

        <div class="metric-row">${metric("Saldo Inicial del Mes", fmtMoneda(saldoInicialPrev))}</div>

        <h5>Flujo del mes</h5>
        <div class="metric-row" id="fe_flujo_metrics"></div>
        <div class="metric-row" id="fe_saldo_final_calc"></div>
        <div id="fe_comparacion"></div>

        <details>
          <summary>🔎 Ver desglose del mes</summary>
          <div id="fe_desglose"></div>
        </details>
      `;

      function actualizarCalculo() {
        const saldoInicial = Number(contenido.querySelector("#fe_saldo_ini").value) || 0;
        const saldoFinalManual = Number(contenido.querySelector("#fe_saldo_fin").value) || 0;
        const flujoOperacion = d.totalIngresos - d.gasto_operativo - d.descuentosNomina;
        const flujoInversion = -d.gasto_inversiones;
        const flujoFinanciacion = -fe.pagoDeuda;
        const flujoConciliacion = fe.flujoConciliacion;
        const saldoFinalCalculado = saldoInicial + flujoOperacion + flujoInversion + flujoFinanciacion + flujoConciliacion;

        contenido.querySelector("#fe_flujo_metrics").innerHTML = `
          ${metric("Operación", fmtMoneda(flujoOperacion))}
          ${metric("Inversión", fmtMoneda(flujoInversion))}
          ${metric("Financiación", fmtMoneda(flujoFinanciacion))}
          ${metric("Conciliación", fmtMoneda(flujoConciliacion))}
        `;
        contenido.querySelector("#fe_saldo_final_calc").innerHTML = metric("Saldo Final Calculado", fmtMoneda(saldoFinalCalculado));

        const comparacionDiv = contenido.querySelector("#fe_comparacion");
        if (!(saldoInicial === 0 && saldoFinalManual === 0)) {
          const diferencia = saldoFinalCalculado - saldoFinalManual;
          comparacionDiv.innerHTML = Math.abs(diferencia) > 100
            ? `<div class="aviso">El saldo calculado no cuadra con el saldo final que ingresaste — diferencia
               de ${fmtMoneda(diferencia)}. Revisá si falta cargar algún movimiento de este mes.</div>`
            : `<div class="ok">✅ Cuadra con el saldo final ingresado (${fmtMoneda(saldoFinalManual)}).</div>`;
        } else {
          comparacionDiv.innerHTML = "";
        }
      }
      contenido.querySelector("#fe_saldo_ini").addEventListener("input", actualizarCalculo);
      contenido.querySelector("#fe_saldo_fin").addEventListener("input", actualizarCalculo);
      actualizarCalculo();

      contenido.querySelector("#fe_desglose").innerHTML = renderDesgloseFlujo(datos, coincide, d);

      contenido.querySelector("#fe_guardar").addEventListener("click", async () => {
        const btn = contenido.querySelector("#fe_guardar");
        const msg = contenido.querySelector("#fe_msg");
        const saldoInicial = Number(contenido.querySelector("#fe_saldo_ini").value) || 0;
        const saldoFinalManual = Number(contenido.querySelector("#fe_saldo_fin").value) || 0;
        btn.disabled = true;
        btn.textContent = "Guardando…";
        try {
          await guardarConciliacionEfectivo(mesStr, saldoInicial, saldoFinalManual);
          datos = await IngresosGastosPeriodo.cargarDatosBase();
          mostrarMsgEF(msg, `Saldos de ${mesStr} guardados.`, false);
          await renderContenido();
        } catch (err) {
          mostrarMsgEF(msg, `No pude guardar: ${err.message}`, true);
          console.error(err);
          btn.disabled = false;
          btn.textContent = "💾 Guardar saldos de este mes";
        }
      });
    }

    selAnio.addEventListener("change", renderContenido);
    selMes.addEventListener("change", renderContenido);
    await renderContenido();
  }

  function mostrarMsgEF(el, texto, esError) {
    el.hidden = false;
    el.textContent = texto;
    el.style.background = esError ? "#f8d7da" : "#d1e7dd";
    el.style.color = esError ? "#842029" : "#0f5132";
  }

  function tablaCategoriasHTML(dict) {
    const entradas = Object.entries(dict).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    if (!entradas.length) return '<p class="caption">Nada este mes.</p>';
    return `<table class="tabla"><thead><tr><th>Categoría</th><th>Valor</th></tr></thead>
      <tbody>${entradas.map(([c, v]) => `<tr><td>${c}</td><td>${fmtMoneda(v)}</td></tr>`).join("")}</tbody></table>`;
  }

  function tablaMovimientosHTML(filas) {
    if (!filas.length) return '<p class="caption">Nada este mes.</p>';
    const ordenadas = [...filas].sort((a, b) => (parseFechaISO(a.fecha) || "").localeCompare(parseFechaISO(b.fecha) || ""));
    return `<table class="tabla"><thead><tr><th>Fecha</th><th>Comercio / Concepto</th><th>Categoría</th><th>Valor</th></tr></thead>
      <tbody>${ordenadas.map((f) => `<tr><td>${f.fecha ?? ""}</td><td>${f.comercio ?? ""}</td>
        <td>${f.categoria ?? ""}</td><td>${fmtMoneda(f.valor)}</td></tr>`).join("")}</tbody></table>`;
  }

  // Puerto de _render_desglose_flujo_efectivo() (app_presupuesto.py):
  // detalle línea por línea de las 4 categorías del flujo del mes.
  function renderDesgloseFlujo(datos, coincide, d) {
    const gastoOperativoSinInv = Object.fromEntries(Object.entries(d.gastoPorCategoria).filter(([k]) => k !== "Inversiones"));

    const descPorCategoria = {};
    for (const fila of datos.colillasDescuentos) {
      const [anio, mes] = extraerAnioMes(fila.Quincena);
      if (coincide(anio, mes)) descPorCategoria[fila.Categoria] = (descPorCategoria[fila.Categoria] || 0) + toNumber(fila.Valor);
    }

    const movInversion = [];
    for (const bloque of [datos.efectivoDetalle, datos.visaDetalle, datos.mcDetalle]) {
      for (const fila of bloque) {
        const [anio, mes] = extraerAnioMes(fila.FechaCompra);
        if (coincide(anio, mes) && fila.Categoria === "Inversiones") {
          movInversion.push({ fecha: fila.FechaCompra, comercio: fila.Comercio, categoria: fila.Categoria, valor: toNumber(fila.ValorCargado) });
        }
      }
    }

    const movFinanciacion = [];
    for (const fila of datos.efectivoDetalle) {
      const [anio, mes] = extraerAnioMes(fila.FechaCompra);
      if (coincide(anio, mes) && fila.Categoria === "Pago de deuda (no presupuestar)") {
        movFinanciacion.push({ fecha: fila.FechaCompra, comercio: fila.Comercio, categoria: fila.Categoria, valor: toNumber(fila.ValorCargado) });
      }
    }

    const entradasConciliacion = [];
    for (const fila of datos.otrosIngresos) {
      const [anio, mes] = extraerAnioMes(fila.Fecha);
      const notasLower = String(fila.Notas || "").toLowerCase();
      const dup = notasLower.includes("no duplicar") || notasLower.includes("ya contabilizad");
      if (coincide(anio, mes) && esNoPresupuestar(fila.Categoria) && !dup) {
        entradasConciliacion.push({ fecha: fila.Fecha, comercio: fila.Concepto, categoria: fila.Categoria, valor: toNumber(fila.Valor) });
      }
    }

    const salidasConciliacion = [];
    for (const fila of datos.efectivoDetalle) {
      const [anio, mes] = extraerAnioMes(fila.FechaCompra);
      const dup = String(fila.Notas || "").toLowerCase().includes("ya contabilizad");
      if (coincide(anio, mes) && fila.Categoria !== "Pago de deuda (no presupuestar)" && esNoPresupuestar(fila.Categoria) && !dup) {
        salidasConciliacion.push({ fecha: fila.FechaCompra, comercio: fila.Comercio, categoria: fila.Categoria, valor: toNumber(fila.ValorCargado) });
      }
    }

    return `
      <p class="caption"><strong>Operación</strong></p>
      <div class="col-3">
        <div><p class="caption">Ingresos por categoría</p>${tablaCategoriasHTML(d.ingresosPorCategoria)}</div>
        <div><p class="caption">Gasto operativo por categoría</p>${tablaCategoriasHTML(gastoOperativoSinInv)}</div>
        <div><p class="caption">Descuentos de nómina por categoría</p>${tablaCategoriasHTML(descPorCategoria)}</div>
      </div>

      <p class="caption"><strong>Inversión</strong> (aportes a plataformas de inversión)</p>
      ${tablaMovimientosHTML(movInversion)}

      <p class="caption"><strong>Financiación</strong> (cuotas de deuda pagadas automáticamente)</p>
      ${tablaMovimientosHTML(movFinanciacion)}

      <p class="caption"><strong>Conciliación</strong> (pago automático de tarjeta ya contado en Operación,
      intereses/4x1000, transferencias entre tus propias cuentas, traslados de/hacia fondos de inversión)</p>
      <div class="col-2">
        <div><p class="caption">Entradas de conciliación (Otros Ingresos)</p>${tablaMovimientosHTML(entradasConciliacion)}</div>
        <div><p class="caption">Salidas de conciliación (Egresos - Efectivo)</p>${tablaMovimientosHTML(salidasConciliacion)}</div>
      </div>
    `;
  }

  // Puerto de guardar_conciliacion_efectivo() (sheets_backend.py): busca la
  // fila existente por Mes (clave) y actualiza en el lugar, o la agrega al
  // final si es la primera vez que se guarda ese mes.
  async function firstBlankRowConciliacion() {
    const raw = await SheetsApi.batchGet(["conciliacion_efectivo"]);
    const filas = raw.conciliacion_efectivo || [];
    let ultimoUsado = 0;
    filas.forEach((r, i) => { if (r && r[0] !== undefined && r[0] !== null && r[0] !== "") ultimoUsado = i + 1; });
    return 66 + ultimoUsado;
  }

  async function guardarConciliacionEfectivo(mes, saldoInicial, saldoFinal) {
    const raw = await SheetsApi.batchGet(["conciliacion_efectivo"]);
    const filas = raw.conciliacion_efectivo || [];
    let filaExistente = null;
    for (let i = 0; i < filas.length; i++) {
      if (filas[i] && filas[i][0] === mes) { filaExistente = 66 + i; break; }
    }
    const fechaRegistro = new Date().toISOString().slice(0, 10);
    if (filaExistente) {
      await SheetsApi.updateRange(`'Balance Mensual'!B${filaExistente}:D${filaExistente}`, [[saldoInicial, saldoFinal, fechaRegistro]]);
    } else {
      const fila = await firstBlankRowConciliacion();
      await SheetsApi.updateRange(`'Balance Mensual'!A${fila}:D${fila}`, [[`'${mes}`, saldoInicial, saldoFinal, fechaRegistro]]);
    }
  }

  // ---------------------------------------------------------------------
  // Auditoría Anual
  // ---------------------------------------------------------------------
  async function renderAuditoriaAnual(panel) {
    panel.innerHTML = `
      <p class="caption">Para un año completo: ingresos y gastos discriminados por categoría, y si el saldo
      calculado a fin de año cuadra contra el saldo real que tenías el 31 de diciembre — para auditar un año
      contra tus extractos antes de confiar en el presupuesto hacia adelante.</p>
      <select id="aud_anio"></select>
      <div id="aud-contenido">Cargando…</div>
    `;
    const hoy = new Date();
    const selAnio = panel.querySelector("#aud_anio");
    for (let a = 2023; a <= 2032; a++) selAnio.add(new Option(a, a));
    selAnio.value = hoy.getFullYear();

    const datos = await IngresosGastosPeriodo.cargarDatosBase();

    async function renderContenido() {
      const contenido = panel.querySelector("#aud-contenido");
      const anioAud = Number(selAnio.value);
      contenido.innerHTML = "Cargando…";

      const mesDicAnterior = `${anioAud - 1}-12`;
      const mesDic = `${anioAud}-12`;
      const filaDicAnt = datos.conciliacion.find((f) => f.Mes === mesDicAnterior);
      const filaDic = datos.conciliacion.find((f) => f.Mes === mesDic);

      let saldoInicialReal, mesAnclaAud = null;
      if (filaDicAnt) {
        saldoInicialReal = toNumber(filaDicAnt.SaldoFinal);
      } else {
        const r = IngresosGastosPeriodo.saldoInicialEncadenado(datos, anioAud, 1);
        saldoInicialReal = r.saldo;
        mesAnclaAud = r.mesAncla;
      }
      const saldoFinalReal = filaDic ? toNumber(filaDic.SaldoFinal) : null;

      let avisos = "";
      if (saldoInicialReal === null) {
        avisos += `<div class="aviso">⚠️ No hay ningún saldo real guardado antes de ${mesDicAnterior} —
          cargalo en Flujo de Efectivo para poder auditar ${anioAud} contra tu extracto real. Mientras tanto
          se asume $0 como arranque.</div>`;
      } else if (!filaDicAnt) {
        avisos += `<p class="caption">Saldo de arranque de ${mesDicAnterior} calculado encadenando desde el
          último saldo real guardado (${mesAnclaAud}) más el flujo de los meses intermedios.</p>`;
      }
      if (saldoFinalReal === null) {
        avisos += `<div class="aviso">⚠️ Tampoco hay un saldo guardado para ${mesDic} — cargalo también para
          poder comparar el cierre de ${anioAud}.</div>`;
      }

      const coincideAnio = (anio2) => anio2 === anioAud;
      const d = IngresosGastosPeriodo.calcular(datos, coincideAnio);
      const fe = IngresosGastosPeriodo.calcularFlujoEfectivo(datos, coincideAnio);

      const ingresosCat = Object.entries(d.ingresosPorCategoria).sort((a, b) => b[1] - a[1]);
      const totalGastos = d.gasto_operativo + d.descuentosNomina;
      const gastoCatSinInv = Object.entries(d.gastoPorCategoria).filter(([k]) => k !== "Inversiones").sort((a, b) => b[1] - a[1]);
      const utilidadNeta = d.totalIngresos - totalGastos;

      const flujoOperacion = d.totalIngresos - d.gasto_operativo - d.descuentosNomina;
      const flujoInversion = -d.gasto_inversiones;
      const flujoFinanciacion = -fe.pagoDeuda;
      const flujoConciliacion = fe.flujoConciliacion;
      const saldoInicialCalc = saldoInicialReal !== null ? saldoInicialReal : 0;
      const saldoFinalCalculado = saldoInicialCalc + flujoOperacion + flujoInversion + flujoFinanciacion + flujoConciliacion;

      let comparacionHtml = "";
      if (saldoFinalReal !== null) {
        const diferencia = saldoFinalCalculado - saldoFinalReal;
        comparacionHtml = Math.abs(diferencia) > 100
          ? `<div class="aviso">⚠️ El saldo calculado no cuadra contra el saldo real de ${mesDic} — diferencia
             de ${fmtMoneda(diferencia)}. Mirá el detalle mes a mes de abajo para ubicar en qué mes se rompe
             la cadena.</div>`
          : `<div class="ok">✅ Cuadra contra el saldo real de ${mesDic} (${fmtMoneda(saldoFinalReal)}).</div>`;
      }

      contenido.innerHTML = `
        ${avisos}
        <h5>Ingresos del año, por categoría</h5>
        ${ingresosCat.length ? `<div class="tabla-scroll"><table class="tabla"><thead><tr><th>Categoría</th><th>Valor</th></tr></thead>
          <tbody>${ingresosCat.map(([c, v]) => `<tr><td>${c}</td><td>${fmtMoneda(v)}</td></tr>`).join("")}</tbody></table></div>`
          : `<p class="caption">No hay ingresos cargados para ${anioAud}.</p>`}
        <div class="metric-row">${metric(`Total Ingresos ${anioAud}`, fmtMoneda(d.totalIngresos))}</div>

        <h5>Gastos del año, por categoría</h5>
        ${gastoCatSinInv.length ? `<div class="tabla-scroll"><table class="tabla"><thead><tr><th>Categoría</th><th>Valor</th></tr></thead>
          <tbody>${gastoCatSinInv.map(([c, v]) => `<tr><td>${c}</td><td>${fmtMoneda(v)}</td></tr>`).join("")}</tbody></table></div>`
          : `<p class="caption">No hay gastos cargados para ${anioAud}.</p>`}
        <div class="metric-row">${metric(`Total Gastos ${anioAud}`, fmtMoneda(totalGastos))}</div>
        ${d.gastoSinCategorizar > 0 ? `<div class="aviso">⚠️ ${fmtMoneda(d.gastoSinCategorizar)} de ${anioAud}
          sigue en la categoría genérica 'Otros' — revisalo para que esta auditoría sea confiable.</div>` : ""}
        ${d.descuentos_sin_categorizar > 100 ? `<div class="aviso">⚠️ ${fmtMoneda(d.descuentos_sin_categorizar)}
          de los descuentos de nómina de ${anioAud} no tiene detalle categorizado en 'Colillas de Pago' — el
          total sí está bien, pero falta desglosarlo ítem por ítem.</div>` : ""}

        <h5>Utilidad Neta del año</h5>
        <div class="metric-row">${metric(`Utilidad Neta ${anioAud}`, fmtMoneda(utilidadNeta))}</div>

        <hr>
        <h5>Reconciliación de caja del año (cuenta de ahorros)</h5>
        <p class="caption">Mismas cuatro categorías que Flujo de Efectivo (Operación/Inversión/Financiación/
        Conciliación), acumuladas para el año completo — arrancando del saldo real de diciembre del año
        anterior.</p>
        <div class="metric-row">
          ${metric("Operación", fmtMoneda(flujoOperacion))}
          ${metric("Inversión", fmtMoneda(flujoInversion))}
          ${metric("Financiación", fmtMoneda(flujoFinanciacion))}
          ${metric("Conciliación", fmtMoneda(flujoConciliacion))}
        </div>
        <div class="metric-row">
          ${metric(`Saldo Inicial (${anioAud - 1}-12-31)`, fmtMoneda(saldoInicialCalc))}
          ${metric(`Saldo Final Calculado (${anioAud}-12-31)`, fmtMoneda(saldoFinalCalculado))}
        </div>
        ${comparacionHtml}

        <details>
          <summary>Ver detalle mes a mes</summary>
          <div class="tabla-scroll" style="max-height:440px;"><table class="tabla" id="aud_mes_tabla"></table></div>
          <p class="caption">El 'Saldo Final Calculado' es la cadena acumulada mes a mes desde el saldo real
          de diciembre anterior — no depende de si guardaste un saldo manual ese mes en particular. 'Saldo
          Final Real' solo aparece si guardaste una conciliación para ese mes específico en Flujo de
          Efectivo.</p>
        </details>
      `;

      const filasMes = [];
      let saldoCorrida = saldoInicialCalc;
      for (let m = 1; m <= 12; m++) {
        const coincideMes = (anio2, mes2) => anio2 === anioAud && mes2 === m;
        const dm = IngresosGastosPeriodo.calcular(datos, coincideMes);
        const fm = IngresosGastosPeriodo.calcularFlujoEfectivo(datos, coincideMes);
        const fo = dm.totalIngresos - dm.gasto_operativo - dm.descuentosNomina;
        const fi = -dm.gasto_inversiones;
        const ff = -fm.pagoDeuda;
        const fc = fm.flujoConciliacion;
        const saldoIniMes = saldoCorrida;
        const saldoFinMes = saldoIniMes + fo + fi + ff + fc;
        saldoCorrida = saldoFinMes;
        const mesStr = `${anioAud}-${String(m).padStart(2, "0")}`;
        const filaReal = datos.conciliacion.find((f) => f.Mes === mesStr);
        const saldoRealMes = filaReal ? toNumber(filaReal.SaldoFinal) : null;
        const diffMes = saldoRealMes !== null ? saldoFinMes - saldoRealMes : null;
        filasMes.push({
          mes: mesStr, ingresos: dm.totalIngresos, gastos: dm.gasto_operativo + dm.descuentosNomina,
          saldoCalc: saldoFinMes, saldoReal: saldoRealMes, diff: diffMes,
        });
      }
      contenido.querySelector("#aud_mes_tabla").innerHTML = `
        <thead><tr><th>Mes</th><th>Ingresos</th><th>Gastos</th><th>Saldo Final Calculado</th>
          <th>Saldo Final Real</th><th>Diferencia</th></tr></thead>
        <tbody>${filasMes.map((f) => `<tr><td>${f.mes}</td><td>${fmtMoneda(f.ingresos)}</td>
          <td>${fmtMoneda(f.gastos)}</td><td>${fmtMoneda(f.saldoCalc)}</td>
          <td>${f.saldoReal !== null ? fmtMoneda(f.saldoReal) : "-"}</td>
          <td>${f.diff !== null ? fmtMoneda(f.diff) : "-"}</td></tr>`).join("")}</tbody>
      `;
    }

    selAnio.addEventListener("change", renderContenido);
    await renderContenido();
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
