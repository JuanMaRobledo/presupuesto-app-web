// Puerto de render_cargar_colillas() + render_cargar_cuenta() +
// aplicar_colillas() + aplicar_movimientos_cuenta() (app_presupuesto.py) --
// subir colillas de pago (PDF) y extractos de cuenta de ahorros (.xlsx),
// con vista previa de solo lectura (nuevo/repetido/ya cargado) antes de
// escribir al Sheet, igual que la versión de Streamlit. La categorización y
// el parseo viven en js/parsers/colillas.js y js/parsers/cuenta.js -- acá
// solo está la UI y la escritura al Sheet.

const PaginaCargar = (() => {
  function render(container) {
    container.innerHTML = `
      <h1>📤 Cargar Extractos</h1>
      <p class="caption">Subí tus colillas de pago (PDF) o el extracto de tu cuenta de ahorros (.xlsx) para irlos
      agregando al Sheet -- se categorizan solos, y te muestro una vista previa antes de aplicar nada.</p>
      <div class="tabs" id="tabs-cargar">
        <button class="tab-btn activo" data-tab="colillas">📄 Colillas de Pago</button>
        <button class="tab-btn" data-tab="cuenta">🏦 Cuenta de Ahorros</button>
      </div>
      <div id="panel-cargar"></div>
    `;
    const tabsDiv = container.querySelector("#tabs-cargar");
    const panel = container.querySelector("#panel-cargar");
    let activo = "colillas";

    tabsDiv.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        activo = btn.dataset.tab;
        tabsDiv.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("activo", b === btn));
        renderTab();
      });
    });

    function renderTab() {
      if (activo === "colillas") renderCargarColillas(panel);
      else renderCargarCuenta(panel);
    }
    renderTab();
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  function pill(texto, tipo) {
    const color = tipo === "ok" ? "#0a7d3c" : "#8a6d00";
    const bg = tipo === "ok" ? "#e6f6ec" : "#fff6e0";
    return `<span style="color:${color};background:${bg};border-radius:12px;padding:2px 10px;font-size:0.8em;font-weight:600;">${texto}</span>`;
  }

  // =========================================================================
  // Colillas de Pago
  // =========================================================================
  function renderCargarColillas(panel) {
    panel.innerHTML = `
      <p><strong>Sube una o varias colillas del Hospital Pablo Tobón Uribe, en PDF.</strong></p>
      <details>
        <summary>ℹ️ ¿Qué hace esta sección?</summary>
        <p class="caption">Lee cada colilla en PDF (devengos y descuentos, categorizados solos) y te muestra una
        vista previa antes de aplicar nada. Las que ya estaban cargadas, o repetidas entre los archivos de esta
        subida, se detectan y se omiten. Al aplicar, escribe directo en la hoja 'Colillas de Pago' del Sheet.</p>
      </details>
      <input type="file" id="col_input" accept="application/pdf" multiple>
      <div id="col_resultado"></div>
    `;
    panel.querySelector("#col_input").addEventListener("change", (ev) => onArchivosColillas(ev, panel));
  }

  async function onArchivosColillas(ev, panel) {
    const archivos = [...ev.target.files];
    const resultado = panel.querySelector("#col_resultado");
    if (!archivos.length) { resultado.innerHTML = ""; return; }
    resultado.innerHTML = "Leyendo y comparando contra el Sheet…";

    let yaCargadas;
    try {
      const raw = await SheetsApi.batchGet(["colillas_resumen"]);
      yaCargadas = new Set((raw.colillas_resumen || []).map((f) => f[1]).filter(Boolean));
    } catch (err) {
      resultado.innerHTML = `<div class="error">No pude leer la hoja 'Colillas de Pago' del Sheet: ${err.message}</div>`;
      return;
    }

    const parsed = [];
    const vistosEnSubida = new Set();
    for (const f of archivos) {
      try {
        const buffer = await f.arrayBuffer();
        const { texto, palabras, avisoPaginas } = await ColillasParser.extraerColillaDePDF(new Uint8Array(buffer));
        const r = ColillasParser.parseColilla(texto, palabras, f.name);
        r._archivo = f.name;
        r._avisoPaginas = avisoPaginas;
        r._duplicadoSubida = vistosEnSubida.has(r.periodo);
        r._nueva = !yaCargadas.has(r.periodo) && !r._duplicadoSubida;
        vistosEnSubida.add(r.periodo);
        parsed.push(r);
      } catch (err) {
        parsed.push({ _error: err.message, _archivo: f.name });
      }
    }

    renderPreviewColillas(resultado, parsed);
  }

  function renderPreviewColillas(resultado, parsed) {
    let html = `<h4>Vista previa</h4>`;
    for (const r of parsed) {
      if (r._error) {
        html += `<div class="error">No pude leer ${r._archivo}: ${r._error}</div>`;
        continue;
      }
      const estado = r._nueva ? pill("nueva", "ok")
        : r._duplicadoSubida ? pill("repetida en esta subida — se omitirá", "skip")
        : pill("ya cargada — se omitirá", "skip");
      html += `
        <div class="card">
          <p><strong>${r.periodo}</strong> (${r._archivo}) &nbsp; ${estado}</p>
          <div class="metric-row">
            ${metric("Devengos", fmtMoneda(r.totalDevengos))}
            ${metric("Descuentos", fmtMoneda(r.totalDescuentos))}
            ${metric("Neto", fmtMoneda(r.neto))}
            ${metric("Fecha de pago", r.fecha)}
          </div>
          <details>
            <summary>Ver devengos y descuentos detallados</summary>
            <p><strong>Devengos</strong></p>
            <table class="tabla"><thead><tr><th>Concepto</th><th>Categoría</th><th>Valor</th></tr></thead>
              <tbody>${r.devengos.map((i) => `<tr><td>${i.concepto}</td><td>${i.categoria}</td><td>${fmtMoneda(i.valor)}</td></tr>`).join("")}</tbody></table>
            <p><strong>Descuentos</strong></p>
            <table class="tabla"><thead><tr><th>Concepto</th><th>Categoría</th><th>Valor</th></tr></thead>
              <tbody>${r.descuentos.map((i) => `<tr><td>${i.concepto}</td><td>${i.categoria}</td><td>${fmtMoneda(i.valor)}</td></tr>`).join("")}</tbody></table>
          </details>
          ${r.revisar.length ? `<p class="aviso">Conceptos no reconocidos (quedarán sin categoría, para que la pongas tú): ${r.revisar.map((c) => `"${c[1]}"`).join(", ")}</p>` : ""}
          ${r._avisoPaginas ? `<p class="aviso">Aviso: ${r._archivo} tiene ${r._avisoPaginas} páginas; solo se leyó la primera.</p>` : ""}
        </div>
      `;
    }

    const nuevas = parsed.filter((r) => r._nueva);
    if (nuevas.length) {
      html += `<button id="col_aplicar">✅ Aplicar ${nuevas.length} colilla(s) nueva(s)</button><div id="col_msg"></div>`;
    } else if (parsed.some((r) => !r._error)) {
      html += `<p>Todas las colillas subidas ya estaban cargadas — no hay nada que aplicar.</p>`;
    }
    resultado.innerHTML = html;
    if (nuevas.length) {
      resultado.querySelector("#col_aplicar").addEventListener("click", () => onAplicarColillas(resultado, nuevas));
    }
  }

  async function onAplicarColillas(resultado, nuevas) {
    const btn = resultado.querySelector("#col_aplicar");
    const msg = resultado.querySelector("#col_msg");
    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      for (const r of nuevas) {
        if (r.periodo.startsWith("Cesantías")) {
          // Liquidación anual: el capital (181) se consigna al fondo el mismo
          // día y no afecta el flujo de caja -- solo se registra en $0 para
          // reconocer el período si se vuelve a subir, y los intereses (191)
          // aparte en Otros Ingresos. Ver misma nota en aplicar_colillas().
          await SheetsApi.appendRows(RANGOS.colillas_resumen, [[r.fecha, r.periodo, 0, 0]]);
          const interes = r.devengos.filter((i) => i.codigo === "191").reduce((s, i) => s + i.valor, 0);
          if (interes) {
            await SheetsApi.appendRows(RANGOS.otros_ingresos, [[r.fecha, "Intereses de Cesantías", "Cesantías", interes,
              `Liquidación de cesantías ${r.periodo} — no incluye el capital, que se consigna al fondo el mismo día y no es ingreso`]]);
          }
          continue;
        }
        const totalDevengos = r.totalDevengos - r.devengos.filter((i) => esNoPresupuestar(i.categoria)).reduce((s, i) => s + i.valor, 0);
        const totalDescuentos = r.totalDescuentos - r.descuentos.filter((i) => esNoPresupuestar(i.categoria)).reduce((s, i) => s + i.valor, 0);
        await SheetsApi.appendRows(RANGOS.colillas_resumen, [[r.fecha, r.periodo, totalDevengos, totalDescuentos]]);
        if (r.devengos.length) {
          await SheetsApi.appendRows(RANGOS.colillas_devengos, r.devengos.map((i) => [i.quincena, i.concepto, i.categoria, i.valor]));
        }
        if (r.descuentos.length) {
          await SheetsApi.appendRows(RANGOS.colillas_descuentos, r.descuentos.map((i) => [i.quincena, i.concepto, i.categoria, i.valor]));
        }
      }
      msg.innerHTML = `<p>Listo — ${nuevas.length} colilla(s) agregada(s) directamente al Google Sheet.</p>`;
      btn.remove();
    } catch (err) {
      msg.innerHTML = `<div class="error">Algo falló al aplicar los cambios: ${err.message}</div>`;
      btn.disabled = false;
      btn.textContent = `✅ Aplicar ${nuevas.length} colilla(s) nueva(s)`;
    }
  }

  // =========================================================================
  // Cuenta de Ahorros
  // =========================================================================
  function renderCargarCuenta(panel) {
    panel.innerHTML = `
      <p><strong>Sube uno o varios extractos o detalles de transacciones de tu cuenta de ahorros (.xlsx, tal como
      los descargas de Bancolombia).</strong></p>
      <p class="caption">Los débitos se registran como Egresos - Efectivo. Los movimientos que ya se contabilizan
      por otro lado (pago automático de tarjetas, intereses de ahorros, tu sueldo ya en Colillas de Pago) se
      cargan igual, para que la conciliación de la cuenta cuadre, pero con categoría "(no presupuestar)" para no
      duplicar tus totales.</p>
      <details>
        <summary>ℹ️ ¿Qué hace esta sección?</summary>
        <p class="caption">Lee el extracto y categoriza cada movimiento solo (ingreso, gasto, aporte a inversión, o
        "(no presupuestar)"). Te muestra un resumen antes de aplicar nada -- nuevos, ya cargados, repetidos entre
        archivos. Al aplicar, escribe en Egresos - Efectivo, Otros Ingresos, y en Inversiones si detecta un aporte
        a una plataforma.</p>
      </details>
      <input type="file" id="cta_input" accept=".xlsx" multiple>
      <div id="cta_resultado"></div>
    `;
    panel.querySelector("#cta_input").addEventListener("change", (ev) => onArchivosCuenta(ev, panel));
  }

  async function onArchivosCuenta(ev, panel) {
    const archivos = [...ev.target.files];
    const resultado = panel.querySelector("#cta_resultado");
    if (!archivos.length) { resultado.innerHTML = ""; return; }
    resultado.innerHTML = "Leyendo y comparando contra el Sheet…";

    let yaIngresos, yaEgresos;
    try {
      const raw = await SheetsApi.batchGet(["otros_ingresos", "efectivo_detalle"]);
      yaIngresos = (raw.otros_ingresos || []).filter((r) => r[0]).map((r) => [serialToText(r[0]), r[1], r[3]]);
      yaEgresos = (raw.efectivo_detalle || []).filter((r) => r[1]).map((r) => [serialToText(r[1]), r[2], r[6]]);
    } catch (err) {
      resultado.innerHTML = `<div class="error">No pude revisar lo ya cargado en el Sheet: ${err.message}</div>`;
      return;
    }

    const todos = [];
    const erroresArchivo = [];
    for (const f of archivos) {
      let wb;
      try {
        const buffer = await f.arrayBuffer();
        wb = XLSX.read(buffer, { type: "array", cellDates: true });
      } catch (err) {
        erroresArchivo.push(`No pude abrir ${f.name}: ${err.message}`);
        continue;
      }
      for (const sn of wb.SheetNames) {
        try {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
          const txns = CuentaParser.parseExtractoCuentaSheet(rows);
          txns.forEach((t) => { t._archivo = f.name; t._sheet = sn; });
          todos.push(...txns);
        } catch (err) {
          erroresArchivo.push(`No pude leer la hoja '${sn}' de ${f.name}: ${err.message}`);
        }
      }
    }

    CuentaParser.marcarNovedadMovimientos(todos, yaIngresos, yaEgresos);
    renderPreviewCuenta(resultado, todos, erroresArchivo);
  }

  function renderPreviewCuenta(resultado, todos, erroresArchivo) {
    const nuevosIngresos = todos.filter((t) => t.valor > 0 && t._nuevo);
    const nuevosEgresos = todos.filter((t) => t.valor < 0 && t._nuevo);
    const duplicadosSubida = todos.filter((t) => t._duplicadoSubida);
    const yaCargados = todos.filter((t) => !t._nuevo && !t._duplicadoSubida);
    const noPresupuestarNuevos = [...nuevosIngresos, ...nuevosEgresos].filter((t) => t.noPresupuestar);

    let html = erroresArchivo.map((e) => `<div class="error">${e}</div>`).join("");
    html += `<h4>Resumen</h4><div class="metric-row">
      ${metric("Ingresos nuevos", nuevosIngresos.length)}
      ${metric("Gastos nuevos", nuevosEgresos.length)}
      ${metric("Ya cargados", yaCargados.length)}
      ${metric("Repetidos en subida", duplicadosSubida.length)}
      ${metric("No presupuestar (se cargan igual)", noPresupuestarNuevos.length)}
    </div>`;

    const filaTxn = (t) => `<tr><td>${fechaDDMMYYYY(t.fecha)}</td><td>${t.descripcion}</td><td>${t.categoria}</td><td>${fmtMoneda(Math.abs(t.valor))}</td><td>${t.nota}</td></tr>`;

    if (nuevosIngresos.length) {
      const noReconocidos = [...new Set(nuevosIngresos.filter((t) => t.categoria === "Otro").map((t) => t.descripcion))];
      html += `<h5>Ingresos nuevos</h5><table class="tabla"><thead><tr><th>Fecha</th><th>Concepto</th><th>Categoría</th><th>Valor</th><th>Notas</th></tr></thead><tbody>${nuevosIngresos.map(filaTxn).join("")}</tbody></table>`;
      if (noReconocidos.length) html += `<p class="aviso">Ingresos no reconocidos (quedarán en 'Otro', clasifícalos tú en el Sheet): ${noReconocidos.join(", ")}</p>`;
    }
    if (nuevosEgresos.length) {
      const noReconocidos = [...new Set(nuevosEgresos.filter((t) => t.categoria === "Otros").map((t) => t.descripcion))];
      html += `<h5>Gastos nuevos</h5><table class="tabla"><thead><tr><th>Fecha</th><th>Concepto</th><th>Categoría</th><th>Valor</th><th>Notas</th></tr></thead><tbody>${nuevosEgresos.map(filaTxn).join("")}</tbody></table>`;
      if (noReconocidos.length) html += `<p class="aviso">Movimientos no reconocidos (quedarán en 'Otros', clasifícalos tú en el Sheet): ${noReconocidos.join(", ")}</p>`;
    }
    if (noPresupuestarNuevos.length) {
      html += `<details><summary>Ver los ${noPresupuestarNuevos.length} movimiento(s) '(no presupuestar)' — se cargan igual, para conciliar la cuenta, pero no cuentan en tus totales</summary>
        <table class="tabla"><thead><tr><th>Fecha</th><th>Concepto</th><th>Categoría</th><th>Valor</th><th>Notas</th></tr></thead><tbody>${noPresupuestarNuevos.map(filaTxn).join("")}</tbody></table></details>`;
    }
    if (yaCargados.length) html += `<p>${yaCargados.length} movimiento(s) ya estaban cargados — se omiten.</p>`;
    if (duplicadosSubida.length) {
      html += `<p class="aviso">${duplicadosSubida.length} movimiento(s) están repetidos entre los archivos de esta subida — se aplicará únicamente la primera aparición.</p>
        <details><summary>Ver movimientos repetidos en esta subida</summary>
        <table class="tabla"><thead><tr><th>Fecha</th><th>Concepto</th><th>Valor</th><th>Archivo</th></tr></thead>
        <tbody>${duplicadosSubida.map((t) => `<tr><td>${fechaDDMMYYYY(t.fecha)}</td><td>${t.descripcion}</td><td>${fmtMoneda(Math.abs(t.valor))}</td><td>${t._archivo}</td></tr>`).join("")}</tbody></table></details>`;
    }

    const totalNuevos = nuevosIngresos.length + nuevosEgresos.length;
    if (totalNuevos) {
      html += `<button id="cta_aplicar">✅ Aplicar ${totalNuevos} movimiento(s) nuevo(s)</button><div id="cta_msg"></div>`;
    } else if (todos.length) {
      html += `<p>Todos los movimientos ya estaban cargados — no hay nada que aplicar.</p>`;
    }
    resultado.innerHTML = html;
    if (totalNuevos) {
      resultado.querySelector("#cta_aplicar").addEventListener("click", () => onAplicarCuenta(resultado, nuevosIngresos, nuevosEgresos, totalNuevos));
    }
  }

  function fechaDDMMYYYY(fecha) {
    return `${String(fecha.getUTCDate()).padStart(2, "0")}/${String(fecha.getUTCMonth() + 1).padStart(2, "0")}/${fecha.getUTCFullYear()}`;
  }

  // Puerto de aplicar_movimientos_cuenta() (app_presupuesto.py).
  async function onAplicarCuenta(resultado, nuevosIngresos, nuevosEgresos, totalNuevos) {
    const btn = resultado.querySelector("#cta_aplicar");
    const msg = resultado.querySelector("#cta_msg");
    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      if (nuevosIngresos.length) {
        await SheetsApi.appendRows(RANGOS.otros_ingresos, nuevosIngresos.map((t) =>
          [CuentaParser.fechaISO(t.fecha), t.descripcion, t.categoria, t.valor, t.nota || ""]));
      }
      if (nuevosEgresos.length) {
        await SheetsApi.appendRows(RANGOS.efectivo_detalle, nuevosEgresos.map((t) => {
          const iso = CuentaParser.fechaISO(t.fecha);
          return [iso.slice(0, 7), iso, t.descripcion, "COP", "1/1", Math.abs(t.valor), Math.abs(t.valor), 0, t.categoria, "No", t.nota || ""];
        }));
      }
      // Aportes/retiros a plataformas de inversión detectadas -- depósito
      // (egreso de la cuenta) = positivo, retiro (ingreso a la cuenta) =
      // negativo, mismo signo que usa el resto de la app.
      const movimientosInversion = [...nuevosIngresos, ...nuevosEgresos].filter((t) => t.flujoInversion);
      for (const moneda of ["pesos", "dolares"]) {
        const movimientos = movimientosInversion.filter((t) => t.flujoInversion[1] === moneda);
        if (!movimientos.length) continue;
        const rango = moneda === "pesos" ? RANGOS.aportes_inversion_pesos : RANGOS.aportes_inversion_dolares;
        await SheetsApi.appendRows(rango, movimientos.map((t) => [
          CuentaParser.fechaISO(t.fecha), t.flujoInversion[0],
          t.valor < 0 ? Math.abs(t.valor) : -Math.abs(t.valor),
          t.valor < 0 ? "Depósito detectado en extracto de cuenta" : "Retiro detectado en extracto de cuenta",
        ]));
      }
      msg.innerHTML = `<p>Listo — ${nuevosIngresos.length} ingreso(s) y ${nuevosEgresos.length} gasto(s) agregados directamente al Google Sheet.</p>`;
      btn.remove();
    } catch (err) {
      msg.innerHTML = `<div class="error">Algo falló al aplicar los cambios: ${err.message}</div>`;
      btn.disabled = false;
      btn.textContent = `✅ Aplicar ${totalNuevos} movimiento(s) nuevo(s)`;
    }
  }

  return { render };
})();
