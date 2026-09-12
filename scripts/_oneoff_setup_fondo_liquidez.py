#!/usr/bin/env python3
"""Script de una sola corrida: agrega "Fondo de Inversión (banco)" como
posición de liquidez en 'Inversiones - Pesos' (Tipo "Fondo (liquidez)"),
con el saldo actual que dio el usuario -- para que Rentabilidad de Fondo
de Inversión (banco) (js/pages/inversiones.js) tenga con qué calcularse.

Idempotente: si la fila ya existe (mismo Ticker/Fondo exacto), actualiza
'Precio Actual' en vez de duplicar. Usa el mismo secret de servicio que ya
usa scripts/actualizar_mercado.py -- no toca ninguna credencial nueva.

Este archivo (y el workflow que lo corre) se borran después de usarse una
vez -- no es parte del Action recurrente, que sigue enfocado solo en datos
de Yahoo Finance según lo documentado en el README.
"""
import json
import os
import sys

import gspread
from google.oauth2.service_account import Credentials

SHEET_ID = "1wImfL85jPWKUwbcGb6gX7Ug4-3peEiXyp0lIcroycIk"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

SHEET_PESOS = "Inversiones - Pesos"
PRIMERA_FILA, ULTIMA_FILA = 5, 45  # bloque de Posiciones (A5:H45)

TICKER = "Fondo de Inversión (banco)"
TIPO = "Fondo (liquidez)"
CANTIDAD = 1
PRECIO_COMPRA = 0
PRECIO_ACTUAL = 7310000


def main():
    creds_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not creds_json:
        raise RuntimeError("Falta el secret GOOGLE_SERVICE_ACCOUNT_JSON.")
    creds = Credentials.from_service_account_info(json.loads(creds_json), scopes=SCOPES)
    gc = gspread.authorize(creds)
    ws = gc.open_by_key(SHEET_ID).worksheet(SHEET_PESOS)

    filas_raw = ws.get(f"A{PRIMERA_FILA}:H{ULTIMA_FILA}", value_render_option="UNFORMATTED_VALUE")
    filas = [(list(r) + [None] * 8)[:8] for r in filas_raw]

    fila_existente = next((i for i, r in enumerate(filas) if str(r[0] or "").strip() == TICKER), None)
    if fila_existente is not None:
        fila_num = PRIMERA_FILA + fila_existente
        ws.update(f"F{fila_num}", [[PRECIO_ACTUAL]], value_input_option="USER_ENTERED")
        print(f"Ya existía en la fila {fila_num} -- actualicé Precio Actual a {PRECIO_ACTUAL}.")
        return

    # gspread recorta las filas vacías al final del rango pedido -- si
    # "filas" salió más corta que el bloque completo, la primera fila libre
    # real es la siguiente a la última que sí volvió (nunca hay un hueco
    # vacío en el medio, siempre se carga de arriba hacia abajo).
    fila_libre = next((i for i, r in enumerate(filas) if not str(r[0] or "").strip()), len(filas))
    fila_num = PRIMERA_FILA + fila_libre
    if fila_num > ULTIMA_FILA:
        raise RuntimeError(f"No hay fila libre entre {PRIMERA_FILA} y {ULTIMA_FILA}.")
    ws.update(f"A{fila_num}:D{fila_num}", [[TICKER, TIPO, CANTIDAD, PRECIO_COMPRA]], value_input_option="USER_ENTERED")
    ws.update(f"F{fila_num}", [[PRECIO_ACTUAL]], value_input_option="USER_ENTERED")
    print(f"Agregado en la fila {fila_num}: {TICKER} | {TIPO} | Precio Actual {PRECIO_ACTUAL}.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
