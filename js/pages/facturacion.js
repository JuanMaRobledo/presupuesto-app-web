// Puerto de render_facturacion_electronica() (app_presupuesto.py): registro
// año a año de facturas/notas electrónicas (DIAN), sin conciliación contra
// Egresos, más el formulario para agregar una factura a mano.

const PaginaFacturacion = (() => {
  const COLS = ["Fecha", "NitEmisor", "Emisor", "NumeroDocumento", "TipoDocumento", "Valor", "RemitenteCorreo", "Notas"];

  async function render(container) {
    container.innerHTML = `
      <h1>🧾 Facturación Electrónica</h1>
      <p class="caption">Registro de facturas y notas electrónicas (DIAN) recibidas por correo, año a año —
      no se concilia contra Egresos, es solo el archivo de los documentos.</p>
      <div id="fe-contenido">Cargando datos del Sheet…</div>
      <div id="fe-form"></div>
    `;
    renderForm(container.querySelector("#fe-form"), container);
    await recargarTabla(container);
  }

  async function recargarTabla(container) {
    const contenido = container.querySelector("#fe-contenido");
    contenido.innerHTML = "Cargando datos del Sheet…";
    try {
      const raw = await SheetsApi.batchGet(["facturacion_electronica"]);
      const filasOriginal = filasAObjetos(raw.facturacion_electronica, COLS, ["Fecha"]);
      if (!filasOriginal.length) {
        contenido.innerHTML = "<p>Todavía no hay facturas electrónicas cargadas. Agregá una abajo.</p>";
        return;
      }

      const filas = filasOriginal.map((f) => {
        const [anio, mes] = extraerAnioMes(f.Fecha);
        const m = String(f.Notas || "").match(/thread (\w+)\)/);
        const correo = m ? `https://mail.google.com/mail/u/0/#all/${m[1]}` : null;
        return { ...f, _anio: anio, _mes: mes, _correo: correo };
      });
      const conValor = filas.filter((f) => typeof f.Valor === "number" && f.Valor > 0);

      const porAnio = {};
      for (const f of conValor) {
        porAnio[f._anio] = porAnio[f._anio] || { facturas: 0, total: 0 };
        porAnio[f._anio].facturas += 1;
        porAnio[f._anio].total += f.Valor;
      }
      const aniosResumen = Object.keys(porAnio).sort((a, b) => b - a);

      contenido.innerHTML = `
        <div class="metric-row">
          ${metric("Facturas cargadas", filas.length.toLocaleString("en-US"))}
          ${metric("Con valor identificado", conValor.length.toLocaleString("en-US"))}
        </div>

        <p class="caption">Resumen por año (solo facturas con valor identificado):</p>
        <table class="tabla">
          <thead><tr><th>Año</th><th>Facturas</th><th>Total</th></tr></thead>
          <tbody>${aniosResumen.map((a) => `<tr><td>${a}</td><td>${porAnio[a].facturas}</td>
            <td>${fmtMoneda(porAnio[a].total)}</td></tr>`).join("")}</tbody>
        </table>

        <input type="text" id="fe_busqueda" placeholder="🔍 Buscar por emisor" class="input-texto" />
        <div class="row">
          <select id="fe_anio"></select>
          <select id="fe_mes"></select>
        </div>
        <p class="caption" id="fe_resumen"></p>
        <div class="tabla-scroll"><table class="tabla" id="fe_tabla"></table></div>
      `;

      const anioSel = contenido.querySelector("#fe_anio");
      const mesSel = contenido.querySelector("#fe_mes");
      const busquedaInput = contenido.querySelector("#fe_busqueda");
      const anios = [...new Set(filas.map((f) => f._anio).filter(Boolean))].sort((a, b) => b - a);
      anioSel.add(new Option("(todos)", "(todos)"));
      anios.forEach((a) => anioSel.add(new Option(a, a)));
      mesSel.add(new Option("(todos)", "(todos)"));
      for (let m = 1; m <= 12; m++) mesSel.add(new Option(`${String(m).padStart(2, "0")} - ${MESES_NOMBRE[m]}`, m));

      function actualizar() {
        let f = filas;
        const busqueda = busquedaInput.value.trim().toLowerCase();
        if (busqueda) f = f.filter((x) => String(x.Emisor || "").toLowerCase().includes(busqueda));
        if (anioSel.value !== "(todos)") f = f.filter((x) => x._anio === Number(anioSel.value));
        if (mesSel.value !== "(todos)") f = f.filter((x) => x._mes === Number(mesSel.value));

        contenido.querySelector("#fe_resumen").textContent =
          `${f.length.toLocaleString("en-US")} de ${filas.length.toLocaleString("en-US")} facturas — Valor y `
          + "Fecha vienen del XML adjunto a cada correo, no del texto del mensaje.";

        const ordenadas = [...f].sort((a, b) => (parseFechaISO(b.Fecha) || "").localeCompare(parseFechaISO(a.Fecha) || ""));
        contenido.querySelector("#fe_tabla").innerHTML = `
          <thead><tr><th>Fecha</th><th>Emisor</th><th>NIT Emisor</th><th>Número Documento</th>
            <th>Tipo Documento</th><th>Valor</th><th>Correo</th></tr></thead>
          <tbody>${ordenadas.map((x) => `<tr>
            <td>${x.Fecha ?? ""}</td><td>${x.Emisor ?? ""}</td><td>${x.NitEmisor ?? ""}</td>
            <td>${x.NumeroDocumento ?? ""}</td><td>${x.TipoDocumento ?? ""}</td>
            <td>${typeof x.Valor === "number" && x.Valor > 0 ? fmtMoneda(x.Valor) : ""}</td>
            <td>${x._correo ? `<a href="${x._correo}" target="_blank" rel="noopener">Abrir ↗</a>` : ""}</td>
          </tr>`).join("")}</tbody>
        `;
      }

      [anioSel, mesSel].forEach((el) => el.addEventListener("change", actualizar));
      busquedaInput.addEventListener("input", actualizar);
      actualizar();
    } catch (err) {
      contenido.innerHTML = `<div class="error">Error cargando el Sheet: ${err.message}</div>`;
      console.error(err);
    }
  }

  function renderForm(formDiv, container) {
    formDiv.innerHTML = `
      <h4>➕ Agregar una factura electrónica manualmente</h4>
      <form id="form_factura">
        <div class="row">
          <div><label>Fecha</label><br><input type="date" id="fac_fecha" required></div>
          <div><label>Valor (dejalo en 0 si no lo sabés)</label><br><input type="number" id="fac_valor" min="0" step="any" value="0"></div>
        </div>
        <div class="campo"><label>Emisor (razón social)</label><br><input type="text" id="fac_emisor" class="input-texto" required></div>
        <div class="row">
          <div><label>NIT Emisor</label><br><input type="text" id="fac_nit"></div>
          <div><label>Número de Documento</label><br><input type="text" id="fac_numero" required></div>
        </div>
        <div class="campo"><label>Tipo de Documento</label><br>
          <input type="text" id="fac_tipo" class="input-texto" value="Factura Electrónica de Venta"></div>
        <div class="campo"><label>Notas (opcional)</label><br><input type="text" id="fac_notas" class="input-texto"></div>
        <button type="submit" id="fac_guardar">💾 Guardar factura</button>
      </form>
      <div class="aviso" id="fac_msg" hidden></div>
    `;
    formDiv.querySelector("#fac_fecha").valueAsDate = new Date();

    formDiv.querySelector("#form_factura").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = formDiv.querySelector("#fac_msg");
      const btn = formDiv.querySelector("#fac_guardar");
      const g = (id) => formDiv.querySelector(id).value;
      const emisor = g("#fac_emisor").trim();
      const numero = g("#fac_numero").trim();
      const nit = g("#fac_nit").trim();
      if (!emisor || !numero) {
        mostrarMsg(msg, "Emisor y Número de Documento son obligatorios.", true);
        return;
      }
      btn.disabled = true;
      btn.textContent = "Guardando…";
      try {
        const raw = await SheetsApi.batchGet(["facturacion_electronica"]);
        const existentes = filasAObjetos(raw.facturacion_electronica, COLS, ["Fecha"]);
        const yaExiste = existentes.some((f) => String(f.NitEmisor) === nit && String(f.NumeroDocumento) === numero);
        if (yaExiste) {
          mostrarMsg(msg, "Ya existía una factura con ese Emisor + Número de Documento — no se agregó de nuevo.", true);
        } else {
          const valor = Number(g("#fac_valor")) || 0;
          await SheetsApi.appendRows(RANGOS.facturacion_electronica, [[
            g("#fac_fecha"), nit, emisor, numero, g("#fac_tipo").trim(), valor > 0 ? valor : "", "", g("#fac_notas").trim(),
          ]]);
          mostrarMsg(msg, "Factura agregada.", false);
          formDiv.querySelector("#form_factura").reset();
          formDiv.querySelector("#fac_fecha").valueAsDate = new Date();
          formDiv.querySelector("#fac_tipo").value = "Factura Electrónica de Venta";
          await recargarTabla(container);
        }
      } catch (err) {
        mostrarMsg(msg, `No pude guardar: ${err.message}`, true);
        console.error(err);
      } finally {
        btn.disabled = false;
        btn.textContent = "💾 Guardar factura";
      }
    });
  }

  function mostrarMsg(el, texto, esError) {
    el.hidden = false;
    el.textContent = texto;
    el.style.background = esError ? "var(--error-bg)" : "var(--success-bg)";
    el.style.color = esError ? "var(--error-text)" : "var(--success-text)";
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  return { render };
})();
