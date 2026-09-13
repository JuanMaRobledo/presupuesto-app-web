// Puerto de render_deudas() (app_presupuesto.py): tarjetas de saldo total/
// cuota mensual, deuda USD aparte, gráfico de participación por entidad,
// tabla y gráfico de cuota mensual por entidad, MÁS el formulario "✏️
// Actualizar deudas manualmente" (4 tabs, uno por crédito con cuota fija —
// ninguno tiene extracto automático, se actualizan a mano con cada estado
// de cuenta nuevo).

const PaginaDeudas = (() => {
  const DEUDA_COLS = [
    "Entidad", "TipoCredito", "SaldoActual", "TasaEA", "CuotaMensual", "PctPagado", "MesesRestantes", "FechaEstPago",
  ];

  // Puerto de _FILAS_DEUDA_ENTIDAD / _CAMPOS_FECHA_DEUDA_ENTIDAD
  // (sheets_backend.py) — cada hoja 'Deuda - <entidad>' guarda sus campos
  // a mano en la columna B, uno por fila fija (sin bloque de encabezado).
  const FILAS_DEUDA_ENTIDAD = {
    numero_obligacion: 6, fecha_desembolso: 7, monto_inicial: 8, saldo_actual: 9,
    fecha_saldo: 10, tasa_ea: 11, cuota_mensual: 13, plazo_meses: 14,
    numero_cuota_actual: 15, proxima_fecha_pago: 16, nota: 17,
  };
  const CAMPOS_FECHA_DEUDA_ENTIDAD = ["fecha_desembolso", "fecha_saldo", "proxima_fecha_pago"];
  const ENTIDADES_DEUDA = [
    { sheet: "Deuda - Bancolombia", rango: "deuda_bancolombia", titulo: "Bancolombia (Crédito Educativo)", key: "bancolombia" },
    { sheet: "Deuda - Sufi", rango: "deuda_sufi", titulo: "Sufi (Crédito de Consumo)", key: "sufi" },
    { sheet: "Deuda - Scotiabank Colpatria", rango: "deuda_scotiabank", titulo: "Scotiabank Colpatria (Leasing Habitacional)", key: "scotiabank" },
    { sheet: "Deuda - Fondo de Empleados", rango: "deuda_fondo_empleados", titulo: "Fondo de Empleados", key: "fondo_empleados" },
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
      <div id="deudas-formularios"></div>
    `;
    await renderContenido(container, "bancolombia");
  }

  async function renderContenido(container, tabActivo) {
    const contenido = container.querySelector("#deudas-contenido");
    try {
      const { deudas, deudaUsd } = await cargarDatos();

      if (!deudas.length) {
        contenido.innerHTML = "<p>Todavía no hay deudas cargadas.</p>";
      } else {
        const saldoTotal = deudas.reduce((s, f) => s + toNumber(f.SaldoActual), 0);
        const cuotaTotal = deudas.reduce((s, f) => s + toNumber(f.CuotaMensual), 0);

        contenido.innerHTML = `
          <div class="metric-row">
            ${metric("Saldo total pendiente (pesos)", fmtMoneda(saldoTotal))}
            ${metric("Cuota mensual total", fmtMoneda(cuotaTotal))}
          </div>
          ${deudaUsd && deudaUsd[0] ? `
            <div class="metric-row">
              ${metric(`${deudaUsd[0]} — deuda en dólares (aparte)`, fmtUsd(toNumber(deudaUsd[2])))}
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
      }
    } catch (err) {
      contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
      console.error(err);
    }

    await renderFormularios(container, tabActivo);
  }

  // ---------------------------------------------------------------------
  // ✏️ Actualizar deudas manualmente
  // ---------------------------------------------------------------------
  async function leerDeudaEntidad(rangoNombre) {
    const raw = await SheetsApi.batchGet([rangoNombre]);
    const filas = raw[rangoNombre] || [];
    const datos = {};
    for (const [campo, fila] of Object.entries(FILAS_DEUDA_ENTIDAD)) {
      const celda = filas[fila - 6];
      let v = celda && celda.length ? celda[0] : null;
      if (CAMPOS_FECHA_DEUDA_ENTIDAD.includes(campo) && typeof v === "number") v = serialToISO(v);
      datos[campo] = v;
    }
    return datos;
  }

  async function renderFormularios(container, tabActivo) {
    const formsDiv = container.querySelector("#deudas-formularios");
    formsDiv.innerHTML = `
      <hr>
      <h4>✏️ Actualizar deudas manualmente</h4>
      <p class="caption">Ninguna de las 4 deudas con cuota fija tiene extracto automático en la app — actualizá
      Saldo Actual, Tasa E.A. y Cuota Mensual cada vez que te llegue un extracto nuevo. Los campos numéricos en
      0 y el N° de Obligación vacío no se guardan (para no pisar lo que ya había con un cero).</p>
      <div class="tabs" id="tabs-deudas">
        ${ENTIDADES_DEUDA.map((e) => `<button class="tab-btn${e.key === tabActivo ? " activo" : ""}" data-tab="${e.key}">${e.titulo}</button>`).join("")}
      </div>
      <div id="panel-deudas">Cargando…</div>
    `;
    const tabsDiv = formsDiv.querySelector("#tabs-deudas");
    const panel = formsDiv.querySelector("#panel-deudas");

    tabsDiv.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        tabsDiv.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("activo", b === btn));
        renderFormEntidad(panel, btn.dataset.tab, container);
      });
    });

    await renderFormEntidad(panel, tabActivo, container);
  }

  async function renderFormEntidad(panel, key, container) {
    const entidad = ENTIDADES_DEUDA.find((e) => e.key === key);
    panel.innerHTML = "Cargando…";
    try {
      const datos = await leerDeudaEntidad(entidad.rango);
      if (datos.saldo_actual === null) {
        panel.innerHTML = `<div class="aviso">Todavía no hay datos guardados para '${entidad.titulo}'.</div>`;
      } else {
        panel.innerHTML = "";
      }
      const formWrap = document.createElement("div");
      formWrap.innerHTML = `
        <form id="form_deuda_${key}">
          <h5>Lo esencial — esto es lo que hace que aparezca en la tabla de arriba</h5>
          <div class="row">
            <div><label>Saldo Actual</label><br>
              <input type="number" id="deuda_saldo_${key}" min="0" step="any" value="${toNumber(datos.saldo_actual)}"></div>
            <div><label>Tasa E.A. (%)</label><br>
              <input type="number" id="deuda_tasa_${key}" min="0" step="any" value="${(toNumber(datos.tasa_ea) * 100).toFixed(2)}"></div>
            <div><label>Cuota Mensual</label><br>
              <input type="number" id="deuda_cuota_${key}" min="0" step="any" value="${toNumber(datos.cuota_mensual)}"></div>
          </div>
          <details>
            <summary>Datos adicionales (opcional, para el pronóstico de pagos completo)</summary>
            <div class="row">
              <div><label>Plazo (meses)</label><br><input type="number" id="deuda_plazo_${key}" step="any" value="${toNumber(datos.plazo_meses)}"></div>
              <div><label>N° Cuota Actual</label><br><input type="number" id="deuda_ncuota_${key}" step="any" value="${toNumber(datos.numero_cuota_actual)}"></div>
              <div><label>N° Obligación</label><br><input type="text" id="deuda_nobl_${key}" class="input-texto" value="${datos.numero_obligacion ?? ""}"></div>
            </div>
            <div class="row">
              <div><label>Fecha del Saldo</label><br><input type="date" id="deuda_fsaldo_${key}" value="${datos.fecha_saldo || ""}"></div>
              <div><label>Próxima Fecha de Pago</label><br><input type="date" id="deuda_fprox_${key}" value="${datos.proxima_fecha_pago || ""}"></div>
              <div><label>Fecha Desembolso</label><br><input type="date" id="deuda_fdes_${key}" value="${datos.fecha_desembolso || ""}"></div>
            </div>
            <div class="campo"><label>Monto Inicial</label><br><input type="number" id="deuda_minicial_${key}" min="0" step="any" value="${toNumber(datos.monto_inicial)}"></div>
            <div class="campo"><label>Nota</label><br><input type="text" id="deuda_nota_${key}" class="input-texto" value="${datos.nota ?? ""}"></div>
          </details>
          <button type="submit" id="deuda_guardar_${key}">💾 Guardar</button>
        </form>
        <div class="aviso" id="deuda_msg_${key}" hidden></div>
      `;
      panel.appendChild(formWrap);

      panel.querySelector(`#form_deuda_${key}`).addEventListener("submit", (ev) => onGuardarDeuda(ev, panel, entidad, container));
    } catch (err) {
      panel.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
      console.error(err);
    }
  }

  async function onGuardarDeuda(ev, panel, entidad, container) {
    ev.preventDefault();
    const key = entidad.key;
    const g = (id) => panel.querySelector(id).value;
    const msg = panel.querySelector(`#deuda_msg_${key}`);
    const btn = panel.querySelector(`#deuda_guardar_${key}`);

    // Puerto de _form_actualizar_deuda() (app_presupuesto.py): las 3 fechas
    // y la nota siempre se guardan; los campos numéricos y N° Obligación
    // solo si tienen un valor (para no pisar lo que ya había con un cero).
    const valores = {
      fecha_saldo: g(`#deuda_fsaldo_${key}`) || null,
      proxima_fecha_pago: g(`#deuda_fprox_${key}`) || null,
      fecha_desembolso: g(`#deuda_fdes_${key}`) || null,
      nota: g(`#deuda_nota_${key}`).trim(),
    };
    const saldoActual = Number(g(`#deuda_saldo_${key}`)) || 0;
    const tasaEa = Number(g(`#deuda_tasa_${key}`)) || 0;
    const cuotaMensual = Number(g(`#deuda_cuota_${key}`)) || 0;
    const plazoMeses = Number(g(`#deuda_plazo_${key}`)) || 0;
    const numeroCuotaActual = Number(g(`#deuda_ncuota_${key}`)) || 0;
    const montoInicial = Number(g(`#deuda_minicial_${key}`)) || 0;
    const numeroObligacion = g(`#deuda_nobl_${key}`).trim();
    if (saldoActual) valores.saldo_actual = saldoActual;
    if (tasaEa) valores.tasa_ea = tasaEa / 100;
    if (cuotaMensual) valores.cuota_mensual = cuotaMensual;
    if (plazoMeses) valores.plazo_meses = plazoMeses;
    if (numeroCuotaActual) valores.numero_cuota_actual = numeroCuotaActual;
    if (montoInicial) valores.monto_inicial = montoInicial;
    if (numeroObligacion) valores.numero_obligacion = numeroObligacion;

    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      const updates = [];
      for (const [campo, valor] of Object.entries(valores)) {
        if (valor === null) continue;
        const fila = FILAS_DEUDA_ENTIDAD[campo];
        const valorFinal = CAMPOS_FECHA_DEUDA_ENTIDAD.includes(campo) ? dateToSerial(valor) : valor;
        updates.push({ range: `'${entidad.sheet}'!B${fila}`, values: [[valorFinal]] });
      }
      if (updates.length) await SheetsApi.batchUpdateRanges(updates, "RAW");
      mostrarMsg(msg, `Datos de '${entidad.titulo}' guardados.`, false);
      await renderContenido(container, entidad.key);
    } catch (err) {
      mostrarMsg(msg, `No pude guardar: ${err.message}`, true);
      console.error(err);
      btn.disabled = false;
      btn.textContent = "💾 Guardar";
    }
  }

  function mostrarMsg(el, texto, esError) {
    el.hidden = false;
    el.textContent = texto;
    el.style.background = esError ? "#f8d7da" : "#d1e7dd";
    el.style.color = esError ? "#842029" : "#0f5132";
  }

  const PALETA = ["#d64545", "#4573d6", "#45a06a", "#d69a45", "#8a56c9", "#45b8c9", "#c9457e", "#a3a3a3"];

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
