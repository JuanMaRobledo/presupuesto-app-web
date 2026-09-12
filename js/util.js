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

// Puerto de _extraer_anio_mes() (app_presupuesto.py) — de un 'Periodo' o
// 'Fecha' saca [año, mes]; [null, null] si el formato no matchea ninguno de
// los patrones conocidos (dd/mm/yyyy, yyyy-mm-dd, yyyy-mm, "1a quincena jul-2026").
function extraerAnioMes(periodo) {
  if (!periodo) return [null, null];
  const s = String(periodo);
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

// Convierte las filas crudas de un rango (array de arrays) en objetos, según
// una lista de nombres de columna en el mismo orden que llegan de la API.
function filasAObjetos(filas, columnas) {
  return (filas || [])
    .filter((r) => r && r[0] !== undefined && r[0] !== null && r[0] !== "")
    .map((r) => {
      const obj = {};
      columnas.forEach((nombre, i) => {
        obj[nombre] = r[i] !== undefined ? r[i] : null;
      });
      return obj;
    });
}
