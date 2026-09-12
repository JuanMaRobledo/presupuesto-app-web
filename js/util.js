// Utilidades puras, sin dependencias del DOM — puerto directo de las
// funciones equivalentes en app_presupuesto.py / sheets_backend.py (Python),
// para que los cálculos den exactamente lo mismo en las dos versiones.

const MESES_NOMBRE = {
  1: "Enero", 2: "Febrero", 3: "Marzo", 4: "Abril", 5: "Mayo", 6: "Junio",
  7: "Julio", 8: "Agosto", 9: "Septiembre", 10: "Octubre", 11: "Noviembre", 12: "Diciembre",
};

const MESES_ABR = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7,
  ago: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12,
};

const NO_PRESUPUESTAR_SUFIJO = "(no presupuestar)";

// Puerto de _to_number() (sheets_backend.py) — detecta formato colombiano
// ('.' miles, ',' decimal) en celdas que quedaron guardadas como texto; casi
// siempre la API ya entrega el número tal cual (UNFORMATTED_VALUE).
function toNumber(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  let s = String(v).replace(/\$/g, "").replace(/%/g, "").trim();
  if (!s || s === "-") return 0;
  const milesPunto = /^-?\d{1,3}(\.\d{3})+$/;
  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.split(".").join("").replace(",", ".");
    } else {
      s = s.split(",").join("");
    }
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  } else if ((s.match(/\./g) || []).length > 1 || milesPunto.test(s)) {
    s = s.split(".").join("");
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Puerto de fmt_moneda() (app_presupuesto.py).
function fmtMoneda(v) {
  const n = Number(v) || 0;
  const abs = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

// Puerto de es_no_presupuestar() (cuenta_formatos.py).
function esNoPresupuestar(categoria) {
  return typeof categoria === "string" && categoria.trim().toLowerCase().endsWith(NO_PRESUPUESTAR_SUFIJO);
}

// Puerto de _serial_to_text() (sheets_backend.py) — Sheets guarda una fecha
// "de verdad" (no texto) como número de serie (días desde 1899-12-30); la
// API con UNFORMATTED_VALUE entrega ese número tal cual, así que hay que
// reconvertirlo a 'dd/mm/yyyy' — si no, cualquier filtro por año/mes sobre
// esa columna queda roto en silencio. Si 'v' ya es texto, lo deja igual.
function serialToText(v) {
  if (typeof v === "number") {
    const epochUTC = Date.UTC(1899, 11, 30);
    const d = new Date(epochUTC + v * 86400000);
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  return v;
}

// Igual que serialToText() pero a 'yyyy-mm-dd' — para precargar un
// <input type="date"> con un valor que llegó como número de serie.
function serialToISO(v) {
  if (typeof v !== "number") return null;
  const epochUTC = Date.UTC(1899, 11, 30);
  const d = new Date(epochUTC + v * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Puerto de _date_to_serial() (sheets_backend.py) — inverso de
// serialToText()/serialToISO(), para escribir una fecha con
// valueInputOption RAW sin que Sheets la reinterprete distinto según el
// locale. 'iso' es 'yyyy-mm-dd' (el valor crudo de un <input type="date">).
function dateToSerial(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const epochUTC = Date.UTC(1899, 11, 30);
  return Math.round((Date.UTC(y, m - 1, d) - epochUTC) / 86400000);
}

// Puerto de _extraer_anio_mes() (app_presupuesto.py) — de un 'Periodo' o
// 'Fecha' saca [año, mes]; [null, null] si el formato no matchea ninguno de
// los patrones conocidos (dd/mm/yyyy, yyyy-mm-dd, yyyy-mm, "1a quincena jul-2026").
// Acepta también un número de serie de Sheets directo (lo reconvierte solo).
function extraerAnioMes(periodo) {
  if (!periodo && periodo !== 0) return [null, null];
  const s = String(typeof periodo === "number" ? serialToText(periodo) : periodo);
  let m = s.match(/^\d{1,2}\/(\d{1,2})\/(\d{4})$/);
  if (m) return [parseInt(m[2], 10), parseInt(m[1], 10)];
  m = s.match(/^(\d{4})-(\d{1,2})-\d{1,2}$/);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  m = s.toLowerCase().match(/([a-záéíóúñ]{3,4})\.?-(\d{4})/);
  if (m) {
    const mesNum = MESES_ABR[m[1].replace(/\.$/, "")];
    if (mesNum) return [parseInt(m[2], 10), mesNum];
  }
  return [null, null];
}

// Convierte 'dd/mm/yyyy' o 'yyyy-mm-dd' a 'yyyy-mm-dd' (para usar como clave
// de comparación de fechas, equivalente a pd.to_datetime(..., dayfirst=True)
// .date() del lado de Python). null si el formato no matchea.
function parseFechaISO(s) {
  if (!s && s !== 0) return null;
  const str = String(typeof s === "number" ? serialToText(s) : s).trim();
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

// Puerto de _shift_mes() (app_presupuesto.py) — suma 'delta' meses a un
// 'yyyy-mm' (delta puede ser negativo).
function shiftMes(mesStr, delta) {
  const anio = parseInt(mesStr.slice(0, 4), 10);
  const mes = parseInt(mesStr.slice(5, 7), 10);
  const total = anio * 12 + (mes - 1) + delta;
  const outAnio = Math.floor(total / 12);
  const outMes = (((total % 12) + 12) % 12) + 1;
  return `${outAnio}-${String(outMes).padStart(2, "0")}`;
}

// Puerto de _periodo_sort_value() (sheets_backend.py) — normaliza fechas y
// "periodos" de distintas fuentes (fecha exacta, quincena, "yyyy-mm") a un
// timestamp comparable, para poder ordenar movimientos de fuentes distintas
// de forma estable sin inventar una fecha de pago exacta para las colillas.
function periodoSortValue(value) {
  if (!value && value !== 0) return -8640000000000000;
  const texto = String(typeof value === "number" ? serialToText(value) : value).trim().toLowerCase();
  let m = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
  m = texto.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  m = texto.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
  m = texto.match(/^(?:(1a|2a)\s+quincena\s+)?([a-záéíóú]{3})-(\d{4})$/);
  if (m && MESES_ABR[m[2]]) {
    const dia = m[1] === "2a" ? 16 : 1;
    return new Date(Number(m[3]), MESES_ABR[m[2]] - 1, dia).getTime();
  }
  return -8640000000000000;
}

// Convierte las filas crudas de un rango (array de arrays) en objetos, según
// una lista de nombres de columna en el mismo orden que llegan de la API.
// 'columnasFecha' (opcional): nombres de columnas que son fecha "de verdad"
// en el Sheet — se les aplica serialToText(), igual que _serial_to_text()
// del lado de Python en cada read_*() que toca una columna de fecha.
function filasAObjetos(filas, columnas, columnasFecha = []) {
  return (filas || [])
    .filter((r) => r && r[0] !== undefined && r[0] !== null && r[0] !== "")
    .map((r) => {
      const obj = {};
      columnas.forEach((nombre, i) => {
        let v = r[i] !== undefined ? r[i] : null;
        if (columnasFecha.includes(nombre)) v = serialToText(v);
        obj[nombre] = v;
      });
      return obj;
    });
}
