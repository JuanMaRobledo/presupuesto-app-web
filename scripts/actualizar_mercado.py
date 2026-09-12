#!/usr/bin/env python3
"""Se ejecuta como GitHub Action (server-side, sin la restricción de CORS que
tiene el navegador) para traer datos reales de Yahoo Finance y dejarlos
escritos en el Google Sheet:

  - Columna 'Precio Actual' de cada posición en 'Inversiones - Pesos' /
    'Inversiones - Dólares' (puerto de _render_actualizar_precios()).
  - Un snapshot diario del valor de cartera por moneda, en la hoja
    'Historial de Valor de Cartera' (puerto de _tomar_snapshot_cartera() /
    guardar_snapshot_cartera()).
  - La TRM (USD/COP) y el valor "shadow" de cada benchmark -- cuánto
    valdrían hoy los mismos aportes puestos en el benchmark en vez de en la
    cartera real -- en una hoja nueva 'Datos de Mercado (Auto)' (puerto de
    _descargar_trm() / _valor_shadow_benchmark()).

La versión web (presupuesto-app-web) es 100% estática y solo lee esas tres
hojas ya calculadas -- nunca llama a Yahoo Finance desde el navegador. Este
script corre en un runner de GitHub Actions con la misma cuenta de servicio
que ya usa la versión de Streamlit (SCOPES = solo Sheets), pasada por el
secret de GitHub GOOGLE_SERVICE_ACCOUNT_JSON -- esa credencial nunca llega
al navegador ni se guarda en el repo.
"""
import json
import os
import sys
from datetime import date, datetime, timedelta

import gspread
import pandas as pd
import yfinance as yf
from google.oauth2.service_account import Credentials

# El ID del Sheet no es secreto -- ya vive público en js/config.js (el
# acceso real lo controla el login de Google de cada persona, no este ID).
SHEET_ID = "1wImfL85jPWKUwbcGb6gX7Ug4-3peEiXyp0lIcroycIk"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

SHEET_POSICIONES = {"pesos": "Inversiones - Pesos", "dolares": "Inversiones - Dólares"}
RANGO_POSICIONES = "A5:H45"
RANGO_APORTES = "A79:D1000"

SHEET_VALOR_CARTERA = "Historial de Valor de Cartera"
VALOR_CARTERA_HEADERS = ["Fecha", "Moneda", "Valor Costo", "Valor Actual", "Aportes Netos"]

SHEET_DATOS_MERCADO = "Datos de Mercado (Auto)"

# Puerto de BENCHMARKS (app_presupuesto.py).
BENCHMARKS = {"pesos": ("ICOLCAP.CL", "COLCAP"), "dolares": ("^GSPC", "S&P 500")}

_SHEETS_EPOCH = date(1899, 12, 30)


def _serial_to_text(v):
    """Puerto de _serial_to_text() (sheets_backend.py)."""
    if isinstance(v, (int, float)):
        try:
            return (_SHEETS_EPOCH + timedelta(days=v)).strftime("%d/%m/%Y")
        except OverflowError:
            return str(v)
    return v


def _get_raw(ws, range_a1):
    return ws.get(range_a1, value_render_option="UNFORMATTED_VALUE")


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def simbolo_cotizacion(ticker, moneda, tipo=""):
    """Puerto exacto de simbolo_cotizacion() (cuenta_formatos.py) -- traduce
    una posición guardada al símbolo público que usa Yahoo Finance."""
    if str(tipo).strip() == "Fondo de Inversión":
        return None
    nombre = str(ticker or "").strip()
    if not nombre:
        return None
    if " - " in nombre:
        plataforma, activo = nombre.split(" - ", 1)
    else:
        plataforma, activo = "", nombre
    activo = activo.strip().upper()
    if not activo or activo in {"CASH", "EFECTIVO/MARGEN", "EFECTIVO", "MARGEN"}:
        return None
    if plataforma in {"Acciones y Valores", "Trii"} or moneda == "pesos":
        return activo if activo.endswith(".CL") else f"{activo}.CL"
    if plataforma == "Binance" or str(tipo).strip() == "Cripto":
        return activo if "-" in activo else f"{activo}-USD"
    return activo.replace(".", "-")


def _serie_cierre(datos, simbolo, total_simbolos):
    """Puerto de _serie_cierre() (app_presupuesto.py)."""
    if datos.empty:
        return pd.Series(dtype=float)
    if isinstance(datos.columns, pd.MultiIndex):
        if simbolo in datos.columns.get_level_values(0):
            serie = datos[simbolo]["Close"]
        elif "Close" in datos.columns.get_level_values(0):
            serie = datos["Close"][simbolo]
        else:
            return pd.Series(dtype=float)
    elif total_simbolos == 1 and "Close" in datos:
        serie = datos["Close"]
    else:
        return pd.Series(dtype=float)
    return pd.to_numeric(serie, errors="coerce").dropna()


