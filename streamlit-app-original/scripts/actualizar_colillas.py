#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Actualiza el Excel de presupuesto con nuevas colillas de pago (PDF del
Hospital Pablo Tobón Uribe, formato "Comprobante Historico De Pago").

USO:
    python3 actualizar_colillas.py Presupuesto_Juan_Robledo.xlsx colilla1.pdf [colilla2.pdf ...]

QUÉ HACE:
    - Lee cada PDF de colilla y detecta: quincena, mes, año, fecha de pago,
      cada devengo y cada descuento (con su valor), y los totales.
    - Si esa quincena YA está cargada en el Excel, la salta (nunca duplica).
    - Si es nueva, la agrega en la hoja "Colillas de Pago", sección
      "Registro de datos" (las tres tablas: Resumen por quincena, Detalle
      de devengos, Detalle de descuentos), en el mismo formato que ya usa
      el archivo. NO toca ninguna fórmula existente ni ninguna otra hoja.
    - Antes de guardar, hace una copia de seguridad del archivo original
      (con fecha y hora en el nombre) por si algo sale mal.
    - Los conceptos de la colilla que el programa no reconoce se agregan
      igual (para no perder el dinero de la cuenta), pero con la categoría
      en blanco y el texto "[REVISAR]" al inicio, para que tú le pongas
      la categoría manualmente en Excel usando el desplegable de la columna.

REQUISITOS (una sola vez):
    pip3 install openpyxl pdfplumber

DESPUÉS DE CORRERLO:
    Abre el Excel normalmente. Al abrirlo, recalcula solo (si no lo hace,
    presiona Ctrl+Alt+F9). Revisa la hoja "Colillas de Pago" y, si aparece
    algún concepto con "[REVISAR]", asígnale categoría ahí mismo.
