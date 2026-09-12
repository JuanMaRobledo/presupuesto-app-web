#!/usr/bin/env python3
"""Script de una sola corrida: corrige el duplicado detectado en
'Inversiones - Pesos' -- la fila 12 "Fiducuenta (reserva impuestos)" y la
fila 13 "Fondo de Inversión (banco)" son la MISMA cuenta real (Fiducuenta
*5601 / 1111000435601), confirmado por el usuario.

Acciones:
1. Corrige el balance de la fila 12 (PrecioCompra/PrecioActual = 302.992,43;
   CostoTotal/ValorActual/GananciaPerdida son fórmulas que se recalculan
   solas).
2. Borra por completo la fila 13 (duplicada).
3. Renombra la Plataforma de las 44 filas de aportes recién escritas, de
   "Fondo de Inversión (banco)" a "Fiducuenta (reserva impuestos)", para que
   coincidan con el TickerFondo real de la posición.

Se borra después de usarse.
"""
import json
import os
import sys

import gspread
from google.oauth2.service_account import Credentials

SHEET_ID = "1wImfL85jPWKUwbcGb6gX7Ug4-3peEiXyp0lIcroycIk"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
PLATAFORMA_VIEJA = "Fondo de Inversión (banco)"
PLATAFORMA_REAL = "Fiducuenta (reserva impuestos)"
NUEVO_BALANCE = 302992.43


def main():
    creds_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not creds_json:
        raise RuntimeError("Falta el secret GOOGLE_SERVICE_ACCOUNT_JSON.")
    creds = Credentials.from_service_account_info(json.loads(creds_json), scopes=SCOPES)
    gc = gspread.authorize(creds)
    ws = gc.open_by_key(SHEET_ID).worksheet("Inversiones - Pesos")

    # --- 1) Corregir el balance de la fila 12 (la posición real) ---
    fila12_antes = ws.get("A12:H12")
    print(f"Fila 12 antes: {fila12_antes}")
    ws.update("D12:D12", [[NUEVO_BALANCE]])
    ws.update("F12:F12", [[NUEVO_BALANCE]])
    print(f"Fila 12: PrecioCompra y PrecioActual actualizados a {NUEVO_BALANCE}.")

    # --- 2) Borrar la fila 13 duplicada ---
    fila13_antes = ws.get("A13:H13")
    print(f"Fila 13 antes (a borrar): {fila13_antes}")
    ws.update("A13:H13", [["", "", "", "", "", "", "", ""]])
    print("Fila 13 borrada.")

    # --- 3) Renombrar la Plataforma en las filas de aportes ---
    aportes = ws.get("A79:D1000")
    filas_a_renombrar = [i + 79 for i, fila in enumerate(aportes) if len(fila) >= 2 and fila[1].strip() == PLATAFORMA_VIEJA]
    print(f"Filas de aportes a renombrar: {filas_a_renombrar}")
    if filas_a_renombrar and filas_a_renombrar == list(range(filas_a_renombrar[0], filas_a_renombrar[-1] + 1)):
        a, b = filas_a_renombrar[0], filas_a_renombrar[-1]
        ws.update(f"B{a}:B{b}", [[PLATAFORMA_REAL]] * (b - a + 1))
    else:
        for fila_num in filas_a_renombrar:
            ws.update(f"B{fila_num}:B{fila_num}", [[PLATAFORMA_REAL]])
    print(f"{len(filas_a_renombrar)} filas de aportes renombradas a '{PLATAFORMA_REAL}'.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
