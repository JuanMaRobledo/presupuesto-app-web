// Puerto (parcial, solo lectura) de render_estados_financieros()
// (app_presupuesto.py): Estado de Resultados y Balance General.
//
// TODAVÍA NO portado: Flujo de Efectivo y Auditoría Anual (necesitan la
// lógica de deduplicación por Notas de _flujo_efectivo_periodo(), que
// separa Financiación/Conciliación del resto de "(no presupuestar)").

const PaginaEstadosFinancieros = (() => {
  function render(container) {
    container.innerHTML = `
      <h1>🏢 Estados Financieros</h1>
      <p class="caption">Tus finanzas vistas como las de una empresa.</p>
      <div class="tabs" id="tabs-ef">
        <button class="tab-btn activo" data-tab="resultados">Estado de Resultados</button>
        <button class="tab-btn" data-tab="balance">Balance General</button>
      </div>
      <div id="panel-ef">Cargando datos del Sheet…</div>
      <div class="aviso">⚠️ Todavía no portados: Flujo de Efectivo y Auditoría Anual — usá
      <a href="https://presupuesto-app-jmr.streamlit.app" target="_blank" rel="noopener">la versión de
      Streamlit</a> para eso mientras tanto.</div>
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
        else await renderBalanceGeneral(panel);
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
        sumado): US$ ${valorPortafolioDolares.toLocaleString("en-US", { minimumFractionDigits: 2 })}</p>` : ""}
      ${(valorPortafolioPesos === 0 && valorPortafolioDolares === 0) ? `<p class="caption">El portafolio de
        inversiones da $0 porque todavía no cargaste posiciones en 📈 Inversiones.</p>` : ""}

      <h5>Pasivos</h5>
      <div class="metric-row">
        ${metric("Saldo total de deudas (pesos)", fmtMoneda(totalPasivos))}
        ${metric("Cuota mensual total", fmtMoneda(cuotaMensualTotal))}
      </div>
      ${deudaUsd && deudaUsd[0] ? `<p class="caption">${deudaUsd[0]} — deuda en dólares (aparte, no sumada):
        US$ ${toNumber(deudaUsd[2]).toLocaleString("en-US", { minimumFractionDigits: 2 })}. ${deudaUsd[1] || ""}</p>` : ""}

      <h5>Patrimonio Neto</h5>
      <div class="metric-row">${metric("Activos − Pasivos (pesos)", fmtMoneda(patrimonioNeto))}</div>
    `;
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