"""
import argparse
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

try:
    from cuenta_formatos import periodo_colilla
except ModuleNotFoundError:
    # Permite ejecutar este archivo por ruta absoluta desde fuera del repo.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from cuenta_formatos import periodo_colilla

try:
    import pdfplumber
except ImportError:
    sys.exit("Falta instalar pdfplumber. Corre:  pip3 install pdfplumber")

try:
    from openpyxl import load_workbook
    from openpyxl.styles import Font
except ImportError:
    sys.exit("Falta instalar openpyxl. Corre:  pip3 install openpyxl")

# ---------------------------------------------------------------------------
# Estilo (igual al resto del archivo)
# ---------------------------------------------------------------------------
FONT_NAME = "Arial"
BLUE = Font(name=FONT_NAME, color="1D4ED8")
MONEY_FMT = '$#,##0;[RED]-$#,##0;"-"'
DATE_FMT = 'dd/mm/yyyy'
SHEET_CP = "Colillas de Pago"

MESES = {"Enero": "ene", "Febrero": "feb", "Marzo": "mar", "Abril": "abr", "Mayo": "may", "Junio": "jun",
         "Julio": "jul", "Agosto": "ago", "Septiembre": "sep", "Octubre": "oct", "Noviembre": "nov",
         "Diciembre": "dic"}

# Código de concepto (tal como aparece al inicio de cada línea de la colilla) ->
# (categoría, nombre base, "hor"/"dia"/None según si hay que anexar unidades al nombre)
CONCEPTOS = {
    "1":    ("Salario Base", "Sueldo", "dia"),
    "45":   ("Recargos y Horas Extra", "Recargo Nocturno 35%", "hor"),
    "52":   ("Recargos y Horas Extra", "Recargo Nocturno Dom/Fest {pct}%", "hor"),
    "66":   ("Recargos y Horas Extra", "Dominical Trabajado {pct}%", "hor"),
    "85":   ("Recargos y Horas Extra", "Horas Adicionales {pct}%", "dia"),
    "775":  ("Formación Continua", "Formación Continua", "dia"),
    "2195": ("Ahorro", "Cuenta A.F.C. Banco Colpatria", None),
    "2355": ("Fondo de Empleados", "Aporte Social Fondo Empleados", None),
    "2360": ("Ahorro", "Ahorro Permanente Fondo Empl.", None),
    "2370": ("Seguros", "FE Salud Sura", None),
    "2450": ("Deuda (Préstamo Fondo Empleados)", "Préstamo Fondo Empleados", None),
    "2806": ("Seguros", "FE Plan C Sura", None),
    "3008": ("Impuestos", "Retención en la Fuente (Método 2)", None),
    "3010": ("Aportes de Ley", "Aporte Salud (EPS Sura)", None),
    "3020": ("Aportes de Ley", "Aporte Pensión (Protección)", None),
    "3023": ("Aportes de Ley", "Aporte Fondo de Solidaridad (Protección)", None),
    "6521": ("Seguros", "Póliza Automóvil - Fondo Empl.", None),
    "6524": ("Transporte", "Parqueadero Carro", None),
    # Cesantías: cada enero, el Hospital emite además de la colilla quincenal
    # normal un comprobante de liquidación de cesantías del año anterior —
    # mismo formato de "colilla" (misma fecha, "Totales:", "Neto a Pagar:"),
    # así que sin distinguirlo el parser lo toma como si fuera otra quincena
    # más (ver detección por "CESANTIAS" en el texto, en parse_colilla). NO
    # es sueldo: el devengo de cesantías (181) se consigna íntegro al fondo
    # el mismo día (descuento 3180, mismo valor) y no queda como plata
    # disponible — main() no guarda ninguno de los dos. Los intereses (191)
    # sí se pagan y son ingreso real, pero este script no escribe en la
    # hoja "Otros Ingresos" (ver aviso impreso en main()) — cargalos a mano
    # ahí, o usá la app (que sí los manda solos).
    "181":  ("Cesantías (no presupuestar)", "Cesantías Año Anterior", None),
    "191":  ("Cesantías (Ingreso)", "Intereses de Cesantías Año Anterior", None),
    "3180": ("Cesantías (no presupuestar)", "Consignación Cesantías a Fondo", None),
}

# Reconocimiento por palabra clave para conceptos sin código fijo conocido
# todavía (ej. la prima de servicios de junio/diciembre, o un bono).
PALABRAS_CLAVE_DEVENGO = [
    (("PRIMA",), "Prima de Servicios", "Prima de Servicios"),
    (("BONO", "BONIFICAC"), "Bonificación", "Bonificación"),
]


def money(s):
    return float(s.replace(",", ""))


def parse_colilla(path):
    with pdfplumber.open(path) as pdf:
        if len(pdf.pages) != 1:
            print(f"  ! Aviso: {path.name} tiene {len(pdf.pages)} páginas; solo se lee la primera.")
        page = pdf.pages[0]
        text = page.extract_text() or ""
        words = page.extract_words(use_text_flow=False, keep_blank_chars=False)

    m = re.search(r"Fecha:\s*(\d{4}-\d{2}-\d{2})", text)
    if not m:
        raise ValueError(f"No encontré la fecha del comprobante en {path.name}. "
                          "¿Es una colilla del Hospital Pablo Tobón Uribe en este formato?")
    fecha_pago = datetime.strptime(m.group(1), "%Y-%m-%d").date()

    m = re.search(r"(Primera|Segunda) Quincena De (\w+) De (\d{4})", text)
    if not m:
        raise ValueError(f"No encontré 'Primera/Segunda Quincena De ... De ...' en {path.name}.")
    quincena_num = "1a" if m.group(1) == "Primera" else "2a"
    mes_nombre = m.group(2)
    anio = m.group(3)
    if mes_nombre not in MESES:
        raise ValueError(f"Mes desconocido '{mes_nombre}' en {path.name}.")
    # El comprobante de Prima (junio/diciembre) y el de liquidación de
    # Cesantías (enero) usan el mismo encabezado "Primera/Segunda Quincena
    # De..." que una quincena normal — el título solo no alcanza para
    # distinguirlos. Se detectan por su devengo característico ("130 PRIMA
    # LEGAL" / cualquier línea con "CESANTIAS"): si aparece, no es una
    # quincena más (ver la misma lógica en app_presupuesto.py).
    periodo = periodo_colilla(text, MESES[mes_nombre], anio, quincena_num)

    m = re.search(r"Totales:\s*\$\s*([\d,]+\.\d{2})\s*\$\s*([\d,]+\.\d{2})", text)
    if not m:
        raise ValueError(f"No encontré la línea de 'Totales:' en {path.name}.")
    total_devengos = money(m.group(1))
    total_descuentos = money(m.group(2))

    m = re.search(r"Neto a Pagar:\s*\$\s*([\d,]+\.\d{2})", text)
    if not m:
        raise ValueError(f"No encontré 'Neto a Pagar:' en {path.name}.")
    neto = money(m.group(1))

    rows = {}
    for w in words:
        key = round(w["top"])
        rows.setdefault(key, []).append(w)

    devengos, descuentos, revisar = [], [], []
    for top in sorted(rows):
        ws = sorted(rows[top], key=lambda w: w["x0"])
        if not ws:
            continue
        first = ws[0]
        if not re.match(r"^\d+$", first["text"]):
            continue  # no es una fila de concepto (encabezado, totales, etc.)
        code = first["text"]
        raw_concept = " ".join(w["text"] for w in ws[1:] if w["x0"] < 220)
        unidad_words = [w for w in ws if 220 <= w["x0"] < 270]
        unidades = None
        if unidad_words:
            try:
                unidades = float(unidad_words[0]["text"])
            except ValueError:
                unidades = None
        money_words = [w for w in ws if w["x0"] >= 300 and re.match(r"^[\d,]+\.\d{2}$", w["text"])]
        if not money_words:
            continue
        mw = money_words[0]
        valor = money(mw["text"])
        columna = "devengo" if mw["x0"] < 400 else ("descuento" if mw["x0"] < 500 else "saldo_prestamo")
        if columna == "saldo_prestamo":
            continue  # saldo de préstamo por nómina, no es un devengo ni un descuento de esta quincena

        if code in CONCEPTOS:
            categoria, nombre_base, unidad_tipo = CONCEPTOS[code]
            pct_match = re.search(r"\((\d+)%", raw_concept)
            pct = pct_match.group(1) if pct_match else ""
            nombre = nombre_base.format(pct=pct) if "{pct}" in nombre_base else nombre_base
            if unidad_tipo == "hor" and unidades is not None:
                nombre += f" ({unidades:g} h)"
            elif unidad_tipo == "dia" and unidades is not None:
                nombre += f" ({unidades:g} días)"
        else:
            upper_concept = raw_concept.upper()
            match_kw = next((cat_nombre for kws, categoria_kw, cat_nombre in PALABRAS_CLAVE_DEVENGO
                              if any(kw in upper_concept for kw in kws)), None)
            categoria_kw = next((categoria_kw for kws, categoria_kw, _ in PALABRAS_CLAVE_DEVENGO
                                  if any(kw in upper_concept for kw in kws)), None)
            if match_kw and columna == "devengo":
                categoria = categoria_kw
                nombre = match_kw
            else:
                categoria = ""
                nombre = f"[REVISAR] {raw_concept} (código {code})"
                revisar.append((code, raw_concept, valor))

        item = dict(quincena=periodo, concepto=nombre, categoria=categoria, valor=valor, codigo=code)
        (devengos if columna == "devengo" else descuentos).append(item)

    return dict(fecha=fecha_pago, periodo=periodo, total_devengos=total_devengos,
                total_descuentos=total_descuentos, neto=neto, devengos=devengos,
                descuentos=descuentos, revisar=revisar)


def find_block(ws, header_texts, formula_col, formula_prefix):
    """Busca la fila de encabezado que coincide con header_texts (columnas 1..N)
    y devuelve (primera_fila_de_datos, ultima_fila_reservada), detectando el
    final del bloque reservado por dónde deja de aparecer la fórmula automática
    que el generador del Excel puso en TODAS las filas reservadas."""
    n = len(header_texts)
    header_row = None
    for row in range(1, ws.max_row + 1):
        vals = [ws.cell(row=row, column=c).value for c in range(1, n + 1)]
        if vals == header_texts:
            header_row = row
            break
    if header_row is None:
        raise RuntimeError(f"No encontré el encabezado {header_texts} en la hoja '{SHEET_CP}'. "
                            "¿Cambió el diseño del archivo?")
    first = header_row + 1
    r = first
    while True:
        val = ws.cell(row=r, column=formula_col).value
        if not (isinstance(val, str) and val.startswith(formula_prefix)):
            break
        r += 1
    last = r - 1
    return first, last


def first_blank_row(ws, first, last, col):
    for r in range(first, last + 1):
        if ws.cell(row=r, column=col).value in (None, ""):
            return r
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("excel", help="Ruta del archivo Presupuesto_Juan_Robledo.xlsx")
    ap.add_argument("colillas", nargs="+", help="Uno o más PDF de colillas de pago")
    ap.add_argument("--salida", help="Guardar en un archivo nuevo en vez de sobrescribir el original")
    args = ap.parse_args()

    excel_path = Path(args.excel)
    if not excel_path.exists():
        sys.exit(f"No encuentro el archivo: {excel_path}")

    print("Leyendo colillas...")
    nuevas = []
    for c in args.colillas:
        p = Path(c)
        if not p.exists():
            print(f"  ! No encuentro {p}, se omite.")
            continue
        try:
            r = parse_colilla(p)
        except Exception as e:
            print(f"  ! No pude leer {p.name}: {e}")
            continue
        print(f"  - {p.name}: {r['periodo']} (fecha {r['fecha']}, "
              f"devengos ${r['total_devengos']:,.0f}, descuentos ${r['total_descuentos']:,.0f}, "
              f"neto ${r['neto']:,.0f})")
        nuevas.append(r)

    if not nuevas:
        sys.exit("No se pudo leer ninguna colilla. No se modificó el archivo.")

    print(f"\nAbriendo {excel_path.name}...")
    wb = load_workbook(excel_path)
    if SHEET_CP not in wb.sheetnames:
        sys.exit(f"El archivo no tiene una hoja llamada '{SHEET_CP}'.")
    ws = wb[SHEET_CP]

    res_first, res_last = find_block(
        ws, ["Fecha de Pago", "Periodo", "Devengos Totales", "Descuentos Totales", "Neto Pagado", "Notas", "Mes (auto)"],
        formula_col=7, formula_prefix='=IF(A')
    dev_first, dev_last = find_block(
        ws, ["Quincena", "Concepto", "Categoría", "Valor", "Secuencia (auto)", "Clave (auto)"],
        formula_col=5, formula_prefix='=IF(A')
    ded_first, ded_last = find_block(
        ws, ["Quincena", "Concepto", "Categoría", "Valor", "Mes (auto)", "Secuencia (auto)", "Clave (auto)"],
        formula_col=5, formula_prefix='=IFERROR(TEXT(INDEX(')

    periodos_existentes = {ws.cell(row=r, column=2).value for r in range(res_first, res_last + 1)
                            if ws.cell(row=r, column=2).value}

    agregadas, omitidas = [], []
    avisos_revisar = []
    avisos_cesantias = []

    for r in nuevas:
        if r["periodo"] in periodos_existentes:
            omitidas.append(r["periodo"])
            continue

        if r["periodo"].startswith("Cesantías"):
            # Liquidación anual de cesantías del fondo, no una quincena (ver
            # CONCEPTOS 181/191/3180): el capital se consigna al fondo el
            # mismo día y no tiene ningún efecto en el flujo de caja, así
            # que no se guarda ni en devengos ni en descuentos. Se deja
            # igual una fila en el resumen (en $0) para que este mismo
            # comprobante no se vuelva a procesar si se sube dos veces.
            rr = first_blank_row(ws, res_first, res_last, col=1)
            if rr is None:
                sys.exit(f"No queda espacio reservado en la tabla 'Resumen por quincena' "
                          f"(fila {res_first} a {res_last}). Avísame para ampliarla.")
            ws.cell(row=rr, column=1, value=r["fecha"])
            ws.cell(row=rr, column=2, value=r["periodo"])
            ws.cell(row=rr, column=3, value=0)
            ws.cell(row=rr, column=4, value=0)
            agregadas.append(r["periodo"])
            interes = sum(it["valor"] for it in r["devengos"] if it.get("codigo") == "191")
            if interes:
                avisos_cesantias.append((r["periodo"], interes))
            continue

        rr = first_blank_row(ws, res_first, res_last, col=1)
        if rr is None:
            sys.exit(f"No queda espacio reservado en la tabla 'Resumen por quincena' "
                      f"(fila {res_first} a {res_last}). Avísame para ampliarla.")
        # Ver comentario junto a los códigos 181/191/3180 en CONCEPTOS: la
        # cesantías de enero no es sueldo y hay que sacarla de los totales.
        total_devengos = r["total_devengos"] - sum(
            it["valor"] for it in r["devengos"] if it["categoria"].endswith("(no presupuestar)"))
        total_descuentos = r["total_descuentos"] - sum(
            it["valor"] for it in r["descuentos"] if it["categoria"].endswith("(no presupuestar)"))
        ws.cell(row=rr, column=1, value=r["fecha"])
        ws.cell(row=rr, column=2, value=r["periodo"])
        ws.cell(row=rr, column=3, value=total_devengos)
        ws.cell(row=rr, column=4, value=total_descuentos)

        for item in r["devengos"]:
            dr = first_blank_row(ws, dev_first, dev_last, col=1)
            if dr is None:
                sys.exit(f"No queda espacio reservado en 'Detalle de devengos' (fila {dev_first} a {dev_last}). "
                          "Avísame para ampliarla.")
            ws.cell(row=dr, column=1, value=item["quincena"])
            ws.cell(row=dr, column=2, value=item["concepto"])
            ws.cell(row=dr, column=3, value=item["categoria"])
            ws.cell(row=dr, column=4, value=item["valor"])

        for item in r["descuentos"]:
            ddr = first_blank_row(ws, ded_first, ded_last, col=1)
            if ddr is None:
                sys.exit(f"No queda espacio reservado en 'Detalle de descuentos' (fila {ded_first} a {ded_last}). "
                          "Avísame para ampliarla.")
            ws.cell(row=ddr, column=1, value=item["quincena"])
            ws.cell(row=ddr, column=2, value=item["concepto"])
            ws.cell(row=ddr, column=3, value=item["categoria"])
            ws.cell(row=ddr, column=4, value=item["valor"])

        agregadas.append(r["periodo"])
        if r["revisar"]:
            avisos_revisar.append((r["periodo"], r["revisar"]))

    if not agregadas:
        print("\nTodas las colillas leídas ya estaban cargadas en el Excel. No se modificó nada.")
        return

    wb.calculation.fullCalcOnLoad = True

    if args.salida:
        salida = Path(args.salida)
    else:
        backup = excel_path.with_name(
            f"{excel_path.stem}.backup-{datetime.now():%Y%m%d-%H%M%S}{excel_path.suffix}")
        shutil.copy2(excel_path, backup)
        print(f"\nCopia de seguridad guardada: {backup.name}")
        salida = excel_path

    wb.save(salida)

    print(f"\nListo. Quincenas agregadas: {', '.join(agregadas)}")
    if omitidas:
        print(f"Ya estaban cargadas (se omitieron): {', '.join(omitidas)}")
    if avisos_revisar:
        print("\n*** Hay conceptos que no reconocí — quedaron sin categoría, revísalos en Excel: ***")
        for periodo, items in avisos_revisar:
            for code, texto, valor in items:
                print(f"   {periodo}: código {code} \"{texto}\" = ${valor:,.0f}")
    if avisos_cesantias:
        print("\n*** Liquidación de cesantías detectada — este script NO carga los intereses a 'Otros "
              "Ingresos' (solo la app lo hace solo). Cargalos a mano ahí: ***")
        for periodo, interes in avisos_cesantias:
            print(f"   {periodo}: intereses de cesantías = ${interes:,.0f}")
    print(f"\nArchivo actualizado: {salida}")
    print("Ábrelo en Excel; si los totales no se ven, presiona Ctrl+Alt+F9 para recalcular.")


if __name__ == "__main__":
    main()
