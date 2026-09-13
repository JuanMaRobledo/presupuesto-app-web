// Puerto de la lógica de extractos de tarjeta de crédito (Bancolombia
// .xlsx) de app_presupuesto.py: TARJETAS/resolve_tarjeta, MERCHANT_CATEGORY/
// categorize, money_extracto (reusa CuentaParser.moneyExtracto),
// parse_periodo_fecha/parse_limite_fecha/parse_date_ddmmyyyy, y los dos
// formatos de extracto (parse_extracto_sheet_v1/v2 según cuál encabezado
// encuentre, igual que el dispatcher parse_extracto_sheet).

const TarjetaParser = (() => {
  const VISA = { label: "Visa ****7497", sheet: "Egresos - Tarjeta Visa 7497" };
  const MASTERCARD = { label: "Mastercard ****5922", sheet: "Egresos - Mastercard 5922" };
  const TARJETAS = { "7497": VISA, "5003": VISA, "5922": MASTERCARD, "2223": MASTERCARD };

  function resolveTarjeta(digitos, nombreArchivo = "") {
    if (digitos in TARJETAS) return TARJETAS[digitos];
    const low = nombreArchivo.toLowerCase();
    if (low.includes("visa")) return VISA;
    if (low.includes("master")) return MASTERCARD;
    return null;
  }

  // Puerto de MERCHANT_CATEGORY (app_presupuesto.py) -- comercio (texto
  // exacto tal como lo trunca el banco) -> [categoría, reembolsable, nota].
  const MERCHANT_CATEGORY = {
    "INTERESES CORRIENTES": ["Intereses y Cargos Financieros (no presupuestar)", "No", ""],
    "ABONO DEBITO AUTOMATICO": ["Pago Tarjeta de Crédito (no presupuestar)", "No", "Pago automático de la tarjeta, no es gasto nuevo"],
    "REVERSION DE ABONO": ["Ajustes y Reversiones (no presupuestar)", "No", "Reversión de un abono anterior"],
    "DLO*GOOGLE SKETCHBOOK": ["Tecnología y Suscripciones", "No", ""],
    "SOC DE MEJORAS PUBLICA": ["Vivienda y Servicios", "No", ""],
    "MERCADOPAGO COLOMBIA L": ["Compras Online / Varios", "No", "Verificar qué se compró"],
    "EDS ZULY": ["Transporte", "No", "Combustible"],
    "RAPPI COLOMBIA*DL": ["Restaurantes y Domicilios", "No", ""],
    "NEWREST HOSPITAL UNIVE": ["Restaurantes y Domicilios", "No", "Cafetería del hospital"],
    "COMFAMA 1190 CIS CITY": ["Entretenimiento", "No", "Verificar servicio específico de Comfama"],
    "AIRBNB * HMF5Z5TMPJ": ["Viajes", "No", ""],
    "PARMESSANO REST DELICA": ["Restaurantes y Domicilios", "No", ""],
    "TERPEL MAYORAL": ["Transporte", "No", "Combustible"],
    aliexpress: ["Compras Online / Varios", "No", ""],
    "LAVAPRES CAMPESTRE DRI": ["Transporte", "No", "Lavado de carro"],
    "CREPES Y WAFFLES CAMPE": ["Restaurantes y Domicilios", "No", ""],
    "EXITO WOW ENVIGADO": ["Mercado y Supermercado", "No", ""],
    "DROGUERIA EX ENVIGADO": ["Salud", "No", ""],
    "MGP*YR Bookingcom": ["Viajes", "No", ""],
    "PAYU PEEWAH": ["Otros", "No", "Verificar comercio"],
    "HOTEL BOGOTA PLAZA": ["Viajes", "No", ""],
    "AIRE DE ROMERO": ["Otros", "No", "Verificar comercio"],
    "CTRO CLINICO Y D INV S": ["Salud", "No", ""],
    "DLO*GOOGLE GOOGLE ONE": ["Tecnología y Suscripciones", "No", ""],
    "MP*TIENDADELM*TIENDADE": ["Compras Online / Varios", "No", ""],
    PRICESMART: ["Mercado y Supermercado", "No", ""],
    "TBL* ARENA ALFA EDUCAC": ["Educación y Profesional", "No", ""],
    "PAGO ELECTRONICO FLYPASS": ["Transporte", "No", "Peajes"],
    "HOSP PABLO TOBON U": ["Restaurantes y Domicilios", "No", "Posible cafetería/tienda del hospital, verificar"],
    "EURO MURANO": ["Restaurantes y Domicilios", "No", ""],
    "SUMUP*TUVET CLINICA VE": ["Mascotas", "No", "Veterinaria"],
    "MERCADO PAGO*MELIMAS": ["Compras Online / Varios", "No", "Mercado Libre"],
    "MOVISTAR PAGOSEPAYCO": ["Tecnología y Suscripciones", "No", "Plan celular"],
    "AVIANCA SACQR59H": ["Viajes", "No", "Tiquete aéreo"],
    "MULTIPLEX VIVA ENVIGAD": ["Entretenimiento", "No", "Cine"],
    "HOMECENTER VTAS A DIST": ["Vivienda y Servicios", "No", ""],
    "MERCADO PAGO": ["Compras Online / Varios", "No", "Verificar qué se compró"],
    "OLIVENZA COCINA MEDITE": ["Restaurantes y Domicilios", "No", ""],
    "PRICESMART AMERICAS": ["Mercado y Supermercado", "No", ""],
    "EDS LA MONTANA": ["Transporte", "No", "Combustible"],
    "EDS TEXACO PUNTO CERO": ["Transporte", "No", "Combustible"],
    "AUTOAMERICA INDUSTRIAL": ["Transporte", "No", "Repuestos/accesorios de carro"],
    "CIA SURAMERICANA DE SE": ["Seguros", "No", ""],
    "SURAMERICANA SEGUROS D": ["Seguros", "No", ""],
    "CREPES Y WAFFLES TESOR": ["Restaurantes y Domicilios", "No", ""],
    "ITADAKI RAMEN SAS": ["Restaurantes y Domicilios", "No", ""],
    AVIANCA: ["Viajes", "No", "Tiquete aéreo"],
    "MERCPAGO*JETSMART": ["Viajes", "No", "Tiquete aéreo"],
    "SNCF-VOYAGEURS": ["Viajes", "No", "Tren (Francia)"],
    "RENFE VIRTUAL INTERNET": ["Viajes", "No", "Tren (España)"],
    "LA TIQUETERA": ["Viajes", "No", "Agencia de viajes/tiquetes"],
    "AIRBNB * HM5A2S3AXE": ["Viajes", "No", ""],
    "AIRBNB * HMS28NYNJY": ["Viajes", "No", ""],
    "MERCPAGO*MERCADOLIBRE": ["Compras Online / Varios", "No", ""],
    "WOMPI*ACEM": ["Educación y Profesional", "No", "Posible membresía/asociación médica, verificar"],
    "GOOGLE *PLAY YOUTUBE*D": ["Tecnología y Suscripciones", "No", "Suscripción YouTube/Google"],
    "DONATELLA TRATTORIA": ["Restaurantes y Domicilios", "No", ""],
    "KAMIL HOSPITAL": ["Restaurantes y Domicilios", "No", "Posible cafetería/tienda del hospital, verificar"],
    NOVAVENTA: ["Compras Online / Varios", "No", ""],
    CREDIMAPFRE: ["Seguros", "No", "Seguro del carro"],
    "OMA BARRA MED HSPTAL P": ["Restaurantes y Domicilios", "No", "Café OMA"],
    "AVIANCA SACD3875": ["Viajes", "No", "Tiquete aéreo"],
    "VIN Y GRETTA PHTU": ["Restaurantes y Domicilios", "No", ""],
    "SUBWAY HOSPITAL PABLO": ["Restaurantes y Domicilios", "No", ""],
    "UBER RIDES*DL": ["Transporte", "No", ""],
    "MONTOLIVO PASTA EXPRES": ["Restaurantes y Domicilios", "No", ""],
    "ANTONIOS GELATO SAS": ["Restaurantes y Domicilios", "No", ""],
  };

  function categorize(merchant) {
    return MERCHANT_CATEGORY[merchant] || ["Otros", "No", "Comercio no reconocido, clasificar manualmente"];
  }

  function moneyExtracto(s) {
    return CuentaParser.moneyExtracto(s);
  }

  function parseDateDDMMYYYY(s) {
    const [d, m, y] = s.split("/");
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  }

  function fechaISO(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }

  function findLabelValue(rows, label, valueColOffset = 1) {
    const labelLower = label.toLowerCase();
    for (const r of rows) {
      if (!r) continue;
      for (let i = 0; i < r.length; i++) {
        const cell = r[i];
        if (typeof cell === "string" && cell.trim().replace(/:$/, "").toLowerCase() === labelLower) {
          if (i + valueColOffset < r.length) return r[i + valueColOffset];
        }
      }
    }
    return null;
  }

  // Puerto de parse_periodo_fecha() -- "15 Ene. 2026" -> Date.
  function parsePeriodoFecha(s) {
    const m = s.trim().match(/^(\d{1,2})\s+([A-Za-zñÑ]+)\.?\s+(\d{4})/);
    if (!m) return null;
    const [, dia, mesTxt, anio] = m;
    const mes = MESES_ABR[mesTxt.toLowerCase().replace(/\.$/, "")];
    if (!mes) return null;
    return new Date(Date.UTC(Number(anio), mes - 1, Number(dia)));
  }

  // Puerto de parse_limite_fecha() -- "Enero. 15, 2026" -> Date.
  function parseLimiteFecha(s) {
    const m = s.trim().match(/^([A-Za-zñÑ]+)\.?\s+(\d{1,2}),\s+(\d{4})/);
    if (!m) return null;
    const [, mesTxt, dia, anio] = m;
    const mes = MESES_ABR[mesTxt.toLowerCase().replace(/\.$/, "")];
    if (!mes) return null;
    return new Date(Date.UTC(Number(anio), mes - 1, Number(dia)));
  }

  // Puerto de _find_valor_bajo() -- busca 'label' como encabezado de una
  // mini-tabla (fila de encabezados, fila de valores justo debajo, misma
  // columna) y devuelve [valor, índiceFilaEncabezado].
  function findValorBajo(rows, label, limite = 40) {
    const labelNorm = label.trim().toLowerCase();
    for (let i = 0; i < Math.min(limite, rows.length); i++) {
      const r = rows[i];
      if (!r) continue;
      for (let j = 0; j < r.length; j++) {
        const cell = r[j];
        if (typeof cell === "string" && cell.trim().toLowerCase() === labelNorm) {
          if (i + 1 < rows.length && rows[i + 1] && j < rows[i + 1].length) return [rows[i + 1][j], i];
        }
      }
    }
    return [null, null];
  }

  // Puerto de parse_extracto_sheet_v1() -- formato viejo, etiqueta:valor en
  // la misma fila, un solo listado continuo de movimientos.
  function parseExtractoSheetV1(rows, headerRows, nombreArchivo = "") {
    const tarjetaCell = findLabelValue(headerRows, "Información de la Tarjeta");
    if (!tarjetaCell) throw new Error("No encontré 'Información de la Tarjeta' — ¿es este el formato correcto?");
    const m = String(tarjetaCell).match(/(\d{4})$/);
    if (!m) throw new Error(`No pude leer los últimos 4 dígitos de la tarjeta en '${tarjetaCell}'.`);
    const digitos = m[1];
    const tarjeta = resolveTarjeta(digitos, nombreArchivo);
    if (!tarjeta) throw new Error(`No reconozco la tarjeta terminada en ${digitos} y el nombre del archivo no dice 'Visa' ni 'Mastercard'. Avísame para agregarla.`);

    let periodoFinTxt = null;
    for (const r of headerRows) {
      if (r && r[0] && String(r[0]).trim().replace(/:$/, "").toLowerCase() === "periodo facturado") {
        periodoFinTxt = r[2];
        break;
      }
    }
    if (!periodoFinTxt) throw new Error("No encontré 'Periodo facturado'.");
    const fechaCorte = parsePeriodoFecha(String(periodoFinTxt));
    if (!fechaCorte) throw new Error(`No pude leer la fecha de cierre de '${periodoFinTxt}'.`);
    const periodoExtracto = `${fechaCorte.getUTCFullYear()}-${String(fechaCorte.getUTCMonth() + 1).padStart(2, "0")}`;

    const limiteTxt = findLabelValue(headerRows, "Pagar antes de");
    const fechaLimite = limiteTxt ? parseLimiteFecha(String(limiteTxt)) : null;

    const monedaTxt = findLabelValue(headerRows, "Moneda");
    const moneda = monedaTxt && String(monedaTxt).toUpperCase().includes("DOLAR") ? "USD" : "COP";

    const stmt = {
      periodo: periodoExtracto, fechaCorte, fechaLimite,
      cupoTotal: moneyExtracto(findLabelValue(headerRows, "Cupo total")),
      cupoDisponible: moneyExtracto(findLabelValue(headerRows, "Cupo disponible")),
      saldoAnterior: moneyExtracto(findLabelValue(headerRows, "+ Saldo anterior")),
      pagoMinimo: moneyExtracto(findLabelValue(headerRows, "Pago mínimo")),
      pagoTotal: moneyExtracto(findLabelValue(headerRows, "Pago total")),
    };

    const txns = [];
    let i = 0;
    while (i < rows.length) {
      const r = rows[i] || [];
      if (r[0] === "Movimientos durante el periodo" || r[0] === "Movimientos antes del periodo") { i += 2; continue; }
      if (r.length > 1 && r[1] && typeof r[1] === "string" && /^\d{2}\/\d{2}\/\d{4}/.test(r[1])) {
        const merchant = r[2];
        const valorTotal = moneyExtracto(r[3]);
        const cuotas = r[4] || "1/1";
        const valorPeriodo = moneyExtracto(r[5]);
        const saldoPend = r.length > 8 ? moneyExtracto(r[8]) : null;
        const [cat, reemb, nota] = categorize(merchant);
        txns.push({
          periodoExtracto, tarjeta: tarjeta.label, sheet: tarjeta.sheet, moneda,
          fechaCompra: parseDateDDMMYYYY(r[1]), comercio: merchant, cuotas,
          valorTotal, valorPeriodo, saldoPendiente: saldoPend, categoria: cat, reembolsable: reemb, nota,
        });
      }
      i += 1;
    }
    return { tarjeta, moneda, statement: stmt, txns };
  }

  // Puerto de parse_extracto_sheet_v2() -- formato nuevo (mediados de 2025
  // en adelante), tablas encabezado-arriba/valor-abajo, encabezado repetido
  // por página impresa (se escanea toda la hoja).
  function parseExtractoSheetV2(rows, nombreArchivo = "", tituloHoja = "") {
    const headerRows = rows.slice(0, 29);

    const [tarjetaCell] = findValorBajo(headerRows, "Tarjeta");
    if (!tarjetaCell) throw new Error("No encontré la columna 'Tarjeta' — ¿es este el formato correcto?");
    const m = String(tarjetaCell).match(/(\d{4})$/);
    if (!m) throw new Error(`No pude leer los últimos 4 dígitos de la tarjeta en '${tarjetaCell}'.`);
    const digitos = m[1];
    const tarjeta = resolveTarjeta(digitos, nombreArchivo);
    if (!tarjeta) throw new Error(`No reconozco la tarjeta terminada en ${digitos} y el nombre del archivo no dice 'Visa' ni 'Mastercard'. Avísame para agregarla.`);

    const [cupoTotal, filaCupo] = findValorBajo(headerRows, "Cupo Total");
    const [cupoDisponible, filaDisp] = findValorBajo(headerRows, "Disponible Total");

    let fechaCorte = null, fechaLimite = null;
    if (filaCupo !== null && filaCupo + 1 < rows.length) {
      const datos = rows[filaCupo + 1] || [];
      if (datos.length > 3 && datos[3]) {
        const [d, mo, y] = String(datos[3]).trim().split("/");
        fechaCorte = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
      }
    }
    if (filaDisp !== null && filaDisp + 1 < rows.length) {
      const datos = rows[filaDisp + 1] || [];
      if (datos.length > 2 && datos[2]) {
        const [d, mo, y] = String(datos[2]).trim().split("/");
        fechaLimite = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
      }
    }
    if (!fechaCorte) throw new Error("No pude leer 'Período Facturado Hasta'.");
    const periodoExtracto = `${fechaCorte.getUTCFullYear()}-${String(fechaCorte.getUTCMonth() + 1).padStart(2, "0")}`;

    const moneda = tituloHoja.trim().toUpperCase() === "DOLARES" ? "USD" : "COP";

    const stmt = {
      periodo: periodoExtracto, fechaCorte, fechaLimite,
      cupoTotal: moneyExtracto(cupoTotal), cupoDisponible: moneyExtracto(cupoDisponible),
      saldoAnterior: moneyExtracto(findLabelValue(headerRows, "Saldo Anterior")),
      pagoMinimo: moneyExtracto(findLabelValue(headerRows, "= Pago mínimo")),
      pagoTotal: moneyExtracto(findLabelValue(headerRows, "= Pagos total")),
    };

    const txns = [];
    for (const r of rows) {
      if (!r || r.length < 3 || !r[1] || typeof r[1] !== "string") continue;
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(r[1].trim())) continue;
      const merchant = r[2];
      if (!merchant) continue;
      const valorTotal = r.length > 3 ? moneyExtracto(r[3]) : null;
      const valorPeriodo = r.length > 6 && r[6] !== null && r[6] !== undefined && r[6] !== "" ? moneyExtracto(r[6]) : valorTotal;
      const saldoPend = r.length > 7 ? moneyExtracto(r[7]) : null;
      const cuotas = r.length > 8 && r[8] ? r[8] : "1/1";
      const [cat, reemb, nota] = categorize(merchant);
      txns.push({
        periodoExtracto, tarjeta: tarjeta.label, sheet: tarjeta.sheet, moneda,
        fechaCompra: parseDateDDMMYYYY(r[1].trim()), comercio: merchant, cuotas,
        valorTotal, valorPeriodo, saldoPendiente: saldoPend, categoria: cat, reembolsable: reemb, nota,
      });
    }
    return { tarjeta, moneda, statement: stmt, txns };
  }

  // Puerto de parse_extracto_sheet() -- dispatcher según cuál encabezado
  // encuentre (Bancolombia cambió el formato a mediados de 2025).
  function parseExtractoSheet(rows, nombreArchivo = "", tituloHoja = "") {
    const headerRows = rows.slice(0, 29);
    if (findLabelValue(headerRows, "Información de la Tarjeta")) {
      return parseExtractoSheetV1(rows, headerRows, nombreArchivo);
    }
    return parseExtractoSheetV2(rows, nombreArchivo, tituloHoja);
  }

  return {
    TARJETAS, resolveTarjeta, MERCHANT_CATEGORY, categorize, moneyExtracto,
    parseDateDDMMYYYY, fechaISO, findLabelValue, parsePeriodoFecha, parseLimiteFecha,
    findValorBajo, parseExtractoSheetV1, parseExtractoSheetV2, parseExtractoSheet,
  };
})();

if (typeof module !== "undefined") module.exports = TarjetaParser;
