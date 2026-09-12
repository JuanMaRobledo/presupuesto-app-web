#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Actualiza el Excel de presupuesto con nuevos extractos de tarjeta de crédito
(el .xlsx "Detallado" que descargas de Bancolombia para la Visa 7497 o la
Mastercard 5922).

USO:
    python3 actualizar_extractos.py Presupuesto_Juan_Robledo.xlsx extracto1.xlsx [extracto2.xlsx ...]

QUÉ HACE:
    - Detecta solo, leyendo el archivo, de qué tarjeta es (por los últimos 4
      dígitos), el mes del extracto, y lee cada movimiento (compras, cuotas,
      intereses, el abono automático) de las hojas PESOS y DOLARES.
    - Si ese extracto (esa tarjeta + ese mes) YA está cargado, lo salta —
      nunca duplica. Por eso puedes correr el script con extractos viejos
      sin miedo a dañar nada.
    - Si es nuevo, agrega el renglón de resumen del extracto y cada
      movimiento en la hoja "Egresos - Tarjeta Visa 7497" o
      "Egresos - Mastercard 5922", con el mismo formato que ya usa el
      archivo. NO toca ninguna fórmula existente.
    - Categoriza cada comercio automáticamente usando la misma lista que ya
      tiene tu Excel. Los comercios que nunca ha visto quedan en la
      categoría "Otros" con una nota "Comercio no reconocido, clasificar
      manualmente" — ábrelos en Excel y ponles la categoría correcta con el
      desplegable (así, la próxima vez que aparezca ese mismo comercio en
      otro extracto, avísame para que lo agregue a la lista y no tengas que
      corregirlo cada vez).
    - Antes de guardar, hace una copia de seguridad del archivo original.

REQUISITOS (una sola vez):
    pip3 install openpyxl

DESPUÉS DE CORRERLO:
    Abre el Excel normalmente (recalcula solo; si no, Ctrl+Alt+F9).
