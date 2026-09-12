#!/usr/bin/env python3
"""Script de una sola corrida: escribe el historial verificado de Fiducuenta
(*5601 / 1111000435601, la plataforma "Fondo de Inversión (banco)") en
'Inversiones - Pesos', reconstruido y verificado matemáticamente contra los
extractos oficiales de Bancolombia (nov-2024 a ago-2026, más 2 retiros de
sept-2026 confirmados por correo).

Acciones:
1. Borra (deja en blanco) la fila existente del retiro aproximado
   (-26,714,000, plataforma "Fondo de Inversión (banco)") en la sección de
   aportes.
2. Agrega 44 filas nuevas con el detalle exacto (fecha/monto/nota).
3. Corrige el balance de la posición "Fondo de Inversión (banco)" en la
   sección de posiciones (antes $7,310,000, ahora $302,992.43).

Se borra después de usarse.
"""
import json
import os
import sys

import gspread
from google.oauth2.service_account import Credentials

SHEET_ID = "1wImfL85jPWKUwbcGb6gX7Ug4-3peEiXyp0lIcroycIk"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
PLATAFORMA = "Fondo de Inversión (banco)"
NUEVO_BALANCE = 302992.43

# (fecha ISO, monto, nota)
MOVIMIENTOS = [
    ("2024-11-30", 9570778.73, "Saldo acumulado en Fiducuenta antes de dic-2024 (ahorros previos), tomado como aporte inicial para el seguimiento — extracto oficial Fiducuenta *5601"),
    ("2024-12-03", 10000000, "Adición Fiducuenta dic-2024 — extracto oficial"),
    ("2024-12-05", 7000000, "Adición Fiducuenta dic-2024 — extracto oficial"),
    ("2024-12-16", 12000000, "Adición Fiducuenta dic-2024 — extracto oficial"),
    ("2024-12-16", 3000000, "Adición Fiducuenta dic-2024 — extracto oficial"),
    ("2024-12-19", -2000000, "Retiro Fiducuenta dic-2024 — extracto oficial"),
    ("2024-12-20", 2000000, "Adición Fiducuenta dic-2024 — extracto oficial"),
    ("2024-12-20", -9839754, "Retiro Fiducuenta dic-2024 — extracto oficial"),
    ("2024-12-26", 5000000, "Adición Fiducuenta dic-2024 — extracto oficial"),
    ("2025-02-04", -500000, "Retiro Fiducuenta feb-2025 — extracto oficial"),
    ("2025-02-05", -1000000, "Retiro Fiducuenta feb-2025 — extracto oficial"),
    ("2025-02-21", -1000000, "Retiro Fiducuenta feb-2025 — extracto oficial"),
    ("2025-03-01", -4000000, "Retiro Fiducuenta mar-2025 — extracto oficial"),
    ("2025-03-10", -1800000, "Retiro Fiducuenta mar-2025 — extracto oficial"),
    ("2025-04-16", 6000000, "Adición Fiducuenta abr-2025 — extracto oficial"),
    ("2025-05-09", -2000000, "Retiro Fiducuenta may-2025 — extracto oficial"),
    ("2025-06-27", 13000000, "Adición Fiducuenta jun-2025 — extracto oficial"),
    ("2025-07-02", -2000000, "Retiro Fiducuenta jul-2025 — extracto oficial"),
    ("2025-07-18", -6000000, "Retiro Fiducuenta jul-2025 — extracto oficial"),
    ("2025-07-19", 2000000, "Adición Fiducuenta jul-2025 — extracto oficial"),
    ("2025-08-02", -1000000, "Retiro Fiducuenta ago-2025 — extracto oficial"),
    ("2025-08-05", 5500000, "Adición Fiducuenta ago-2025 — extracto oficial"),
    ("2025-08-21", -2000000, "Retiro Fiducuenta ago-2025 — extracto oficial"),
    ("2025-08-27", -300000, "Retiro Fiducuenta ago-2025 — extracto oficial"),
    ("2025-09-03", -100000, "Retiro Fiducuenta sept-2025 — extracto oficial"),
    ("2025-09-03", -300000, "Retiro Fiducuenta sept-2025 — extracto oficial"),
    ("2025-09-15", -15000000, "Retiro Fiducuenta sept-2025, usado para pagar impuestos — extracto oficial"),
    ("2025-09-16", -10000000, "Retiro Fiducuenta sept-2025, usado para pagar impuestos — extracto oficial"),
    ("2025-09-16", -1200000, "Retiro Fiducuenta sept-2025, usado para pagar impuestos — extracto oficial"),
    ("2025-09-23", -1200000, "Retiro Fiducuenta sept-2025 — extracto oficial"),
    ("2025-10-10", 3000000, "Adición Fiducuenta oct-2025 — extracto oficial"),
    ("2025-10-16", -15000000, "Retiro Fiducuenta oct-2025 — extracto oficial"),
    ("2025-11-05", 4500000, "Adición Fiducuenta nov-2025 — extracto oficial"),
    ("2025-11-10", -4000000, "Retiro Fiducuenta nov-2025 — extracto oficial"),
    ("2025-11-20", -382000, "Retiro Fiducuenta nov-2025 — extracto oficial"),
    ("2025-11-20", -1000000, "Retiro Fiducuenta nov-2025 — extracto oficial"),
    ("2025-11-21", -2000000, "Retiro Fiducuenta nov-2025 — extracto oficial"),
    ("2025-12-03", -68000, "Retiro Fiducuenta dic-2025 — extracto oficial"),
    ("2025-12-03", -800000, "Retiro Fiducuenta dic-2025 — extracto oficial"),
    ("2025-12-26", -200000, "Retiro Fiducuenta dic-2025 — extracto oficial"),
    ("2026-07-01", 7000000, "Adición Fiducuenta jul-2026 — extracto oficial"),
    ("2026-07-28", 13000000, "Adición Fiducuenta jul-2026 — extracto oficial"),
    ("2026-09-01", -13000000, "Retiro Fiducuenta sept-2026 — confirmado por notificación Bancolombia (extracto de sept aún no emitido)"),
    ("2026-09-09", -7000000, "Retiro Fiducuenta sept-2026 — confirmado por notificación Bancolombia (extracto de sept aún no emitido)"),
]


