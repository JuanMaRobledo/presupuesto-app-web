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

    print("\n=== Hojas que mencionan conciliacion/diagnostico/fondo/pibank en el título ===")
    for ws in hojas:
        t = ws.title.lower()
        if any(p in t for p in ("conciliaci", "diagnostic", "fondo", "pibank")):
            print(f"-> '{ws.title}'")

    # Buscar la hoja de "Libro crudo" (nombre exacto puede variar un poco).
    libro_crudo = next((ws for ws in hojas if "libro crudo" in ws.title.lower()), None)
    if libro_crudo is None:
        print("\nNo encontré ninguna hoja 'Libro crudo...'.")
        return

    print(f"\n=== Filas de '{libro_crudo.title}' que mencionan FONDO o PIBANK (cualquier fecha) ===")
    valores = libro_crudo.get_all_values()  # incluye encabezados
    encontradas = 0
    for i, fila in enumerate(valores):
        texto = " | ".join(fila).upper()
        if "FONDO" in texto or "PIBANK" in texto:
            print(f"Fila {i+1}: {fila}")
            encontradas += 1
    print(f"\nTotal filas encontradas: {encontradas} (de {len(valores)} filas totales en la hoja)")

    print(f"\n=== Rango de fechas real en '{libro_crudo.title}' (columna Periodo, col A) ===")
    periodos = sorted(set(fila[0] for fila in valores[1:] if fila and fila[0] and fila[0][:2] == "20"))
    if periodos:
        print(f"Desde {periodos[0]} hasta {periodos[-1]} -- {len(periodos)} períodos distintos con datos reales")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