"""
import argparse
import re
import shutil
import sys
from datetime import date, datetime
from pathlib import Path

try:
    from openpyxl import load_workbook
except ImportError:
    sys.exit("Falta instalar openpyxl. Corre:  pip3 install openpyxl")

# ---------------------------------------------------------------------------
# Tarjetas conocidas: últimos 4 dígitos -> etiqueta y hoja del Excel
# ---------------------------------------------------------------------------
VISA = dict(label="Visa ****7497", sheet="Egresos - Tarjeta Visa 7497")
MASTERCARD = dict(label="Mastercard ****5922", sheet="Egresos - Mastercard 5922")
# Los últimos 4 dígitos cambian cada vez que el banco reemite la tarjeta física
# (se mantiene la misma cuenta/cupo) — 5003 y 2223 son reemisiones ya vistas
# de la Visa y la Mastercard respectivamente (ver app_presupuesto.py).
TARJETAS = {
    "7497": VISA, "5003": VISA,
    "5922": MASTERCARD, "2223": MASTERCARD,
}

MESES_ABR = {"ene": 1, "feb": 2, "mar": 3, "abr": 4, "may": 5, "jun": 6, "jul": 7,
             "ago": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dic": 12}

MONEY_FMT = '$#,##0;[RED]-$#,##0;"-"'
DATE_FMT = 'dd/mm/yyyy'

# ---------------------------------------------------------------------------
# Categorías (igual que el resto del archivo) y comercio -> categoría
# ---------------------------------------------------------------------------
NO_PRESUPUESTAR_CATS = [
    "Pago Tarjeta de Crédito (no presupuestar)",
    "Intereses y Cargos Financieros (no presupuestar)",
    "Ajustes y Reversiones (no presupuestar)",
]

MERCHANT_CATEGORY = {
    "INTERESES CORRIENTES": ("Intereses y Cargos Financieros (no presupuestar)", "No", ""),
    "ABONO DEBITO AUTOMATICO": ("Pago Tarjeta de Crédito (no presupuestar)", "No", "Pago automático de la tarjeta, no es gasto nuevo"),
    "REVERSION DE ABONO": ("Ajustes y Reversiones (no presupuestar)", "No", "Reversión de un abono anterior"),
    "DLO*GOOGLE SKETCHBOOK": ("Tecnología y Suscripciones", "No", ""),
    "SOC DE MEJORAS PUBLICA": ("Vivienda y Servicios", "No", ""),
    "MERCADOPAGO COLOMBIA L": ("Compras Online / Varios", "No", "Verificar qué se compró"),
    "EDS ZULY": ("Transporte", "No", "Combustible"),
    "RAPPI COLOMBIA*DL": ("Restaurantes y Domicilios", "No", ""),
    "NEWREST HOSPITAL UNIVE": ("Restaurantes y Domicilios", "No", "Cafetería del hospital"),
    "COMFAMA 1190 CIS CITY": ("Entretenimiento", "No", "Verificar servicio específico de Comfama"),
    "AIRBNB * HMF5Z5TMPJ": ("Viajes", "No", ""),
    "PARMESSANO REST DELICA": ("Restaurantes y Domicilios", "No", ""),
    "TERPEL MAYORAL": ("Transporte", "No", "Combustible"),
    "aliexpress": ("Compras Online / Varios", "No", ""),
    "LAVAPRES CAMPESTRE DRI": ("Transporte", "No", "Lavado de carro"),
    "CREPES Y WAFFLES CAMPE": ("Restaurantes y Domicilios", "No", ""),
    "EXITO WOW ENVIGADO": ("Mercado y Supermercado", "No", ""),
    "DROGUERIA EX ENVIGADO": ("Salud", "No", ""),
    "MGP*YR Bookingcom": ("Viajes", "No", ""),
    "PAYU PEEWAH": ("Otros", "No", "Verificar comercio"),
    "HOTEL BOGOTA PLAZA": ("Viajes", "No", ""),
    "AIRE DE ROMERO": ("Otros", "No", "Verificar comercio"),
    "CTRO CLINICO Y D INV S": ("Salud", "No", ""),
    "DLO*GOOGLE GOOGLE ONE": ("Tecnología y Suscripciones", "No", ""),
    "MP*TIENDADELM*TIENDADE": ("Compras Online / Varios", "No", ""),
    "PRICESMART": ("Mercado y Supermercado", "No", ""),
    "TBL* ARENA ALFA EDUCAC": ("Educación y Profesional", "No", ""),
    "PAGO ELECTRONICO FLYPASS": ("Transporte", "No", "Peajes"),
    "HOSP PABLO TOBON U": ("Restaurantes y Domicilios", "No", "Posible cafetería/tienda del hospital, verificar"),
    "EURO MURANO": ("Restaurantes y Domicilios", "No", ""),
    "SUMUP*TUVET CLINICA VE": ("Mascotas", "No", "Veterinaria"),
    "MERCADO PAGO*MELIMAS": ("Compras Online / Varios", "No", "Mercado Libre"),
    "MOVISTAR PAGOSEPAYCO": ("Tecnología y Suscripciones", "No", "Plan celular"),
    "AVIANCA SACQR59H": ("Viajes", "No", "Tiquete aéreo"),
    "MULTIPLEX VIVA ENVIGAD": ("Entretenimiento", "No", "Cine"),
    "HOMECENTER VTAS A DIST": ("Vivienda y Servicios", "No", ""),
    "MERCADO PAGO": ("Compras Online / Varios", "No", "Verificar qué se compró"),
    "OLIVENZA COCINA MEDITE": ("Restaurantes y Domicilios", "No", ""),
    # Agregados en auditoría 2026-09 (ver app_presupuesto.py): comercios que
    # aparecían en "Otros" con montos altos/repetidos — el match es por texto
    # EXACTO tal como lo trunca cada banco, así que una variante de corte
    # distinta del mismo comercio no matchea sola, hay que agregar cada una.
    "PRICESMART AMERICAS": ("Mercado y Supermercado", "No", ""),
    "EDS LA MONTANA": ("Transporte", "No", "Combustible"),
    "EDS TEXACO PUNTO CERO": ("Transporte", "No", "Combustible"),
    "AUTOAMERICA INDUSTRIAL": ("Transporte", "No", "Repuestos/accesorios de carro"),
    "CIA SURAMERICANA DE SE": ("Seguros", "No", ""),
    "SURAMERICANA SEGUROS D": ("Seguros", "No", ""),
    "CREPES Y WAFFLES TESOR": ("Restaurantes y Domicilios", "No", ""),
    "ITADAKI RAMEN SAS": ("Restaurantes y Domicilios", "No", ""),
    "AVIANCA": ("Viajes", "No", "Tiquete aéreo"),
    "MERCPAGO*JETSMART": ("Viajes", "No", "Tiquete aéreo"),
    "SNCF-VOYAGEURS": ("Viajes", "No", "Tren (Francia)"),
    "RENFE VIRTUAL INTERNET": ("Viajes", "No", "Tren (España)"),
    "LA TIQUETERA": ("Viajes", "No", "Agencia de viajes/tiquetes"),
    "AIRBNB * HM5A2S3AXE": ("Viajes", "No", ""),
    "AIRBNB * HMS28NYNJY": ("Viajes", "No", ""),
    "MERCPAGO*MERCADOLIBRE": ("Compras Online / Varios", "No", ""),
    "WOMPI*ACEM": ("Educación y Profesional", "No", "Posible membresía/asociación médica, verificar"),
    "GOOGLE *PLAY YOUTUBE*D": ("Tecnología y Suscripciones", "No", "Suscripción YouTube/Google"),
    "DONATELLA TRATTORIA": ("Restaurantes y Domicilios", "No", ""),
    "KAMIL HOSPITAL": ("Restaurantes y Domicilios", "No", "Posible cafetería/tienda del hospital, verificar"),
    "NOVAVENTA": ("Compras Online / Varios", "No", ""),
    "CREDIMAPFRE": ("Seguros", "No", "Seguro del carro"),
    "OMA BARRA MED HSPTAL P": ("Restaurantes y Domicilios", "No", "Café OMA"),
    "AVIANCA SACD3875": ("Viajes", "No", "Tiquete aéreo"),
    "VIN Y GRETTA PHTU": ("Restaurantes y Domicilios", "No", ""),
    "SUBWAY HOSPITAL PABLO": ("Restaurantes y Domicilios", "No", ""),
    "UBER RIDES*DL": ("Transporte", "No", ""),
    "MONTOLIVO PASTA EXPRES": ("Restaurantes y Domicilios", "No", ""),
    "ANTONIOS GELATO SAS": ("Restaurantes y Domicilios", "No", ""),
}


def categorize(merchant):
    return MERCHANT_CATEGORY.get(merchant, ("Otros", "No", "Comercio no reconocido, clasificar manualmente"))


def money(s):
    """Convierte un valor de dinero del extracto a float, sin importar si viene
    en formato colombiano (1.234.567,89) o en formato con coma de miles
    (1,234,567.89) — el extracto mezcla los dos según el campo."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    s = str(s).strip()
    if s == "":
        return None
    neg = s.startswith("-") or s.endswith("-")  # el formato nuevo de Bancolombia pone el '-' al final
    s = s.strip("-").lstrip("+")
    lc, lp = s.rfind(","), s.rfind(".")
    if lc == -1 and lp == -1:
        val = float(s)
    elif lc == -1:
        val = float(s.replace(".", "")) if s.count(".") > 1 or len(s.split(".")[-1]) == 3 else float(s)
    elif lp == -1:
        val = float(s.replace(",", "")) if s.count(",") > 1 or len(s.split(",")[-1]) == 3 else float(s.replace(",", "."))
    elif lc > lp:
        val = float(s.replace(".", "").replace(",", "."))
    else:
        val = float(s.replace(",", ""))
    return -val if neg else val