def descargar_cotizaciones(simbolos):
    """Puerto de _descargar_cotizaciones() (app_presupuesto.py)."""
    simbolos = tuple(sorted(set(simbolos)))
    if not simbolos:
        return {}
    datos = yf.download(list(simbolos), period="5d", interval="1d", group_by="ticker",
                         auto_adjust=False, progress=False, threads=True)
    resultado = {}
    for simbolo in simbolos:
        serie = _serie_cierre(datos, simbolo, len(simbolos))
        if not serie.empty:
            resultado[simbolo] = {"precio": float(serie.iloc[-1]),
                                   "fecha": pd.Timestamp(serie.index[-1]).date().isoformat()}
    return resultado


def descargar_trm():
    """Puerto de _descargar_trm() (app_presupuesto.py)."""
    try:
        datos = yf.download("COP=X", period="5d", interval="1d", progress=False)
    except Exception:
        return None, None
    serie = _serie_cierre(datos, "COP=X", 1)
    if serie.empty:
        return None, None
    return float(serie.iloc[-1]), pd.Timestamp(serie.index[-1]).date().isoformat()


def descargar_historico_cierre(simbolo, fecha_inicio):
    """Puerto de _descargar_historico_cierre() (app_presupuesto.py)."""
    try:
        datos = yf.download(simbolo, start=fecha_inicio.isoformat(), progress=False)
    except Exception:
        return pd.Series(dtype=float)
    serie = _serie_cierre(datos, simbolo, 1)
    if not serie.empty:
        serie.index = pd.to_datetime(serie.index).tz_localize(None)
    return serie


def _precio_en(serie, fecha):
    hasta = serie[serie.index <= pd.Timestamp(fecha)]
    return float(hasta.iloc[-1]) if not hasta.empty else float(serie.iloc[0])


def valor_shadow_benchmark(moneda, flujos):
    """Puerto de _valor_shadow_benchmark() (app_presupuesto.py) -- recibe los
    flujos (fecha, monto en COP) ya leídos del Sheet en vez de volver a
    leerlos, porque el caller ya los necesita para el snapshot de cartera."""
    simbolo, nombre = BENCHMARKS.get(moneda, (None, None))
    if not simbolo or not flujos:
        return None, nombre
    fecha_inicio = min(f for f, _ in flujos)
    serie_precio = descargar_historico_cierre(simbolo, fecha_inicio)
    if serie_precio.empty:
        return None, nombre
    serie_fx = descargar_historico_cierre("COP=X", fecha_inicio) if moneda == "dolares" else None
    if moneda == "dolares" and serie_fx.empty:
        return None, nombre

    unidades = 0.0
    for fecha, monto in flujos:
        monto_en_moneda_benchmark = monto
        if serie_fx is not None:
            fx = _precio_en(serie_fx, fecha)
            monto_en_moneda_benchmark = monto / fx if fx else 0.0
        precio = _precio_en(serie_precio, fecha)
        if precio:
            unidades += monto_en_moneda_benchmark / precio
    return unidades * float(serie_precio.iloc[-1]), nombre


def guardar_snapshot_cartera(sh, moneda, fecha, valor_costo, valor_actual, aportes_netos):
    """Puerto de guardar_snapshot_cartera() (sheets_backend.py) -- crea la
    hoja si hace falta (self-healing, igual que el original) y actualiza en
    vez de duplicar si ya hay un snapshot de la misma fecha/moneda (evita
    apilar uno por cada corrida del Action en el mismo día)."""
    try:
        ws = sh.worksheet(SHEET_VALOR_CARTERA)
    except gspread.exceptions.WorksheetNotFound:
        ws = sh.add_worksheet(title=SHEET_VALOR_CARTERA, rows=2000, cols=5)
        ws.update("A1:E1", [VALOR_CARTERA_HEADERS], value_input_option="RAW")
    fecha_dd_mm = fecha.strftime("%d/%m/%Y")
    existentes = _get_raw(ws, f"A2:E{max(ws.row_count, 2)}")
    fila_existente = next((i for i, r in enumerate(existentes)
                            if r and _serial_to_text(r[0]) == fecha_dd_mm and len(r) > 1 and r[1] == moneda), None)
    valores = [fecha.isoformat(), moneda, valor_costo, valor_actual, aportes_netos]
    if fila_existente is not None:
        ws.update(f"A{fila_existente + 2}:E{fila_existente + 2}", [valores], value_input_option="USER_ENTERED")
    else:
        ws.append_rows([valores], value_input_option="USER_ENTERED")


