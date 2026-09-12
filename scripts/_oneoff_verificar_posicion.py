#!/usr/bin/env python3
"""Script de una sola corrida, SOLO LECTURA: revisa cómo están estructuradas
(valores vs. fórmulas) las filas de 'Inversiones - Pesos'!A5:H45, en
particular la fila 13 (Fondo de Inversión (banco)) y una fila normal de
acciones, para saber si G/H son fórmulas o valores literales antes de
corregir la fila 13. Se borra después de usarse.
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
    ws = gc.open_by_key(SHEET_ID).worksheet("Inversiones - Pesos")

    print("=== Valores formateados (get, A5:H20) ===")
    valores = ws.get("A5:H20")
    for i, fila in enumerate(valores):
        print(f"Fila {i+5}: {fila}")

    print("\n=== Fórmulas crudas (value_render_option=FORMULA, A5:H20) ===")
    formulas = ws.get("A5:H20", value_render_option="FORMULA")
    for i, fila in enumerate(formulas):
        print(f"Fila {i+5}: {fila}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