def main():
    creds_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not creds_json:
        raise RuntimeError("Falta el secret GOOGLE_SERVICE_ACCOUNT_JSON.")
    creds = Credentials.from_service_account_info(json.loads(creds_json), scopes=SCOPES)
    gc = gspread.authorize(creds)
    ws = gc.open_by_key(SHEET_ID).worksheet("Inversiones - Pesos")

    # --- 1) Localizar y borrar la fila aproximada existente ---
    aportes = ws.get("A79:D1000")
    fila_vieja = None
    for i, fila in enumerate(aportes):
        if len(fila) >= 2 and fila[1].strip() == PLATAFORMA:
            fila_vieja = i + 79
            print(f"Fila vieja encontrada en A{fila_vieja}: {fila}")
    if fila_vieja is not None:
        ws.update(f"A{fila_vieja}:D{fila_vieja}", [["", "", "", ""]])
        print(f"Fila A{fila_vieja} borrada.")
    else:
        print("No se encontró ninguna fila vieja de esta plataforma (nada que borrar).")

    # --- 2) Agregar las 44 filas nuevas al final de la lista de aportes ---
    ultima_fila_usada = 78
    for i, fila in enumerate(aportes):
        if any(c.strip() for c in fila):
            ultima_fila_usada = i + 79
    fila_inicio = ultima_fila_usada + 1
    filas_nuevas = [[fecha, PLATAFORMA, monto, nota] for fecha, monto, nota in MOVIMIENTOS]
    ws.update(f"A{fila_inicio}:D{fila_inicio + len(filas_nuevas) - 1}", filas_nuevas)
    print(f"{len(filas_nuevas)} filas nuevas escritas desde A{fila_inicio}.")

    # --- 3) Corregir el balance de la posición ---
    posiciones = ws.get("A5:H45")
    fila_pos = None
    for i, fila in enumerate(posiciones):
        if len(fila) >= 1 and fila[0].strip() == PLATAFORMA:
            fila_pos = i + 5
    if fila_pos is not None:
        print(f"Posición encontrada en fila {fila_pos}: {posiciones[fila_pos - 5]}")
        ws.update(f"E{fila_pos}:G{fila_pos}", [[NUEVO_BALANCE, NUEVO_BALANCE, NUEVO_BALANCE]])
        print(f"Balance de la posición (CostoTotal/PrecioActual/ValorActual) actualizado a {NUEVO_BALANCE} en fila {fila_pos}.")
    else:
        print("ADVERTENCIA: no se encontró la fila de posición de esta plataforma.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