def escribir_datos_mercado(sh, trm, trm_fecha, shadow_por_moneda):
    """Escribe (o crea) 'Datos de Mercado (Auto)' -- hoja simple de
    clave/valor (columna A = etiqueta, B = valor); el lado web la lee por
    etiqueta, no por posición de fila, así que el orden acá no importa."""
    try:
        ws = sh.worksheet(SHEET_DATOS_MERCADO)
    except gspread.exceptions.WorksheetNotFound:
        ws = sh.add_worksheet(title=SHEET_DATOS_MERCADO, rows=20, cols=2)
    valor_pesos, nombre_pesos = shadow_por_moneda.get("pesos", (None, None))
    valor_dolares, nombre_dolares = shadow_por_moneda.get("dolares", (None, None))
    filas = [
        ["Fecha de Actualización", datetime.utcnow().isoformat(timespec="seconds") + "Z"],
        ["TRM (USD/COP)", trm if trm is not None else ""],
        ["TRM Fecha", trm_fecha or ""],
        ["Benchmark Pesos", nombre_pesos or ""],
        ["Benchmark Pesos Valor Shadow (COP)", valor_pesos if valor_pesos is not None else ""],
        ["Benchmark Dólares", nombre_dolares or ""],
        ["Benchmark Dólares Valor Shadow (USD)", valor_dolares if valor_dolares is not None else ""],
    ]
    ws.update("A1:B7", filas, value_input_option="USER_ENTERED")


def main():
    creds_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not creds_json:
        raise RuntimeError("Falta el secret GOOGLE_SERVICE_ACCOUNT_JSON (Settings → Secrets and "
                            "variables → Actions del repo).")
    info = json.loads(creds_json)
    creds = Credentials.from_service_account_info(info, scopes=SCOPES)
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(SHEET_ID)

    # 1) Leer posiciones de cada moneda y armar la lista de símbolos a cotizar.
    posiciones_ws = {moneda: sh.worksheet(nombre) for moneda, nombre in SHEET_POSICIONES.items()}
    posiciones_filas = {}
    referencias = {}  # (moneda, idx) -> símbolo Yahoo
    for moneda, ws in posiciones_ws.items():
        filas_raw = _get_raw(ws, RANGO_POSICIONES)
        filas = [(list(r) + [None] * 8)[:8] for r in filas_raw]
        posiciones_filas[moneda] = filas
        for idx, fila in enumerate(filas):
            ticker = str(fila[0] or "").strip()
            if not ticker:
                continue
            simbolo = simbolo_cotizacion(ticker, moneda, fila[1] or "")
            if simbolo:
                referencias[(moneda, idx)] = simbolo

    # 2) Cotizar y escribir 'Precio Actual' (columna F) de cada posición con símbolo.
    cotizaciones = descargar_cotizaciones(set(referencias.values()))
    actualizadas, faltantes = 0, set()
    for (moneda, idx), simbolo in referencias.items():
        cot = cotizaciones.get(simbolo)
        if cot:
            posiciones_filas[moneda][idx][5] = cot["precio"]
            actualizadas += 1
        else:
            faltantes.add(simbolo)

    for moneda, ws in posiciones_ws.items():
        data = [{"range": f"'{ws.title}'!F{5 + idx}", "values": [[posiciones_filas[moneda][idx][5]]]}
                for idx in range(len(posiciones_filas[moneda])) if (moneda, idx) in referencias]
        if data:
            ws.spreadsheet.values_batch_update({"valueInputOption": "USER_ENTERED", "data": data})

    # 3) TRM.
    trm, trm_fecha = descargar_trm()

    # 4) Snapshot de cartera + valor shadow del benchmark, por moneda.
    shadow_por_moneda = {}
    for moneda, ws in posiciones_ws.items():
        filas_pos = posiciones_filas[moneda]  # ya con 'Precio Actual' actualizado arriba
        valor_costo = sum(abs(_num(f[2])) * _num(f[3]) for f in filas_pos)
        valor_actual = sum(_num(f[2]) * _num(f[5]) for f in filas_pos)

        aportes_raw = _get_raw(ws, RANGO_APORTES)
        aportes_netos, flujos = 0.0, []
        for r in aportes_raw:
            if not r or not r[0]:
                continue
            fecha = pd.to_datetime(_serial_to_text(r[0]), dayfirst=True, errors="coerce")
            monto = _num(r[2]) if len(r) > 2 else 0.0
            aportes_netos += monto
            if not pd.isna(fecha) and monto:
                flujos.append((fecha.date(), monto))

        if valor_costo or valor_actual or aportes_netos:
            guardar_snapshot_cartera(sh, moneda, date.today(), valor_costo, valor_actual, aportes_netos)

        shadow_por_moneda[moneda] = valor_shadow_benchmark(moneda, flujos)

    # 5) 'Datos de Mercado (Auto)'.
    escribir_datos_mercado(sh, trm, trm_fecha, shadow_por_moneda)

    print(f"Precios actualizados: {actualizadas}. Sin cotización: {', '.join(sorted(faltantes)) or 'ninguno'}.")
    print(f"TRM (USD/COP): {trm} ({trm_fecha})")
    for moneda, (valor, nombre) in shadow_por_moneda.items():
        print(f"Benchmark {moneda} ({nombre}): {valor}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
