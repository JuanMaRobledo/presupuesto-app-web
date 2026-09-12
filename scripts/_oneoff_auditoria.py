#!/usr/bin/env python3
"""Script de una sola corrida, SOLO LECTURA: auditoría general de
'Inversiones - Pesos' e 'Inversiones - Dólares' después de la reconciliación
de Fiducuenta, para detectar inconsistencias (duplicados, fórmulas rotas,
plataformas de Aportes sin fila en Posiciones, huecos raros, etc.).

No escribe nada. Se borra después de usarse.
"""
import json
import os
import sys
from collections import Counter, defaultdict

import gspread
from google.oauth2.service_account import Credentials

SHEET_ID = "1wImfL85jPWKUwbcGb6gX7Ug4-3peEiXyp0lIcroycIk"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


def to_num(s):
    if s is None or s == "" or s == "-":
        return None
    try:
        return float(str(s).replace("$", "").replace(".", "").replace(",", ".").strip())
    except ValueError:
        return None


def auditar_hoja(ws, nombre_moneda):
    print(f"\n{'='*70}\nAUDITORÍA: Inversiones - {nombre_moneda}\n{'='*70}")

    # --- Posiciones ---
    posiciones_fmt = ws.get("A5:H45")
    posiciones_formula = ws.get("A5:H45", value_render_option="FORMULA")
    print(f"\n--- Posiciones (A5:H45), {len([f for f in posiciones_fmt if any(c.strip() for c in f)])} filas no vacías ---")
    tickers_vistos = Counter()
    for i, (fila, fila_f) in enumerate(zip(posiciones_fmt, posiciones_formula)):
        if not any(str(c).strip() for c in fila):
            continue
        fila_num = i + 5
        ticker = fila[0].strip() if len(fila) > 0 else ""
        tickers_vistos[ticker] += 1
        print(f"Fila {fila_num}: {fila}")
        # Verificar consistencia Costo=Cantidad*PrecioCompra, Valor=Cantidad*PrecioActual, Ganancia=Valor-Costo
        cantidad = to_num(fila[2]) if len(fila) > 2 else None
        precio_compra = to_num(fila[3]) if len(fila) > 3 else None
        costo = to_num(fila[4]) if len(fila) > 4 else None
        precio_actual = to_num(fila[5]) if len(fila) > 5 else None
        valor = to_num(fila[6]) if len(fila) > 6 else None
        ganancia = to_num(fila[7]) if len(fila) > 7 else None
        if cantidad is not None and precio_compra is not None and costo is not None:
            esperado = cantidad * precio_compra
            if abs(esperado - costo) > 1:
                print(f"  ⚠️ CostoTotal no cuadra: esperado {esperado:,.2f}, hay {costo:,.2f}")
        if cantidad is not None and precio_actual is not None and valor is not None:
            esperado = cantidad * precio_actual
            if abs(esperado - valor) > 1:
                print(f"  ⚠️ ValorActual no cuadra: esperado {esperado:,.2f}, hay {valor:,.2f}")
        if costo is not None and valor is not None and ganancia is not None:
            esperado = valor - costo
            if abs(esperado - ganancia) > 1:
                print(f"  ⚠️ GananciaPerdida no cuadra: esperado {esperado:,.2f}, hay {ganancia:,.2f}")
        # Verificar si son fórmulas vivas o valores fijos pegados
        formulas_col = [str(fila_f[j]) if j < len(fila_f) else "" for j in (4, 6, 7)]
        son_formula = [f.startswith("=") for f in formulas_col]
        if not all(son_formula) and any(str(fila[4]).strip() not in ("", "-") for _ in [0]):
            faltantes = [("CostoTotal", "E"), ("ValorActual", "G"), ("GananciaPerdida", "H")]
            rotas = [nom for (nom, _), ok in zip(faltantes, son_formula) if not ok]
            if rotas:
                print(f"  ℹ️ Columnas sin fórmula (valores fijos, no recalculan solas): {rotas}")

    dups = {t: c for t, c in tickers_vistos.items() if c > 1 and t}
    if dups:
        print(f"\n⚠️ TICKERS DUPLICADOS EN POSICIONES: {dups}")
    else:
        print("\n✅ No hay TickerFondo duplicados en Posiciones.")

    # --- Aportes ---
    aportes = ws.get("A79:D1000")
    print(f"\n--- Aportes (A79:D1000), {len([f for f in aportes if any(c.strip() for c in f)])} filas no vacías ---")
    por_plataforma = defaultdict(lambda: {"aportes": 0.0, "retiros": 0.0, "n": 0, "fechas": []})
    filas_invalidas = []
    for i, fila in enumerate(aportes):
        if not any(str(c).strip() for c in fila):
            continue
        fila_num = i + 79
        if len(fila) < 3:
            filas_invalidas.append((fila_num, fila))
            continue
        fecha, plataforma, monto = fila[0], fila[1], fila[2]
        monto_num = to_num(monto)
        if monto_num is None or not fecha.strip() or not plataforma.strip():
            filas_invalidas.append((fila_num, fila))
            continue
        stats = por_plataforma[plataforma]
        stats["n"] += 1
        stats["fechas"].append(fecha)
        if monto_num >= 0:
            stats["aportes"] += monto_num
        else:
            stats["retiros"] += -monto_num

    if filas_invalidas:
        print(f"\n⚠️ FILAS DE APORTES CON DATOS FALTANTES/INVÁLIDOS: {filas_invalidas}")
    else:
        print("\n✅ Todas las filas de aportes tienen fecha, plataforma y monto numérico válidos.")

    print("\n--- Resumen por plataforma (aportes) ---")
    for plat, stats in sorted(por_plataforma.items()):
        neto = stats["aportes"] - stats["retiros"]
        rango = f"{min(stats['fechas'])} a {max(stats['fechas'])}" if stats["fechas"] else "?"
        print(f"  {plat}: {stats['n']} movs, aportes={stats['aportes']:,.2f}, retiros={stats['retiros']:,.2f}, neto={neto:,.2f}, rango={rango}")

    # Cruce: plataformas en Aportes que no tienen fila en Posiciones (esperado para
    # Acciones y Valores/Trii, que compran varios tickers distintos -- solo marcamos
    # como sospechoso si el nombre se parece a un TickerFondo real pero no calza exacto)
    tickers_pos = set(t for t in tickers_vistos if t)
    plataformas_aportes = set(por_plataforma.keys())
    print("\n--- Cruce Aportes vs Posiciones ---")
    for plat in sorted(plataformas_aportes):
        if plat in tickers_pos:
            print(f"  ✅ '{plat}' tiene fila propia en Posiciones.")
        else:
            print(f"  ℹ️ '{plat}' NO tiene fila en Posiciones (¿plataforma de trading con varias posiciones, ej. Acciones y Valores/Trii?)")
    for tk in sorted(tickers_pos):
        if tk not in plataformas_aportes:
            print(f"  ℹ️ Posición '{tk}' no tiene ningún aporte/retiro registrado en Aportes.")


def main():
    creds_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not creds_json:
        raise RuntimeError("Falta el secret GOOGLE_SERVICE_ACCOUNT_JSON.")
    creds = Credentials.from_service_account_info(json.loads(creds_json), scopes=SCOPES)
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(SHEET_ID)

    auditar_hoja(sh.worksheet("Inversiones - Pesos"), "Pesos")
    auditar_hoja(sh.worksheet("Inversiones - Dólares"), "Dólares")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
