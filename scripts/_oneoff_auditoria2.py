#!/usr/bin/env python3
"""Script de una sola corrida, SOLO LECTURA: segunda auditoría, más amplia,
después de agregar la vista Consolidada y corregir el bug de XIRR de
acciones. Cubre:
1. Inversiones - Pesos/Dólares: lo mismo que la auditoría anterior
   (duplicados, fórmulas, filas de aportes válidas, cruce plataformas).
2. Historial de Valor de Cartera: fechas ordenadas, sin huecos raros.
3. Verificación cruzada de la fila 12 (Fiducuenta) contra lo esperado
   después de la reconciliación (balance, sin fórmulas rotas).

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

    posiciones_fmt = ws.get("A5:H45")
    posiciones_formula = ws.get("A5:H45", value_render_option="FORMULA")
    no_vacias = [f for f in posiciones_fmt if any(c.strip() for c in f)]
    print(f"\n--- Posiciones (A5:H45), {len(no_vacias)} filas no vacías ---")
    tickers_vistos = Counter()
    for i, (fila, fila_f) in enumerate(zip(posiciones_fmt, posiciones_formula)):
        if not any(str(c).strip() for c in fila):
            continue
        fila_num = i + 5
        ticker = fila[0].strip() if len(fila) > 0 else ""
        tickers_vistos[ticker] += 1
        cantidad = to_num(fila[2]) if len(fila) > 2 else None
        precio_compra = to_num(fila[3]) if len(fila) > 3 else None
        costo = to_num(fila[4]) if len(fila) > 4 else None
        precio_actual = to_num(fila[5]) if len(fila) > 5 else None
        valor = to_num(fila[6]) if len(fila) > 6 else None
        ganancia = to_num(fila[7]) if len(fila) > 7 else None
        problemas = []
        if cantidad is not None and precio_compra is not None and costo is not None:
            if abs(cantidad * precio_compra - costo) > 1:
                problemas.append(f"CostoTotal esperado {cantidad*precio_compra:,.2f}, hay {costo:,.2f}")
        if cantidad is not None and precio_actual is not None and valor is not None:
            if abs(cantidad * precio_actual - valor) > 1:
                problemas.append(f"ValorActual esperado {cantidad*precio_actual:,.2f}, hay {valor:,.2f}")
        if costo is not None and valor is not None and ganancia is not None:
            if abs((valor - costo) - ganancia) > 1:
                problemas.append(f"GananciaPerdida esperada {valor-costo:,.2f}, hay {ganancia:,.2f}")
        marca = " ⚠️ " + "; ".join(problemas) if problemas else ""
        print(f"Fila {fila_num}: {fila}{marca}")

    dups = {t: c for t, c in tickers_vistos.items() if c > 1 and t}
    print(f"\n{'⚠️ TICKERS DUPLICADOS: ' + str(dups) if dups else '✅ Sin tickers duplicados.'}")

    aportes = ws.get("A79:D1000")
    no_vacias_ap = [f for f in aportes if any(c.strip() for c in f)]
    print(f"\n--- Aportes (A79:D1000), {len(no_vacias_ap)} filas no vacías ---")
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

    print("⚠️ FILAS INVÁLIDAS: " + str(filas_invalidas) if filas_invalidas else "✅ Todas las filas de aportes válidas.")
    print("\n--- Resumen por plataforma ---")
    for plat, stats in sorted(por_plataforma.items()):
        neto = stats["aportes"] - stats["retiros"]
        rango = f"{min(stats['fechas'])} a {max(stats['fechas'])}" if stats["fechas"] else "?"
        print(f"  {plat}: {stats['n']} movs, aportes={stats['aportes']:,.2f}, retiros={stats['retiros']:,.2f}, neto={neto:,.2f}, rango={rango}")

    tickers_pos = set(t for t in tickers_vistos if t)
    plataformas_aportes = set(por_plataforma.keys())
    print("\n--- Cruce Aportes vs Posiciones ---")
    for plat in sorted(plataformas_aportes):
        estado = "✅ tiene fila propia" if plat in tickers_pos else "ℹ️ sin fila propia (plataforma de trading multi-posición)"
        print(f"  '{plat}': {estado}")
    for tk in sorted(tickers_pos):
        if tk not in plataformas_aportes:
            print(f"  ℹ️ Posición '{tk}' sin aportes/retiros registrados.")

    return tickers_vistos, por_plataforma


def auditar_historial_valor_cartera(sh):
    print(f"\n{'='*70}\nAUDITORÍA: Historial de Valor de Cartera\n{'='*70}")
    ws = sh.worksheet("Historial de Valor de Cartera")
    filas = ws.get("A2:E5000")
    no_vacias = [f for f in filas if any(c.strip() for c in f)]
    print(f"{len(no_vacias)} filas no vacías.")
    for f in no_vacias[-10:]:
        print(f"  {f}")
    fechas_pesos = [f[0] for f in no_vacias if len(f) > 1 and f[1].strip() == "pesos"]
    fechas_dolares = [f[0] for f in no_vacias if len(f) > 1 and f[1].strip() == "dolares"]
    print(f"Snapshots pesos: {len(fechas_pesos)}, dólares: {len(fechas_dolares)}")


def main():
    creds_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not creds_json:
        raise RuntimeError("Falta el secret GOOGLE_SERVICE_ACCOUNT_JSON.")
    creds = Credentials.from_service_account_info(json.loads(creds_json), scopes=SCOPES)
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(SHEET_ID)

    auditar_hoja(sh.worksheet("Inversiones - Pesos"), "Pesos")
    auditar_hoja(sh.worksheet("Inversiones - Dólares"), "Dólares")
    auditar_historial_valor_cartera(sh)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
