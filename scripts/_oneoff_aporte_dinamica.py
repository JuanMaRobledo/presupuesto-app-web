#!/usr/bin/env python3
"""Script de una sola corrida: agrega el aporte inicial a "Trii - Cuenta
Dinámica" (fondo Accival) que faltaba en 'Inversiones - Pesos' -- sin él,
esa posición no tenía ningún flujo de caja propio y su rentabilidad nunca
se podía calcular (ni simple ni XIRR). Dato confirmado por el usuario:
10 de julio de 2026, $174,000 COP. Mismo criterio de "primera fila libre"
que first_blank_row() (sheets_backend.py): la fila justo después de la
última con datos en A79:A1000, no el primer hueco en blanco.

Se borra después de usarse.
"""
import os

import gspread
from google.oauth2.service_account import Credentials

SHEET_ID = "1wImfL85jPWKUwbcGb6gX7Ug4-3peEiXyp0lIcroycIk"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

FIRST, LAST = 79, 1000
FECHA, PLATAFORMA, MONTO, NOTAS = "2026-07-10", "Trii", 174000, "Aporte inicial a Cuenta Dinámica (Accival) — backfill"


def main():
    creds = Credentials.from_service_account_info(
        __import__("json").loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]), scopes=SCOPES)
    gc = gspread.authorize(creds)
    ws = gc.open_by_key(SHEET_ID).worksheet("Inversiones - Pesos")

    col_vals = ws.get(f"A{FIRST}:A{LAST}")
    ultimo_usado = 0
    for i in range(LAST - FIRST + 1):
        val = col_vals[i][0] if i < len(col_vals) and col_vals[i] else ""
        if val not in (None, ""):
            ultimo_usado = i + 1
    fila_libre = FIRST + ultimo_usado
    print(f"Primera fila libre del bloque de aportes: {fila_libre}")

    existentes = ws.get(f"A{FIRST}:D{fila_libre - 1}") if fila_libre > FIRST else []
    ya_trii = [f for f in existentes if len(f) > 1 and f[1].strip() == "Trii"]
    print(f"Aportes ya cargados bajo Plataforma 'Trii': {ya_trii}")
    if ya_trii:
        print("Ya hay un aporte 'Trii' cargado -- no agrego otro, revisar a mano.")
        return

    ws.update(f"A{fila_libre}:D{fila_libre}", [[FECHA, PLATAFORMA, MONTO, NOTAS]],
              value_input_option="USER_ENTERED")
    print(f"Escrito en fila {fila_libre}: {[FECHA, PLATAFORMA, MONTO, NOTAS]}")

    verificacion = ws.get(f"A{fila_libre}:D{fila_libre}")
    print(f"Verificación de lo escrito: {verificacion}")


if __name__ == "__main__":
    main()
