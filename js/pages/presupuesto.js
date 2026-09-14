// Puerto de render_presupuesto() (app_presupuesto.py) — la hoja
// 'Presupuesto' funciona distinto a las demás: la celda B5 es un selector
// de mes que las fórmulas de la hoja usan para calcular "Gasto Real" de
// cada categoría, así que hay que ESCRIBIR el mes ahí antes de poder LEER
// el gasto real de ese mes (mismo protocolo que set_presupuesto_mes() +
// read_presupuesto() en Python). Por eso esta página no puede ser de solo
// lectura como las demás. Incluye "💡 Sugerir metas" (puerto de
// _gasto_real_categoria_mes()/_descuentos_categoria_mes()): promedio de
// gasto real de los últimos 3 meses con datos, por categoría.

const PaginaPresupuesto = (() => {
  let mesAplicado = null;
  let chart = null;

  function filaN(vals, n) {
    const row = (n - 5 >= 0 && n - 5 < vals.length) ? (vals[n - 5] || []) : [];
    return [0, 1, 2, 3, 4].map((i) => (row[i] !== undefined ? row[i] : null));
  }

  function parsePresupuesto(vals) {
    const mesActual = filaN(vals, 5)[1] || "";
    const categorias = [];
    for (let n = 8; n <= 25; n++) {
      const [a, b, c, d, e] = filaN(vals, n);
      if (a) categorias.push({ fila: n, categoria: a, presupuesto: toNumber(b), gasto_real: toNumber(c), diferencia: toNumber(d), pct_usado: toNumber(e) });
    }
    const descuentos = [];
    for (let n = 56; n <= 62; n++) {
      const [a, b, c, d, e] = filaN(vals, n);
      if (a) descuentos.push({ fila: n, categoria: a, presupuesto: toNumber(b), real: toNumber(c), diferencia: toNumber(d), pct_usado: toNumber(e) });
    }
    return { mesActual, categorias, descuentos };
  }

  async function cargarPresupuesto(mesPres) {
    if (mesAplicado !== mesPres) {
      await SheetsApi.updateRange("'Presupuesto'!B5", [[mesPres]], "RAW");
      mesAplicado = mesPres;
    }
    const raw = await SheetsApi.batchGet(["presupuesto"]);
    return parsePresupuesto(raw.presupuesto || []);
  }

  // Puerto de _gasto_real_categoria_mes()/_descuentos_categoria_mes()
  // (app_presupuesto.py) — gasto real por categoría de un mes puntual, en
  // la misma convención "efectivo real" que usa la columna 'Gasto Real' de
  // la hoja Presupuesto: el efectivo cuenta en su propio mes, las tarjetas
  // en el mes siguiente al extracto (cuando se pagan). Los descuentos de
  // nómina se agrupan por quincena de pago, no por extracto.
  const EGRESO_COLS_SUGERIR = [
    "PeriodoExtracto", "FechaCompra", "Comercio", "Moneda", "Cuotas", "ValorTotal",
    "ValorCargado", "SaldoPendiente", "Categoria", "Reembolsable", "Notas",
  ];

  async function sugerirMetas(p) {
    const hoy = new Date();
    const mesActual = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
    const mesesPrev = [1, 2, 3].map((i) => shiftMes(mesActual, -i));

    const raw = await SheetsApi.batchGet(["efectivo_detalle", "visa_detalle", "mc_detalle", "colillas_descuentos"]);
    const efectivo = filasAObjetos(raw.efectivo_detalle, EGRESO_COLS_SUGERIR, ["FechaCompra"]);
    const visa = filasAObjetos(raw.visa_detalle, EGRESO_COLS_SUGERIR, ["FechaCompra"]);
    const mc = filasAObjetos(raw.mc_detalle, EGRESO_COLS_SUGERIR, ["FechaCompra"]);
    const descuentos = filasAObjetos(raw.colillas_descuentos, ["Quincena", "Concepto", "Categoria", "Valor"]);

    function gastoRealCategoriaMes(mesStr) {
      const mesCorteTarjetas = shiftMes(mesStr, -1);
      const totales = {};
      for (const [filas, mesObjetivo] of [[efectivo, mesStr], [visa, mesCorteTarjetas], [mc, mesCorteTarjetas]]) {
        for (const f of filas) {
          if (f.Moneda === "COP" && !esNoPresupuestar(f.Categoria) && f.PeriodoExtracto === mesObjetivo) {
            totales[f.Categoria] = (totales[f.Categoria] || 0) + toNumber(f.ValorCargado);
          }
        }
      }
      return totales;
    }

    function descuentosCategoriaMes(mesStr) {
      const anioObj = Number(mesStr.slice(0, 4));
      const mesObj = Number(mesStr.slice(5, 7));
      const totales = {};
      for (const d of descuentos) {
        const [a, m] = extraerAnioMes(d.Quincena);
        if (a === anioObj && m === mesObj) totales[d.Categoria] = (totales[d.Categoria] || 0) + toNumber(d.Valor);
      }
      return totales;
    }

    const catPorMes = mesesPrev.map(gastoRealCategoriaMes);
    const descPorMes = mesesPrev.map(descuentosCategoriaMes);

    const promedioRedondeado = (valores) => {
      const noCero = valores.filter((v) => v > 0);
      if (!noCero.length) return null;
      const promedio = noCero.reduce((s, v) => s + v, 0) / noCero.length;
      return Math.round(promedio / 1000) * 1000;
    };

    const sugerenciasCat = {};
    for (const cat of p.categorias) {
      const sugerido = promedioRedondeado(catPorMes.map((d) => d[cat.categoria] || 0));
      if (sugerido !== null) sugerenciasCat[cat.fila] = sugerido;
    }
    const sugerenciasDesc = {};
    for (const desc of p.descuentos) {
      const sugerido = promedioRedondeado(descPorMes.map((d) => d[desc.categoria] || 0));
      if (sugerido !== null) sugerenciasDesc[desc.fila] = sugerido;
    }
    return { sugerenciasCat, sugerenciasDesc, mesesPrev };
  }

  async function render(container) {
    container.innerHTML = `
      <h1>📋 Presupuesto</h1>
      <p class="caption">Definí una meta mensual por categoría y comparala contra el gasto real de un mes
      puntual — el efectivo cuenta en su propio mes y las tarjetas en el mes siguiente al extracto, cuando se
      pagan.</p>
      <div class="row">
        <select id="pr_anio"></select>
        <select id="pr_mes"></select>
      </div>
      <div id="pr-contenido">Cargando…</div>
    `;
    const hoy = new Date();
    const selAnio = container.querySelector("#pr_anio");
    const selMes = container.querySelector("#pr_mes");
    for (let a = 2023; a <= 2032; a++) selAnio.add(new Option(a, a));
    selAnio.value = hoy.getFullYear();
    for (let m = 1; m <= 12; m++) selMes.add(new Option(MESES_NOMBRE[m], m));
    selMes.value = hoy.getMonth() + 1;
    selAnio.addEventListener("change", () => renderContenido(container));
    selMes.addEventListener("change", () => renderContenido(container));

    await renderContenido(container);
  }

  async function renderContenido(container) {
    const contenido = container.querySelector("#pr-contenido");
    const anio = container.querySelector("#pr_anio").value;
    const mes = container.querySelector("#pr_mes").value.padStart(2, "0");
    const mesPres = `${anio}-${mes}`;
    contenido.innerHTML = "Cargando…";
    try {
      const p = await cargarPresupuesto(mesPres);

      // Aviso visual de "casi" o "ya te pasaste" del presupuesto: rojo si el
      // gasto real ya superó la meta, naranja si lleva 90%+ usado -- antes
      // solo mostraba "$X disponible" sin resaltar cuándo eso era negativo
      // o estaba a punto de serlo, así que había que leer el número con
      // atención para notarlo (mismo criterio que Streamlit).
      const avisoDisponibleHTML = (meta, real) => {
        if (meta <= 0) return "—";
        const disponible = meta - real;
        const pctUsado = (real / meta) * 100;
        if (disponible < 0) return `<span style="color:var(--error);">⚠️ ${fmtMoneda(-disponible)} de más</span>`;
        if (pctUsado >= 90) return `<span style="color:var(--warning-text);">🟡 ${fmtMoneda(disponible)} disponible (${pctUsado.toFixed(0)}% usado)</span>`;
        return `${fmtMoneda(disponible)} disponible`;
      };

      const filaHtml = (item, campoNombre, etiqueta, prefijoId) => `
        <div class="metric-row" style="align-items:center;">
          <div style="flex:2;min-width:160px;">${item.categoria}</div>
          <div style="flex:1;min-width:140px;" class="caption">${etiqueta}: ${fmtMoneda(item[campoNombre])}</div>
          <div style="flex:1;min-width:120px;">
            <input type="number" step="10000" class="input-meta" data-fila="${item.fila}"
              data-base="${item[campoNombre]}"
              id="${prefijoId}_${item.fila}" value="${item.presupuesto}">
          </div>
          <div style="flex:1;min-width:120px;" class="caption" id="disp_${item.fila}">
            ${avisoDisponibleHTML(item.presupuesto, item[campoNombre])}
          </div>
        </div>`;

      contenido.innerHTML = `
        <button type="button" id="pr_sugerir">💡 Sugerir metas según el promedio de los últimos meses con datos</button>
        <div class="aviso" id="pr_sugerir_msg" hidden></div>

        <h4>Metas por categoría de gasto</h4>
        ${p.categorias.length ? p.categorias.map((c) => filaHtml(c, "gasto_real", "Gasto real", "meta_cat")).join("") : "<p class=\"caption\">Sin categorías.</p>"}

        <h4>Metas de descuentos de nómina</h4>
        <p class="caption">Ahorro, Seguros, Impuestos, Aportes de Ley y cuotas de deuda descontadas de la
        colilla — no es gasto discrecional, pero sí reduce lo disponible.</p>
        ${p.descuentos.length ? p.descuentos.map((d) => filaHtml(d, "real", "Real", "meta_desc")).join("") : "<p class=\"caption\">Sin descuentos.</p>"}

        <button id="pr_guardar" type="button">💾 Guardar todas las metas</button>
        <div class="aviso" id="pr_msg" hidden></div>

        <div id="pr_chart_wrap"></div>
      `;

      function actualizarDisponible(input) {
        const fila = input.dataset.fila;
        const base = Number(input.dataset.base);
        const meta = Number(input.value) || 0;
        const dispEl = contenido.querySelector(`#disp_${fila}`);
        dispEl.innerHTML = avisoDisponibleHTML(meta, base);
      }

      contenido.querySelectorAll(".input-meta").forEach((input) => {
        input.addEventListener("input", () => actualizarDisponible(input));
      });

      contenido.querySelector("#pr_sugerir").addEventListener("click", async () => {
        const btnSug = contenido.querySelector("#pr_sugerir");
        const msgSug = contenido.querySelector("#pr_sugerir_msg");
        btnSug.disabled = true;
        btnSug.textContent = "Calculando…";
        try {
          const { sugerenciasCat, sugerenciasDesc, mesesPrev } = await sugerirMetas(p);
          for (const [fila, valor] of Object.entries(sugerenciasCat)) {
            const input = contenido.querySelector(`#meta_cat_${fila}`);
            if (input) { input.value = valor; actualizarDisponible(input); }
          }
          for (const [fila, valor] of Object.entries(sugerenciasDesc)) {
            const input = contenido.querySelector(`#meta_desc_${fila}`);
            if (input) { input.value = valor; actualizarDisponible(input); }
          }
          msgSug.hidden = false;
          msgSug.style.background = "var(--success-bg)";
          msgSug.style.color = "var(--success-text)";
          msgSug.textContent = `Metas sugeridas con el promedio de ${mesesPrev.join(", ")} (donde hubo datos) —
            revisalas y ajustalas antes de guardar.`;
        } catch (err) {
          msgSug.hidden = false;
          msgSug.style.background = "var(--error-bg)";
          msgSug.style.color = "var(--error-text)";
          msgSug.textContent = `No pude calcular la sugerencia: ${err.message}`;
          console.error(err);
        } finally {
          btnSug.disabled = false;
          btnSug.textContent = "💡 Sugerir metas según el promedio de los últimos meses con datos";
        }
      });

      contenido.querySelector("#pr_guardar").addEventListener("click", async () => {
        const btn = contenido.querySelector("#pr_guardar");
        const msg = contenido.querySelector("#pr_msg");
        btn.disabled = true;
        btn.textContent = "Guardando…";
        try {
          const updates = [...contenido.querySelectorAll(".input-meta")].map((input) => ({
            range: `'Presupuesto'!B${input.dataset.fila}`,
            values: [[Number(input.value) || 0]],
          }));
          await SheetsApi.batchUpdateRanges(updates);
          msg.hidden = false;
          msg.style.background = "var(--success-bg)";
          msg.style.color = "var(--success-text)";
          msg.textContent = "Metas guardadas.";
          await renderContenido(container);
        } catch (err) {
          msg.hidden = false;
          msg.style.background = "var(--error-bg)";
          msg.style.color = "var(--error-text)";
          msg.textContent = `No pude guardar: ${err.message}`;
          btn.disabled = false;
          btn.textContent = "💾 Guardar todas las metas";
        }
      });

      const conMeta = p.categorias.filter((c) => c.presupuesto > 0);
      const chartWrap = contenido.querySelector("#pr_chart_wrap");
      if (conMeta.length) {
        chartWrap.innerHTML = `
          <h4>Presupuesto vs. gasto real (categorías con meta definida)</h4>
          <canvas id="pr_chart" height="100"></canvas>
        `;
        if (chart) chart.destroy();
        chart = new Chart(chartWrap.querySelector("#pr_chart").getContext("2d"), {
          type: "bar",
          data: {
            labels: conMeta.map((c) => c.categoria),
            datasets: [
              { label: "Presupuesto", data: conMeta.map((c) => c.presupuesto), backgroundColor: "#1d4ed8" },
              { label: "Gasto Real", data: conMeta.map((c) => c.gasto_real), backgroundColor: "#dc2626" },
            ],
          },
          options: { responsive: true, scales: { y: { ticks: { callback: (v) => fmtMoneda(v) } } } },
        });
      } else {
        chartWrap.innerHTML = `<p>Definí al menos una meta arriba (y guardala) para ver el gráfico de comparación.</p>`;
      }
    } catch (err) {
      contenido.innerHTML = `<div class="error">Error: ${err.message}</div>`;
      console.error(err);
    }
  }

  return { render };
})();
