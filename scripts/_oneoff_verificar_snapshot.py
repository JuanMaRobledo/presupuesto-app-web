#!/usr/bin/env python3
"""Script de una sola corrida, SOLO LECTURA: confirma que el snapshot de
'Historial de Valor de Cartera' de hoy tiene el AportesNetos correcto
después del fix del bug en actualizar_mercado.py. Se borra tras usarse.
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
    creds = Credentials.from_service_account_info(json.loads(creds_json), scopes=SCOPES)
    gc = gspread.authorize(creds)
    ws = gc.open_by_key(SHEET_ID).worksheet("Historial de Valor de Cartera")
    filas = ws.get("A2:E5000")
    for i, f in enumerate(filas):
        if any(c.strip() for c in f):
            print(f"Fila {i+2}: {f}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
