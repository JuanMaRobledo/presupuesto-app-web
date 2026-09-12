// Puerto parcial de render_resumen() (app_presupuesto.py). Portado por ahora:
// las tarjetas de 💰 Ingresos, 🏦 Deudas y 📈 Inversiones (estado actual),
// con el mismo selector "Ver resumen de: Total histórico / Un año / Un mes"
// que la versión de Streamlit — los números deberían coincidir exactamente.
//
// TODAVÍA NO portado (ver README → Estado de la migración): 💳 Gastos,
// ⚖️ Balance y la tasa de ahorro, porque _ingresos_gastos_periodo() del lado
// de Python cruza gasto real por categoría contra los aportes a cada
// plataforma de inversión (para separar qué "Inversiones" es de verdad
// ahorro y qué son retiros que volvieron a ser gasto) — es la parte más
// intrincada de toda la app y se está portando aparte, con cuidado, para no
// mostrar un número mal calculado.

const PaginaResumen = (() => {
  let datosCache = null;

  async function cargarDatos() {
    if (datosCache) return datosCache;
    const raw = await SheetsApi.batchGet(["colillas_resumen", "otros_ingresos", "deudas", "resumen_kpis"]);

    const colillas = filasAObjetos(raw.colillas_resumen, ["FechaPago", "Periodo", "DevengosTotales", "DescuentosTotales"]);
    const otrosIngresos = filasAObjetos(raw.otros_ingresos, ["Fecha", "Concepto", "Categoria", "Valor", "Notas"]);
    const deudas = filasAObjetos(raw.deudas, [
      "Entidad", "TipoCredito", "SaldoActual", "TasaEA", "CuotaMensual", "PctPagado", "MesesRestantes", "FechaEstPago",
    ]);
    const kpis = {};
    (raw.resumen_kpis || []).forEach((row) => {
      if (row && row[0]) kpis[row[0]] = toNumber(row.length >= 4 ? row[3] : row[row.length - 1]);
    });

    datosCache = { colillas, otrosIngresos, deudas, kpis };
    return datosCache;
  }

  function calcularIngresos(datos, coincide) {
    let ingresosColillas = 0;
    for (const fila of datos.colillas) {
      const [anio, mes] = extraerAnioMes(fila.Periodo);
      if (coincide(anio, mes)) ingresosColillas += toNumber(fila.DevengosTotales);
    }
    let otrosIngresos = 0;
    for (const fila of datos.otrosIngresos) {
      const [anio, mes] = extraerAnioMes(fila.Fecha);
      const presupuestar = !esNoPresupuestar(fila.Categoria);
      if (coincide(anio, mes) && presupuestar) otrosIngresos += toNumber(fila.Valor);
    }
    return { ingresosColillas, otrosIngresos, totalIngresos: ingresosColillas + otrosIngresos };
  }

  function render(container) {
    container.innerHTML = `
      <h1>🏠 Resumen</h1>
      <p class="caption">Vista general — este primer corte trae Ingresos, Deudas e Inversiones. Gastos y
      Balance todavía no están portados acá (sí en la versión de Streamlit); ver el aviso al final.</p>

      <div class="campo">
        <label>Ver resumen de:</label>
        <div class="radio-row" id="alcance-radios">
          <label><input type="radio" name="alcance" value="total" checked> Total histórico</label>
          <label><input type="radio" name="alcance" value="anio"> Un año</label>
          <label><input type="radio" name="alcance" value="mes"> Un mes</label>
        </div>
        <div id="selectores-periodo" class="row" style="display:none;">
          <select id="sel-anio"></select>
          <select id="sel-mes" style="display:none;"></select>
        </div>
      </div>

      <div id="resumen-contenido">Cargando datos del Sheet…</div>
    `;

    const hoy = new Date();
    const anios = [];
    for (let a = 2023; a <= 2032; a++) anios.push(a);
    const selAnio = container.querySelector("#sel-anio");
    const selMes = container.querySelector("#sel-mes");
    anios.forEach((a) => selAnio.add(new Option(a, a)));
    selAnio.value = anios.includes(hoy.getFullYear()) ? hoy.getFullYear() : anios[0];
    for (let m = 1; m <= 12; m++) selMes.add(new Option(MESES_NOMBRE[m], m));
    selMes.value = hoy.getMonth() + 1;

    const radios = container.querySelectorAll('input[name="alcance"]');
    const selectoresDiv = container.querySelector("#selectores-periodo");

    function alcanceActual() {
      return [...radios].find((r) => r.checked).value;
    }

    function actualizar() {
      const alcance = alcanceActual();
      selectoresDiv.style.display = alcance === "total" ? "none" : "flex";
      selMes.style.display = alcance === "mes" ? "inline-block" : "none";
      renderContenido();
    }

    radios.forEach((r) => r.addEventListener("change", actualizar));
    selAnio.addEventListener("change", renderContenido);
    selMes.addEventListener("change", renderContenido);

    async function renderContenido() {
      const contenido = container.querySelector("#resumen-contenido");
      try {
        const datos = await cargarDatos();
        const alcance = alcanceActual();
        const anioSel = parseInt(selAnio.value, 10);
        const mesSel = parseInt(selMes.value, 10);
        const coincide = (anio, mes) => {
          if (alcance === "total") return true;
          if (anio === null) return false;
          if (alcance === "anio") return anio === anioSel;
          return anio === anioSel && mes === mesSel;
        };

        const { ingresosColillas, otrosIngresos, totalIngresos } = calcularIngresos(datos, coincide);
        const saldoDeudas = datos.deudas.reduce((s, f) => s + toNumber(f.SaldoActual), 0);
        const cuotaDeudas = datos.deudas.reduce((s, f) => s + toNumber(f.CuotaMensual), 0);
        const portafolioPesos = datos.kpis["Valor actual del portafolio de inversiones en pesos"] || 0;
        const portafolioDolares = datos.kpis["Valor actual del portafolio de inversiones en dólares"] || 0;

        contenido.innerHTML = `
          <h4>💰 Ingresos</h4>
          <div class="metric-row">
            ${metric("Colillas de pago", fmtMoneda(ingresosColillas))}
            ${metric("Otros ingresos", fmtMoneda(otrosIngresos))}
            ${metric("Total ingresos brutos", fmtMoneda(totalIngresos))}
          </div>

          <h4>🏦 Deudas</h4>
          <p class="caption">Estado actual — no cambia según el selector de arriba.</p>
          <div class="metric-row">
            ${metric("Saldo total pendiente", fmtMoneda(saldoDeudas))}
            ${metric("Cuota mensual total", fmtMoneda(cuotaDeudas))}
          </div>

          <h4>📈 Inversiones</h4>
          <p class="caption">Estado actual — tampoco cambia según el selector de arriba.</p>
          <div class="metric-row">
            ${metric("Portafolio en pesos", fmtMoneda(portafolioPesos))}
            ${metric("Portafolio en dólares", "US$ " + portafolioDolares.toLocaleString("en-US", { minimumFractionDigits: 2 }))}
          </div>

          <div class="aviso">
            ⚠️ 💳 Gastos, ⚖️ Balance y la tasa de ahorro todavía no están portados a esta versión web —
            usá <a href="https://presupuesto-app-jmr.streamlit.app" target="_blank" rel="noopener">la versión de Streamlit</a>
            para eso mientras tanto.
          </div>
        `;
      } catch (err) {
        contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
        console.error(err);
      }
    }

    renderContenido();
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
