#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Capa de acceso a la base de datos real de la app: el Google Sheet que es una
copia en vivo de Presupuesto_Juan_Robledo.xlsx (mismas hojas, mismas
fórmulas). Este módulo solo sabe leer/escribir rangos concretos — no conoce
nada de Streamlit ni de cómo se parsean colillas/extractos.

Los "bloques reservados" (BLOCKS) son las mismas zonas de filas que ya
usaban actualizar_colillas.py / actualizar_extractos.py para el Excel local,
calculadas una vez sobre el archivo original. Si algún bloque se llena, la
app lo extiende automáticamente conservando las fórmulas que lo referencian.
"""
from datetime import date, datetime, timedelta
import re

import gspread
import pandas as pd
import streamlit as st
from google.oauth2.service_account import Credentials
from gspread.utils import rowcol_to_a1

from cuenta_formatos import es_no_presupuestar

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

SHEET_CP = "Colillas de Pago"
SHEET_VISA = "Egresos - Tarjeta Visa 7497"
SHEET_MC = "Egresos - Mastercard 5922"
SHEET_EFECTIVO = "Egresos - Efectivo"
SHEET_OTROS_ING = "Otros Ingresos"
SHEET_RESUMEN = "Resumen"
SHEET_RESUMEN_MENSUAL = "Resumen Mensual"
SHEET_DEUDAS = "Deudas - Resumen"
SHEET_BALANCE = "Balance Mensual"
SHEET_CATEGORIAS = "Categorías"
SHEET_CATEGORIAS_ESENCIALES = "Categorías Esenciales"
SHEET_INVERSIONES_PESOS = "Inversiones - Pesos"
SHEET_INVERSIONES_DOLARES = "Inversiones - Dólares"
SHEET_HISTORIAL_INVERSIONES = "Historial de Inversiones"
SHEET_PRESUPUESTO = "Presupuesto"
SHEET_CESANTIAS = "Cesantías"
SHEET_PENSION_OBLIGATORIA = "Pensión Obligatoria"
SHEET_FACTURACION_ELECTRONICA = "Facturación Electrónica"

BLOCKS = {
    "colillas_resumen":    dict(sheet=SHEET_CP, header=149, first=150, last=294, cols=7),
    "colillas_devengos":   dict(sheet=SHEET_CP, header=325, first=326, last=531, cols=4),
    "colillas_descuentos": dict(sheet=SHEET_CP, header=544, first=545, last=2010, cols=4),
    "visa_detalle":        dict(sheet=SHEET_VISA, header=14, first=15, last=5614, cols=11),
    "visa_resumen":        dict(sheet=SHEET_VISA, header=5620, first=5621, last=5660, cols=11),
    "mc_detalle":          dict(sheet=SHEET_MC, header=14, first=15, last=5601, cols=11),
    "mc_resumen":          dict(sheet=SHEET_MC, header=5607, first=5608, last=5647, cols=11),
    "mc_detalle_usd":      dict(sheet=SHEET_MC, header=5697, first=5698, last=6697, cols=11),
    "efectivo_detalle":    dict(sheet=SHEET_EFECTIVO, header=14, first=15, last=1999, cols=11),
    "otros_ingresos":      dict(sheet=SHEET_OTROS_ING, header=3, first=4, last=5263, cols=5),
    "conciliacion_efectivo": dict(sheet=SHEET_BALANCE, header=65, first=66, last=265, cols=4),
    "aportes_inversion_pesos":   dict(sheet=SHEET_INVERSIONES_PESOS, header=78, first=79, last=1000, cols=4),
    "aportes_inversion_dolares": dict(sheet=SHEET_INVERSIONES_DOLARES, header=78, first=79, last=1000, cols=4),
    "posiciones_pesos":    dict(sheet=SHEET_INVERSIONES_PESOS, header=4, first=5, last=45, cols=8),
    "posiciones_dolares":  dict(sheet=SHEET_INVERSIONES_DOLARES, header=4, first=5, last=45, cols=8),
    # Extracto real del fondo de cesantías (Fecha de Corte, Fondo, Saldo
    # Anterior, Aportes del Período, Rendimientos, Retiros, Saldo Actual,
    # Notas) — hoja nueva, separada del resto: ver _fetch_cesantias() más
    # abajo, que la deja afuera del batchGet único de _fetch_all() para que
    # si todavía no existe en algún Sheet no tumbe la carga de toda la app.
    # OJO: a diferencia de otros bloques (p. ej. 'otros_ingresos'), esta hoja
    # tiene una fila en blanco extra entre el subtítulo y los encabezados
    # (fila 3 vacía, encabezados en fila 4, datos desde fila 5) — verificado
    # contra el Sheet real.
    "cesantias":           dict(sheet=SHEET_CESANTIAS, header=4, first=5, last=503, cols=8),
    # Extracto real del fondo de pensión obligatoria (mismas columnas y
    # mismo layout de fila en blanco que 'cesantias' — ver comentario
    # arriba y _fetch_pension_obligatoria() más abajo).
    "pension_obligatoria": dict(sheet=SHEET_PENSION_OBLIGATORIA, header=4, first=5, last=503, cols=8),
}

# Bloques que NO van en el batchGet único de _fetch_all() (ver _all_ranges())
# porque viven en una hoja que puede no existir todavía.
_BLOCKS_INDEPENDIENTES = {"cesantias", "pension_obligatoria"}

TARJETA_BLOCKS = {
    "Visa ****7497": dict(detalle="visa_detalle", resumen="visa_resumen"),
    "Mastercard ****5922": dict(detalle="mc_detalle", resumen="mc_resumen", detalle_usd="mc_detalle_usd"),
}


class SinEspacioError(Exception):
    """El bloque reservado está lleno — hay que extenderlo en el Sheet."""


@st.cache_resource(show_spinner=False)
def _client():
    info = dict(st.secrets["gcp_service_account"])
    creds = Credentials.from_service_account_info(info, scopes=SCOPES)
    return gspread.authorize(creds)


@st.cache_resource(show_spinner=False)
def _spreadsheet():
    return _client().open_by_key(st.secrets["sheet_id"])


@st.cache_resource(show_spinner=False)
def _worksheet(name):
    return _spreadsheet().worksheet(name)


def export_workbook_excel():
    """Descarga el Sheet completo (todas las hojas, tal como están) y lo arma
    como un .xlsx en memoria, para que el usuario tenga un respaldo local."""
    from io import BytesIO
    from openpyxl import Workbook

    wb = Workbook()
    wb.remove(wb.active)
    for ws in _spreadsheet().worksheets():
        hoja = wb.create_sheet(title=ws.title[:31])
        for fila in ws.get_all_values():
            hoja.append(fila)
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _a1(row, col):
    return rowcol_to_a1(row, col)


def _range(row1, col1, row2, col2):
    return f"{_a1(row1, col1)}:{_a1(row2, col2)}"


def _get_raw(ws, range_a1):
    """Lee un rango con valores sin formatear (números como float, no como
    texto con separadores de miles) — evita cualquier ambigüedad de locale
    (1.234,56 vs 1,234.56) al interpretar montos."""
    return ws.get(range_a1, value_render_option="UNFORMATTED_VALUE")


_SHEETS_EPOCH = date(1899, 12, 30)


def _serial_to_text(v):
    """Convierte un valor de fecha leído sin formato (número de serie de
    Sheets) a texto dd/mm/yyyy. Si ya es texto, lo deja igual."""
    if isinstance(v, (int, float)):
        try:
            return (_SHEETS_EPOCH + timedelta(days=v)).strftime("%d/%m/%Y")
        except (OverflowError, ValueError):
            return v
    return v


def _date_to_serial(d):
    """Convierte un date de Python al número de serie de Sheets (inverso de
    _serial_to_text) — para escribir fechas con value_input_option='RAW'
    sin arriesgarse a que Sheets las reinterprete como texto o las parsee
    distinto según el locale."""
    return (d - _SHEETS_EPOCH).days


def check_connection():
    """Lanza una excepción clara si las credenciales o el sheet_id no sirven."""
    ws = _worksheet(SHEET_CP)
    ws.acell("A1")


def first_blank_row(block_key):
    """Primera fila libre del bloque para escribir o para saber hasta dónde
    leer. OJO: no es 'el primer hueco en blanco' — es la fila justo después
    de la ÚLTIMA fila con datos. Si hubiera un hueco en el medio (por un
    borrado manual de una celda, por ejemplo) esto lo salta, para no
    escribir encima de datos reales que sigan más abajo ni dejarlos
    invisibles al leer."""
    b = BLOCKS[block_key]
    ws = _worksheet(b["sheet"])
    col_vals = ws.get(_range(b["first"], 1, b["last"], 1))
    n = b["last"] - b["first"] + 1
    ultimo_usado = 0  # offset (1-based) de la última fila con datos; 0 = ninguna
    for i in range(n):
        val = col_vals[i][0] if i < len(col_vals) and col_vals[i] else ""
        if val not in (None, ""):
            ultimo_usado = i + 1
    if ultimo_usado >= n:
        return _extend_block(block_key, 1)
    return b["first"] + ultimo_usado


def column_values(block_key, col):
    """Todos los valores no vacíos de una columna dentro del bloque (para
    chequear qué periodos/quincenas ya están cargados)."""
    b = BLOCKS[block_key]
    ws = _worksheet(b["sheet"])
    vals = ws.get(_range(b["first"], col, b["last"], col))
    return {row[0] for row in vals if row and row[0] not in (None, "")}


def existing_keys(block_key, cols, date_col=None):
    """Para bloques sin una hoja de 'ya cargados' aparte (efectivo, otros
    ingresos): junta, de cada fila ya escrita, los valores de las columnas
    indicadas (1-based) como una tupla, para poder chequear si un
    movimiento nuevo ya está cargado comparando su misma tupla. Si
    date_col está en cols, esa columna se lee como fecha (dd/mm/yyyy) para
    que la comparación coincida con cómo se arma la clave al escribir."""
    b = BLOCKS[block_key]
    ws = _worksheet(b["sheet"])
    vals = _get_raw(ws, _range(b["first"], 1, b["last"], max(cols)))
    keys = []
    for row in vals:
        if not row or not row[0]:
            continue
        key = []
        for c in cols:
            v = row[c - 1] if c - 1 < len(row) else ""
            if c == date_col:
                v = _serial_to_text(v)
            key.append(v)
        keys.append(tuple(key))
    return keys


def _extend_block(block_key, min_extra_rows):
    """Agranda un bloque reservado para que nunca se quede sin espacio —
    se llama sola desde _check_fits, no hace falta pedirlo a mano.

    BLOCKS vive en el código, no en la hoja: si otra sesión ya extendió
    este bloque después de que arrancó este proceso, el 'last' de acá
    puede estar desactualizado. Por eso primero revisa bastante más abajo
    de lo que cree que es el límite — si ya hay lugar (porque otra sesión
    lo dejó), solo actualiza el número en memoria, sin tocar la hoja. Si de
    verdad no hay espacio, inserta filas DENTRO del rango actual (no al
    final) con insertDimension, para que toda fórmula que ya referencia
    este bloque —en cualquier hoja del libro— se agrande sola, sin tener
    que salir a corregir fórmulas a mano (así se coló el bug de Efectivo
    que quedó excluyendo movimientos ya cargados)."""
    b = BLOCKS[block_key]
    ws = _worksheet(b["sheet"])
    extra = max(min_extra_rows, 2000)
    ventana = extra + 3000
    hasta = min(b["last"] + ventana, ws.row_count)

    # Primero confirmamos dónde termina REALMENTE lo ya usado — nunca nos
    # fiamos a ciegas del 'last' de acá, por si otra sesión ya escribió más
    # allá de lo que este proceso cree. 'ultimo_usado' solo puede crecer
    # respecto al 'last' declarado, jamás achicarse.
    ultimo_usado = b["last"]
    if hasta > b["last"]:
        # ojo: la API recorta filas vacías al final de la respuesta, así que
        # cualquier índice más allá de lo devuelto también cuenta como
        # blanco (mismo truco que ya usa first_blank_row más arriba).
        col_vals = ws.get(_range(b["last"] + 1, 1, hasta, 1))
        for i in range(hasta - b["last"]):
            val = col_vals[i][0] if i < len(col_vals) and col_vals[i] else ""
            if val not in (None, ""):
                ultimo_usado = b["last"] + 1 + i

    if hasta - ultimo_usado >= extra:
        # ya hay 'extra' filas libres confirmadas justo después de lo
        # realmente usado — no hace falta insertar nada.
        b["last"] = ultimo_usado + extra
        return ultimo_usado + 1

    # de verdad no hay lugar: insertar SIEMPRE después de lo confirmado como
    # usado (nunca en 'b["last"]' a ciegas, para no partir datos reales que
    # ya se hubieran escrito más allá de lo que este proceso creía).
    insert_at = ultimo_usado + 1
    if ws.row_count < insert_at + extra + 50:
        ws.add_rows(insert_at + extra + 50 - ws.row_count)
    ws.spreadsheet.batch_update({"requests": [{
        "insertDimension": {
            "range": {"sheetId": ws.id, "dimension": "ROWS",
                      "startIndex": insert_at - 1, "endIndex": insert_at - 1 + extra},
            "inheritFromBefore": True,
        }
    }]})
    b["last"] = insert_at - 1 + extra
    for otro in BLOCKS.values():
        if otro is not b and otro["sheet"] == b["sheet"] and otro["header"] >= insert_at:
            otro["header"] += extra
            otro["first"] += extra
            otro["last"] += extra
    return insert_at


def _check_fits(block_key, end_row):
    b = BLOCKS[block_key]
    if end_row > b["last"]:
        _extend_block(block_key, end_row - b["last"])


def write_block_rows(block_key, start_row, rows):
    """Escribe una o más filas consecutivas de valores (lista de listas),
    todas con las mismas columnas 1..N, empezando en start_row. Para
    bloques sin columnas de fórmula intercaladas (devengos, descuentos,
    detalle de compras de tarjeta)."""
    b = BLOCKS[block_key]
    end_row = start_row + len(rows) - 1
    _check_fits(block_key, end_row)
    ws = _worksheet(b["sheet"])
    ws.update(_range(start_row, 1, end_row, len(rows[0])), rows, value_input_option="USER_ENTERED")


def write_row_segments(block_key, row, segments):
    """Escribe varios tramos de columnas de una misma fila en una sola
    llamada a la API. segments: lista de (columna_inicial, [valores]).
    Para bloques donde hay columnas con fórmulas intercaladas entre las
    columnas que sí escribimos (p. ej. el resumen de extractos de
    tarjeta: '% Cupo Utilizado' y 'Compras del Mes' son fórmulas)."""
    _check_fits(block_key, row)
    b = BLOCKS[block_key]
    ws = _worksheet(b["sheet"])
    data = []
    for col_start, values in segments:
        col_end = col_start + len(values) - 1
        data.append({"range": _range(row, col_start, row, col_end), "values": [values]})
    ws.batch_update(data, value_input_option="USER_ENTERED")


def clear_rows_by_key(block_key, key_col, key_value):
    """Borra (deja en blanco) todas las filas de un bloque cuyo valor en la
    columna key_col (1-based) sea exactamente key_value. Solo limpia el
    contenido — no corre filas hacia arriba — así no hace falta reajustar
    ningún otro bloque de la misma hoja ni sus fórmulas. Devuelve cuántas
    filas se limpiaron."""
    b = BLOCKS[block_key]
    ws = _worksheet(b["sheet"])
    vals = ws.get(_range(b["first"], 1, b["last"], b["cols"]))
    filas_a_borrar = []
    for i, row in enumerate(vals):
        val = row[key_col - 1] if len(row) >= key_col else ""
        if val == key_value:
            filas_a_borrar.append(b["first"] + i)
    if not filas_a_borrar:
        return 0
    rangos = [_range(fila, 1, fila, b["cols"]) for fila in filas_a_borrar]
    ws.batch_clear(rangos)
    return len(filas_a_borrar)


def eliminar_colilla(periodo):
    """Borra una quincena completa: la fila de resumen (columna 'Periodo')
    más sus devengos y descuentos (columna 'Quincena'), todos identificados
    por texto exacto. Devuelve cuántas filas se borraron de cada bloque."""
    return dict(
        resumen=clear_rows_by_key("colillas_resumen", 2, periodo),
        devengos=clear_rows_by_key("colillas_devengos", 1, periodo),
        descuentos=clear_rows_by_key("colillas_descuentos", 1, periodo),
    )


def corregir_prima_mal_etiquetada(periodo_viejo):
    """Renombra como Prima un comprobante ya guardado como quincena.

    Conserva fecha, totales, devengos y descuentos; únicamente cambia la
    clave del período en los tres bloques de Colillas de Pago. Antes de
    escribir valida que el período exista, que tenga un devengo de Prima de
    Servicios y que el período de destino no esté ocupado.
    """
    m = re.search(r"([a-zA-Z]{3})-(\d{4})$", periodo_viejo)
    if not m:
        raise ValueError(f"No pude reconocer mes/año en '{periodo_viejo}'.")
    periodo_nuevo = f"Prima {m.group(1).lower()}-{m.group(2)}"

    b_res = BLOCKS["colillas_resumen"]
    b_dev = BLOCKS["colillas_devengos"]
    b_desc = BLOCKS["colillas_descuentos"]
    if len({b_res["sheet"], b_dev["sheet"], b_desc["sheet"]}) != 1:
        raise ValueError("Los bloques de Colillas de Pago no están en la misma hoja.")

    ws = _worksheet(b_res["sheet"])
    resumen = ws.get(_range(b_res["first"], 1, b_res["last"], b_res["cols"]))
    devengos = ws.get(_range(b_dev["first"], 1, b_dev["last"], b_dev["cols"]))
    descuentos = ws.get(_range(b_desc["first"], 1, b_desc["last"], b_desc["cols"]))

    if any(len(row) > 1 and row[1] == periodo_nuevo for row in resumen):
        raise ValueError(f"Ya existe el período de destino '{periodo_nuevo}'.")
    filas_resumen = [b_res["first"] + i for i, row in enumerate(resumen)
                     if len(row) > 1 and row[1] == periodo_viejo]
    if len(filas_resumen) != 1:
        raise ValueError(f"Esperaba una fila de resumen para '{periodo_viejo}' y encontré {len(filas_resumen)}.")

    filas_devengos = [b_dev["first"] + i for i, row in enumerate(devengos)
                      if row and row[0] == periodo_viejo]
    es_prima = any(len(row) > 2 and row[0] == periodo_viejo and row[2] == "Prima de Servicios"
                   for row in devengos)
    if not es_prima:
        raise ValueError(f"'{periodo_viejo}' no contiene un devengo de Prima de Servicios.")
    filas_descuentos = [b_desc["first"] + i for i, row in enumerate(descuentos)
                        if row and row[0] == periodo_viejo]

    hoja = b_res["sheet"].replace("'", "''")
    data = [{"range": f"'{hoja}'!B{filas_resumen[0]}", "values": [[periodo_nuevo]]}]
    data += [{"range": f"'{hoja}'!A{fila}", "values": [[periodo_nuevo]]} for fila in filas_devengos]
    data += [{"range": f"'{hoja}'!A{fila}", "values": [[periodo_nuevo]]} for fila in filas_descuentos]
    ws.spreadsheet.values_batch_update({"valueInputOption": "USER_ENTERED", "data": data})

    return dict(periodo_viejo=periodo_viejo, periodo_nuevo=periodo_nuevo,
                resumen=len(filas_resumen), devengos=len(filas_devengos),
                descuentos=len(filas_descuentos))


def corregir_cesantias_mal_etiquetada(periodo_viejo):
    """Corrige una liquidación de cesantías que había quedado guardada como
    si fuera una quincena (mismo bug que ya se arregló para la Prima —
    parse_colilla() ahora la detecta sola, pero eso no corrige lo que ya
    estaba cargado de antes). periodo_viejo: el 'Periodo' actual tal como
    está en 'Colillas de Pago' → resumen (p.ej. '2a quincena ene-2026').

    Relabels ese período a 'Cesantías {mes}-{año}' con Devengos/Descuentos
    Totales en $0 (el capital se consigna al fondo el mismo día y no tiene
    efecto en caja), borra sus devengos/descuentos detallados (ya no se
    guardan para cesantías, ver aplicar_colillas() en app_presupuesto.py),
    y si había un devengo de intereses lo manda a Otros Ingresos como
    ingreso real. Devuelve {'periodo_viejo', 'periodo_nuevo', 'interes'}."""
    m = re.search(r"([a-zA-Z]{3})-(\d{4})$", periodo_viejo)
    if not m:
        raise ValueError(f"No pude reconocer mes/año en '{periodo_viejo}'.")
    periodo_nuevo = f"Cesantías {m.group(1).lower()}-{m.group(2)}"

    b_res = BLOCKS["colillas_resumen"]
    ws_res = _worksheet(b_res["sheet"])
    vals = ws_res.get(_range(b_res["first"], 1, b_res["last"], b_res["cols"]))
    fila_idx = next((i for i, row in enumerate(vals) if len(row) > 1 and row[1] == periodo_viejo), None)
    if fila_idx is None:
        raise ValueError(f"No encontré '{periodo_viejo}' en Colillas de Pago → resumen.")
    fecha_raw = vals[fila_idx][0] if vals[fila_idx] else None
    fila_num = b_res["first"] + fila_idx

    df_dev = read_colillas_devengos()
    interes = float(df_dev.loc[(df_dev["Quincena"] == periodo_viejo) &
                                (df_dev["Concepto"] == "Intereses de Cesantías Año Anterior"), "Valor"].sum())

    write_row_segments("colillas_resumen", fila_num, [(2, [periodo_nuevo]), (3, [0, 0])])
    clear_rows_by_key("colillas_devengos", 1, periodo_viejo)
    clear_rows_by_key("colillas_descuentos", 1, periodo_viejo)

    if interes:
        fecha_txt = _serial_to_text(fecha_raw)
        if fecha_txt and "/" in str(fecha_txt):
            d, mo, y = str(fecha_txt).split("/")
            fecha_iso = f"{y}-{mo}-{d}"
        else:
            fecha_iso = str(fecha_txt) if fecha_txt else date.today().isoformat()
        fecha_dd_mm = datetime.strptime(fecha_iso, "%Y-%m-%d").strftime("%d/%m/%Y")
        # Guarda contra doble clic/carrera: si dos corridas leen la hoja
        # antes de que la primera renombre el período, las dos encuentran
        # "periodo_viejo" y booking-ean el interés dos veces (pasó en
        # producción). Antes de escribir, chequea si ya hay una fila
        # idéntica para esta fecha.
        ya_registrado = not read_otros_ingresos_tabla().pipe(
            lambda df: df[(df["Fecha"] == fecha_dd_mm) & (df["Concepto"] == "Intereses de Cesantías")
                          & (df["Categoría"] == "Cesantías")]).empty
        if not ya_registrado:
            fila_oi = first_blank_row("otros_ingresos")
            write_block_rows("otros_ingresos", fila_oi,
                              [[fecha_iso, "Intereses de Cesantías", "Cesantías", interes,
                                f"Liquidación de cesantías {periodo_nuevo} — corregido de '{periodo_viejo}', no "
                                "incluye el capital, que se consigna al fondo el mismo día y no es ingreso"]])

    return dict(periodo_viejo=periodo_viejo, periodo_nuevo=periodo_nuevo, interes=interes)


def eliminar_extracto(tarjeta_label, periodo):
    """Borra un extracto completo de una tarjeta: la fila de resumen del
    corte más el detalle de compras de ese período (y el detalle en USD
    también, si esa tarjeta tiene bloque aparte para dólares)."""
    blocks = TARJETA_BLOCKS[tarjeta_label]
    resultado = dict(
        resumen=clear_rows_by_key(blocks["resumen"], 1, periodo),
        detalle=clear_rows_by_key(blocks["detalle"], 1, periodo),
    )
    if "detalle_usd" in blocks:
        resultado["detalle_usd"] = clear_rows_by_key(blocks["detalle_usd"], 1, periodo)
    return resultado


def recategorizar_comercios(mapeo, solo_otros=True):
    """Recategoriza en bloque: mapeo es {comercio: categoria_nueva}. Busca en
    Egresos - Efectivo/Visa/Mastercard las filas cuyo comercio esté en
    mapeo. Si solo_otros=True (default, usado por el chequeo de 'Gasto sin
    categorizar'), solo toca las que además tengan categoría actual
    'Otros' — nunca pisa una fila ya categorizada distinto sin querer. Si
    solo_otros=False (recategorización general, cualquier comercio),
    reescribe la categoría sin importar cuál tenga hoy. Devuelve cuántas
    filas se actualizaron por bloque."""
    resultado = {}
    for block_key in ("efectivo_detalle", "visa_detalle", "mc_detalle"):
        b = BLOCKS[block_key]
        ws = _worksheet(b["sheet"])
        vals = ws.get(_range(b["first"], 1, b["last"], b["cols"]))
        data = []
        for i, row in enumerate(vals):
            comercio = row[2] if len(row) > 2 else ""
            categoria = row[8] if len(row) > 8 else ""
            if comercio in mapeo and (not solo_otros or categoria == "Otros"):
                fila = b["first"] + i
                data.append({"range": f"'{b['sheet']}'!I{fila}", "values": [[mapeo[comercio]]]})
        if data:
            ws.spreadsheet.values_batch_update({"valueInputOption": "USER_ENTERED", "data": data})
        resultado[block_key] = len(data)
    return resultado


def recategorizar_conceptos_ingreso(mapeo):
    """Recategoriza en bloque la hoja 'Otros Ingresos': mapeo es
    {concepto: categoria_nueva}. Reescribe la categoría de toda fila cuyo
    concepto esté en mapeo, sin importar cuál tenga hoy — a diferencia de
    recategorizar_comercios() no hay un 'solo_otros', porque acá no hay un
    caso de uso frecuente de solo arreglar una categoría genérica
    puntual. Devuelve cuántas filas se actualizaron."""
    b = BLOCKS["otros_ingresos"]
    ws = _worksheet(b["sheet"])
    vals = ws.get(_range(b["first"], 1, b["last"], b["cols"]))
    data = []
    for i, row in enumerate(vals):
        concepto = row[1] if len(row) > 1 else ""
        if concepto in mapeo:
            fila = b["first"] + i
            data.append({"range": f"'{b['sheet']}'!C{fila}", "values": [[mapeo[concepto]]]})
    if data:
        ws.spreadsheet.values_batch_update({"valueInputOption": "USER_ENTERED", "data": data})
    return len(data)


def clear_read_cache():
    _fetch_all.clear()
    _fetch_cesantias.clear()
    _fetch_pension_obligatoria.clear()
    read_clasificacion_esencial.clear()
    read_categorias_gasto.clear()


# ---------------------------------------------------------------------------
# Lectura para el dashboard — todo ya viene calculado por las fórmulas del
# Sheet, acá solo se lee el resultado.
#
# Todas las funciones read_* de acá abajo sacan sus datos de _fetch_all(),
# que trae TODO en una sola llamada batchGet en vez de una petición HTTP
# separada por cada tabla (~15 antes). El límite gratuito de la API de
# Sheets es 60 lecturas por minuto por usuario — con una petición por tabla,
# cargar el Dashboard una sola vez ya lo rozaba (o superaba, como pasó).
# Las funciones read_* individuales quedan sin su propio @st.cache_data:
# ya no hacen I/O, solo recortan/transforman lo que trajo _fetch_all(), así
# que cachearlas aparte no ahorra nada y solo complica invalidar el cache.
# ---------------------------------------------------------------------------
def _all_ranges():
    ranges = {}
    for key, b in BLOCKS.items():
        if key in _BLOCKS_INDEPENDIENTES:
            continue
        ranges[f"block:{key}"] = f"'{b['sheet']}'!{_range(b['first'], 1, b['last'], b['cols'])}"
    ranges["resumen_kpis"] = f"'{SHEET_RESUMEN}'!{_range(5, 2, 18, 5)}"          # B5:E18
    ranges["resumen_categorias"] = f"'{SHEET_RESUMEN}'!{_range(22, 2, 39, 5)}"  # B22:E39
    ranges["resumen_mensual"] = f"'{SHEET_RESUMEN_MENSUAL}'!{_range(5, 2, 30, 7)}"  # B5:G30 (fila 5 = encabezado)
    ranges["deudas"] = f"'{SHEET_DEUDAS}'!{_range(5, 1, 10, 8)}"                # A5:H10
    ranges["deuda_tarjeta_usd"] = f"'{SHEET_DEUDAS}'!{_range(12, 1, 12, 3)}"     # A12:C12
    ranges["balance_mensual"] = f"'{SHEET_BALANCE}'!{_range(6, 1, 61, 17)}"     # A6:Q61
    ranges["presupuesto"] = f"'{SHEET_PRESUPUESTO}'!{_range(5, 1, 63, 5)}"      # A5:E63
    return ranges


@st.cache_data(ttl=30, show_spinner=False)
def _fetch_all():
    ranges = _all_ranges()
    resp = _spreadsheet().values_batch_get(list(ranges.values()),
                                            params={"valueRenderOption": "UNFORMATTED_VALUE"})
    value_ranges = resp.get("valueRanges", [])
    return {key: vr.get("values", []) for key, vr in zip(ranges.keys(), value_ranges)}


def _rows_for(block_key):
    """Filas no vacías de un bloque completo, ya traídas por _fetch_all()."""
    return [r for r in _fetch_all()[f"block:{block_key}"] if r and r[0] not in (None, "")]


def read_resumen_kpis():
    vals = _fetch_all()["resumen_kpis"]
    out = []
    for row in vals:
        if len(row) >= 1 and row[0]:
            label = row[0]
            value = row[3] if len(row) >= 4 else (row[-1] if row else None)
            out.append((label, _to_number(value)))
    return out


def read_resumen_categorias():
    vals = _fetch_all()["resumen_categorias"]
    rows = [(r[0], _to_number(r[3]) if len(r) >= 4 else 0) for r in vals if r and r[0]]
    df = pd.DataFrame(rows, columns=["Categoría", "Gasto Real"])
    return df[df["Gasto Real"] > 0].sort_values("Gasto Real", ascending=False).reset_index(drop=True)


def read_resumen_mensual():
    vals = _fetch_all()["resumen_mensual"]  # vals[0] = encabezado (fila 5)
    header = vals[0] if vals else []
    rows = [r for r in vals[1:] if r and r[0]]
    df = pd.DataFrame(rows, columns=header[:len(rows[0])] if rows else header)
    for col in df.columns[1:]:
        df[col] = df[col].map(_to_number)
    return df


def read_deudas_resumen():
    """Créditos con cuota fija (Bancolombia/Sufi/Scotiabank/Fondo de
    Empleados) y tarjetas de crédito (Visa/Mastercard, solo su saldo a
    pagar en pesos) en una sola tabla. Las tarjetas no tienen tasa/cuota/
    plazo fijo — esas columnas quedan en blanco (None, no 0) para esas
    filas en vez de mostrar un falso "0,00%"."""
    header = ["Entidad", "Tipo de Crédito", "Saldo Actual", "Tasa E.A.", "Cuota Mensual",
              "% Pagado", "Meses Restantes Est.", "Fecha Est. de Pago Total"]
    vals = _fetch_all()["deudas"]
    rows = [r for r in vals if r and r[0]]
    df = pd.DataFrame(rows, columns=header[:len(rows[0])] if rows else header)
    for col in ("Saldo Actual", "Tasa E.A.", "Cuota Mensual", "% Pagado", "Meses Restantes Est."):
        if col in df.columns:
            df[col] = df[col].map(lambda v: float("nan") if v in (None, "") else _to_number(v))
    if "Fecha Est. de Pago Total" in df.columns:
        df["Fecha Est. de Pago Total"] = df["Fecha Est. de Pago Total"].map(
            lambda v: None if v in (None, "") else _serial_to_text(v))
    return df


def read_deuda_tarjeta_usd():
    """Deuda de Mastercard en dólares (fila aparte en 'Deudas - Resumen',
    nunca sumada al total en pesos de read_deudas_resumen()). Devuelve
    (entidad, nota, valor_usd) o None si la fila está vacía."""
    vals = _fetch_all()["deuda_tarjeta_usd"]
    row = vals[0] if vals else []
    if not row or not row[0]:
        return None
    entidad = row[0]
    nota = row[1] if len(row) > 1 else ""
    valor = _to_number(row[2]) if len(row) > 2 else 0
    return entidad, nota, valor


SHEET_DEUDA_FONDO_EMPLEADOS = "Deuda - Fondo de Empleados"
SHEET_DEUDA_BANCOLOMBIA = "Deuda - Bancolombia"
SHEET_DEUDA_SUFI = "Deuda - Sufi"
SHEET_DEUDA_SCOTIABANK = "Deuda - Scotiabank Colpatria"
# Las 4 hojas de deuda con cuota fija comparten exactamente el mismo layout
# (columna B de estas filas) — verificado celda por celda contra las 3 que
# ya traían datos antes de generalizar esto.
_FILAS_DEUDA_ENTIDAD = {
    "numero_obligacion": 6, "fecha_desembolso": 7, "monto_inicial": 8, "saldo_actual": 9,
    "fecha_saldo": 10, "tasa_ea": 11, "cuota_mensual": 13, "plazo_meses": 14,
    "numero_cuota_actual": 15, "proxima_fecha_pago": 16, "nota": 17,
}
_CAMPOS_FECHA_DEUDA_ENTIDAD = {"fecha_desembolso", "fecha_saldo", "proxima_fecha_pago"}


def read_deuda_entidad(sheet_name):
    """Lee los campos manuales (celda B de cada fila) de una hoja 'Deuda -
    <entidad>' — todas se completan a mano cada vez que llega un extracto
    nuevo, no tienen ingestión automática. Las fechas vuelven ya
    convertidas a date de Python."""
    ws = _worksheet(sheet_name)
    filas = sorted(_FILAS_DEUDA_ENTIDAD.values())
    resp = ws.spreadsheet.values_get(f"'{sheet_name}'!B{filas[0]}:B{filas[-1]}",
                                      params={"valueRenderOption": "UNFORMATTED_VALUE"})
    vals = resp.get("values", [])

    def valor_fila(fila):
        idx = fila - filas[0]
        fila_vals = vals[idx] if idx < len(vals) else []
        return fila_vals[0] if fila_vals else None

    datos = {}
    for campo, fila in _FILAS_DEUDA_ENTIDAD.items():
        v = valor_fila(fila)
        if campo in _CAMPOS_FECHA_DEUDA_ENTIDAD and isinstance(v, (int, float)):
            v = _SHEETS_EPOCH + timedelta(days=v)
        datos[campo] = v
    return datos


def set_deuda_entidad(sheet_name, valores):
    """Escribe los campos manuales de una hoja 'Deuda - <entidad>'.
    valores: {campo: valor} usando las claves de _FILAS_DEUDA_ENTIDAD — los
    campos de fecha esperan un date de Python (se convierten solos a
    número de serie). Se escribe con RAW para que Sheets no reinterprete
    nada — mismo motivo que set_presupuesto_mes()."""
    ws = _worksheet(sheet_name)
    data = []
    for campo, valor in valores.items():
        if campo not in _FILAS_DEUDA_ENTIDAD:
            continue
        fila = _FILAS_DEUDA_ENTIDAD[campo]
        if campo in _CAMPOS_FECHA_DEUDA_ENTIDAD and valor is not None:
            valor = _date_to_serial(valor)
        data.append({"range": f"B{fila}", "values": [[valor]]})
    if data:
        ws.batch_update(data, value_input_option="RAW")


def set_balance_mensual_mes(anio, mes_nombre):
    """Escribe el selector Año/Mes (E4/G4) de la hoja 'Balance Mensual' —
    la hoja recalcula sus fórmulas para ese mes. Leé el resultado después
    con read_balance_mensual() (y limpiá su cache antes, porque el valor
    que devuelve depende del selector que acabás de cambiar)."""
    ws = _worksheet(SHEET_BALANCE)
    ws.update("E4", [[anio]], value_input_option="USER_ENTERED")
    ws.update("G4", [[mes_nombre]], value_input_option="USER_ENTERED")


def read_balance_mensual():
    """Lee los totales ya calculados por la hoja 'Balance Mensual' para el
    mes que tenga puesto el selector (E4/G4) en ese momento — todo lo que
    efectivamente se pagó e ingresó ese mes. Llamá clear_read_cache() antes
    si acabás de cambiar el selector con set_balance_mensual_mes()."""
    vals = _fetch_all()["balance_mensual"]  # A6:Q61

    def cell(fila, col):
        row = vals[fila - 6] if 0 <= fila - 6 < len(vals) else []
        return row[col - 1] if col - 1 < len(row) else None

    def tabla(fila_ini, fila_fin, columnas):
        filas = [(cell(f, 1), _to_number(cell(f, 2))) for f in range(fila_ini, fila_fin + 1) if cell(f, 1)]
        return pd.DataFrame(filas, columns=columnas)

    return {
        "ingresos_brutos": _to_number(cell(6, 2)),
        "egresos_tarjetas_efectivo": _to_number(cell(6, 7)),
        "descuentos_nomina": _to_number(cell(6, 12)),
        "balance": _to_number(cell(6, 17)),
        "egresos_por_metodo": tabla(14, 16, ["Método", "Valor"]),
        "descuentos_por_categoria": tabla(35, 42, ["Categoría", "Valor"]),
        "ingresos_por_fuente": tabla(60, 61, ["Fuente", "Valor"]),
    }


def read_presupuesto():
    """Lee la hoja 'Presupuesto': el mes que tiene puesto el selector (B5),
    las metas por categoría de gasto (filas 8-25) y las metas de descuentos
    de nómina (filas 56-62), cada una ya comparada por las fórmulas de la
    hoja contra lo real. 'Presupuesto Mensual' viene en blanco hasta que se
    define una meta — se devuelve como 0. Se incluye el número de fila de
    cada categoría para poder escribirla de vuelta con
    set_presupuesto_metas() sin depender de que el orden no cambie."""
    vals = _fetch_all()["presupuesto"]  # A5:E63

    def fila(n):
        row = vals[n - 5] if 0 <= n - 5 < len(vals) else []
        return (list(row) + [None] * 5)[:5]

    mes_actual = fila(5)[1] or ""

    categorias = []
    for n in range(8, 26):
        a, b, c, d, e = fila(n)
        if a:
            categorias.append(dict(fila=n, categoria=a, presupuesto=_to_number(b),
                                    gasto_real=_to_number(c), diferencia=_to_number(d),
                                    pct_usado=_to_number(e)))

    descuentos = []
    for n in range(56, 63):
        a, b, c, d, e = fila(n)
        if a:
            descuentos.append(dict(fila=n, categoria=a, presupuesto=_to_number(b),
                                    real=_to_number(c), diferencia=_to_number(d),
                                    pct_usado=_to_number(e)))

    return dict(mes_actual=mes_actual, categorias=categorias, descuentos=descuentos)


def set_presupuesto_mes(mes):
    """Escribe el selector 'Mes a analizar' (B5) de la hoja 'Presupuesto' —
    copiá un 'Periodo Extracto' tal como aparece en Egresos (ej. '2026-08').
    Se escribe con value_input_option="RAW" (no "USER_ENTERED") a propósito:
    B5 no tiene formato de texto explícito, y Sheets interpreta un
    "USER_ENTERED" con forma "YYYY-MM" como fecha (queda como número de
    serie), rompiendo las fórmulas LEFT/RIGHT($B$5) que arman el mes
    siguiente para Visa/Mastercard. Llamá clear_read_cache() después para
    releer con el mes nuevo."""
    ws = _worksheet(SHEET_PRESUPUESTO)
    ws.update("B5", [[mes]], value_input_option="RAW")


def set_presupuesto_metas(metas):
    """Escribe de una sola vez las metas mensuales (columna B) de la hoja
    'Presupuesto'. metas: {número de fila: valor} — usá los números de fila
    que devuelve read_presupuesto() (no hay que separar categorías de
    descuentos, ambas tablas comparten la misma columna B)."""
    if not metas:
        return
    ws = _worksheet(SHEET_PRESUPUESTO)
    data = [{"range": f"B{fila}", "values": [[valor]]} for fila, valor in metas.items()]
    ws.batch_update(data, value_input_option="USER_ENTERED")


def read_tarjeta_resumen(block_key):
    """Resumen mensual de una tarjeta (cupo, saldo anterior, compras del
    mes, pago total, etc.) tal como está en el Sheet — para conciliar cada
    período contra lo cargado en el detalle de compras. La columna 11 es
    "Notas" en las tarjetas sin bloque USD (Visa) y "Saldo a pagar USD" en
    las que sí lo tienen (Mastercard) — son hojas con layout distinto ahí."""
    col11 = "Saldo a pagar USD" if "detalle_usd" in TARJETA_BLOCKS.get(
        next((k for k, v in TARJETA_BLOCKS.items() if v["resumen"] == block_key), ""), {}) else "Notas"
    headers = ["Periodo Extracto", "Fecha de Corte", "Fecha Límite de Pago", "Cupo Total",
               "Cupo Disponible", "% Cupo Utilizado", "Saldo Anterior", "Compras del Mes",
               "Pago Mínimo", "Pago Total", col11]
    rows = []
    for r in _rows_for(block_key):
        row = (list(r) + [None] * 11)[:11]
        row[1] = _serial_to_text(row[1])
        row[2] = _serial_to_text(row[2])
        idx_numericos = (3, 4, 5, 6, 7, 8, 9, 10) if col11 == "Saldo a pagar USD" else (3, 4, 5, 6, 7, 8, 9)
        for i in idx_numericos:
            row[i] = _to_number(row[i])
        rows.append(row)
    return pd.DataFrame(rows, columns=headers)


def read_conciliacion_efectivo():
    """Saldos de la cuenta de ahorros (Egresos - Efectivo) ingresados a
    mano, mes a mes — no vienen en los extractos que subís, así que hay que
    cargarlos aparte para poder conciliar esa cuenta."""
    headers = ["Mes", "Saldo Inicial", "Saldo Final", "Fecha de Registro"]
    rows = []
    for r in _rows_for("conciliacion_efectivo"):
        row = (list(r) + [None] * 4)[:4]
        row[1] = _to_number(row[1])
        row[2] = _to_number(row[2])
        row[3] = _serial_to_text(row[3])
        rows.append(row)
    return pd.DataFrame(rows, columns=headers)


def guardar_conciliacion_efectivo(mes, saldo_inicial, saldo_final):
    """Guarda (o actualiza si ya había uno) el saldo inicial/final a mano de
    un mes de la cuenta de ahorros. 'mes' es la clave, en texto 'yyyy-mm'."""
    b = BLOCKS["conciliacion_efectivo"]
    ws = _worksheet(b["sheet"])
    vals = _get_raw(ws, _range(b["first"], 1, b["last"], 1))
    fila_existente = None
    for i, r in enumerate(vals, start=b["first"]):
        if r and r[0] == mes:
            fila_existente = i
            break
    fecha_registro = date.today().isoformat()
    if fila_existente:
        ws.update(_range(fila_existente, 2, fila_existente, 4),
                  [[saldo_inicial, saldo_final, fecha_registro]], value_input_option="USER_ENTERED")
    else:
        fila = first_blank_row("conciliacion_efectivo")
        ws.update(_range(fila, 1, fila, 4),
                  [[as_text(mes), saldo_inicial, saldo_final, fecha_registro]], value_input_option="USER_ENTERED")


def _read_simple_block(block_key, headers):
    """Bloque reservado completo, sin columnas de fecha, como DataFrame —
    para pestañas del Dashboard que muestran una hoja del Sheet tal como
    es."""
    rows = [(list(r) + [None] * len(headers))[:len(headers)] for r in _rows_for(block_key)]
    df = pd.DataFrame(rows, columns=headers)
    if "Valor" in df.columns:
        df["Valor"] = df["Valor"].map(_to_number)
    return df


def read_colillas_resumen():
    headers = ["Fecha de Pago", "Periodo", "Devengos Totales", "Descuentos Totales"]
    rows = [[_serial_to_text(r[0]), r[1] if len(r) > 1 else "", _to_number(r[2]) if len(r) > 2 else 0,
              _to_number(r[3]) if len(r) > 3 else 0] for r in _rows_for("colillas_resumen")]
    return pd.DataFrame(rows, columns=headers)


def read_colillas_devengos():
    return _read_simple_block("colillas_devengos", ["Quincena", "Concepto", "Categoría", "Valor"])


def read_colillas_descuentos():
    return _read_simple_block("colillas_descuentos", ["Quincena", "Concepto", "Categoría", "Valor"])


def read_otros_ingresos_tabla():
    headers = ["Fecha", "Concepto", "Categoría", "Valor", "Notas"]
    rows = [[_serial_to_text(r[0]), r[1] if len(r) > 1 else "", r[2] if len(r) > 2 else "",
              _to_number(r[3]) if len(r) > 3 else 0, r[4] if len(r) > 4 else ""] for r in _rows_for("otros_ingresos")]
    df = pd.DataFrame(rows, columns=headers)
    df.insert(len(headers), "Presupuestar", df["Categoría"].map(lambda c: "No" if es_no_presupuestar(c) else "Sí"))
    return df


def eliminar_otro_ingreso(fecha_dd_mm, concepto, categoria, valor):
    """Borra la primera fila de 'Otros Ingresos' que calce exacto en fecha
    (dd/mm/yyyy, como la devuelve read_otros_ingresos_tabla), concepto,
    categoría y valor — para limpiar un duplicado puntual (p. ej. un fix
    que corrió dos veces por una carrera de doble clic) sin tener que
    editar el Sheet a mano. Si hay dos filas idénticas, borra solo la
    primera — llamar de nuevo para la otra. Devuelve True si borró algo."""
    b = BLOCKS["otros_ingresos"]
    ws = _worksheet(b["sheet"])
    vals = _get_raw(ws, _range(b["first"], 1, b["last"], b["cols"]))
    for i, row in enumerate(vals):
        if not row or not row[0]:
            continue
        fila = (list(row) + [""] * 5)[:5]
        if (_serial_to_text(fila[0]) == fecha_dd_mm and str(fila[1]) == concepto
                and str(fila[2]) == categoria and abs(_to_number(fila[3]) - valor) < 0.5):
            fila_num = b["first"] + i
            ws.batch_clear([_range(fila_num, 1, fila_num, b["cols"])])
            return True
    return False


@st.cache_data(ttl=30, show_spinner=False)
def _fetch_cesantias():
    """Aparte de _fetch_all(): la hoja 'Cesantías' es nueva y puede no
    existir todavía en algún Sheet — si falta, que solo afecte a esta
    sección (💰 Cesantías, dentro de 📈 Inversiones), no a toda la app."""
    b = BLOCKS["cesantias"]
    try:
        ws = _worksheet(b["sheet"])
    except gspread.exceptions.WorksheetNotFound:
        return []
    vals = ws.get(_range(b["first"], 1, b["last"], b["cols"]))
    return [r for r in vals if r and r[0] not in (None, "")]


def read_cesantias():
    """Extracto real del fondo de cesantías, cargado a mano (por ahora) del
    documento que envía el fondo — no tiene que ver con la liquidación
    anual que llega en la colilla de nómina de enero (esa va aparte, ver
    aplicar_colillas() en app_presupuesto.py)."""
    headers = ["Fecha de Corte", "Fondo", "Saldo Anterior", "Aportes del Período",
               "Rendimientos", "Retiros", "Saldo Actual", "Notas"]
    rows = []
    for r in _fetch_cesantias():
        fila = (list(r) + [""] * 8)[:8]
        rows.append([_serial_to_text(fila[0]), fila[1], _to_number(fila[2]), _to_number(fila[3]),
                     _to_number(fila[4]), _to_number(fila[5]), _to_number(fila[6]), fila[7]])
    return pd.DataFrame(rows, columns=headers)


@st.cache_data(ttl=30, show_spinner=False)
def _fetch_pension_obligatoria():
    """Aparte de _fetch_all(): la hoja 'Pensión Obligatoria' es nueva y
    puede no existir todavía en algún Sheet — si falta, que solo afecte a
    esta sección (🏦 Pensión Obligatoria, dentro de 📈 Inversiones), no a
    toda la app."""
    b = BLOCKS["pension_obligatoria"]
    try:
        ws = _worksheet(b["sheet"])
    except gspread.exceptions.WorksheetNotFound:
        return []
    vals = ws.get(_range(b["first"], 1, b["last"], b["cols"]))
    return [r for r in vals if r and r[0] not in (None, "")]


def read_pension_obligatoria():
    """Extracto real del fondo de pensión obligatoria (AFP), cargado a mano
    del documento que envía el fondo — igual que read_cesantias() pero para
    la cuenta de pensión. Los aportes vía nómina (concepto 'Aporte Pensión')
    son un descuento de ley aparte que ya está en Colillas de Pago; este
    extracto es el saldo real que reporta la AFP, con sus rendimientos."""
    headers = ["Fecha de Corte", "Fondo", "Saldo Anterior", "Aportes del Período",
               "Rendimientos", "Retiros", "Saldo Actual", "Notas"]
    rows = []
    for r in _fetch_pension_obligatoria():
        fila = (list(r) + [""] * 8)[:8]
        rows.append([_serial_to_text(fila[0]), fila[1], _to_number(fila[2]), _to_number(fila[3]),
                     _to_number(fila[4]), _to_number(fila[5]), _to_number(fila[6]), fila[7]])
    return pd.DataFrame(rows, columns=headers)


def read_aportes_inversion(moneda):
    """Aportes (transferencias salientes hacia una plataforma de inversión)
    de la hoja 'Inversiones - Pesos' o 'Inversiones - Dólares'. moneda:
    'pesos' o 'dolares'."""
    block_key = f"aportes_inversion_{moneda}"
    headers = ["Fecha", "Plataforma", "Monto Transferido (COP)", "Notas"]
    rows = [[_serial_to_text(r[0]), r[1] if len(r) > 1 else "", _to_number(r[2]) if len(r) > 2 else 0,
              r[3] if len(r) > 3 else ""] for r in _rows_for(block_key)]
    return pd.DataFrame(rows, columns=headers)


def agregar_aportes_inversion(moneda, filas):
    """Agrega flujos que no existan aún, sin duplicar por fecha/plataforma/monto.

    Los depósitos llevan monto positivo y los retiros monto negativo. Se
    conserva el nombre histórico de la función para no romper llamadas.
    """
    def fecha_clave(valor):
        if isinstance(valor, datetime):
            return valor.date().isoformat()
        if isinstance(valor, date):
            return valor.isoformat()
        texto = str(valor).strip()
        for formato in ("%Y-%m-%d", "%d/%m/%Y"):
            try:
                return datetime.strptime(texto, formato).date().isoformat()
            except ValueError:
                pass
        return texto

    existentes = read_aportes_inversion(moneda)
    claves = {(fecha_clave(r["Fecha"]), str(r["Plataforma"]), round(float(r["Monto Transferido (COP)"]), 2))
              for _, r in existentes.iterrows()}
    nuevas = []
    for fila in filas:
        clave = (fecha_clave(fila[0]), str(fila[1]), round(float(fila[2]), 2))
        if clave not in claves:
            nuevas.append(fila)
            claves.add(clave)
    if nuevas:
        inicio = first_blank_row(f"aportes_inversion_{moneda}")
        write_block_rows(f"aportes_inversion_{moneda}", inicio, nuevas)
    return len(nuevas)


def set_aportes_inversion(moneda, filas):
    """Sobrescribe los aportes/retiros de 'Inversiones - Pesos/Dólares' con
    'filas' (lista de [fecha, plataforma, monto, notas]) — permite editar o
    borrar flujos ya cargados, no solo agregar. Las filas del bloque que
    sobren respecto a 'filas' quedan en blanco, igual que
    set_posiciones_inversion()."""
    block_key = f"aportes_inversion_{moneda}"
    b = BLOCKS[block_key]
    capacidad = b["last"] - b["first"] + 1
    if len(filas) > capacidad:
        raise SinEspacioError(f"Máximo {capacidad} aportes — hay {len(filas)}.")
    ws = _worksheet(b["sheet"])
    filas_planas = [list(f) + [""] * (4 - len(f)) for f in filas]
    filas_planas += [["", "", "", ""]] * (capacidad - len(filas_planas))
    ws.update(_range(b["first"], 1, b["last"], 4), filas_planas, value_input_option="USER_ENTERED")


HISTORIAL_INVERSION_HEADERS = [
    "Fecha", "Plataforma", "Moneda", "Activo", "Operación", "Cantidad",
    "Precio", "Comisión", "Resultado Realizado", "Fuente",
]


def read_historial_inversion():
    """Lee compras, ventas, cortos y coberturas importadas de los brokers."""
    try:
        ws = _worksheet(SHEET_HISTORIAL_INVERSIONES)
    except gspread.exceptions.WorksheetNotFound:
        return pd.DataFrame(columns=HISTORIAL_INVERSION_HEADERS)
    valores = _get_raw(ws, f"A2:J{max(ws.row_count, 2)}")
    filas = []
    for r in valores:
        if not r or not r[0]:
            continue
        fila = (list(r) + [None] * 10)[:10]
        fila[0] = _serial_to_text(fila[0])
        for idx in (5, 6, 7, 8):
            fila[idx] = _to_number(fila[idx])
        filas.append(fila)
    return pd.DataFrame(filas, columns=HISTORIAL_INVERSION_HEADERS)


def agregar_historial_inversion(filas):
    """Guarda operaciones del broker de forma idempotente.

    ``filas`` sigue el orden de ``HISTORIAL_INVERSION_HEADERS``. La clave
    económica excluye Fuente para que renombrar o volver a descargar el mismo
    reporte no duplique una operación.
    """
    if not filas:
        return 0
    try:
        ws = _worksheet(SHEET_HISTORIAL_INVERSIONES)
    except gspread.exceptions.WorksheetNotFound:
        ws = _spreadsheet().add_worksheet(title=SHEET_HISTORIAL_INVERSIONES, rows=2000, cols=10)
        ws.update("A1:J1", [HISTORIAL_INVERSION_HEADERS], value_input_option="RAW")

    existentes = read_historial_inversion()

    def clave(fila):
        fecha = fila[0]
        if isinstance(fecha, (date, datetime)):
            fecha = fecha.date().isoformat() if isinstance(fecha, datetime) else fecha.isoformat()
        else:
            texto = str(fecha).strip()
            fecha = texto
            for formato in ("%Y-%m-%d", "%d/%m/%Y"):
                try:
                    fecha = datetime.strptime(texto, formato).date().isoformat()
                    break
                except ValueError:
                    pass
        return (fecha, str(fila[1]), str(fila[3]), str(fila[4]),
                round(float(fila[5]), 8), round(float(fila[6]), 8), round(float(fila[7]), 8))

    claves = {clave(r.tolist()) for _, r in existentes.iterrows()}
    nuevas = []
    for fila in filas:
        if clave(fila) not in claves:
            nuevas.append(fila)
            claves.add(clave(fila))
    if nuevas:
        ws.append_rows(nuevas, value_input_option="USER_ENTERED")
    return len(nuevas)


def set_historial_inversion(filas):
    """Sobrescribe toda la hoja 'Historial de Inversiones' con 'filas'
    (mismo orden que HISTORIAL_INVERSION_HEADERS) — permite editar o borrar
    operaciones ya importadas, no solo agregar. A diferencia de los bloques
    reservados de BLOCKS, esta hoja crece por filas (append_rows), así que
    'sobrescribir' significa borrar todo el rango usado y volver a escribir
    desde la fila 2."""
    try:
        ws = _worksheet(SHEET_HISTORIAL_INVERSIONES)
    except gspread.exceptions.WorksheetNotFound:
        ws = _spreadsheet().add_worksheet(title=SHEET_HISTORIAL_INVERSIONES, rows=2000, cols=10)
        ws.update("A1:J1", [HISTORIAL_INVERSION_HEADERS], value_input_option="RAW")
    ws.batch_clear([f"A2:J{max(ws.row_count, 2)}"])
    if filas:
        necesarias = len(filas) + 1
        if ws.row_count < necesarias:
            ws.add_rows(necesarias - ws.row_count)
        ws.update(f"A2:J{len(filas) + 1}", filas, value_input_option="USER_ENTERED")


FACTURACION_ELECTRONICA_HEADERS = [
    "Fecha", "NIT Emisor", "Emisor", "Número Documento", "Tipo Documento",
    "Valor", "Remitente Correo", "Notas",
]


def read_facturacion_electronica():
    """Facturas/notas electrónicas recibidas por correo (notificaciones DIAN)
    — es un registro documental año a año, no se concilia contra Egresos."""
    try:
        ws = _worksheet(SHEET_FACTURACION_ELECTRONICA)
    except gspread.exceptions.WorksheetNotFound:
        return pd.DataFrame(columns=FACTURACION_ELECTRONICA_HEADERS)
    valores = _get_raw(ws, f"A2:H{max(ws.row_count, 2)}")
    filas = []
    for r in valores:
        if not r or not r[0]:
            continue
        fila = (list(r) + [None] * 8)[:8]
        fila[0] = _serial_to_text(fila[0])
        fila[5] = _to_number(fila[5])
        filas.append(fila)
    return pd.DataFrame(filas, columns=FACTURACION_ELECTRONICA_HEADERS)


def agregar_facturas_electronicas(filas):
    """Guarda facturas electrónicas de forma idempotente — la clave es (NIT
    Emisor, Número Documento), lo que de verdad identifica un documento DIAN
    único, así que reimportar el mismo correo (o el mismo lote) no duplica
    filas. ``filas`` sigue el orden de FACTURACION_ELECTRONICA_HEADERS."""
    if not filas:
        return 0
    try:
        ws = _worksheet(SHEET_FACTURACION_ELECTRONICA)
    except gspread.exceptions.WorksheetNotFound:
        ws = _spreadsheet().add_worksheet(title=SHEET_FACTURACION_ELECTRONICA, rows=2000, cols=8)
        ws.update("A1:H1", [FACTURACION_ELECTRONICA_HEADERS], value_input_option="RAW")

    existentes = read_facturacion_electronica()
    claves = {(str(r["NIT Emisor"]), str(r["Número Documento"])) for _, r in existentes.iterrows()}
    nuevas = []
    for fila in filas:
        clave = (str(fila[1]), str(fila[3]))
        if clave not in claves:
            nuevas.append(fila)
            claves.add(clave)
    if nuevas:
        ws.append_rows(nuevas, value_input_option="USER_ENTERED")
    return len(nuevas)


def set_facturas_electronicas(filas):
    """Sobrescribe toda la hoja 'Facturación Electrónica' con 'filas' (mismo
    orden que FACTURACION_ELECTRONICA_HEADERS) — permite editar o borrar
    documentos ya importados, no solo agregar."""
    try:
        ws = _worksheet(SHEET_FACTURACION_ELECTRONICA)
    except gspread.exceptions.WorksheetNotFound:
        ws = _spreadsheet().add_worksheet(title=SHEET_FACTURACION_ELECTRONICA, rows=2000, cols=8)
        ws.update("A1:H1", [FACTURACION_ELECTRONICA_HEADERS], value_input_option="RAW")
    ws.batch_clear([f"A2:H{max(ws.row_count, 2)}"])
    if filas:
        necesarias = len(filas) + 1
        if ws.row_count < necesarias:
            ws.add_rows(necesarias - ws.row_count)
        ws.update(f"A2:H{len(filas) + 1}", filas, value_input_option="USER_ENTERED")


SHEET_DECLARACIONES_RENTA = "Declaraciones de Renta"
DECLARACIONES_RENTA_HEADERS = [
    "Año", "Fecha de Presentación", "Patrimonio Líquido", "Ingresos Brutos",
    "Renta Líquida Gravable", "Impuesto a Cargo", "Retenciones y Anticipos",
    "Saldo (+ a pagar / - a favor)", "Link PDF", "Notas",
]


def read_declaraciones_renta():
    """Declaraciones de renta presentadas, un registro por año — el PDF en
    sí no se sube a través de la app (se guarda a mano en Google Drive),
    acá solo queda el desglose de valores y un link al archivo."""
    try:
        ws = _worksheet(SHEET_DECLARACIONES_RENTA)
    except gspread.exceptions.WorksheetNotFound:
        return pd.DataFrame(columns=DECLARACIONES_RENTA_HEADERS)
    valores = _get_raw(ws, f"A2:J{max(ws.row_count, 2)}")
    filas = []
    for r in valores:
        if not r or not r[0]:
            continue
        fila = (list(r) + [None] * 10)[:10]
        fila[1] = _serial_to_text(fila[1])
        for i in (2, 3, 4, 5, 6, 7):
            fila[i] = _to_number(fila[i])
        filas.append(fila)
    return pd.DataFrame(filas, columns=DECLARACIONES_RENTA_HEADERS)


def guardar_declaracion_renta(fila):
    """Guarda la declaración de un año — la clave es el Año, así que volver
    a guardar el mismo año reemplaza esa fila en vez de duplicarla (permite
    editar una declaración ya cargada). 'fila' sigue el orden de
    DECLARACIONES_RENTA_HEADERS."""
    try:
        ws = _worksheet(SHEET_DECLARACIONES_RENTA)
    except gspread.exceptions.WorksheetNotFound:
        ws = _spreadsheet().add_worksheet(title=SHEET_DECLARACIONES_RENTA, rows=100, cols=10)
        ws.update("A1:J1", [DECLARACIONES_RENTA_HEADERS], value_input_option="RAW")

    existentes = read_declaraciones_renta()
    anio = str(fila[0])
    filas_nuevas = [list(r) for _, r in existentes.iterrows() if str(r["Año"]) != anio]
    filas_nuevas.append(fila)
    filas_nuevas.sort(key=lambda r: int(r[0]))

    ws.batch_clear([f"A2:J{max(ws.row_count, 2)}"])
    necesarias = len(filas_nuevas) + 1
    if ws.row_count < necesarias:
        ws.add_rows(necesarias - ws.row_count)
    ws.update(f"A2:J{len(filas_nuevas) + 1}", filas_nuevas, value_input_option="USER_ENTERED")


SHEET_VALOR_CARTERA = "Historial de Valor de Cartera"
VALOR_CARTERA_HEADERS = ["Fecha", "Moneda", "Valor Costo", "Valor Actual", "Aportes Netos"]


def read_historial_valor_cartera():
    """Serie de snapshots del valor total de la cartera, guardados cada vez
    que se actualizan precios o se guardan posiciones/aportes — es la base
    del gráfico de crecimiento y rentabilidad en el tiempo (ver
    _render_crecimiento_rentabilidad en app_presupuesto.py)."""
    try:
        ws = _worksheet(SHEET_VALOR_CARTERA)
    except gspread.exceptions.WorksheetNotFound:
        return pd.DataFrame(columns=VALOR_CARTERA_HEADERS)
    valores = _get_raw(ws, f"A2:E{max(ws.row_count, 2)}")
    filas = []
    for r in valores:
        if not r or not r[0]:
            continue
        fila = (list(r) + [None] * 5)[:5]
        fila[0] = _serial_to_text(fila[0])
        fila[2], fila[3], fila[4] = _to_number(fila[2]), _to_number(fila[3]), _to_number(fila[4])
        filas.append(fila)
    return pd.DataFrame(filas, columns=VALOR_CARTERA_HEADERS)


def guardar_snapshot_cartera(moneda, fecha, valor_costo, valor_actual, aportes_netos):
    """Guarda (o actualiza, si ya hay uno de la misma fecha y moneda) un
    snapshot del valor total de la cartera — evita que actualizar precios
    varias veces el mismo día apile snapshots repetidos."""
    try:
        ws = _worksheet(SHEET_VALOR_CARTERA)
    except gspread.exceptions.WorksheetNotFound:
        ws = _spreadsheet().add_worksheet(title=SHEET_VALOR_CARTERA, rows=2000, cols=5)
        ws.update("A1:E1", [VALOR_CARTERA_HEADERS], value_input_option="RAW")
    if isinstance(fecha, datetime):
        fecha_dt = fecha.date()
    elif isinstance(fecha, date):
        fecha_dt = fecha
    else:
        fecha_dt = date.fromisoformat(str(fecha))
    # Sheets convierte el texto ISO que escribimos abajo a un valor de fecha
    # real (serie de Sheets); al releerlo con _get_raw + _serial_to_text
    # vuelve como texto dd/mm/yyyy, no ISO — hay que comparar en ese mismo
    # formato o nunca reconocería el snapshot de hoy ya guardado.
    fecha_dd_mm = fecha_dt.strftime("%d/%m/%Y")
    existentes = _get_raw(ws, f"A2:E{max(ws.row_count, 2)}")
    fila_existente = next((i for i, r in enumerate(existentes)
                          if r and _serial_to_text(r[0]) == fecha_dd_mm and len(r) > 1 and r[1] == moneda), None)
    valores = [fecha_dt.isoformat(), moneda, valor_costo, valor_actual, aportes_netos]
    if fila_existente is not None:
        ws.update(f"A{fila_existente + 2}:E{fila_existente + 2}", [valores], value_input_option="USER_ENTERED")
    else:
        ws.append_rows([valores], value_input_option="USER_ENTERED")


SHEET_METAS_ASIGNACION = "Metas de Asignación de Cartera"
METAS_ASIGNACION_HEADERS = ["Moneda", "Tipo", "Meta %"]


def read_metas_asignacion():
    """Meta de asignación (% objetivo) por moneda y tipo de activo (Acción,
    ETF, Cripto...) — la compara contra lo real _render_metas_asignacion()
    en app_presupuesto.py."""
    try:
        ws = _worksheet(SHEET_METAS_ASIGNACION)
    except gspread.exceptions.WorksheetNotFound:
        return pd.DataFrame(columns=METAS_ASIGNACION_HEADERS)
    valores = _get_raw(ws, f"A2:C{max(ws.row_count, 2)}")
    filas = []
    for r in valores:
        if not r or not r[0]:
            continue
        fila = (list(r) + [None] * 3)[:3]
        fila[2] = _to_number(fila[2])
        filas.append(fila)
    return pd.DataFrame(filas, columns=METAS_ASIGNACION_HEADERS)


def set_metas_asignacion(filas):
    """Sobrescribe toda la hoja 'Metas de Asignación de Cartera' con 'filas'
    ([moneda, tipo, meta_decimal], p. ej. 0.30 para 30%) — permite editar o
    borrar metas ya guardadas, no solo agregar."""
    try:
        ws = _worksheet(SHEET_METAS_ASIGNACION)
    except gspread.exceptions.WorksheetNotFound:
        ws = _spreadsheet().add_worksheet(title=SHEET_METAS_ASIGNACION, rows=200, cols=3)
        ws.update("A1:C1", [METAS_ASIGNACION_HEADERS], value_input_option="RAW")
    ws.batch_clear([f"A2:C{max(ws.row_count, 2)}"])
    if filas:
        necesarias = len(filas) + 1
        if ws.row_count < necesarias:
            ws.add_rows(necesarias - ws.row_count)
        ws.update(f"A2:C{len(filas) + 1}", filas, value_input_option="USER_ENTERED")


def read_posiciones_inversion(moneda):
    """Posiciones de bolsa (Ticker/Fondo, Tipo, Cantidad, Precio Compra
    Promedio) de 'Inversiones - Pesos' o 'Inversiones - Dólares'. 'Costo
    Total', 'Valor Actual' y 'Ganancia/Pérdida' son fórmulas del Sheet
    (=Cantidad*Precio Compra, =Cantidad*Precio Actual, =Valor Actual-Costo
    Total) — se leen, nunca se escriben."""
    block_key = f"posiciones_{moneda}"
    headers = ["Ticker / Fondo", "Tipo", "Cantidad", "Precio Compra Promedio",
               "Costo Total", "Precio Actual", "Valor Actual", "Ganancia/Pérdida"]
    rows = []
    for r in _rows_for(block_key):
        row = (list(r) + [None] * 8)[:8]
        for i in (2, 3, 4, 5, 6, 7):
            row[i] = _to_number(row[i])
        rows.append(row)
    return pd.DataFrame(rows, columns=headers)


def set_posiciones_inversion(moneda, filas):
    """Sobrescribe las posiciones de 'Inversiones - Pesos/Dólares' con
    'filas' (lista de dicts: ticker, tipo, cantidad, precio_compra,
    precio_actual) — nunca toca 'Costo Total'/'Valor Actual'/
    'Ganancia-Pérdida' (columnas E/G/H, fórmulas del Sheet). Las filas del
    bloque que sobren respecto a 'filas' quedan en blanco."""
    block_key = f"posiciones_{moneda}"
    b = BLOCKS[block_key]
    capacidad = b["last"] - b["first"] + 1
    if len(filas) > capacidad:
        raise SinEspacioError(f"Máximo {capacidad} posiciones — hay {len(filas)}.")
    ws = _worksheet(b["sheet"])
    data = []
    for i in range(capacidad):
        fila_num = b["first"] + i
        if i < len(filas):
            f = filas[i]
            data.append({"range": f"'{b['sheet']}'!A{fila_num}:D{fila_num}",
                         "values": [[f["ticker"], f["tipo"], f["cantidad"], f["precio_compra"]]]})
            data.append({"range": f"'{b['sheet']}'!F{fila_num}", "values": [[f["precio_actual"]]]})
        else:
            data.append({"range": f"'{b['sheet']}'!A{fila_num}:D{fila_num}", "values": [["", "", "", ""]]})
            data.append({"range": f"'{b['sheet']}'!F{fila_num}", "values": [[""]]})
    ws.spreadsheet.values_batch_update({"valueInputOption": "USER_ENTERED", "data": data})


def read_egreso_detalle(block_key):
    """Detalle crudo de una hoja de egresos (efectivo, visa, mastercard) tal
    como está en el Sheet, para mostrarla como su propia pestaña."""
    headers = ["Periodo Extracto", "Fecha Compra", "Comercio / Concepto", "Moneda", "Cuotas",
               "Valor Total Compra", "Valor Cargado Este Periodo", "Saldo Pendiente (cuotas)",
               "Categoría", "Reembolsable", "Notas"]
    rows = []
    for r in _rows_for(block_key):
        row = (list(r) + [None] * 11)[:11]
        row[1] = _serial_to_text(row[1])
        for i in (5, 6, 7):
            row[i] = _to_number(row[i])
        rows.append(row)
    df = pd.DataFrame(rows, columns=headers)
    df.insert(len(headers), "Presupuestar", df["Categoría"].map(lambda c: "No" if es_no_presupuestar(c) else "Sí"))
    return df


@st.cache_data(ttl=30, show_spinner=False)
def read_clasificacion_esencial():
    """Categoría -> 'Esencial'/'No esencial'/... tal como está editada en la
    hoja 'Categorías Esenciales' (columna B). El usuario la edita ahí
    directamente; cualquier categoría que no aparezca en esa hoja (o cuya
    celda de clasificación esté vacía) queda afuera del diccionario — quien
    llama debe decidir el fallback (ver clasificar_esencial() en
    cuenta_formatos.py, pensada justo para eso)."""
    try:
        ws = _worksheet(SHEET_CATEGORIAS_ESENCIALES)
    except gspread.exceptions.WorksheetNotFound:
        return {}
    vals = ws.get(_range(5, 1, 60, 2))
    return {row[0]: row[1] for row in vals if len(row) > 1 and row[0] and row[1]}


@st.cache_data(ttl=30, show_spinner=False)
def read_categorias_gasto():
    """Lista de categorías de gasto tal como está en 'Categorías disponibles'
    de la hoja 'Categorías' (A2:A25) — la misma lista que usan los
    desplegables de Egresos. Si el usuario agrega una categoría nueva ahí,
    aparece acá solo, sin tocar código. OJO: la fila 26 es el encabezado de
    la siguiente sección de esa misma hoja ("Categorías presupuestables",
    solo texto de referencia, no leído por ninguna función — se corrió una
    fila hacia abajo al insertar 'Seguridad Social' en la 25), así que este
    rango no puede crecer más allá de A25 sin invadirlo de nuevo."""
    ws = _worksheet(SHEET_CATEGORIAS)
    vals = ws.get(_range(2, 1, 25, 1))
    return [row[0] for row in vals if row and row[0]]


def read_movimientos_recientes(limite=5000):
    """OJO: 'Valor' mezcla movimientos en COP y en USD (las compras de
    tarjeta en dólares, columna 'Moneda') — nunca sumes esta columna sin
    filtrar antes por 'Moneda', o vas a estar sumando pesos con dólares
    como si fueran la misma unidad."""
    frames = []

    for r in _rows_for("colillas_devengos"):
        frames.append(dict(Fuente="Colilla (devengo)", Periodo=r[0],
                            Concepto=r[1] if len(r) > 1 else "",
                            Categoría=r[2] if len(r) > 2 else "", Moneda="COP",
                            Valor=_to_number(r[3]) if len(r) > 3 else 0))

    for r in _rows_for("colillas_descuentos"):
        frames.append(dict(Fuente="Colilla (descuento)", Periodo=r[0],
                            Concepto=r[1] if len(r) > 1 else "",
                            Categoría=r[2] if len(r) > 2 else "", Moneda="COP",
                            Valor=-_to_number(r[3]) if len(r) > 3 else 0))

    for tarjeta, blocks in TARJETA_BLOCKS.items():
        for det, sufijo, moneda in [(blocks["detalle"], "", "COP"), (blocks.get("detalle_usd"), " (USD)", "USD")]:
            if det is None:
                continue
            for r in _rows_for(det):
                frames.append(dict(Fuente=tarjeta + sufijo,
                                    Periodo=_serial_to_text(r[1]) if len(r) > 1 else r[0],
                                    Concepto=r[2] if len(r) > 2 else "",
                                    Categoría=r[8] if len(r) > 8 else "", Moneda=moneda,
                                    Valor=-_to_number(r[6]) if len(r) > 6 else 0))

    for r in _rows_for("efectivo_detalle"):
        frames.append(dict(Fuente="Cuenta de ahorros",
                            Periodo=_serial_to_text(r[1]) if len(r) > 1 else r[0],
                            Concepto=r[2] if len(r) > 2 else "",
                            Categoría=r[8] if len(r) > 8 else "", Moneda="COP",
                            Valor=-_to_number(r[6]) if len(r) > 6 else 0))

    for r in _rows_for("otros_ingresos"):
        frames.append(dict(Fuente="Otros ingresos",
                            Periodo=_serial_to_text(r[0]),
                            Concepto=r[1] if len(r) > 1 else "",
                            Categoría=r[2] if len(r) > 2 else "", Moneda="COP",
                            Valor=_to_number(r[3]) if len(r) > 3 else 0))

    df = pd.DataFrame(frames, columns=["Fuente", "Periodo", "Concepto", "Categoría", "Moneda", "Valor"])
    if df.empty:
        return df
    df.insert(len(df.columns), "Presupuestar", df["Categoría"].map(lambda c: "No" if es_no_presupuestar(c) else "Sí"))
    df["_orden_fecha"] = df["Periodo"].map(_periodo_sort_value)
    return (df.sort_values("_orden_fecha", ascending=False, kind="stable")
              .head(limite)
              .drop(columns="_orden_fecha")
              .reset_index(drop=True))


_MESES_CORTOS = {
    "ene": 1, "feb": 2, "mar": 3, "abr": 4, "may": 5, "jun": 6,
    "jul": 7, "ago": 8, "sep": 9, "oct": 10, "nov": 11, "dic": 12,
}


def _periodo_sort_value(value):
    """Normaliza fechas y periodos usados por las distintas fuentes.

    Los movimientos bancarios tienen fecha exacta; las colillas solo indican
    quincena. Para estas últimas usamos el día 1 o 16 del mes, suficiente para
    intercalarlas correctamente sin inventar una fecha de pago exacta.
    """
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time())

    texto = str(value or "").strip().lower()
    for formato in ("%d/%m/%Y", "%Y-%m-%d", "%Y-%m"):
        try:
            return datetime.strptime(texto, formato)
        except ValueError:
            pass

    match = re.fullmatch(r"(?:(1a|2a)\s+quincena\s+)?([a-záéíóú]{3})-(\d{4})", texto)
    if match and match.group(2) in _MESES_CORTOS:
        dia = 16 if match.group(1) == "2a" else 1
        return datetime(int(match.group(3)), _MESES_CORTOS[match.group(2)], dia)
    return datetime.min


def as_text(v):
    """Fuerza texto literal al escribir con USER_ENTERED — Sheets, igual que
    si lo tipearas a mano, intenta interpretar solo como fecha valores como
    '2026-04' o como fecha/fracción valores como '4/12'. Anteponer un
    apóstrofe (igual que en la UI de Sheets) evita esa conversión; el
    apóstrofe no queda guardado ni se muestra."""
    return f"'{v}"


_MILES_PUNTO = re.compile(r"^-?\d{1,3}(\.\d{3})+$")


def _to_number(v):
    """Casi siempre v ya viene como int/float (todas las lecturas usan
    value_render_option=UNFORMATTED_VALUE) — esta rama de texto solo corre
    para celdas que quedaron guardadas como texto (una carga vieja, algo
    tipeado a mano). Antes asumía formato de EE.UU. (',' miles, '.' decimal),
    que rompe el formato colombiano real de estas celdas ('.' miles, ','
    decimal): "$5.087.559" quedaba en 0 (float() no acepta dos puntos) y
    "$886.231" quedaba en 886.231 — 1000 veces menos. Se detecta el
    separador decimal por cuál aparece último cuando hay los dos, y un
    solo punto como separador de miles solo si agrupa de a 3 dígitos
    exactos (si no, se asume que ES el separador decimal, p. ej. "15.8")."""
    if v in (None, ""):
        return 0
    if isinstance(v, (int, float)):
        return v
    s = str(v).replace("$", "").replace("%", "").strip()
    if not s or s == "-":
        return 0
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")
    elif s.count(".") > 1 or _MILES_PUNTO.match(s):
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return 0
