#!/usr/bin/env python3
"""Script de una sola corrida, SOLO LECTURA: audita los Tipo/TickerFondo
reales de Posiciones (Pesos y Dólares) y las Plataformas reales de Aportes,
para diseñar la separación Acciones / Fondos de Inversión / Fiducuenta /
Liquidez en la web app (hoy solo separa títulos vs. liquidez en 2 grupos).

No escribe nada. Se borra después de usarse.
"""
import os

import gspread
from google.oauth2.service_account import Credentials

SHEET_ID = "1wImfL85jPWKUwbcGb6gX7Ug4-3peEiXyp0lIcroycIk"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


def main():
    creds_json = os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]
    with open("/tmp/sa.json", "w") as f:
        f.write(creds_json)
    creds = Credentials.from_service_account_file("/tmp/sa.json", scopes=SCOPES)
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(SHEET_ID)

    for nombre_hoja, nombre_moneda in [("Inversiones - Pesos", "Pesos"), ("Inversiones - Dólares", "Dólares")]:
        ws = sh.worksheet(nombre_hoja)
        posiciones = ws.get("A5:H45")
        print(f"\n{'='*70}\nPOSICIONES -- {nombre_moneda}\n{'='*70}")
        for fila in posiciones:
            if fila and any(c.strip() for c in fila):
                ticker = fila[0] if len(fila) > 0 else ""
                tipo = fila[1] if len(fila) > 1 else ""
                valor = fila[6] if len(fila) > 6 else ""
                print(f"  TickerFondo={ticker!r:55} Tipo={tipo!r:25} ValorActual={valor!r}")

        aportes = ws.get("A79:D1000")
        plataformas = sorted({f[1].strip() for f in aportes if len(f) > 1 and f[1].strip()})
        print(f"\nPlataformas en Aportes -- {nombre_moneda}: {plataformas}")


if __name__ == "__main__":
    main()