def parse_date_ddmmyyyy(s):
    d, m, y = s.split("/")
    return date(int(y), int(m), int(d))


def find_label_value(rows, label, value_col_offset=1):
    """Busca en las filas de encabezado una celda con texto == label (o que
    empiece por label) y devuelve el valor de la celda vecina."""
    for r in rows:
        for i, cell in enumerate(r):
            if isinstance(cell, str) and cell.strip().rstrip(":").lower() == label.lower():
                if i + value_col_offset < len(r):
                    return r[i + value_col_offset]
    return None


def parse_periodo_fecha(s):
    """'30 ago. 2026' -> date(2026, 8, 30)"""
    m = re.match(r"(\d{1,2})\s+([A-Za-zñÑ]+)\.?\s+(\d{4})", s.strip())
    if not m:
        return None
    dia, mes_txt, anio = m.groups()
    mes = MESES_ABR.get(mes_txt.lower().rstrip("."))
    if not mes:
        return None
    return date(int(anio), mes, int(dia))


def parse_limite_fecha(s):
    """'sep. 16, 2026' -> date(2026, 9, 16)"""
    m = re.match(r"([A-Za-zñÑ]+)\.?\s+(\d{1,2}),\s+(\d{4})", s.strip())
    if not m:
        return None
    mes_txt, dia, anio = m.groups()
    mes = MESES_ABR.get(mes_txt.lower().rstrip("."))
    if not mes:
        return None
    return date(int(anio), mes, int(dia))


