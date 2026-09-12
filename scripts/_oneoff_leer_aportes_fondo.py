#!/usr/bin/env python3
"""Script de una sola corrida, SOLO LECTURA: lee los aportes registrados
para la plataforma 'Fondo de Inversión (banco)' en 'Inversiones - Pesos'
(fecha, monto, etc.) para poder cruzarlos con el extracto de Pibank.

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

    ws = sh.worksheet("Inversiones - Pesos")
    valores = ws.get("A75:D1000")
    print(f"=== 'Inversiones - Pesos'!A75:D1000: {len(valores)} filas ===")
    for i, fila in enumerate(valores):
        texto = " | ".join(fila).upper()
        if "FONDO DE INVERSI" in texto or "FONDO" in texto:
            print(f"Fila {i+75}: {fila}")

    print("\n=== Encabezado real de la sección de aportes (primeras filas no vacías) ===")
    for i, fila in enumerate(valores[:6]):
        print(f"Fila {i+75}: {fila}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
