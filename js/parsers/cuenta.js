// Puerto de cuenta_formatos.py + las funciones de extracto de cuenta de
// app_presupuesto.py (parse_extracto_cuenta_sheet, movimiento_cuenta,
// concepto_cuenta, categorize_cuenta, marcar_novedad_movimientos) — mismas
// reglas y las mismas tablas de categorización, para que un extracto de
// cuenta clasifique exactamente igual en las dos versiones.

const CuentaParser = (() => {
  function normalizarTexto(valor) {
    return String(valor ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
  }

  const _MESES_ES = {
    ENE: 1, ENERO: 1, FEB: 2, FEBRERO: 2, MAR: 3, MARZO: 3, ABR: 4, ABRIL: 4,
    MAY: 5, MAYO: 5, JUN: 6, JUNIO: 6, JUL: 7, JULIO: 7, AGO: 8, AGOSTO: 8,
    SEP: 9, SEPT: 9, SEPTIEMBRE: 9, OCT: 10, OCTUBRE: 10, NOV: 11, NOVIEMBRE: 11,
    DIC: 12, DICIEMBRE: 12,
  };

  // Puerto de _fecha_espanol() (cuenta_formatos.py). 'valor' puede ser un
  // string "15 ENE 2026" / "15 Ene. 2026", un objeto Date (SheetJS con
  // cellDates), o un número de serie de Excel/Sheets.
  function fechaEspanol(valor) {
    if (valor instanceof Date) return valor;
    if (typeof valor === "number") {
      // Serie de Excel/Sheets: días desde 1899-12-30 (mismo epoch que Sheets).
      const epochUTC = Date.UTC(1899, 11, 30);
      return new Date(epochUTC + valor * 86400000);
    }
    const texto = normalizarTexto(valor).replace(/\./g, "");
    const m = texto.match(/^(\d{1,2})\s+([A-Z]+)\s+(\d{4})$/);
    if (!m) throw new Error(`Fecha no reconocida: ${JSON.stringify(valor)}`);
    const [, dia, mesTexto, anio] = m;
    const mes = _MESES_ES[mesTexto];
    if (!mes) throw new Error(`Mes no reconocido en la fecha: ${JSON.stringify(valor)}`);
    return new Date(Date.UTC(Number(anio), mes - 1, Number(dia)));
  }

  function fechaISO(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }

  // Puerto de concepto_cuenta() (cuenta_formatos.py) -- unifica variantes de
  // texto del banco al mismo concepto canónico, exactamente en el mismo
  // orden de reglas que la versión Python (el orden importa: reglas más
  // específicas primero).
  function conceptoCuenta(descripcion) {
    const upper = normalizarTexto(descripcion);
    const soloDigitos = upper.replace(/\D/g, "");
    if (upper.includes("SUCURSAL VIRTUAL") && soloDigitos.includes("10312780933")) {
      return "TRANSFERENCIA MAMA 10312780933";
    }
    if (upper.includes("SUCURSAL VIRTUAL") && (soloDigitos.includes("10072477435") || soloDigitos.includes("10074277435"))) {
      return "PAGO LILI 10072477435";
    }
    if (upper.includes("SUCURSAL VIRTUAL") && soloDigitos.includes("23077460411")) {
      return "TRANSFERENCIA ESPOSA 23077460411";
    }
    if (upper.includes("HOSPITAL HPTU")) {
      if (upper.includes("PGO NOMIN") || upper.includes("CONCEPTO NOMINA")) return "PAGO DE NOMI HOSPITAL HPTU";
      return "PAGO DE PROV HOSPITAL HPTU";
    }
    if (upper.includes("UDEA UNIVERSIDA") && upper.includes("NOMINA")) return "PAGO DE NOMI UDEA UNIVERSIDA";
    if (upper.includes("SUCURSAL VIRTUAL") && (upper.includes("AL PRODUCTO") || upper.includes("DEL PRODUCTO"))) {
      const m = upper.match(/(?:AL|DEL) PRODUCTO\s+(.+)$/);
      const numero = m ? m[1].replace(/\D/g, "") : "";
      return `TRANSFERENCIA CTA SUC VIRTUAL ${numero}`.trimEnd();
    }
    if (upper.includes("TRANSFERENCIA") && upper.includes("DESDE NEQUI")) return "TRANSFERENCIA DESDE NEQUI";
    if (upper.includes("TRANSFERENCIA") && upper.includes("NEQUI")) return "TRANSFERENCIAS A NEQUI";
    if (upper.includes("RETIRO CAJERO")) return "RETIRO CAJERO";
    return String(descripcion ?? "").trim();
  }

  const NO_PRESUPUESTAR_SUFIJO = "(no presupuestar)";
  function esNoPresupuestar(categoria) {
    return typeof categoria === "string" && categoria.trim().toLowerCase().endsWith(NO_PRESUPUESTAR_SUFIJO);
  }

  const CAT_NO_PRESUPUESTAR_INGRESO = "Ajustes y Reversiones (no presupuestar)";

  // Puerto de PLATAFORMAS_INVERSION_PESOS/_DOLARES (cuenta_formatos.py).
  const PLATAFORMAS_INVERSION_PESOS = {
    "ACCIONES Y VAL": "Acciones y Valores",
    "ACCIONES-Y-VALO": "Acciones y Valores",
    TRII: "Trii",
  };
  const PLATAFORMAS_INVERSION_DOLARES = {
    PLENTI: "Plenti",
    BINANCE: "Binance",
    HAPI: "Hapi",
    "MONO COLOMBIA": "Hapi",
    "SOLUCIONES DE PAGOS": "Interactive Brokers",
  };
  const FONDO_INVERSION_PALABRAS_CLAVE = ["FONDO DE INVERSION", "FONDO DE INVERS"];

  function plataformaInversion(descripcion) {
    const upper = String(descripcion ?? "").toUpperCase();
    for (const [kw, nombre] of Object.entries(PLATAFORMAS_INVERSION_PESOS)) {
      if (upper.includes(kw)) return [nombre, "pesos"];
    }
    for (const [kw, nombre] of Object.entries(PLATAFORMAS_INVERSION_DOLARES)) {
      if (upper.includes(kw)) return [nombre, "dolares"];
    }
    return null;
  }

  function esMovimientoBroker(descripcion) {
    const upper = String(descripcion ?? "").toUpperCase();
    return plataformaInversion(descripcion) !== null || FONDO_INVERSION_PALABRAS_CLAVE.some((kw) => upper.includes(kw));
  }

  // Puerto de CUENTA_CATEGORY_EGRESO (cuenta_formatos.py).
  const CUENTA_CATEGORY_EGRESO = {
    "PAGO AUTOM TC VISA": ["Pago Tarjeta de Crédito (no presupuestar)", "Pago automático de la tarjeta Visa, ya contabilizado en el detalle de la tarjeta"],
    "PAGO AUTOM TC MASTER PESOS": ["Pago Tarjeta de Crédito (no presupuestar)", "Pago automático Mastercard (pesos), ya contabilizado en el detalle de la tarjeta"],
    "PAGO AUTOM TC MASTER DOLAR": ["Pago Tarjeta de Crédito (no presupuestar)", "Pago automático Mastercard (dólares), ya contabilizado en el detalle de la tarjeta"],
    "TRANSFERENCIA CTA SUC VIRTUAL": ["Ajustes y Reversiones (no presupuestar)", "Transferencia entre tus propias cuentas"],
    "TRANSFERENCIA ESPOSA 23077460411": ["Ajustes y Reversiones (no presupuestar)", "Transferencia enviada a la cuenta de tu esposa"],
    "TRANSFERENCIA MAMA 10312780933": ["Apoyo familiar", "Ayuda familiar — dinero enviado a tu mamá"],
    "PAGO LILI 10072477435": ["Servicio doméstico", "Pago a Lili por el servicio de aseo"],
    "TRANSFERENCIAS A NEQUI": ["Ajustes y Reversiones (no presupuestar)", "Transferencia a tu cuenta Nequi"],
    "CUOTA MANEJO CUPO ROTATIVO": ["Intereses y Cargos Financieros (no presupuestar)", ""],
    "IVA CUOTA MANEJO CUPO ROTATIVO": ["Intereses y Cargos Financieros (no presupuestar)", ""],
    "IMPTO GOBIERNO 4X1000": ["Intereses y Cargos Financieros (no presupuestar)", "Impuesto 4x1000"],
    "PAGO SURAMERICANA DE SEGUROS": ["Seguros", ""],
    "Recarga de Tarjeta Civica": ["Transporte", "Recarga tarjeta Cívica"],
    "PAGO PSE EMPRESAS PUBLICAS DE": ["Vivienda y Servicios", "EPM — servicios públicos"],
    "PAGO PSE PAGOS ELECTRONICOS S": ["Vivienda y Servicios", "Cuota del leasing habitacional pagada por PSE (el resto de la cuota la cubre el ahorro AFC que se descuenta de la nómina)"],
    "AJUSTE INTERES AHORROS DB": ["Intereses y Cargos Financieros (no presupuestar)", "Ajuste/corrección en contra de intereses de ahorros"],
    "PAGO INTERBANC JUAN": ["Ajustes y Reversiones (no presupuestar)", "Transferencia entre tus propias cuentas"],
    "DEBITO OBLIGACION SUFI": ["Pago de deuda (no presupuestar)", "Cuota automática del crédito Sufi, ya contabilizada en Deuda - Sufi"],
    "DEBITO POR ABONO CARTERA": ["Pago de deuda (no presupuestar)", "Abono automático a cartera/crédito, ya contabilizado en su hoja de Deuda"],
    "PAGO CREDITO SUC VIRTUAL": ["Pago de deuda (no presupuestar)", "Pago a un crédito hecho por Sucursal Virtual, ya contabilizado en su hoja de Deuda"],
    "DB A CUENTA POR ABONO CARTERA": ["Pago de deuda (no presupuestar)", "Abono automático a cartera/crédito, ya contabilizado en su hoja de Deuda"],
    "RETIRO TARJETA EN SUCURSAL": ["Ajustes y Reversiones (no presupuestar)", "Retiro de efectivo en sucursal — no es gasto hasta que se use el efectivo"],
    "RETIRO CAJERO": ["Ajustes y Reversiones (no presupuestar)", "Retiro de efectivo en cajero — no es gasto hasta que se use el efectivo"],
    "TRASLADO VIRTUAL OTROS BANCOS": ["Ajustes y Reversiones (no presupuestar)", "Transferencia a una cuenta tuya en otro banco"],
  };

  // Puerto de CUENTA_CATEGORY_INGRESO (cuenta_formatos.py).
  const CUENTA_CATEGORY_INGRESO = {
    "PAGO DE NOMI UDEA UNIVERSIDA": ["Honorarios / Consultoría", "Nómina UDEA"],
    "PAGO DE NOMI UNIVERSIDAD EIA": ["Honorarios / Consultoría", "Nómina EIA"],
    "PAGO DE NOMI UNIVERSIDAD PON": ["Honorarios / Consultoría", "Nómina UPB"],
    "PAGO DE PROV UNIVERSIDAD EIA": ["Honorarios / Consultoría", ""],
    "PAGO INTERBANC ASTRAZENECA COL": ["Honorarios / Consultoría", ""],
    "PAGO INTERBANC UNIVERSIDAD DE": ["Honorarios / Consultoría", ""],
    "PAGO DE PROV HOSPITAL HPTU": ["Honorarios / Consultoría", "Pago del hospital, fuera de tu nómina quincenal"],
    "DEVOLUCION ABONO TC": ["Otro", "Devolución/reversión de un abono a tarjeta"],
    "TRANSFERENCIA CTA SUC VIRTUAL": ["Otro", "Transferencia recibida por Sucursal Virtual — revisá de quién es si querés más detalle"],
    "TRANSFERENCIA ESPOSA 23077460411": ["Reembolso (esposa/otros)", "Transferencia recibida desde la cuenta de tu esposa"],
    "TRANSFERENCIAS A NEQUI": ["Otro", "Transferencia recibida vía Nequi — revisá de quién es si querés más detalle"],
    "TRANSFERENCIA DESDE NEQUI": ["Otro", "Transferencia recibida vía Nequi — revisá de quién es si querés más detalle"],
    "ABONO INTERESES AHORROS": ["Rendimientos Financieros", "Interés pagado por el banco sobre el saldo de ahorros"],
    "AJUSTE INTERES AHORROS CR": [CAT_NO_PRESUPUESTAR_INGRESO, "Ajuste/corrección a favor de intereses de ahorros"],
    "PAGO DE NOMI HOSPITAL HPTU": [CAT_NO_PRESUPUESTAR_INGRESO, "Nómina del hospital — ya contabilizada en Colillas de Pago, no duplicar"],
    "REV CUOTA MANEJO CUPO ROTATIVO": [CAT_NO_PRESUPUESTAR_INGRESO, "Reversión de la cuota de manejo"],
    "REV IVA CUOTA MANEJO CUPO ROTA": [CAT_NO_PRESUPUESTAR_INGRESO, "Reversión del IVA de la cuota de manejo"],
    "REV IMPTO GOBIERNO 4X1000": [CAT_NO_PRESUPUESTAR_INGRESO, "Reversión del 4x1000"],
    "TRASLADO DE FONDO DE INVERS": [CAT_NO_PRESUPUESTAR_INGRESO, "Traslado desde tu fondo de inversión — no es ingreso nuevo"],
    "PAGO DE PROV FONDO DE EMPLEA": [CAT_NO_PRESUPUESTAR_INGRESO, "Desembolso de préstamo del Fondo de Empleados — no es ingreso nuevo, se paga vía nómina"],
    "DESEMBOLSO CREDIAGIL APP": [CAT_NO_PRESUPUESTAR_INGRESO, "Desembolso de préstamo Crediagil — no es ingreso nuevo"],
    "PAGO INTERBANC JUAN": [CAT_NO_PRESUPUESTAR_INGRESO, "Transferencia entre tus propias cuentas"],
  };

  // Puerto de categorize_cuenta() (cuenta_formatos.py). 'concepto' debe ser
  // el CONCEPTO ya canónico (salida de conceptoCuenta), no la descripción
  // cruda -- ver la misma advertencia en la versión Python.
  function categorizeCuenta(concepto, esIngreso) {
    const tabla = esIngreso ? CUENTA_CATEGORY_INGRESO : CUENTA_CATEGORY_EGRESO;
    if (concepto in tabla) return tabla[concepto];
    if (concepto.startsWith("TRANSFERENCIA CTA SUC VIRTUAL ")) return tabla["TRANSFERENCIA CTA SUC VIRTUAL"];
    if (esMovimientoBroker(concepto)) {
      if (esIngreso) return [CAT_NO_PRESUPUESTAR_INGRESO, "Dinero que vuelve desde tu cuenta de inversión/broker — no es ingreso nuevo"];
      return ["Inversiones", "Fondeo de tu cuenta de inversión/broker (Plenti, Acciones y Valores, Binance, Hapi)"];
    }
    return esIngreso ? ["Otro", "Movimiento no reconocido, clasificar manualmente"] : ["Otros", "Movimiento no reconocido, clasificar manualmente"];
  }

  // Puerto de movimiento_cuenta() (cuenta_formatos.py). 'fecha' es un Date.
  function movimientoCuenta(fecha, descripcion, valor) {
    const concepto = conceptoCuenta(descripcion);
    const esIngreso = valor > 0;
    const [categoria, nota] = categorizeCuenta(concepto, esIngreso);
    let plataforma = plataformaInversion(concepto);
    if (plataforma === null && FONDO_INVERSION_PALABRAS_CLAVE.some((kw) => concepto.toUpperCase().includes(kw))) {
      plataforma = ["Fondo de inversión", "pesos"];
    }
    const aporteInversion = !esIngreso ? plataforma : null;
    return {
      fecha, descripcion, concepto, valor, categoria, nota,
      noPresupuestar: esNoPresupuestar(categoria),
      aporteInversion, flujoInversion: plataforma,
    };
  }

  // Puerto de parse_detalle_transacciones_sheet() (cuenta_formatos.py).
  // 'rows' = array de arrays (una hoja de SheetJS con {header:1}). Devuelve
  // null si la hoja no tiene los headers FECHA/DESCRIPCION/VALOR en las
  // primeras 20 filas (no es este formato).
  function parseDetalleTransaccionesSheet(rows) {
    const required = ["FECHA", "DESCRIPCION", "VALOR"];
    let headerRow = null;
    let indices = null;
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const row = rows[i] || [];
      const headers = {};
      row.forEach((value, idx) => {
        if (value !== null && value !== undefined && value !== "") headers[normalizarTexto(value)] = idx;
      });
      if (required.every((h) => h in headers)) {
        headerRow = i;
        indices = headers;
        break;
      }
    }
    if (headerRow === null) return null;

    const txns = [];
    for (let i = headerRow + 1; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 1;
      if (!row || row.every((v) => v === null || v === undefined || v === "")) continue;
      let fecha, descripcion, valor;
      try {
        fecha = fechaEspanol(row[indices.FECHA]);
        descripcion = String(row[indices.DESCRIPCION] ?? "").trim();
        valor = Number(row[indices.VALOR]);
        if (Number.isNaN(valor)) throw new Error("valor no numérico");
      } catch (exc) {
        throw new Error(`Fila ${rowNumber} inválida en el detalle de transacciones: ${exc.message}`);
      }
      if (!descripcion) throw new Error(`Fila ${rowNumber} sin descripción en el detalle de transacciones`);
      if ("TIPO DE TRANSACCION" in indices) {
        const tipo = normalizarTexto(row[indices["TIPO DE TRANSACCION"]]);
        if (tipo === "DEBITO") valor = -Math.abs(valor);
        else if (tipo === "CREDITO") valor = Math.abs(valor);
        else throw new Error(`Fila ${rowNumber} con tipo de transacción no reconocido: ${JSON.stringify(tipo)}`);
      }
      txns.push({ fecha, descripcion, valor });
    }
    return txns;
  }

  // Puerto del parser legado ("extracto impreso tradicional",
  // parse_extracto_cuenta_sheet() en app_presupuesto.py cuando el formato de
  // arriba no aplica) -- busca DESDE/HASTA y fechas 'dd/mm' sin año,
  // infiriendo el año cuando el mes retrocede respecto al anterior.
  function parseExtractoCuentaLegacy(rows) {
    let desde = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r && r[0] === "DESDE" && r.length > 1 && r[1] === "HASTA") {
        const val = rows[i + 1] ? rows[i + 1][0] : null;
        if (val) {
          const m = String(val).trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
          if (m) desde = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
        }
        break;
      }
    }
    if (!desde) throw new Error("No encontré 'DESDE/HASTA' — ¿es este el formato de extracto de cuenta de Bancolombia?");

    let currentYear = desde.getUTCFullYear();
    let prevMonth = desde.getUTCMonth() + 1;
    const txns = [];
    for (const r of rows) {
      if (!r || !r[0] || typeof r[0] !== "string") continue;
      const m = r[0].trim().match(/^(\d{1,2})\/(\d{2})$/);
      if (!m) continue;
      const dia = Number(m[1]);
      const mes = Number(m[2]);
      if (mes < prevMonth) currentYear += 1;
      prevMonth = mes;
      let fecha;
      try {
        fecha = new Date(Date.UTC(currentYear, mes - 1, dia));
        if (Number.isNaN(fecha.getTime())) continue;
      } catch {
        continue;
      }
      const descripcion = r.length > 1 && r[1] ? String(r[1]).trim() : "";
      if (!descripcion) continue;
      const valorRaw = r.length > 4 ? r[4] : null;
      if (valorRaw === null || valorRaw === undefined || valorRaw === "") continue;
      const valor = moneyExtracto(valorRaw);
      if (valor === null) continue;
      txns.push({ fecha, descripcion, valor });
    }
    return txns;
  }

  // Puerto de money_extracto() (app_presupuesto.py) -- maneja tanto
  // "1.234,56" (formato colombiano) como "1,234.56", y el '-' al final
  // (formato nuevo de Bancolombia).
  function moneyExtracto(s) {
    if (s === null || s === undefined) return null;
    if (typeof s === "number") return s;
    s = String(s).trim();
    if (s === "") return null;
    const neg = s.startsWith("-") || s.endsWith("-");
    s = s.replace(/^-+|-+$/g, "").replace(/^\+/, "");
    const lc = s.lastIndexOf(",");
    const lp = s.lastIndexOf(".");
    let val;
    if (lc === -1 && lp === -1) {
      val = parseFloat(s);
    } else if (lc === -1) {
      const dotCount = (s.match(/\./g) || []).length;
      val = (dotCount > 1 || s.split(".").pop().length === 3) ? parseFloat(s.split(".").join("")) : parseFloat(s);
    } else if (lp === -1) {
      const commaCount = (s.match(/,/g) || []).length;
      val = (commaCount > 1 || s.split(",").pop().length === 3) ? parseFloat(s.split(",").join("")) : parseFloat(s.replace(",", "."));
    } else if (lc > lp) {
      val = parseFloat(s.split(".").join("").replace(",", "."));
    } else {
      val = parseFloat(s.split(",").join(""));
    }
    return neg ? -val : val;
  }

  // Puerto de parse_extracto_cuenta_sheet() (app_presupuesto.py) -- intenta
  // primero "Detalle de transacciones", si no aplica cae al formato legado,
  // y aplica movimientoCuenta() a cada fila resultante.
  function parseExtractoCuentaSheet(rows) {
    const detalle = parseDetalleTransaccionesSheet(rows);
    const txns = detalle !== null ? detalle : parseExtractoCuentaLegacy(rows);
    return txns.map((t) => movimientoCuenta(t.fecha, t.descripcion, t.valor));
  }

  // Puerto de marcar_novedad_movimientos() (cuenta_formatos.py) -- dedup por
  // (fecha, concepto canónico, |valor| a 2 decimales) respetando
  // multiplicidad real (dos cargos idénticos el mismo día no son duplicados
  // entre sí, salvo que la fuente ya los tuviera esa misma cantidad de
  // veces). 'yaIngresos'/'yaEgresos': arrays de [fechaISO, descripcionCruda, valor]
  // ya existentes en el Sheet.
  function marcarNovedadMovimientos(movimientos, yaIngresos, yaEgresos) {
    function contarClaves(lista) {
      const counter = new Map();
      for (const [fecha, descripcion, valor] of lista) {
        const concepto = conceptoCuenta(descripcion);
        const clave = JSON.stringify([fecha, concepto, Math.round(Math.abs(Number(valor)) * 100) / 100]);
        counter.set(clave, (counter.get(clave) || 0) + 1);
      }
      return counter;
    }
    const existentes = { true: contarClaves(yaIngresos), false: contarClaves(yaEgresos) };
    const vistosPorFuente = new Map();
    const maximoPorClave = new Map();

    function fechaDDMMYYYY(fecha) {
      return `${String(fecha.getUTCDate()).padStart(2, "0")}/${String(fecha.getUTCMonth() + 1).padStart(2, "0")}/${fecha.getUTCFullYear()}`;
    }

    for (const mov of movimientos) {
      const concepto = mov.concepto || conceptoCuenta(mov.descripcion);
      const esIngreso = mov.valor > 0;
      const claveBase = JSON.stringify([fechaDDMMYYYY(mov.fecha), concepto, Math.round(Math.abs(mov.valor) * 100) / 100]);
      const claveSubida = JSON.stringify([esIngreso, claveBase]);
      const fuente = JSON.stringify([mov._archivo || null, mov._sheet || null]);
      const claveVistos = `${fuente}::${claveSubida}`;
      const aparicion = (vistosPorFuente.get(claveVistos) || 0) + 1;
      vistosPorFuente.set(claveVistos, aparicion);

      let cantidadExistente = existentes[esIngreso].get(claveBase) || 0;
      if (concepto.startsWith("TRANSFERENCIA CTA SUC VIRTUAL ")) {
        const fechaTxt = JSON.parse(claveBase)[0];
        const valorTxt = JSON.parse(claveBase)[2];
        const claveGenerica = JSON.stringify([fechaTxt, "TRANSFERENCIA CTA SUC VIRTUAL", valorTxt]);
        cantidadExistente = Math.max(cantidadExistente, existentes[esIngreso].get(claveGenerica) || 0);
      }
      const yaExiste = aparicion <= cantidadExistente;
      const maxPrevio = maximoPorClave.get(claveSubida) || 0;
      mov._duplicadoSubida = !yaExiste && aparicion <= maxPrevio;
      mov._nuevo = !yaExiste && !mov._duplicadoSubida;
      maximoPorClave.set(claveSubida, Math.max(maxPrevio, aparicion));
    }
    return movimientos;
  }

  return {
    normalizarTexto, fechaEspanol, fechaISO, conceptoCuenta, categorizeCuenta,
    movimientoCuenta, parseDetalleTransaccionesSheet, parseExtractoCuentaLegacy,
    parseExtractoCuentaSheet, marcarNovedadMovimientos, plataformaInversion,
    esNoPresupuestar, moneyExtracto,
  };
})();

if (typeof module !== "undefined") module.exports = CuentaParser;