def parse_extracto_sheet(ws):
    """Lee una hoja (PESOS o DOLARES) de un extracto de tarjeta Bancolombia."""
    rows = list(ws.iter_rows(values_only=True))
    header_rows = rows[:29]

    tarjeta_cell = find_label_value(header_rows, "Información de la Tarjeta")
    if not tarjeta_cell:
        raise ValueError("No encontré 'Información de la Tarjeta' — ¿es este el formato correcto?")
    m = re.search(r"(\d{4})$", str(tarjeta_cell))
    if not m:
        raise ValueError(f"No pude leer los últimos 4 dígitos de la tarjeta en '{tarjeta_cell}'.")
    digitos = m.group(1)
    if digitos not in TARJETAS:
        raise ValueError(f"No reconozco la tarjeta terminada en {digitos}. Avísame para agregarla "
                          f"(dime a qué tarjeta corresponde: nombre y hoja del Excel).")
    tarjeta = TARJETAS[digitos]

    # 'Periodo facturado: ' está en la columna A; los dos valores están en B y C
    periodo_fin_txt = None
    for r in header_rows:
        if r[0] and str(r[0]).strip().rstrip(":").lower() == "periodo facturado":
            periodo_fin_txt = r[2]
            break
    if not periodo_fin_txt:
        raise ValueError("No encontré 'Periodo facturado'.")
    fecha_corte = parse_periodo_fecha(str(periodo_fin_txt))
    if not fecha_corte:
        raise ValueError(f"No pude leer la fecha de cierre de '{periodo_fin_txt}'.")
    periodo_extracto = f"{fecha_corte.year:04d}-{fecha_corte.month:02d}"

    limite_txt = find_label_value(header_rows, "Pagar antes de")
    fecha_limite = parse_limite_fecha(str(limite_txt)) if limite_txt else None

    moneda_txt = find_label_value(header_rows, "Moneda")
    moneda = "USD" if moneda_txt and "DOLAR" in str(moneda_txt).upper() else "COP"

    stmt = dict(
        periodo=periodo_extracto,
        fecha_corte=fecha_corte,
        fecha_limite=fecha_limite,
        cupo_total=money(find_label_value(header_rows, "Cupo total")),
        cupo_disponible=money(find_label_value(header_rows, "Cupo disponible")),
        saldo_anterior=money(find_label_value(header_rows, "+ Saldo anterior")),
        pago_minimo=money(find_label_value(header_rows, "Pago mínimo")),
        pago_total=money(find_label_value(header_rows, "Pago total")),
        notas="",
    )

    txns = []
    i = 0
    while i < len(rows):
        r = rows[i]
        if r and r[0] in ("Movimientos durante el periodo", "Movimientos antes del periodo"):
            i += 2
            continue
        if len(r) > 1 and r[1] and isinstance(r[1], str) and re.match(r"\d{2}/\d{2}/\d{4}", r[1]):
            merchant = r[2]
            valor_total = money(r[3])
            cuotas = r[4] if r[4] else "1/1"
            valor_periodo = money(r[5])
            saldo_pend = money(r[8]) if len(r) > 8 else None
            cat, reemb, nota = categorize(merchant)
            txns.append(dict(
                periodo_extracto=periodo_extracto,
                tarjeta=tarjeta["label"],
                sheet=tarjeta["sheet"],
                moneda=moneda,
                fecha_compra=parse_date_ddmmyyyy(r[1]),
                comercio=merchant,
                cuotas=cuotas,
                valor_total=valor_total,
                valor_periodo=valor_periodo,
                saldo_pendiente=saldo_pend,
                categoria=cat,
                reembolsable=reemb,
                nota=nota,
            ))
        i += 1

    return dict(tarjeta=tarjeta, moneda=moneda, statement=stmt, txns=txns)


