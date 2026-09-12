// Puerto (parcial) de render_presupuesto() (app_presupuesto.py) — la hoja
// 'Presupuesto' funciona distinto a las demás: la celda B5 es un selector
// de mes que las fórmulas de la hoja usan para calcular "Gasto Real" de
// cada categoría, así que hay que ESCRIBIR el mes ahí antes de poder LEER
// el gasto real de ese mes (mismo protocolo que set_presupuesto_mes() +
// read_presupuesto() en Python). Por eso esta página no puede ser de solo
// lectura como las demás.
//
// TODAVÍA NO portado: el botón "💡 Sugerir metas" (necesita
// _gasto_real_categoria_mes()/_descuentos_categoria_mes(), un promedio de
// los últimos 3 meses — se puede agregar después).

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
            ${item.presupuesto > 0 ? fmtMoneda(item.presupuesto - item[campoNombre]) + " disponible" : "—"}
          </div>
        </div>`;

      contenido.innerHTML = `
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

      contenido.querySelectorAll(".input-meta").forEach((input) => {
        input.addEventListener("input", () => {
          const fila = input.dataset.fila;
          const base = Number(input.dataset.base);
          const meta = Number(input.value) || 0;
          const dispEl = contenido.querySelector(`#disp_${fila}`);
          dispEl.textContent = meta > 0 ? `${fmtMoneda(meta - base)} disponible` : "—";
        });
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
          msg.style.background = "#d1e7dd";
          msg.style.color = "#0f5132";
          msg.textContent = "Metas guardadas.";
          await renderContenido(container);
        } catch (err) {
          msg.hidden = false;
          msg.style.background = "#f8d7da";
          msg.style.color = "#842029";
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
              { label: "Presupuesto", data: conMeta.map((c) => c.presupuesto), backgroundColor: "#4573d6" },
              { label: "Gasto Real", data: conMeta.map((c) => c.gasto_real), backgroundColor: "#d64545" },
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
