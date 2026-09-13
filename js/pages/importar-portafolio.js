// Puerto de _render_importar_portafolios() (app_presupuesto.py): reconstruye
// posiciones abiertas, historial de operaciones y depósitos/retiros a partir
// de reportes CSV de un broker, y concilia esos flujos contra la cuenta 1031
// (Egresos - Efectivo + Otros Ingresos) antes de guardar todo en el Sheet.
//
// Formatos CSV admitidos (mismos que Python, mismo criterio de detección por
// encabezados): "reporte de portafolio" (Hapi/Interactive Brokers/Binance,
// columnas Transaction Type/Symbol/Trade Date), movimientos de Binance
// (Operación/Moneda/Cambiar) y Acciones y Valores / Trii (Fecha y hora +
// Tipo de orden/Símbolo de la acción, o Tipo de movimiento para depósitos/
// retiros).
//
// TODAVÍA NO admite el PDF "Transaction History" de Interactive Brokers:
// Python lo lee con pdfplumber.extract_tables(), que ubica columnas por las
// líneas/espacios reales del PDF -- sin un extracto de ejemplo para probar
// contra un parser hecho a mano con pdf.js (que solo da texto posicionado,
// no tablas), el riesgo de reconstruir mal una columna (cantidad/precio) y
// guardar un monto financiero incorrecto es demasiado alto. Para ese caso
// puntual seguí usando la versión de Streamlit mientras tanto.
const ImportarPortafolio = (() => {
  // -----------------------------------------------------------------------
  // Parser CSV genérico (equivalente a csv.DictReader) -- maneja comillas y
  // comas dentro de campos, que un split(",") simple rompería.
  // -----------------------------------------------------------------------
  function parseCSV(texto) {
    if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
    const filas = [];
    let fila = [], campo = "", enComillas = false;
    for (let i = 0; i < texto.length; i++) {
      const c = texto[i];
      if (enComillas) {
        if (c === '"') {
          if (texto[i + 1] === '"') { campo += '"'; i++; } else enComillas = false;
        } else campo += c;
      } else if (c === '"') {
        enComillas = true;
      } else if (c === ",") {
        fila.push(campo); campo = "";
      } else if (c === "\r") {
        // el \n que sigue cierra la fila
      } else if (c === "\n") {
        fila.push(campo); campo = ""; filas.push(fila); fila = [];
      } else {
        campo += c;
      }
    }
    if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
    if (!filas.length) return { registros: [], campos: new Set() };
    const encabezados = filas[0].map((h) => h.trim());
    const registros = filas.slice(1)
      .filter((f) => f.some((v) => v !== ""))
      .map((f) => {
        const obj = {};
        encabezados.forEach((h, i) => { obj[h] = f[i] !== undefined ? f[i] : ""; });
        return obj;
      });
    return { registros, campos: new Set(encabezados) };
  }

  function parseFloatUS(v) {
    if (v === undefined || v === null || v === "") return 0;
    const n = parseFloat(String(v).replace(/,/g, ""));
    return isNaN(n) ? 0 : n;
  }

  // Puerto de _fecha_compacta() (app_presupuesto.py) -- "yyyymmdd" -> ISO.
  function fechaCompacta(v) {
    const s = String(v).trim();
    if (!/^\d{8}$/.test(s)) throw new Error(`Fecha no reconocida: ${v}`);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }

  // Puerto de _fecha_espanol() (app_presupuesto.py).
  const MESES_ES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sept: 9, sep: 9, oct: 10, nov: 11, dic: 12 };
  function fechaEspanol(valor) {
    const m = String(valor || "").toLowerCase().match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
    if (!m || !(m[2] in MESES_ES)) throw new Error(`Fecha no reconocida: ${valor}`);
    return `${m[3]}-${String(MESES_ES[m[2]]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
  }

  // -----------------------------------------------------------------------
  // Puerto de resumen_operaciones_inversion()/posiciones_binance_desde_
  // movimientos() (cuenta_formatos.py) -- reconstruye posiciones abiertas
  // (largas y cortas) con costo promedio a partir de una lista de compras/
  // ventas/cortos/coberturas.
  // -----------------------------------------------------------------------
  const ETFS = new Set(["KWEB", "SPYL", "USO", "XOP", "IUES", "IWVL", "VOO", "CSPXCO", "IUESCO"]);
  const PRIORIDAD_OP = { BUY: 0, SHORT: 0, SELL: 1, COVER: 1 };

  function resumenOperacionesInversion(operaciones, plataforma) {
    const estado = {};
    const indexadas = operaciones.map((op, i) => [i, op]);
    // Los extractos suelen venir en orden descendente -- dentro de una misma
    // fecha, compras antes que ventas (mismo motivo que la versión Python).
    indexadas.sort((a, b) => {
      const [ia, opA] = a, [ib, opB] = b;
      const fa = opA.date || "0000-00-00", fb = opB.date || "0000-00-00";
      if (fa !== fb) return fa < fb ? -1 : 1;
      const ta = String(opA.time ?? ""), tb = String(opB.time ?? "");
      if (ta !== tb) return ta < tb ? -1 : 1;
      const pa = PRIORIDAD_OP[String(opA.type).toUpperCase()] ?? 9;
      const pb = PRIORIDAD_OP[String(opB.type).toUpperCase()] ?? 9;
      if (pa !== pb) return pa - pb;
      return ia - ib;
    });

    const historial = [];
    for (const [, op] of indexadas) {
      const simbolo = String(op.symbol || "").trim().toUpperCase();
      const tipo = String(op.type || "").trim().toUpperCase();
      if (!simbolo || !["BUY", "SELL", "SHORT", "COVER"].includes(tipo)) continue;
      const cantidad = Math.abs(Number(op.quantity) || 0);
      const precio = Number(op.price) || 0;
      const comision = Math.abs(Number(op.commission) || 0);
      if (cantidad <= 0 || precio <= 0) continue;
      if (!estado[simbolo]) {
        estado[simbolo] = { largos: 0, costoLargos: 0, cortos: 0, ingresoCortos: 0, ultimoPrecio: 0, precioActual: 0, nombre: "" };
      }
      const pos = estado[simbolo];
      let realizadoOp = 0;
      if (tipo === "BUY") {
        pos.largos += cantidad;
        pos.costoLargos += cantidad * precio + comision;
      } else if (tipo === "SELL" && pos.largos > 0) {
        const cierre = Math.min(cantidad, pos.largos);
        const costoPromedio = pos.costoLargos / pos.largos;
        const comisionCierre = (comision * cierre) / cantidad;
        realizadoOp = cierre * precio - comisionCierre - cierre * costoPromedio;
        pos.largos -= cierre;
        pos.costoLargos -= cierre * costoPromedio;
        if (pos.largos < 1e-8) { pos.largos = 0; pos.costoLargos = 0; }
      } else if (tipo === "SHORT") {
        pos.cortos += cantidad;
        pos.ingresoCortos += cantidad * precio - comision;
      } else if (tipo === "COVER" && pos.cortos > 0) {
        const cierre = Math.min(cantidad, pos.cortos);
        const ingresoPromedio = pos.ingresoCortos / pos.cortos;
        const comisionCierre = (comision * cierre) / cantidad;
        realizadoOp = cierre * ingresoPromedio - cierre * precio - comisionCierre;
        pos.cortos -= cierre;
        pos.ingresoCortos -= cierre * ingresoPromedio;
        if (pos.cortos < 1e-8) { pos.cortos = 0; pos.ingresoCortos = 0; }
      }
      pos.ultimoPrecio = precio;
      if (op.current_price !== undefined && op.current_price !== null && op.current_price !== "") {
        pos.precioActual = Number(op.current_price);
      }
      pos.nombre = op.name || pos.nombre;
      historial.push({
        fecha: op.date, plataforma, moneda: op.moneda || "USD", activo: simbolo, operacion: tipo,
        cantidad, precio, comision, resultado_realizado: realizadoOp, fuente: String(op.source || ""),
      });
    }

    const resultado = [];
    for (const simbolo of Object.keys(estado).sort()) {
      const pos = estado[simbolo];
      const cantidad = pos.largos - pos.cortos;
      if (Math.abs(cantidad) <= 1e-8) continue;
      const precioCompra = cantidad > 0 ? pos.costoLargos / pos.largos : pos.ingresoCortos / pos.cortos;
      resultado.push({
        ticker: `${plataforma} - ${simbolo}`, tipo: ETFS.has(simbolo) ? "ETF" : "Acción",
        cantidad, precio_compra: precioCompra, precio_actual: pos.precioActual || pos.ultimoPrecio,
      });
    }
    const estadosFinales = {};
    for (const simbolo of Object.keys(estado)) {
      const neta = estado[simbolo].largos - estado[simbolo].cortos;
      estadosFinales[simbolo] = neta > 1e-8 ? "Abierta larga" : neta < -1e-8 ? "Abierta corta" : "Cerrada";
    }
    for (const fila of historial) fila.estado = estadosFinales[fila.activo];
    return { posiciones: resultado, historial };
  }

  function posicionesBinanceDesdeMovimientos(movimientos) {
    const saldos = {};
    for (const mov of movimientos) {
      const moneda = String(mov["Moneda"] || "").trim().toUpperCase();
      if (!moneda || moneda === "COP") continue;
      saldos[moneda] = (saldos[moneda] || 0) + parseFloatUS(mov["Cambiar"]);
    }
    return Object.keys(saldos).sort().filter((m) => saldos[m] > 1e-10).map((moneda) => ({
      ticker: `Binance - ${moneda}`, tipo: "Cripto", cantidad: saldos[moneda], precio_compra: 0, precio_actual: 0, moneda: "dolares",
    }));
  }

  // -----------------------------------------------------------------------
  // Parsers por formato -- puerto de _parse_portfolio_csv()/_parse_binance_
  // csv()/_parse_acciones_valores_csv()/_parse_inversion_csv() (app_presupuesto.py).
  // -----------------------------------------------------------------------
  function parsePortfolioCSV(registros, nombreArchivo) {
    const tipos = new Set(registros.map((f) => String(f["Transaction Type"] || "").toUpperCase()));
    const simbolos = new Set(registros.map((f) => String(f["Symbol"] || "").toUpperCase()));
    let plataforma;
    if (["SHORT", "COVER"].some((t) => tipos.has(t))) plataforma = "Interactive Brokers";
    else if ([...simbolos].some((s) => s.endsWith("-USD"))) plataforma = "Binance";
    else plataforma = "Hapi";

    const operaciones = [], flujos = [];
    for (const fila of registros) {
      const tipo = String(fila["Transaction Type"] || "").toUpperCase();
      const simbolo = String(fila["Symbol"] || "").trim();
      const fechaTxt = fila["Trade Date"];
      if (!fechaTxt) continue;
      const fecha = fechaCompacta(fechaTxt);
      if (simbolo === "$$CASH_TX") {
        if (["DEPOSIT", "WITHDRAWAL", "WITHDRAW"].includes(tipo)) {
          const esRetiro = tipo !== "DEPOSIT";
          const monto = Math.abs(parseFloatUS(fila["Quantity"]));
          flujos.push({ fecha, monto_origen: esRetiro ? -monto : monto, moneda_origen: "USD", plataforma,
            moneda_cuenta: "dolares", tipo_flujo: esRetiro ? "Retiro" : "Depósito", fuente: nombreArchivo });
        }
        continue;
      }
      if (["BUY", "SELL", "SHORT", "COVER"].includes(tipo)) {
        const simboloOperacion = plataforma === "Binance" && simbolo.endsWith("-USD") ? simbolo.slice(0, -4) : simbolo;
        operaciones.push({
          date: fecha, time: fila["Time"], symbol: simboloOperacion, type: tipo,
          quantity: parseFloatUS(fila["Quantity"]), price: parseFloatUS(fila["Purchase Price"]),
          commission: parseFloatUS(fila["Commission"]), current_price: parseFloatUS(fila["Current Price"]),
          name: simboloOperacion, source: nombreArchivo, moneda: "USD",
        });
      }
    }
    const { posiciones, historial } = resumenOperacionesInversion(operaciones, plataforma);
    for (const posicion of posiciones) {
      posicion.moneda = "dolares";
      posicion.cotizacion_reportada = true;
      if (plataforma === "Interactive Brokers") posicion.ticker = posicion.ticker.replace("Interactive Brokers - ", "IBKR - ");
      if (plataforma === "Binance") posicion.tipo = "Cripto";
    }
    return { posiciones, flujos, historial };
  }

  function parseBinanceCSV(registros, campos, nombreArchivo) {
    if (campos.has("ID de transacción (TXID)")) return { posiciones: [], flujos: [], historial: [] };
    const flujos = [];
    for (const fila of registros) {
      const fecha = String(fila["Hora"] || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
      const monto = parseFloatUS(fila["Cambiar"]);
      const operacion = String(fila["Operación"] || "").trim();
      const moneda = String(fila["Moneda"] || "").trim().toUpperCase();
      if (operacion === "Deposit" && moneda === "COP" && monto > 0) {
        flujos.push({ fecha, monto_origen: monto, moneda_origen: "COP", plataforma: "Binance", moneda_cuenta: "dolares", tipo_flujo: "Depósito", fuente: nombreArchivo });
      } else if (operacion === "P2P Trading" && monto !== 0) {
        flujos.push({ fecha, monto_origen: monto, moneda_origen: moneda, plataforma: "Binance", moneda_cuenta: "dolares", tipo_flujo: monto > 0 ? "Depósito" : "Retiro", fuente: nombreArchivo });
      } else if (["Withdraw", "Withdrawal"].includes(operacion) && monto < 0) {
        flujos.push({ fecha, monto_origen: monto, moneda_origen: moneda, plataforma: "Binance", moneda_cuenta: "dolares", tipo_flujo: "Retiro", fuente: nombreArchivo });
      } else if (operacion === "Buy Crypto With Fiat" && monto > 0) {
        // Este export de Binance omite el importe fiat -- se concilia solo
        // si hay una única salida bancaria ese día (ver cruzarFlujos1031()).
        flujos.push({ fecha, monto_origen: monto, moneda_origen: moneda, plataforma: "Binance", moneda_cuenta: "dolares", tipo_flujo: "Depósito", fuente: nombreArchivo, importe_fiat_desconocido: true });
      }
    }
    return { posiciones: posicionesBinanceDesdeMovimientos(registros), flujos, historial: [] };
  }

  function parseAccionesValoresCSV(registros, campos, nombreArchivo) {
    if (campos.has("Tipo de movimiento")) {
      const flujos = [];
      for (const fila of registros) {
        const tipoMovimiento = String(fila["Tipo de movimiento"] || "").trim();
        if (fila["Estado"] !== "Aprobado" || !["Depósito", "Retiro"].includes(tipoMovimiento)) continue;
        const esRetiro = tipoMovimiento === "Retiro";
        const monto = Math.abs(parseFloatUS(fila["Valor total"]));
        flujos.push({ fecha: fechaEspanol(fila["Fecha y hora"]), monto_origen: esRetiro ? -monto : monto, moneda_origen: "COP",
          plataforma: "Acciones y Valores", moneda_cuenta: "pesos", tipo_flujo: esRetiro ? "Retiro" : "Depósito", fuente: nombreArchivo });
      }
      return { posiciones: [], flujos, historial: [] };
    }
    const operaciones = [];
    for (const fila of registros) {
      if (fila["Estado"] !== "Aprobado") continue;
      const tipo = { "Compra": "BUY", "Venta": "SELL" }[fila["Tipo de orden"]];
      if (!tipo) continue;
      const cantidadTxt = String(fila["Acciones completadas"] || "0").split("/")[0];
      operaciones.push({
        date: fechaEspanol(fila["Fecha y hora"]), symbol: fila["Símbolo de la acción"], type: tipo,
        quantity: parseFloatUS(cantidadTxt), price: parseFloatUS(fila["Precio por acción"]),
        commission: parseFloatUS(fila["Valor comisión"]), moneda: "COP", source: nombreArchivo,
      });
    }
    const { posiciones, historial } = resumenOperacionesInversion(operaciones, "Acciones y Valores");
    for (const p of posiciones) p.moneda = "pesos";
    return { posiciones, flujos: [], historial };
  }

  function parseInversionCSV(texto, nombreArchivo) {
    const { registros, campos } = parseCSV(texto);
    if (["Transaction Type", "Symbol", "Trade Date"].every((c) => campos.has(c))) {
      return parsePortfolioCSV(registros, nombreArchivo);
    }
    if (["Operación", "Moneda", "Cambiar"].every((c) => campos.has(c)) || campos.has("ID de transacción (TXID)")) {
      return parseBinanceCSV(registros, campos, nombreArchivo);
    }
    if (campos.has("Fecha y hora") && (["Tipo de orden", "Símbolo de la acción"].every((c) => campos.has(c)) || campos.has("Tipo de movimiento"))) {
      return parseAccionesValoresCSV(registros, campos, nombreArchivo);
    }
    throw new Error(`Formato CSV no reconocido: ${nombreArchivo}`);
  }

  // Puerto de _deduplicar_posiciones_importadas() -- consolida posiciones
  // repetidas cuando dos reportes se solapan.
  function deduplicarPosicionesImportadas(posiciones) {
    const unicas = new Map();
    for (const posicion of posiciones) {
      const ticker = String(posicion.ticker || "").trim();
      if (!ticker) continue;
      const anterior = unicas.get(ticker);
      if (!anterior) { unicas.set(ticker, { ...posicion }); continue; }
      const combinada = { ...anterior };
      for (const campo of ["tipo", "moneda", "cantidad", "precio_compra"]) {
        const v = posicion[campo];
        if (v !== undefined && v !== null && v !== "" && v !== 0) combinada[campo] = v;
      }
      if (posicion.cotizacion_reportada || !combinada.precio_actual) {
        combinada.precio_actual = posicion.precio_actual !== undefined ? posicion.precio_actual : (combinada.precio_actual || 0);
      }
      combinada.cotizacion_reportada = !!(combinada.cotizacion_reportada || posicion.cotizacion_reportada);
      unicas.set(ticker, combinada);
    }
    return [...unicas.values()];
  }

  // -----------------------------------------------------------------------
  // Cruce con la cuenta 1031 -- puerto de _cruzar_flujos_1031() (app_presupuesto.py).
  // -----------------------------------------------------------------------
  const PALABRAS_1031 = {
    "Hapi": ["MONO COLOMBIA"],
    "Interactive Brokers": ["SOLUCIONES DE PAGOS"],
    "Acciones y Valores": ["ACCIONES Y VAL"],
    "Binance": ["BINANCE", "MOVII", "COLOCA GRO"],
  };

  function fechaUTC(iso) { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); }
  function diffDias(aISO, bISO) { return Math.round((fechaUTC(aISO) - fechaUTC(bISO)) / 86400000); }

  function cruzarFlujos1031(flujos, egresos, ingresos) {
    const movimientos = [];
    egresos.forEach((fila, i) => {
      const fechaMov = parseFechaISO(fila.FechaCompra);
      if (!fechaMov) return;
      movimientos.push({ idx: `egreso-${i}`, fecha: fechaMov, concepto: String(fila.Comercio || ""), cop: Math.abs(toNumber(fila.ValorTotal)), direccion: "salida" });
    });
    ingresos.forEach((fila, i) => {
      const fechaMov = parseFechaISO(fila.Fecha);
      if (!fechaMov) return;
      movimientos.push({ idx: `ingreso-${i}`, fecha: fechaMov, concepto: String(fila.Concepto || ""), cop: Math.abs(toNumber(fila.Valor)), direccion: "entrada" });
    });
    const usados = new Set();
    const cruces = [];
    const ordenados = [...flujos].sort((a, b) => a.fecha.localeCompare(b.fecha) || Math.abs(b.monto_origen) - Math.abs(a.monto_origen));
    for (const flujo of ordenados) {
      const esRetiro = flujo.tipo_flujo === "Retiro" || flujo.monto_origen < 0;
      let candidatos = [];
      for (const mov of movimientos) {
        if (mov.direccion !== (esRetiro ? "entrada" : "salida")) continue;
        if (usados.has(mov.idx)) continue;
        const retraso = esRetiro ? diffDias(mov.fecha, flujo.fecha) : diffDias(flujo.fecha, mov.fecha);
        if (retraso < 0 || retraso > 7) continue;
        const palabrasPlataforma = PALABRAS_1031[flujo.plataforma] || [];
        const conceptoUpper = mov.concepto.toUpperCase();
        if (!(palabrasPlataforma.some((p) => conceptoUpper.includes(p)) || (esRetiro && conceptoUpper.includes("FONDO DE INVERS")))) continue;
        const monto = Math.abs(flujo.monto_origen), moneda = flujo.moneda_origen;
        if (moneda === "COP") {
          const diferencia = Math.abs(mov.cop - monto);
          if (diferencia <= Math.max(1, monto * 0.001)) candidatos.push([retraso + diferencia / Math.max(monto, 1), mov, 1.0]);
        } else if (flujo.importe_fiat_desconocido) {
          if (retraso === 0) candidatos.push([0, mov, 0.0]);
        } else if (monto >= 10) {
          const tasa = mov.cop / monto;
          if (tasa >= 2500 && tasa <= 5500) candidatos.push([retraso + Math.abs(tasa - 3800) / 1000, mov, tasa]);
        }
      }
      if (flujo.importe_fiat_desconocido && candidatos.length !== 1) candidatos = [];
      if (candidatos.length) {
        candidatos.sort((a, b) => a[0] - b[0]);
        const [, mov, tasa] = candidatos[0];
        usados.add(mov.idx);
        cruces.push({ ...flujo, fecha_1031: mov.fecha, concepto_1031: mov.concepto, cop: esRetiro ? -mov.cop : mov.cop, tasa_implicita: tasa, estado: "Conciliado" });
      } else {
        cruces.push({ ...flujo, fecha_1031: null, concepto_1031: "", cop: 0, tasa_implicita: 0, estado: `Sin ${esRetiro ? "entrada" : "salida"} 1031 identificada` });
      }
    }
    return cruces;
  }

  function flujosGuardablesDeCruces(cruces) {
    const guardables = [];
    for (const cruce of cruces) {
      if (cruce.estado === "Conciliado") guardables.push(cruce);
      else if (cruce.moneda_origen === "COP") {
        // El reporte del broker trae el importe exacto en COP -- sigue
        // siendo una fuente válida aunque no se haya podido emparejar con
        // el texto bancario.
        const esRetiro = cruce.tipo_flujo === "Retiro" || cruce.monto_origen < 0;
        guardables.push({ ...cruce, fecha_1031: cruce.fecha, cop: esRetiro ? -Math.abs(cruce.monto_origen) : Math.abs(cruce.monto_origen) });
      }
    }
    return guardables;
  }

  // Puerto de "{:.8g}" de Python -- solo para el texto de Notas, no entra en
  // ningún cálculo.
  function formatG(n) {
    if (!isFinite(n)) return String(n);
    let s = n.toPrecision(8);
    if (s.includes("e") || s.includes("E")) return String(n);
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }

  // -----------------------------------------------------------------------
  // Guardado -- puerto del bloque "Guardar posiciones, historial y flujos"
  // de _render_importar_portafolios().
  // -----------------------------------------------------------------------
  function claveHistorialDeObjeto(f) {
    const fechaISO = parseFechaISO(f.Fecha) || String(f.Fecha ?? "").trim();
    const num = (v) => Math.round(toNumber(v) * 1e8) / 1e8;
    return [fechaISO, String(f.Plataforma ?? ""), String(f.Activo ?? ""), String(f.Operacion ?? "").toUpperCase(), num(f.Cantidad), num(f.Precio), num(f.Comision)].join("|||");
  }
  function claveHistorialDeFila(fila) {
    return claveHistorialDeObjeto({ Fecha: fila[0], Plataforma: fila[1], Activo: fila[3], Operacion: fila[4], Cantidad: fila[5], Precio: fila[6], Comision: fila[7] });
  }

  function prefijosDeMoneda(nuevas, historial, moneda) {
    const prefijosImportados = new Set(historial.map((h) => (h.plataforma === "Interactive Brokers" ? "IBKR" : h.plataforma)));
    const prefijosMoneda = new Set(nuevas.map((p) => p.ticker.split(" - ")[0]));
    const permitido = moneda === "dolares" ? new Set(["IBKR", "Binance", "Hapi"]) : new Set(["Acciones y Valores", "Trii"]);
    for (const p of prefijosImportados) if (permitido.has(p)) prefijosMoneda.add(p);
    return prefijosMoneda;
  }

  function combinarPosiciones(existentes, nuevas, prefijosMoneda) {
    const combinadas = new Map();
    for (const fila of existentes) {
      const ticker = String(fila.TickerFondo || "").trim();
      if (!ticker) continue;
      const prefijo = ticker.includes(" - ") ? ticker.split(" - ")[0] : ticker;
      const esEfectivoMargen = ticker.endsWith("Efectivo/Margen");
      if (prefijosMoneda.has(prefijo) && !esEfectivoMargen) continue;
      combinadas.set(ticker, { ticker, tipo: fila.Tipo || "", cantidad: toNumber(fila.Cantidad), precio_compra: toNumber(fila.PrecioCompra), precio_actual: toNumber(fila.PrecioActual) });
    }
    for (const posicion of nuevas) {
      const anterior = combinadas.get(posicion.ticker);
      if (anterior) {
        for (const campo of ["precio_compra", "precio_actual"]) {
          if (!posicion[campo] && anterior[campo]) posicion[campo] = anterior[campo];
        }
      }
      combinadas.set(posicion.ticker, posicion);
    }
    return [...combinadas.values()];
  }

  // Puerto de set_posiciones_inversion() -- nunca toca Costo Total/Valor
  // Actual/Ganancia-Pérdida (columnas E/G/H, fórmulas del Sheet).
  async function guardarPosicionesInversion(moneda, filas) {
    const rango = moneda === "pesos" ? RANGOS.posiciones_pesos : RANGOS.posiciones_dolares;
    const hoja = rango.split("!")[0];
    const m = rango.match(/![A-Z]+(\d+):[A-Z]+(\d+)/);
    const first = Number(m[1]), last = Number(m[2]);
    const capacidad = last - first + 1;
    if (filas.length > capacidad) throw new Error(`Máximo ${capacidad} posiciones en ${moneda} -- hay ${filas.length}.`);
    const data = [];
    for (let i = 0; i < capacidad; i++) {
      const filaNum = first + i;
      if (i < filas.length) {
        const f = filas[i];
        data.push({ range: `${hoja}!A${filaNum}:D${filaNum}`, values: [[f.ticker, f.tipo, f.cantidad, f.precio_compra]] });
        data.push({ range: `${hoja}!F${filaNum}`, values: [[f.precio_actual]] });
      } else {
        data.push({ range: `${hoja}!A${filaNum}:D${filaNum}`, values: [["", "", "", ""]] });
        data.push({ range: `${hoja}!F${filaNum}`, values: [[""]] });
      }
    }
    await SheetsApi.batchUpdateRanges(data);
  }

  // Puerto de agregar_aportes_inversion() -- no duplica por fecha/plataforma/monto.
  async function agregarAportesInversion(moneda, filasNuevas, aportesExistentes) {
    const fechaClave = (v) => parseFechaISO(v) || String(v).trim();
    const claves = new Set(aportesExistentes.map((r) => `${fechaClave(r.Fecha)}|||${r.Plataforma}|||${Math.round(toNumber(r.MontoTransferido) * 100) / 100}`));
    const nuevas = [];
    for (const fila of filasNuevas) {
      const clave = `${fechaClave(fila[0])}|||${fila[1]}|||${Math.round(fila[2] * 100) / 100}`;
      if (!claves.has(clave)) { nuevas.push(fila); claves.add(clave); }
    }
    if (nuevas.length) {
      const rango = moneda === "pesos" ? RANGOS.aportes_inversion_pesos : RANGOS.aportes_inversion_dolares;
      await SheetsApi.appendRows(rango, nuevas);
    }
    return nuevas.length;
  }

  // Puerto de agregar_historial_inversion() -- misma clave económica que
  // claveHistorial() de PaginaInversiones (excluye Fuente y Resultado
  // Realizado), para que volver a subir el mismo reporte no duplique.
  async function agregarHistorialInversion(filasNuevas, historialExistente) {
    const claves = new Set(historialExistente.map(claveHistorialDeObjeto));
    const nuevas = [];
    for (const fila of filasNuevas) {
      const clave = claveHistorialDeFila(fila);
      if (!claves.has(clave)) { nuevas.push(fila); claves.add(clave); }
    }
    if (nuevas.length) await SheetsApi.appendRows(RANGOS.historial_inversion, nuevas);
    return nuevas.length;
  }

  // Puerto de recategorizar_comercios(mapeo, solo_otros=False) -- los pagos
  // PSE que financian estas plataformas quedaban categorizados como un
  // gasto genérico; se recategorizan a "Inversiones" para no contarlos dos
  // veces (como gasto Y como aporte).
  const MAPEO_RECATEGORIZAR = {
    "PAGO PSE MONO COLOMBIA SAS": "Inversiones",
    "PAGO PSE SOLUCIONES DE PAGOS": "Inversiones",
    "PAGO PSE ACCIONES Y VALORES S": "Inversiones",
    "PAGO PSE ACCIONES Y VALORES": "Inversiones",
  };
  async function recategorizarComercios() {
    const claves = ["efectivo_detalle", "visa_detalle", "mc_detalle"];
    const raw = await SheetsApi.batchGet(claves);
    for (const key of claves) {
      const rango = RANGOS[key];
      const hoja = rango.split("!")[0];
      const first = Number(rango.match(/![A-Z]+(\d+):/)[1]);
      const data = [];
      (raw[key] || []).forEach((row, i) => {
        const comercio = row[2] || "";
        if (MAPEO_RECATEGORIZAR[comercio] !== undefined) {
          data.push({ range: `${hoja}!I${first + i}`, values: [[MAPEO_RECATEGORIZAR[comercio]]] });
        }
      });
      if (data.length) await SheetsApi.batchUpdateRanges(data);
    }
  }

  async function guardarTodo(datos, posiciones, historial, flujosGuardables) {
    for (const moneda of ["pesos", "dolares"]) {
      const nuevas = posiciones.filter((p) => (p.moneda || "dolares") === moneda);
      const prefijosMoneda = prefijosDeMoneda(nuevas, historial, moneda);
      if (!nuevas.length && !prefijosMoneda.size) continue;
      const existentes = moneda === "pesos" ? datos.posicionesPesos : datos.posicionesDolares;
      const combinadas = combinarPosiciones(existentes, nuevas, prefijosMoneda);
      await guardarPosicionesInversion(moneda, combinadas);
    }
    let agregadosAportes = 0;
    for (const moneda of ["pesos", "dolares"]) {
      const filasAporte = flujosGuardables.filter((c) => c.moneda_cuenta === moneda).map((c) => [
        c.fecha_1031, c.plataforma, c.cop,
        `${c.tipo_flujo} ${formatG(Math.abs(c.monto_origen))} ${c.moneda_origen} el ${c.fecha} — ${c.fuente}`,
      ]);
      const existentesAportes = moneda === "pesos" ? datos.aportesPesos : datos.aportesDolares;
      agregadosAportes += await agregarAportesInversion(moneda, filasAporte, existentesAportes);
    }
    const filasHistorial = historial.map((h) => [h.fecha, h.plataforma, h.moneda, h.activo, h.operacion, h.cantidad, h.precio, h.comision, h.resultado_realizado, h.fuente]);
    const operacionesAgregadas = await agregarHistorialInversion(filasHistorial, datos.historial);
    await recategorizarComercios();
    return { totalPosiciones: posiciones.length, operacionesAgregadas, agregadosAportes };
  }

  // -----------------------------------------------------------------------
  // Interfaz
  // -----------------------------------------------------------------------
  function agruparHistorialResumen(historial) {
    const grupos = new Map();
    for (const f of historial) {
      const key = `${f.plataforma}|||${f.activo}|||${f.estado}`;
      if (!grupos.has(key)) grupos.set(key, { plataforma: f.plataforma, activo: f.activo, estado: f.estado, operaciones: 0, resultado: 0 });
      const g = grupos.get(key);
      g.operaciones += 1;
      g.resultado += f.resultado_realizado;
    }
    return [...grupos.values()];
  }

  function render(div, datos, recargar) {
    div.innerHTML = `
      <details id="imp_detalle">
        <summary>📥 Importar portafolios y conciliar flujos con la cuenta 1031</summary>
        <p class="caption">Admite CSV de Hapi, Binance, Interactive Brokers (reporte de portafolio) y Acciones y
        Valores (Trii). Reconoce compras, ventas, posiciones en corto, coberturas, depósitos y retiros. El PDF
        "Transaction History" de Interactive Brokers todavía no está soportado acá -- usá
        <a href="https://presupuesto-app-jmr.streamlit.app" target="_blank" rel="noopener">la versión de
        Streamlit</a> para ese caso puntual.</p>
        <input type="file" id="imp_csv" accept=".csv" multiple>
        <div id="imp_resultado"></div>
      </details>
    `;
    div.querySelector("#imp_csv").addEventListener("change", (ev) => onArchivosSeleccionados(ev, div, datos, recargar));
  }

  async function onArchivosSeleccionados(ev, div, datos, recargar) {
    const archivos = [...ev.target.files];
    const resultado = div.querySelector("#imp_resultado");
    if (!archivos.length) { resultado.innerHTML = ""; return; }
    resultado.innerHTML = `<p class="caption">Leyendo ${archivos.length} archivo(s)…</p>`;

    let posiciones = [], flujos = [], historial = [];
    try {
      for (const archivo of archivos) {
        const texto = await archivo.text();
        const r = parseInversionCSV(texto, archivo.name);
        posiciones = posiciones.concat(r.posiciones);
        flujos = flujos.concat(r.flujos);
        historial = historial.concat(r.historial);
      }
    } catch (err) {
      resultado.innerHTML = `<div class="error">No pude interpretar los archivos: ${err.message}</div>`;
      console.error(err);
      return;
    }

    posiciones = deduplicarPosicionesImportadas(posiciones);

    let html = "";
    if (posiciones.length) {
      html += `<p><strong>Posiciones abiertas detectadas: ${posiciones.length}</strong></p>
        <div class="tabla-scroll" style="max-height:260px;"><table class="tabla">
          <thead><tr><th>Posición</th><th>Tipo</th><th>Cantidad</th><th>Precio compra promedio</th><th>Precio actual/provisional</th></tr></thead>
          <tbody>${posiciones.map((p) => `<tr><td>${p.ticker}</td><td>${p.tipo}</td>
            <td>${Number(p.cantidad).toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
            <td>${Number(p.precio_compra).toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
            <td>${Number(p.precio_actual).toLocaleString("en-US", { maximumFractionDigits: 4 })}</td></tr>`).join("")}</tbody>
        </table></div>`;
    }

    const resumenHist = agruparHistorialResumen(historial);
    if (resumenHist.length) {
      html += `<p><strong>Posiciones abiertas, cortas y cerradas detectadas</strong></p>
        <div class="tabla-scroll" style="max-height:260px;"><table class="tabla">
          <thead><tr><th>Plataforma</th><th>Activo</th><th>Estado</th><th>Operaciones</th><th>Resultado realizado</th></tr></thead>
          <tbody>${resumenHist.map((r) => `<tr><td>${r.plataforma}</td><td>${r.activo}</td><td>${r.estado}</td>
            <td>${r.operaciones}</td><td>${r.resultado.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr>`).join("")}</tbody>
        </table></div>`;
    }

    resultado.innerHTML = html || `<p class="caption">No se detectaron posiciones ni operaciones nuevas en estos archivos.</p>`;

    let cruces = [];
    if (flujos.length) {
      resultado.insertAdjacentHTML("beforeend", `<p class="caption">Conciliando ${flujos.length} depósito(s)/retiro(s) contra la cuenta 1031…</p>`);
      try {
        const raw = await SheetsApi.batchGet(["efectivo_detalle", "otros_ingresos"]);
        const EGRESO_COLS = ["PeriodoExtracto", "FechaCompra", "Comercio", "Moneda", "Cuotas", "ValorTotal", "ValorCargado", "SaldoPendiente", "Categoria", "Reembolsable", "Notas"];
        const egresos = filasAObjetos(raw.efectivo_detalle, EGRESO_COLS, ["FechaCompra"]);
        const ingresos = filasAObjetos(raw.otros_ingresos, ["Fecha", "Concepto", "Categoria", "Valor", "Notas"], ["Fecha"]);
        cruces = cruzarFlujos1031(flujos, egresos, ingresos);
      } catch (err) {
        resultado.insertAdjacentHTML("beforeend", `<div class="error">No pude leer la cuenta 1031 para conciliar: ${err.message}</div>`);
        console.error(err);
      }
    }

    if (cruces.length) {
      resultado.insertAdjacentHTML("beforeend", `
        <p><strong>Cruce de depósitos y retiros con la cuenta 1031</strong></p>
        <div class="tabla-scroll" style="max-height:260px;"><table class="tabla">
          <thead><tr><th>Flujo</th><th>Plataforma</th><th>Fecha broker</th><th>Monto origen</th><th>Moneda</th>
            <th>Fecha cuenta 1031</th><th>COP conciliado</th><th>Tasa implícita</th><th>Estado</th></tr></thead>
          <tbody>${cruces.map((c) => `<tr><td>${c.tipo_flujo}</td><td>${c.plataforma}</td><td>${c.fecha}</td>
            <td>${Number(c.monto_origen).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td><td>${c.moneda_origen}</td>
            <td>${c.fecha_1031 ?? ""}</td><td>${c.cop.toLocaleString("en-US")}</td>
            <td>${c.tasa_implicita ? c.tasa_implicita.toFixed(2) : ""}</td><td>${c.estado}</td></tr>`).join("")}</tbody>
        </table></div>
      `);
    }

    const flujosGuardables = flujosGuardablesDeCruces(cruces);
    if (posiciones.length || historial.length || flujosGuardables.length) {
      resultado.insertAdjacentHTML("beforeend", `
        <button id="imp_guardar" type="button">💾 Guardar posiciones, historial y flujos</button>
        <div id="imp_msg"></div>
      `);
      resultado.querySelector("#imp_guardar").addEventListener("click", () =>
        onGuardarImportacion(resultado, datos, posiciones, historial, flujosGuardables, recargar));
    }
  }

  async function onGuardarImportacion(resultado, datos, posiciones, historial, flujosGuardables, recargar) {
    const btn = resultado.querySelector("#imp_guardar");
    const msg = resultado.querySelector("#imp_msg");
    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      const r = await guardarTodo(datos, posiciones, historial, flujosGuardables);
      msg.innerHTML = `<div class="aviso">Guardadas ${r.totalPosiciones} posiciones, ${r.operacionesAgregadas}
        operaciones históricas y ${r.agregadosAportes} flujos de efectivo nuevos.</div>`;
      await recargar();
    } catch (err) {
      msg.innerHTML = `<div class="error">No pude guardar: ${err.message}</div>`;
      console.error(err);
      btn.disabled = false;
      btn.textContent = "💾 Guardar posiciones, historial y flujos";
    }
  }

  return {
    render,
    // guardarPosicionesInversion también la usa el editor manual de
    // Posiciones (renderEditorPosiciones() en inversiones.js) -- mismo
    // puerto de set_posiciones_inversion(), un solo lugar que sabe escribir
    // A:D+F sin tocar las columnas de fórmula.
    guardarPosicionesInversion,
    // Expuestas para pruebas.
    parseInversionCSV, deduplicarPosicionesImportadas, cruzarFlujos1031, flujosGuardablesDeCruces,
    resumenOperacionesInversion, posicionesBinanceDesdeMovimientos, combinarPosiciones, prefijosDeMoneda,
  };
})();
