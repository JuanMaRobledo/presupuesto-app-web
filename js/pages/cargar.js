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
      <p class="caption">Subí tus colillas de pago (PDF), el extracto de tu cuenta de ahorros (.xlsx) o el extracto
      de tu tarjeta de crédito (.xlsx) para irlos agregando al Sheet -- se categorizan solos, y te muestro una
      vista previa antes de aplicar nada.</p>
      <div class="tabs" id="tabs-cargar">
        <button class="tab-btn activo" data-tab="colillas">📄 Colillas de Pago</button>
        <button class="tab-btn" data-tab="cuenta">🏦 Cuenta de Ahorros</button>
        <button class="tab-btn" data-tab="tarjeta">💳 Tarjeta de Crédito</button>
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
      else if (activo === "cuenta") renderCargarCuenta(panel);
      else renderCargarTarjeta(panel);
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

  // =========================================================================
  // Tarjeta de Crédito (Visa/Mastercard)
  // =========================================================================
  const TARJETA_RANGO_KEY = {
    "Visa ****7497": { detalle: "visa_detalle", resumen: "visa_resumen" },
    "Mastercard ****5922": { detalle: "mc_detalle", resumen: "mc_resumen", detalleUsd: "mc_detalle_usd" },
  };

  function renderCargarTarjeta(panel) {
    panel.innerHTML = `
      <p><strong>Sube uno o varios extractos detallados de la Visa o la Mastercard (.xlsx, tal como los descargas
      de Bancolombia).</strong></p>
      <details>
        <summary>ℹ️ ¿Qué hace esta sección?</summary>
        <p class="caption">Lee cada extracto de tarjeta (compras categorizadas solas, resumen del corte) y te
        muestra una vista previa antes de aplicar nada. Los que ya estaban cargados, o repetidos entre los
        archivos de esta subida, se detectan y se omiten. Al aplicar, escribe directo en la hoja de Egresos de
        esa tarjeta en el Sheet.</p>
      </details>
      <input type="file" id="tj_input" accept=".xlsx" multiple>
      <div id="tj_resultado"></div>
    `;
    panel.querySelector("#tj_input").addEventListener("change", (ev) => onArchivosTarjeta(ev, panel));
  }

  // Puerto de la parte de dedup de render_cargar_extractos() -- 'ya' por
  // tarjeta se lee una sola vez (no por archivo/hoja) para no repetir la
  // misma consulta de lectura si se suben varios meses de una vuelta.
  async function onArchivosTarjeta(ev, panel) {
    const archivos = [...ev.target.files];
    const resultado = panel.querySelector("#tj_resultado");
    if (!archivos.length) { resultado.innerHTML = ""; return; }
    resultado.innerHTML = "Leyendo y comparando contra el Sheet…";

    const yaPorTarjeta = new Map();
    async function yaCargados(tarjetaLabel) {
      if (!yaPorTarjeta.has(tarjetaLabel)) {
        const rango = TARJETA_RANGO_KEY[tarjetaLabel].resumen;
        const raw = await SheetsApi.batchGet([rango]);
        yaPorTarjeta.set(tarjetaLabel, new Set((raw[rango] || []).map((f) => f[0]).filter(Boolean)));
      }
      return yaPorTarjeta.get(tarjetaLabel);
    }

    const parsed = [];
    const vistosEnSubida = new Set();
    for (const f of archivos) {
      let wb;
      try {
        wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      } catch (err) {
        parsed.push({ _error: `No pude abrir ${f.name}: ${err.message}`, _archivo: f.name });
        continue;
      }
      for (const sn of wb.SheetNames) {
        let r;
        try {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
          r = TarjetaParser.parseExtractoSheet(rows, f.name, sn);
        } catch (err) {
          parsed.push({ _error: `No pude leer la hoja '${sn}' de ${f.name}: ${err.message}`, _archivo: f.name });
          continue;
        }
        r._archivo = f.name;
        r._sheet = sn;
        try {
          const ya = await yaCargados(r.tarjeta.label);
          const claveSubida = `${r.tarjeta.label}::${r.statement.periodo}::${r.moneda}`;
          r._duplicadoSubida = vistosEnSubida.has(claveSubida);
          r._nueva = !ya.has(r.statement.periodo) && !r._duplicadoSubida;
          vistosEnSubida.add(claveSubida);
        } catch (err) {
          r._nueva = false;
          parsed.push({ _error: `No pude revisar la hoja '${r.tarjeta.sheet}' del Sheet: ${err.message}`, _archivo: f.name });
        }
        parsed.push(r);
      }
    }

    renderPreviewTarjeta(resultado, parsed);
  }

  function renderPreviewTarjeta(resultado, parsed) {
    let html = `<h4>Vista previa</h4>`;
    for (const r of parsed) {
      if (r._error) { html += `<div class="error">${r._error}</div>`; continue; }
      const estado = r._nueva ? pill("nuevo", "ok")
        : r._duplicadoSubida ? pill("repetido en esta subida — se omitirá", "skip")
        : pill("ya cargado — se omitirá", "skip");
      const s = r.statement;
      html += `
        <div class="card">
          <p><strong>${r.tarjeta.label}</strong> — ${s.periodo} (${r.moneda}) &nbsp;
            <span class="caption">${r._archivo} [${r._sheet}]</span> &nbsp; ${estado}</p>
          <div class="metric-row">
            ${metric("Pago total", fmtMoneda(s.pagoTotal))}
            ${metric("Cupo disponible", fmtMoneda(s.cupoDisponible))}
            ${metric("Movimientos", r.txns.length)}
            ${metric("Pagar antes de", s.fechaLimite ? TarjetaParser.fechaISO(s.fechaLimite) : "?")}
          </div>
          <details>
            <summary>Ver movimientos</summary>
            <table class="tabla"><thead><tr><th>Fecha</th><th>Comercio</th><th>Cuotas</th><th>Valor este período</th><th>Categoría</th></tr></thead>
              <tbody>${r.txns.map((t) => `<tr><td>${TarjetaParser.fechaISO(t.fechaCompra)}</td><td>${t.comercio}</td><td>${t.cuotas}</td><td>${fmtMoneda(t.valorPeriodo)}</td><td>${t.categoria}</td></tr>`).join("")}</tbody></table>
          </details>
          ${(() => {
            const nuevosComercios = [...new Set(r.txns.filter((t) => t.categoria === "Otros" && t.nota === "Comercio no reconocido, clasificar manualmente").map((t) => t.comercio))];
            return nuevosComercios.length ? `<p class="aviso">Comercios no reconocidos (quedarán en 'Otros', clasifícalos tú): ${nuevosComercios.join(", ")}</p>` : "";
          })()}
        </div>
      `;
    }

    const nuevos = parsed.filter((r) => r._nueva);
    if (nuevos.length) {
      html += `<button id="tj_aplicar">✅ Aplicar ${nuevos.length} extracto(s) nuevo(s)</button><div id="tj_msg"></div>`;
    } else if (parsed.some((r) => !r._error)) {
      html += `<p>Todos los extractos subidos ya estaban cargados — no hay nada que aplicar.</p>`;
    }
    resultado.innerHTML = html;
    if (nuevos.length) resultado.querySelector("#tj_aplicar").addEventListener("click", () => onAplicarTarjeta(resultado, nuevos));
  }

  function colLetra(n) {
    return String.fromCharCode("A".charCodeAt(0) + n - 1);
  }

  // Puerto de first_blank_row() (sheets_backend.py) para el bloque resumen
  // (tiene columnas de fórmula intercaladas, así que no se puede usar
  // appendRows -- hace falta saber la fila exacta para escribir tramos de
  // columnas sueltos con batchUpdateRanges).
  async function primeraFilaLibreResumen(rangoNombre) {
    const raw = await SheetsApi.batchGet([rangoNombre]);
    const filas = raw[rangoNombre] || [];
    const filaInicio = Number(RANGOS[rangoNombre].match(/!A(\d+):/)[1]);
    let ultimoUsado = 0;
    filas.forEach((fila, i) => {
      if (fila && fila[0] !== undefined && fila[0] !== null && fila[0] !== "") ultimoUsado = i + 1;
    });
    return filaInicio + ultimoUsado;
  }

  // Puerto de _fila_detalle_tarjeta() (app_presupuesto.py).
  function filaDetalleTarjeta(t) {
    const saldo = t.saldoPendiente !== null && t.saldoPendiente !== undefined ? t.saldoPendiente : "";
    return [t.periodoExtracto, TarjetaParser.fechaISO(t.fechaCompra), t.comercio, t.moneda, t.cuotas,
      t.valorTotal, t.valorPeriodo, saldo, t.categoria, t.reembolsable, t.nota];
  }

  // Puerto de aplicar_extractos() (app_presupuesto.py).
  async function onAplicarTarjeta(resultado, nuevos) {
    const btn = resultado.querySelector("#tj_aplicar");
    const msg = resultado.querySelector("#tj_msg");
    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      const porHoja = new Map();
      for (const r of nuevos) {
        if (!porHoja.has(r.tarjeta.label)) porHoja.set(r.tarjeta.label, []);
        porHoja.get(r.tarjeta.label).push(r);
      }

      for (const [tarjetaLabel, entradas] of porHoja) {
        const blocks = TARJETA_RANGO_KEY[tarjetaLabel];
        const vistosPeriodo = new Set();
        for (const entrada of entradas) {
          const periodo = entrada.statement.periodo;
          if (!vistosPeriodo.has(periodo)) {
            const entradasPeriodo = entradas.filter((e) => e.statement.periodo === periodo);
            const copEntrada = entradasPeriodo.find((e) => e.moneda === "COP");
            const usdEntrada = entradasPeriodo.find((e) => e.moneda === "USD");
            const sFechas = (copEntrada || usdEntrada).statement;
            const filaResumen = await primeraFilaLibreResumen(blocks.resumen);
            const segments = [
              { range: `${RANGOS[blocks.resumen].split("!")[0]}!A${filaResumen}:C${filaResumen}`,
                values: [[sFechas.periodo, TarjetaParser.fechaISO(sFechas.fechaCorte), sFechas.fechaLimite ? TarjetaParser.fechaISO(sFechas.fechaLimite) : ""]] },
            ];
            if (copEntrada) {
              const s = copEntrada.statement;
              segments.push({ range: `${RANGOS[blocks.resumen].split("!")[0]}!D${filaResumen}:E${filaResumen}`, values: [[s.cupoTotal, s.cupoDisponible]] });
              segments.push({ range: `${RANGOS[blocks.resumen].split("!")[0]}!G${filaResumen}:G${filaResumen}`, values: [[s.saldoAnterior]] });
              segments.push({ range: `${RANGOS[blocks.resumen].split("!")[0]}!I${filaResumen}:J${filaResumen}`, values: [[s.pagoMinimo, s.pagoTotal]] });
            }
            if (blocks.detalleUsd && usdEntrada) {
              segments.push({ range: `${RANGOS[blocks.resumen].split("!")[0]}!K${filaResumen}:K${filaResumen}`, values: [[usdEntrada.statement.pagoTotal]] });
            }
            await SheetsApi.batchUpdateRanges(segments);
            vistosPeriodo.add(periodo);
          }

          const copTxns = entrada.txns.filter((t) => t.moneda === "COP");
          const otrasTxns = entrada.txns.filter((t) => t.moneda !== "COP");
          if (copTxns.length) await SheetsApi.appendRows(RANGOS[blocks.detalle], copTxns.map(filaDetalleTarjeta));
          if (otrasTxns.length) {
            if (!blocks.detalleUsd) throw new Error(`${tarjetaLabel} tiene movimientos en ${otrasTxns[0].moneda} pero todavía no tiene un bloque separado para esa moneda.`);
            await SheetsApi.appendRows(RANGOS[blocks.detalleUsd], otrasTxns.map(filaDetalleTarjeta));
          }
        }
      }
      msg.innerHTML = `<p>Listo — ${nuevos.length} extracto(s) agregado(s) directamente al Google Sheet.</p>`;
      btn.remove();
    } catch (err) {
      msg.innerHTML = `<div class="error">Algo falló al aplicar los cambios: ${err.message}</div>`;
      btn.disabled = false;
      btn.textContent = `✅ Aplicar ${nuevos.length} extracto(s) nuevo(s)`;
    }
  }

  return { render };
})();
