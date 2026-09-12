// Puerto (parcial, solo lectura) de render_deudas() (app_presupuesto.py):
// tarjetas de saldo total/cuota mensual, deuda USD aparte, gráfico de
// participación por entidad, tabla y gráfico de cuota mensual por entidad.
//
// TODAVÍA NO portado: el formulario "✏️ Actualizar deudas manualmente" al
// pie (4 tabs, uno por crédito con cuota fija) — es una operación de
// escritura, fuera de alcance de esta primera versión de solo lectura.

const PaginaDeudas = (() => {
  const DEUDA_COLS = [
    "Entidad", "TipoCredito", "SaldoActual", "TasaEA", "CuotaMensual", "PctPagado", "MesesRestantes", "FechaEstPago",
  ];
  let chartPie = null;
  let chartCuotas = null;

  async function cargarDatos() {
    const raw = await SheetsApi.batchGet(["deudas", "deuda_tarjeta_usd"]);
    return {
      deudas: filasAObjetos(raw.deudas, DEUDA_COLS, ["FechaEstPago"]),
      deudaUsd: (raw.deuda_tarjeta_usd || [])[0] || null,
    };
  }

  function fmtCampo(v, formatter) {
    if (v === null || v === undefined || v === "") return "-";
    return formatter(toNumber(v));
  }

  async function render(container) {
    container.innerHTML = `
      <h1>🏦 Deudas y créditos</h1>
      <p class="caption">Los créditos con cuota fija más el saldo a pagar de Visa y Mastercard en pesos — las
      tarjetas no tienen tasa/cuota/plazo fijo, así que esas columnas quedan vacías para ellas. Es un estado de
      hoy, no cambia con ningún selector de mes.</p>
      <div id="deudas-contenido">Cargando datos del Sheet…</div>
    `;
    const contenido = container.querySelector("#deudas-contenido");
    try {
      const { deudas, deudaUsd } = await cargarDatos();
      if (!deudas.length) {
        contenido.innerHTML = "<p>Todavía no hay deudas cargadas.</p>";
        return;
      }

      const saldoTotal = deudas.reduce((s, f) => s + toNumber(f.SaldoActual), 0);
      const cuotaTotal = deudas.reduce((s, f) => s + toNumber(f.CuotaMensual), 0);

      contenido.innerHTML = `
        <div class="metric-row">
          ${metric("Saldo total pendiente (pesos)", fmtMoneda(saldoTotal))}
          ${metric("Cuota mensual total", fmtMoneda(cuotaTotal))}
        </div>
        ${deudaUsd && deudaUsd[0] ? `
          <div class="metric-row">
            ${metric(`${deudaUsd[0]} — deuda en dólares (aparte)`, "US$ " + toNumber(deudaUsd[2]).toLocaleString("en-US", { minimumFractionDigits: 2 }))}
          </div>
          <p class="caption">${deudaUsd[1] || ""}</p>
        ` : ""}

        <canvas id="chart_deudas_pie" height="140"></canvas>

        <div class="tabla-scroll">
          <table class="tabla">
            <thead><tr><th>Entidad</th><th>Tipo de Crédito</th><th>Saldo Actual</th><th>Tasa E.A.</th>
              <th>Cuota Mensual</th><th>% Pagado</th><th>Meses Restantes Est.</th><th>Fecha Est. de Pago Total</th></tr></thead>
            <tbody>${deudas.map((f) => `<tr>
              <td>${f.Entidad ?? ""}</td>
              <td>${f.TipoCredito ?? ""}</td>
              <td>${fmtCampo(f.SaldoActual, fmtMoneda)}</td>
              <td>${fmtCampo(f.TasaEA, (v) => (v * 100).toFixed(2) + "%")}</td>
              <td>${fmtCampo(f.CuotaMensual, fmtMoneda)}</td>
              <td>${fmtCampo(f.PctPagado, (v) => (v * 100).toFixed(1) + "%")}</td>
              <td>${fmtCampo(f.MesesRestantes, (v) => v.toFixed(0))}</td>
              <td>${f.FechaEstPago || "-"}</td>
            </tr>`).join("")}</tbody>
          </table>
        </div>

        <h5>Cuota mensual por entidad</h5>
        <canvas id="chart_deudas_cuotas" height="100"></canvas>
      `;

      if (chartPie) chartPie.destroy();
      if (chartCuotas) chartCuotas.destroy();

      const conSaldo = deudas.filter((f) => toNumber(f.SaldoActual) > 0);
      if (conSaldo.length) {
        const ctx = contenido.querySelector("#chart_deudas_pie").getContext("2d");
        chartPie = new Chart(ctx, {
          type: "doughnut",
          data: {
            labels: conSaldo.map((f) => f.Entidad),
            datasets: [{ data: conSaldo.map((f) => toNumber(f.SaldoActual)), backgroundColor: PALETA }],
          },
          options: { responsive: true },
        });
      }

      const conCuota = deudas.filter((f) => f.CuotaMensual !== null && f.CuotaMensual !== "" && toNumber(f.CuotaMensual) > 0)
        .sort((a, b) => toNumber(b.CuotaMensual) - toNumber(a.CuotaMensual));
      if (conCuota.length) {
        const ctx2 = contenido.querySelector("#chart_deudas_cuotas").getContext("2d");
        chartCuotas = new Chart(ctx2, {
          type: "bar",
          data: {
            labels: conCuota.map((f) => f.Entidad),
            datasets: [{ label: "Cuota Mensual", data: conCuota.map((f) => toNumber(f.CuotaMensual)), backgroundColor: "#d64545" }],
          },
          options: { responsive: true, plugins: { legend: { display: false } },
            scales: { y: { ticks: { callback: (v) => fmtMoneda(v) } } } },
        });
      }
    } catch (err) {
      contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
      console.error(err);
    }
  }

  const PALETA = ["#d64545", "#4573d6", "#45a06a", "#d69a45", "#8a56c9", "#45b8c9", "#c9457e", "#a3a3a3"];

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