def find_block(ws, header_texts, date_col):
    """Busca la fila de encabezado y devuelve (primera_fila_datos,
    ultima_fila_reservada), usando el formato de fecha ya puesto en TODAS
    las filas reservadas para saber dónde termina el bloque."""
    n = len(header_texts)
    header_row = None
    for row in range(1, ws.max_row + 1):
        vals = [ws.cell(row=row, column=c).value for c in range(1, n + 1)]
        if vals == header_texts:
            header_row = row
            break
    if header_row is None:
        raise RuntimeError(f"No encontré el encabezado {header_texts} en la hoja '{ws.title}'. "
                            "¿Cambió el diseño del archivo?")
    first = header_row + 1
    r = first
    while ws.cell(row=r, column=date_col).number_format == "dd/mm/yyyy":
        r += 1
    return first, r - 1


def first_blank_row(ws, first, last, col):
    for r in range(first, last + 1):
        if ws.cell(row=r, column=col).value in (None, ""):
            return r
    return None


DET_HEADERS = ["Periodo Extracto", "Fecha Compra", "Comercio / Concepto", "Moneda", "Cuotas",
               "Valor Total Compra", "Valor Cargado Este Periodo", "Saldo Pendiente (cuotas)",
               "Categoría", "Reembolsable", "Notas"]
