// Puerto de render_resumen() (app_presupuesto.py) — la parte de cálculo
// (_ingresos_gastos_periodo, categorización de gasto + cruce de
// Inversiones contra plataforma) vive en js/ingresos-gastos.js, compartida
// con 🏢 Estados Financieros → Estado de Resultados.
//
// TODAVÍA NO portado: el gráfico de "Tendencia de los últimos meses" al pie
// de Resumen (usa Resumen Mensual, vista efectivo real — página aparte).

const PaginaResumen = (() => {
  let datosCache = null;

  async function cargarDatos() {
    if (datosCache) return datosCache;
    datosCache = await IngresosGastosPeriodo.cargarDatosBase();
    return datosCache;
  }

  function render(container) {
    container.innerHTML = `
      <h1>🏠 Resumen</h1>
      <p class="caption">Vista general: cuánto entra, cuánto sale, qué balance queda, cuánta deuda tenés
      pendiente y cuánto llevás aportado a inversiones.</p>

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

        const d = IngresosGastosPeriodo.calcular(datos, coincide);
        const saldoDeudas = datos.deudas.reduce((s, f) => s + toNumber(f.SaldoActual), 0);
        const cuotaDeudas = datos.deudas.reduce((s, f) => s + toNumber(f.CuotaMensual), 0);
        const portafolioPesos = datos.kpis["Valor actual del portafolio de inversiones en pesos"] || 0;
        const portafolioDolares = datos.kpis["Valor actual del portafolio de inversiones en dólares"] || 0;

        const totalEgresos = d.gastoReal + d.descuentosNomina;
        const balance = d.totalIngresos - totalEgresos;
        const ahorroNomina = d.descuento_ahorro + d.descuento_fondo_empleados;
        const ahorroTotal = d.gasto_inversiones + d.gasto_ahorro + ahorroNomina;
        const totalAhorrado = balance + ahorroTotal;
        const tasaAhorro = d.totalIngresos ? (totalAhorrado / d.totalIngresos * 100) : 0;

        contenido.innerHTML = `
          <h4>💰 Ingresos</h4>
          <div class="metric-row">
            ${metric("Colillas de pago", fmtMoneda(d.ingresosColillas))}
            ${metric("Otros ingresos", fmtMoneda(d.otrosIngresos))}
            ${metric("Total ingresos brutos", fmtMoneda(d.totalIngresos))}
          </div>

          <h4>💳 Gastos</h4>
          <div class="metric-row">
            ${metric("Gasto real (efectivo+tarjetas)", fmtMoneda(d.gastoReal))}
            ${metric("Descuentos de nómina", fmtMoneda(d.descuentosNomina))}
            ${metric("Seguros vía nómina", fmtMoneda(d.seguros_nomina))}
          </div>
          ${d.gastoSinCategorizar > 0 ? `
            <div class="aviso">⚠️ ${fmtMoneda(d.gastoSinCategorizar)}
            (${(d.gastoReal ? d.gastoSinCategorizar / d.gastoReal * 100 : 0).toFixed(0)}% del gasto real de
            este alcance) está en la categoría genérica 'Otros'.</div>` : ""}

          <h4>⚖️ Balance</h4>
          <p class="caption">Ingresos brutos menos gasto real y descuentos de nómina (vista devengado).</p>
          <div class="metric-row">
            ${metric("Total ingresos", fmtMoneda(d.totalIngresos))}
            ${metric("Total egresos", fmtMoneda(totalEgresos))}
          </div>
          <div class="metric-row">
            ${metric("Balance (efectivo)", fmtMoneda(balance))}
            ${metric("Tasa de ahorro (efectivo + ahorro + inversión)", tasaAhorro.toFixed(0) + "%")}
          </div>

          ${ahorroTotal > 0 ? `
            <h6>No es gasto de consumo — discriminado por origen</h6>
            <div class="metric-row">
              ${metric("Inversiones", fmtMoneda(d.gasto_inversiones))}
              ${metric("Ahorro (efectivo/tarjeta)", fmtMoneda(d.gasto_ahorro))}
              ${metric("Ahorro vía nómina", fmtMoneda(ahorroNomina))}
            </div>
            ${IngresosGastosPeriodo.renderDesgloseInversiones(d)}
          ` : ""}

          ${d.descuento_deuda_nomina > 0 ? `
            <p class="caption">Aparte, ${fmtMoneda(d.descuento_deuda_nomina)} de este alcance se fue a cuotas
            de deuda descontadas directo de la nómina (leasing habitacional / préstamo del Fondo de
            Empleados) — tampoco es consumo, pero no se suma a la tasa de ahorro.</p>` : ""}

          ${d.ingreso_cesantias > 0 ? `
            <p class="caption">De los ingresos, ${fmtMoneda(d.ingreso_cesantias)} son de la categoría
            Cesantías (intereses o retiro del fondo) — ya están incluidos en 'Total ingresos'.</p>` : ""}

          ${totalAhorrado >= 0
            ? `<div class="ok">✅ Con este alcance, no gastaste ${fmtMoneda(totalAhorrado)} (efectivo +
               ahorro + inversión) — una tasa de ahorro de ${tasaAhorro.toFixed(0)}%
               (${tasaAhorro >= 20 ? "saludable: 20% o más" : "referencia: 20% o más se considera saludable"}).</div>`
            : `<div class="aviso">⚠️ Con este alcance, el gasto superó el ingreso por
               ${fmtMoneda(Math.abs(totalAhorrado))} incluso contando lo aportado a ahorro e inversión
               (tasa de ahorro de ${tasaAhorro.toFixed(0)}%).</div>`}

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

          <div class="aviso">⚠️ El gráfico de "Tendencia de los últimos meses" todavía no está portado —
          usá <a href="https://presupuesto-app-jmr.streamlit.app" target="_blank" rel="noopener">la versión
          de Streamlit</a> para eso mientras tanto.</div>
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
