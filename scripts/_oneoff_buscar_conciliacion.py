#!/usr/bin/env python3
"""Script de una sola corrida, SOLO LECTURA: busca en todo el Sheet (vía la
cuenta de servicio, sin el límite de tamaño del conector de Drive) la
conciliación de "Fondo de Inversión (banco)" que el usuario dice que ya
existe -- lista todas las hojas, y dentro de "Libro crudo..." busca filas
relacionadas con FONDO/PIBANK en 2025, más cualquier hoja con "conciliaci"
o "diagnostico" en el nombre.

No escribe nada. Se borra después de usarse.
"""
import json
import os
import sys

import gspread
from google.oauth2.service_account import Credentials

SHEET_ID = "1wImfL85jPWKUwbcGb6gX7Ug4-3peEiXyp0lIcroycIk"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


def main():
    creds_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not creds_json:
        raise RuntimeError("Falta el secret GOOGLE_SERVICE_ACCOUNT_JSON.")
    creds = Credentials.from_service_account_info(json.loads(creds_json), scopes=SCOPES)
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(SHEET_ID)

    print("=== Todas las hojas del Sheet ===")
    hojas = sh.worksheets()
    for ws in hojas:
        print(f"- '{ws.title}' ({ws.row_count} filas x {ws.col_count} cols)")

    # ---- 'Conciliación' completa ----
    conc = next((ws for ws in hojas if ws.title == "Conciliación"), None)
    if conc is not None:
        print(f"\n=== Contenido completo de 'Conciliación' ({conc.row_count}x{conc.col_count}) ===")
        for i, fila in enumerate(conc.get_all_values()):
            if any(c.strip() for c in fila):
                print(f"Fila {i+1}: {fila}")

    # ---- 'Cuenta 1031 - Auditoría' (el "libro crudo" de la cuenta bancaria) ----
    libro = next((ws for ws in hojas if ws.title == "Cuenta 1031 - Auditoría"), None)
    if libro is not None:
        valores = libro.get_all_values()
        print(f"\n=== 'Cuenta 1031 - Auditoría': {len(valores)} filas totales ===")
        print(f"Encabezado: {valores[0] if valores else '(vacía)'}")
        periodos = sorted(set(fila[0] for fila in valores[1:] if fila and fila[0] and fila[0][:2] == "20"))
        if periodos:
            print(f"Rango real de datos: {periodos[0]} a {periodos[-1]} ({len(periodos)} períodos)")
        print("\n--- Filas que mencionan FONDO o PIBANK ---")
        encontradas = 0
        for i, fila in enumerate(valores):
            texto = " | ".join(fila).upper()
            if "FONDO" in texto or "PIBANK" in texto:
                print(f"Fila {i+1}: {fila}")
                encontradas += 1
        print(f"Total: {encontradas} filas")

    # ---- 'Auditoría' (por si acá está la conciliación real) ----
    aud = next((ws for ws in hojas if ws.title == "Auditoría"), None)
    if aud is not None:
        valores = aud.get_all_values()
        print(f"\n=== 'Auditoría': {len(valores)} filas totales ===")
        print(f"Encabezado: {valores[0] if valores else '(vacía)'}")
        for i, fila in enumerate(valores[:5]):
            print(f"Fila {i+1}: {fila}")
        print("--- Filas que mencionan FONDO o PIBANK ---")
        encontradas = 0
        for i, fila in enumerate(valores):
            texto = " | ".join(fila).upper()
            if "FONDO" in texto or "PIBANK" in texto:
                print(f"Fila {i+1}: {fila}")
                encontradas += 1
        print(f"Total: {encontradas} filas")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