STMT_HEADERS = ["Periodo Extracto", "Fecha de Corte", "Fecha Límite de Pago", "Cupo Total",
                "Cupo Disponible", "% Cupo Utilizado", "Saldo Anterior",
                "Compras del Mes (detalle)", "Pago Mínimo", "Pago Total", "Notas"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("excel", help="Ruta del archivo Presupuesto_Juan_Robledo.xlsx")
    ap.add_argument("extractos", nargs="+", help="Uno o más .xlsx de extracto detallado de tarjeta")
    ap.add_argument("--salida", help="Guardar en un archivo nuevo en vez de sobrescribir el original")
    args = ap.parse_args()

    excel_path = Path(args.excel)
    if not excel_path.exists():
        sys.exit(f"No encuentro el archivo: {excel_path}")

    print("Leyendo extractos...")
    parsed = []
    for e in args.extractos:
        p = Path(e)
        if not p.exists():
            print(f"  ! No encuentro {p}, se omite.")
            continue
        try:
            wbx = load_workbook(p, data_only=True)
        except Exception as ex:
            print(f"  ! No pude abrir {p.name}: {ex}")
            continue
        for sn in wbx.sheetnames:
            try:
                r = parse_extracto_sheet(wbx[sn])
            except Exception as ex:
                print(f"  ! No pude leer la hoja '{sn}' de {p.name}: {ex}")
                continue
            print(f"  - {p.name} [{sn}]: {r['tarjeta']['label']} ({r['moneda']}), "
                  f"periodo {r['statement']['periodo']}, {len(r['txns'])} movimientos")
            parsed.append(r)

    if not parsed:
        sys.exit("No se pudo leer ningún extracto. No se modificó el archivo.")

    print(f"\nAbriendo {excel_path.name}...")
    wb = load_workbook(excel_path)

    # Agrupar por hoja de destino (Visa / Mastercard) y por periodo, para no
    # duplicar el renglón de resumen si vienen varias monedas del mismo mes.
    por_hoja = {}
    for r in parsed:
        por_hoja.setdefault(r["tarjeta"]["sheet"], []).append(r)

    agregados, omitidos, avisos = [], [], []

    for sheet_name, entradas in por_hoja.items():
        if sheet_name not in wb.sheetnames:
            print(f"  ! El archivo no tiene una hoja '{sheet_name}', se omite.")
            continue
        ws = wb[sheet_name]
        det_first, det_last = find_block(ws, DET_HEADERS, date_col=2)
        stmt_first, stmt_last = find_block(ws, STMT_HEADERS, date_col=2)

        periodos_existentes = {ws.cell(row=r, column=1).value for r in range(stmt_first, stmt_last + 1)
                                if ws.cell(row=r, column=1).value}

        # Solo un renglón de resumen por periodo (aunque haya PESOS y DOLARES)
        vistos_periodo = set()
        for entrada in entradas:
            periodo = entrada["statement"]["periodo"]
            etiqueta = f"{entrada['tarjeta']['label']} {periodo} ({entrada['moneda']})"
            if periodo in periodos_existentes:
                omitidos.append(etiqueta)
                continue

            if periodo not in vistos_periodo:
                sr = first_blank_row(ws, stmt_first, stmt_last, col=1)
                if sr is None:
                    sys.exit(f"No queda espacio reservado en 'Extractos mensuales' de '{sheet_name}'. "
                              "Avísame para ampliarla.")
                s = entrada["statement"]
                ws.cell(row=sr, column=1, value=s["periodo"])
                ws.cell(row=sr, column=2, value=s["fecha_corte"])
                ws.cell(row=sr, column=3, value=s["fecha_limite"])
                ws.cell(row=sr, column=4, value=s["cupo_total"])
                ws.cell(row=sr, column=5, value=s["cupo_disponible"])
                ws.cell(row=sr, column=7, value=s["saldo_anterior"])
                ws.cell(row=sr, column=9, value=s["pago_minimo"])
                ws.cell(row=sr, column=10, value=s["pago_total"])
                vistos_periodo.add(periodo)

            for t in entrada["txns"]:
                dr = first_blank_row(ws, det_first, det_last, col=1)
                if dr is None:
                    sys.exit(f"No queda espacio reservado en 'Detalle de compras' de '{sheet_name}'. "
                              "Avísame para ampliarla.")
                ws.cell(row=dr, column=1, value=t["periodo_extracto"])
                ws.cell(row=dr, column=2, value=t["fecha_compra"])
                ws.cell(row=dr, column=3, value=t["comercio"])
                ws.cell(row=dr, column=4, value=t["moneda"])
                ws.cell(row=dr, column=5, value=t["cuotas"])
                ws.cell(row=dr, column=6, value=t["valor_total"])
                ws.cell(row=dr, column=7, value=t["valor_periodo"])
                ws.cell(row=dr, column=8, value=t["saldo_pendiente"])
                ws.cell(row=dr, column=9, value=t["categoria"])
                ws.cell(row=dr, column=10, value=t["reembolsable"])
                ws.cell(row=dr, column=11, value=t["nota"])
                if t["categoria"] == "Otros" and t["nota"] == "Comercio no reconocido, clasificar manualmente":
                    avisos.append((entrada["tarjeta"]["label"], t["comercio"], t["valor_periodo"]))

            agregados.append(etiqueta)

    if not agregados:
        print("\nTodos los extractos leídos ya estaban cargados en el Excel. No se modificó nada.")
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

    print(f"\nListo. Extractos agregados: {', '.join(agregados)}")
    if omitidos:
        print(f"Ya estaban cargados (se omitieron): {', '.join(omitidos)}")
    if avisos:
        print("\n*** Comercios nuevos que no reconocí — quedaron en 'Otros', clasifícalos en Excel: ***")
        vistos = set()
        for tarjeta, comercio, valor in avisos:
            key = (tarjeta, comercio)
            if key in vistos:
                continue
            vistos.add(key)
            print(f"   {tarjeta}: \"{comercio}\" (ej. ${valor:,.0f})")
    print(f"\nArchivo actualizado: {salida}")
    print("Ábrelo en Excel; si los totales no se ven, presiona Ctrl+Alt+F9 para recalcular.")


if __name__ == "__main__":
    main()
