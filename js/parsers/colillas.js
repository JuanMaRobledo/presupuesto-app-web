// Puerto de parse_colilla() + CONCEPTOS + PALABRAS_CLAVE_DEVENGO +
// money_colilla() + periodo_colilla() (app_presupuesto.py /
// cuenta_formatos.py) — colillas de pago del Hospital Pablo Tobón Uribe en
// PDF. parseColilla() recibe 'texto' (page.extract_text() de pdfplumber) y
// 'palabras' (equivalente a page.extract_words(): array de {texto, x0, top}
// por cada palabra, con su posición) — separado así para poder testear la
// lógica sin depender de pdf.js, y para que extraerColillaDePDF() (que sí
// usa pdf.js) sea la única parte que toca un File real.

const ColillasParser = (() => {
  const MESES = {
    Enero: "ene", Febrero: "feb", Marzo: "mar", Abril: "abr", Mayo: "may", Junio: "jun",
    Julio: "jul", Agosto: "ago", Septiembre: "sep", Octubre: "oct", Noviembre: "nov", Diciembre: "dic",
  };

  // Puerto de CONCEPTOS (app_presupuesto.py) -- código de nómina -> [categoría, nombre (o plantilla con "{pct}"), tipoUnidad].
  const CONCEPTOS = {
    "1": ["Salario Base", "Sueldo", "dia"],
    "45": ["Recargos y Horas Extra", "Recargo Nocturno 35%", "hor"],
    "52": ["Recargos y Horas Extra", "Recargo Nocturno Dom/Fest {pct}%", "hor"],
    "66": ["Recargos y Horas Extra", "Dominical Trabajado {pct}%", "hor"],
    "85": ["Recargos y Horas Extra", "Horas Adicionales {pct}%", "dia"],
    "775": ["Formación Continua", "Formación Continua", "dia"],
    "2195": ["Ahorro", "Cuenta A.F.C. Banco Colpatria", null],
    "2355": ["Fondo de Empleados", "Aporte Social Fondo Empleados", null],
    "2360": ["Ahorro", "Ahorro Permanente Fondo Empl.", null],
    "2370": ["Seguros", "FE Salud Sura", null],
    "2450": ["Deuda (Préstamo Fondo Empleados)", "Préstamo Fondo Empleados", null],
    "2806": ["Seguros", "FE Plan C Sura", null],
    "3008": ["Impuestos", "Retención en la Fuente (Método 2)", null],
    "3010": ["Aportes de Ley", "Aporte Salud (EPS Sura)", null],
    "3020": ["Aportes de Ley", "Aporte Pensión (Protección)", null],
    "3023": ["Aportes de Ley", "Aporte Fondo de Solidaridad (Protección)", null],
    "6521": ["Seguros", "Póliza Automóvil - Fondo Empl.", null],
    "6524": ["Transporte", "Parqueadero Carro", null],
    // Cesantías: ver nota extensa en aplicarColillas() sobre por qué el
    // capital (181) no se guarda, solo los intereses (191).
    "181": ["Cesantías (no presupuestar)", "Cesantías Año Anterior", null],
    "191": ["Cesantías (Ingreso)", "Intereses de Cesantías Año Anterior", null],
    "3180": ["Cesantías (no presupuestar)", "Consignación Cesantías a Fondo", null],
    "130": ["Prima de Servicios", "Prima Legal", null],
    "145": ["Vacaciones y Licencias", "Vacaciones", null],
    "951": ["Vacaciones y Licencias", "Ajuste de Vacaciones en Tiempo", null],
    "15": ["Vacaciones y Licencias", "Incapacidad", null],
    "20": ["Vacaciones y Licencias", "Gasto de Incapacidad", null],
    "736": ["Vacaciones y Licencias", "Tiempo Para Ti", null],
    "26": ["Vacaciones y Licencias", "Licencia de Paternidad", null],
    "3510": ["Seguros", "Servicios Hospitalarios 2", null],
    "2410": ["Ahorro", "Cuota Voluntaria Fondo Empleados", null],
    "2905": ["Ahorro", "Ahorro Navideño", null],
  };

  const PALABRAS_CLAVE_DEVENGO = [
    [["PRIMA"], "Prima de Servicios", "Prima de Servicios"],
    [["BONO", "BONIFICAC"], "Bonificación", "Bonificación"],
  ];

  function moneyColilla(s) {
    return parseFloat(String(s).replace(/,/g, ""));
  }

  function normalizarTexto(valor) {
    return String(valor ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
  }

  // Puerto de periodo_colilla() (cuenta_formatos.py).
  function periodoColilla(texto, mesAbrev, anio, quincenaNum) {
    const normalizado = normalizarTexto(texto);
    if (normalizado.includes("PRIMA LEGAL")) return `Prima ${mesAbrev}-${anio}`;
    if (normalizado.includes("CESANTIAS")) return `Cesantías ${mesAbrev}-${anio}`;
    return `${quincenaNum} quincena ${mesAbrev}-${anio}`;
  }

  // Puerto de parse_colilla() (app_presupuesto.py). 'texto' = todo el texto
  // de la página (para los regex de campos globales); 'palabras' = lista de
  // {texto, x0, top} de cada palabra individual con su posición (para
  // reconstruir la tabla de conceptos, que en el PDF no es una tabla real).
  function parseColilla(texto, palabras, nombreArchivo) {
    let m = texto.match(/Fecha:\s*(\d{4}-\d{2}-\d{2})/);
    if (!m) throw new Error(`No encontré la fecha del comprobante en ${nombreArchivo}. ¿Es una colilla del Hospital Pablo Tobón Uribe en este formato?`);
    const fechaPago = m[1];

    m = texto.match(/(Primera|Segunda) Quincena De (\w+) De (\d{4})/);
    if (!m) throw new Error(`No encontré 'Primera/Segunda Quincena De ... De ...' en ${nombreArchivo}.`);
    const quincenaNum = m[1] === "Primera" ? "1a" : "2a";
    const mesNombre = m[2];
    const anio = m[3];
    if (!(mesNombre in MESES)) throw new Error(`Mes desconocido '${mesNombre}' en ${nombreArchivo}.`);
    const periodo = periodoColilla(texto, MESES[mesNombre], anio, quincenaNum);

    m = texto.match(/Totales:\s*\$\s*([\d,]+\.\d{2})\s*\$\s*([\d,]+\.\d{2})/);
    if (!m) throw new Error(`No encontré la línea de 'Totales:' en ${nombreArchivo}.`);
    const totalDevengos = moneyColilla(m[1]);
    const totalDescuentos = moneyColilla(m[2]);

    m = texto.match(/Neto a Pagar:\s*\$\s*([\d,]+\.\d{2})/);
    if (!m) throw new Error(`No encontré 'Neto a Pagar:' en ${nombreArchivo}.`);
    const neto = moneyColilla(m[1]);

    // Agrupa palabras por fila visual (mismo 'top' redondeado) y ordena cada
    // fila por posición horizontal, igual que la versión Python.
    const filas = new Map();
    for (const w of palabras) {
      const key = Math.round(w.top);
      if (!filas.has(key)) filas.set(key, []);
      filas.get(key).push(w);
    }

    const devengos = [], descuentos = [], revisar = [];
    const tops = [...filas.keys()].sort((a, b) => a - b);
    for (const top of tops) {
      const wsRow = [...filas.get(top)].sort((a, b) => a.x0 - b.x0);
      if (!wsRow.length) continue;
      const first = wsRow[0];
      if (!/^\d+$/.test(first.texto)) continue;
      const code = first.texto;
      const rawConcept = wsRow.slice(1).filter((w) => w.x0 < 220).map((w) => w.texto).join(" ");
      const unidadWords = wsRow.filter((w) => w.x0 >= 220 && w.x0 < 270);
      let unidades = null;
      if (unidadWords.length) {
        const v = parseFloat(unidadWords[0].texto);
        unidades = Number.isNaN(v) ? null : v;
      }
      const moneyWords = wsRow.filter((w) => w.x0 >= 300 && /^[\d,]+\.\d{2}$/.test(w.texto));
      if (!moneyWords.length) continue;
      const mw = moneyWords[0];
      const valor = moneyColilla(mw.texto);
      const columna = mw.x0 < 400 ? "devengo" : mw.x0 < 500 ? "descuento" : "saldo_prestamo";
      if (columna === "saldo_prestamo") continue;

      let categoria, nombreItem;
      if (code in CONCEPTOS) {
        const [cat, nombreBase, unidadTipo] = CONCEPTOS[code];
        categoria = cat;
        const pctMatch = rawConcept.match(/\((\d+)%/);
        const pct = pctMatch ? pctMatch[1] : "";
        nombreItem = nombreBase.includes("{pct}") ? nombreBase.replace("{pct}", pct) : nombreBase;
        if (unidadTipo === "hor" && unidades !== null) nombreItem += ` (${formatG(unidades)} h)`;
        else if (unidadTipo === "dia" && unidades !== null) nombreItem += ` (${formatG(unidades)} días)`;
      } else {
        const upperConcept = rawConcept.toUpperCase();
        const encontrada = PALABRAS_CLAVE_DEVENGO.find(([kws]) => kws.some((kw) => upperConcept.includes(kw)));
        if (encontrada && columna === "devengo") {
          categoria = encontrada[1];
          nombreItem = encontrada[2];
        } else {
          categoria = "";
          nombreItem = `[REVISAR] ${rawConcept} (código ${code})`;
          revisar.push([code, rawConcept, valor]);
        }
      }

      const item = { quincena: periodo, concepto: nombreItem, categoria, valor, codigo: code };
      (columna === "devengo" ? devengos : descuentos).push(item);
    }

    return { fecha: fechaPago, periodo, totalDevengos, totalDescuentos, neto, devengos, descuentos, revisar };
  }

  // Puerto de Python's "{unidades:g}" -- número sin ceros/decimales de sobra
  // (2.0 -> "2", 2.5 -> "2.5").
  function formatG(n) {
    return String(Math.round(n * 1e10) / 1e10);
  }

  // Extrae {texto, palabras} de la primera página de un PDF usando pdf.js
  // (pdfjsLib, cargado como <script> global) -- equivalente a
  // page.extract_text() + page.extract_words() de pdfplumber. pdf.js agrupa
  // texto en "items" (no necesariamente una palabra cada uno); se separan
  // por espacios y se interpola la posición x de cada palabra dentro del
  // ancho del item, proporcional a su offset de caracteres.
  async function extraerColillaDePDF(arrayBuffer) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const avisoPaginas = pdf.numPages !== 1 ? pdf.numPages : null;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const lineas = new Map();
    const palabras = [];
    for (const item of content.items) {
      const str = item.str;
      if (!str || !str.trim()) continue;
      // transform = [a, b, c, d, e, f] -- e,f son la posición (x,y) en
      // coordenadas PDF (origen abajo-izquierda); 'top' (como pdfplumber,
      // distancia desde ARRIBA de la página) = altura de página - y.
      const x = item.transform[4];
      const y = item.transform[5];
      const top = viewport.height - y;
      const key = Math.round(top / 3) * 3; // agrupa líneas con leve variación de baseline
      if (!lineas.has(key)) lineas.set(key, []);
      lineas.get(key).push(str);

      const partes = str.split(/(\s+)/); // conserva los separadores para medir offsets
      let offsetChars = 0;
      const totalChars = str.length || 1;
      for (const parte of partes) {
        if (parte.trim()) {
          const x0 = x + (item.width * offsetChars) / totalChars;
          palabras.push({ texto: parte, x0, top });
        }
        offsetChars += parte.length;
      }
    }

    const topsOrdenados = [...lineas.keys()].sort((a, b) => a - b);
    const texto = topsOrdenados.map((t) => lineas.get(t).join(" ")).join("\n");
    return { texto, palabras, avisoPaginas };
  }

  return {
    CONCEPTOS, PALABRAS_CLAVE_DEVENGO, moneyColilla, periodoColilla, parseColilla,
    normalizarTexto, extraerColillaDePDF,
  };
})();

if (typeof module !== "undefined") module.exports = ColillasParser;
