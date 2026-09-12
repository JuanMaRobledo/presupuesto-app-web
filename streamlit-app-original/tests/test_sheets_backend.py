import unittest
from datetime import date, datetime
from unittest.mock import Mock, patch

import gspread
import pandas as pd

import sheets_backend as db


class SheetsBackendTests(unittest.TestCase):
    def tearDown(self):
        db._fetch_all.clear()

    def test_to_number_parses_colombian_thousands_and_decimal_separators(self):
        casos = [
            ("$5.087.559", 5087559.0),
            ("$886.231", 886231.0),
            ("9509439,00", 9509439.0),
            ("5087559", 5087559.0),
            (5087559, 5087559),
            (5087559.0, 5087559.0),
            ("15.49", 15.49),
            ("15,49", 15.49),
            ("7437,5", 7437.5),
            ("-111900,44", -111900.44),
            ("-345595", -345595.0),
            ("1.000", 1000.0),
            ("$1.234.567,89", 1234567.89),
            (None, 0),
            ("", 0),
            ("-", 0),
            ("no es un numero", 0),
        ]
        for entrada, esperado in casos:
            with self.subTest(entrada=entrada):
                self.assertAlmostEqual(db._to_number(entrada), esperado, places=2)

    def test_write_block_rows_validates_range_before_writing(self):
        worksheet = Mock()
        rows = [["2026-09-01", "periodo", 10, 2]]

        with patch.object(db, "_check_fits") as check_fits, \
             patch.object(db, "_worksheet", return_value=worksheet):
            db.write_block_rows("colillas_resumen", 150, rows)

        check_fits.assert_called_once_with("colillas_resumen", 150)
        worksheet.update.assert_called_once_with(
            "A150:D150", rows, value_input_option="USER_ENTERED"
        )

    def test_first_blank_row_extends_a_full_block(self):
        worksheet = Mock()
        worksheet.get.return_value = [["a"], ["b"]]
        block = {"sheet": "Prueba", "header": 1, "first": 2, "last": 3, "cols": 1}

        def extend(_block_key, _extra):
            block["last"] = 2003
            return 4

        with patch.dict(db.BLOCKS, {"prueba": block}, clear=True), \
             patch.object(db, "_worksheet", return_value=worksheet), \
             patch.object(db, "_extend_block", side_effect=extend) as extend_block:
            self.assertEqual(4, db.first_blank_row("prueba"))

        extend_block.assert_called_once_with("prueba", 1)

    def test_fetch_all_uses_one_batch_request(self):
        spreadsheet = Mock()
        spreadsheet.values_batch_get.return_value = {
            "valueRanges": [{"values": [[1]]}, {"values": [[2]]}]
        }
        ranges = {"uno": "'Hoja'!A1", "dos": "'Hoja'!A2"}

        db._fetch_all.clear()
        with patch.object(db, "_all_ranges", return_value=ranges), \
             patch.object(db, "_spreadsheet", return_value=spreadsheet):
            self.assertEqual({"uno": [[1]], "dos": [[2]]}, db._fetch_all())

        spreadsheet.values_batch_get.assert_called_once_with(
            list(ranges.values()), params={"valueRenderOption": "UNFORMATTED_VALUE"}
        )

    def test_periodo_sort_value_understands_dates_and_pay_periods(self):
        self.assertEqual(datetime(2026, 9, 4), db._periodo_sort_value("04/09/2026"))
        self.assertEqual(datetime(2026, 9, 16), db._periodo_sort_value("2a quincena sep-2026"))
        self.assertEqual(datetime(2026, 9, 1), db._periodo_sort_value("2026-09"))

    def test_all_ranges_excludes_independent_blocks(self):
        # Regresión: 'cesantias' vive en una hoja nueva que puede no existir
        # todavía en algún Sheet — si entrara al batchGet único de
        # _fetch_all(), una hoja faltante tumbaría la carga de TODA la app,
        # no solo de la sección de Cesantías.
        self.assertIn("cesantias", db.BLOCKS)
        ranges = db._all_ranges()
        self.assertNotIn("block:cesantias", ranges)

    def test_fetch_cesantias_returns_empty_when_sheet_does_not_exist_yet(self):
        db._fetch_cesantias.clear()
        with patch.object(db, "_worksheet", side_effect=gspread.exceptions.WorksheetNotFound("Cesantías")):
            self.assertEqual([], db._fetch_cesantias())

    def test_read_cesantias_maps_columns_and_numbers(self):
        db._fetch_cesantias.clear()
        rows = [["01/01/2026", "Fondo Nacional del Ahorro", 1000, 200, 50, 0, 1250, "Corte anual"]]
        with patch.object(db, "_fetch_cesantias", return_value=rows):
            df = db.read_cesantias()

        self.assertEqual(["Fecha de Corte", "Fondo", "Saldo Anterior", "Aportes del Período",
                           "Rendimientos", "Retiros", "Saldo Actual", "Notas"], list(df.columns))
        fila = df.iloc[0]
        self.assertEqual("Fondo Nacional del Ahorro", fila["Fondo"])
        self.assertEqual(1250, fila["Saldo Actual"])
        self.assertEqual("Corte anual", fila["Notas"])

    def test_corregir_cesantias_mal_etiquetada_relabels_and_books_interest(self):
        # Regresión: una liquidación de cesantías ya cargada de antes con el
        # bug de la colisión de período (etiquetada como si fuera una
        # quincena) — el botón de arreglo debe relabelarla, sacar su
        # capital/consignación de Colillas de Pago (sin tocar caja) y
        # mandar solo los intereses a Otros Ingresos.
        resumen_ws = Mock()
        resumen_ws.get.return_value = [["2026-01-15", "2a quincena ene-2026", 21500000, 19200000]]
        devengos_df = pd.DataFrame([
            {"Quincena": "2a quincena ene-2026", "Concepto": "Cesantías Año Anterior",
             "Categoría": "Cesantías (no presupuestar)", "Valor": 19200000},
            {"Quincena": "2a quincena ene-2026", "Concepto": "Intereses de Cesantías Año Anterior",
             "Categoría": "Cesantías (no presupuestar)", "Valor": 2300000},
        ])

        with patch.object(db, "_worksheet", return_value=resumen_ws), \
             patch.object(db, "read_colillas_devengos", return_value=devengos_df), \
             patch.object(db, "read_otros_ingresos_tabla",
                          return_value=pd.DataFrame(columns=["Fecha", "Concepto", "Categoría", "Valor"])), \
             patch.object(db, "write_row_segments") as write_segments, \
             patch.object(db, "clear_rows_by_key") as clear_rows, \
             patch.object(db, "first_blank_row", return_value=10), \
             patch.object(db, "write_block_rows") as write_rows:
            resultado = db.corregir_cesantias_mal_etiquetada("2a quincena ene-2026")

        self.assertEqual("Cesantías ene-2026", resultado["periodo_nuevo"])
        self.assertEqual(2300000, resultado["interes"])
        write_segments.assert_called_once_with(
            "colillas_resumen", 150, [(2, ["Cesantías ene-2026"]), (3, [0, 0])])
        clear_rows.assert_any_call("colillas_devengos", 1, "2a quincena ene-2026")
        clear_rows.assert_any_call("colillas_descuentos", 1, "2a quincena ene-2026")
        write_rows.assert_called_once_with("otros_ingresos", 10, [
            ["2026-01-15", "Intereses de Cesantías", "Cesantías", 2300000,
             "Liquidación de cesantías Cesantías ene-2026 — corregido de '2a quincena ene-2026', no incluye "
             "el capital, que se consigna al fondo el mismo día y no es ingreso"]])

    def test_corregir_cesantias_mal_etiquetada_skips_booking_interest_twice(self):
        # Regresión real: un doble clic (o dos corridas superpuestas) hizo
        # que esta función se ejecutara dos veces sobre el mismo período
        # antes de que la primera lo renombrara, duplicando el ingreso.
        resumen_ws = Mock()
        resumen_ws.get.return_value = [["2026-01-29", "2a quincena ene-2026", 21500000, 19200000]]
        devengos_df = pd.DataFrame([
            {"Quincena": "2a quincena ene-2026", "Concepto": "Intereses de Cesantías Año Anterior",
             "Categoría": "Cesantías (no presupuestar)", "Valor": 2308696},
        ])
        ya_registrado = pd.DataFrame([
            {"Fecha": "29/01/2026", "Concepto": "Intereses de Cesantías", "Categoría": "Cesantías",
             "Valor": 2308696},
        ])

        with patch.object(db, "_worksheet", return_value=resumen_ws), \
             patch.object(db, "read_colillas_devengos", return_value=devengos_df), \
             patch.object(db, "read_otros_ingresos_tabla", return_value=ya_registrado), \
             patch.object(db, "write_row_segments"), \
             patch.object(db, "clear_rows_by_key"), \
             patch.object(db, "first_blank_row", return_value=10), \
             patch.object(db, "write_block_rows") as write_rows:
            resultado = db.corregir_cesantias_mal_etiquetada("2a quincena ene-2026")

        self.assertEqual(2308696, resultado["interes"])
        write_rows.assert_not_called()

    def test_corregir_prima_mal_etiquetada_relabels_all_colilla_rows(self):
        worksheet = Mock()
        worksheet.get.side_effect = [
            [["2025-12-15", "1a quincena dic-2025", 9509439, 1104759]],
            [["1a quincena dic-2025", "Prima Legal", "Prima de Servicios", 9509439]],
            [["1a quincena dic-2025", "Retención", "Impuestos", 1104759]],
        ]

        with patch.object(db, "_worksheet", return_value=worksheet):
            resultado = db.corregir_prima_mal_etiquetada("1a quincena dic-2025")

        self.assertEqual("Prima dic-2025", resultado["periodo_nuevo"])
        self.assertEqual(1, resultado["devengos"])
        self.assertEqual(1, resultado["descuentos"])
        worksheet.spreadsheet.values_batch_update.assert_called_once_with({
            "valueInputOption": "USER_ENTERED",
            "data": [
                {"range": "'Colillas de Pago'!B150", "values": [["Prima dic-2025"]]},
                {"range": "'Colillas de Pago'!A326", "values": [["Prima dic-2025"]]},
                {"range": "'Colillas de Pago'!A545", "values": [["Prima dic-2025"]]},
            ],
        })

    def test_corregir_prima_mal_etiquetada_rejects_non_prima(self):
        worksheet = Mock()
        worksheet.get.side_effect = [
            [["2026-06-30", "2a quincena jun-2026", 5000000, 1000000]],
            [["2a quincena jun-2026", "Sueldo", "Salario Base", 5000000]],
            [],
        ]

        with patch.object(db, "_worksheet", return_value=worksheet):
            with self.assertRaises(ValueError):
                db.corregir_prima_mal_etiquetada("2a quincena jun-2026")

        worksheet.spreadsheet.values_batch_update.assert_not_called()

    def test_corregir_cesantias_mal_etiquetada_raises_when_period_not_found(self):
        resumen_ws = Mock()
        resumen_ws.get.return_value = [["2026-01-15", "1a quincena ene-2026", 5000000, 1500000]]

        with patch.object(db, "_worksheet", return_value=resumen_ws):
            with self.assertRaises(ValueError):
                db.corregir_cesantias_mal_etiquetada("2a quincena ene-2026")

    def test_recent_transactions_are_sorted_across_sources(self):
        rows = {
            "colillas_devengos": [["1a quincena sep-2026", "Sueldo", "Ingresos", 100]],
            "colillas_descuentos": [],
            "visa_detalle": [["2026-09", "03/09/2026", "Compra Visa", "COP", "1/1", 20, 20, 0, "Otros"]],
            "mc_detalle": [["2026-09", "02/09/2026", "Compra MC", "COP", "1/1", 20, 20, 0, "Otros"]],
            "mc_detalle_usd": [],
            "efectivo_detalle": [["2026-09", "01/09/2026", "Cuenta", "COP", "1/1", 20, 20, 0, "Otros"]],
            "otros_ingresos": [["04/09/2026", "Ingreso extra", "Ingresos", 30]],
        }

        with patch.object(db, "_rows_for", side_effect=lambda key: rows[key]):
            recent = db.read_movimientos_recientes()

        self.assertEqual(
            ["Otros ingresos", "Visa ****7497", "Mastercard ****5922",
             "Colilla (devengo)", "Cuenta de ahorros"],
            recent["Fuente"].head(5).tolist(),
        )

    def test_agregar_aportes_inversion_skips_existing_rows(self):
        existentes = pd.DataFrame([
            {"Fecha": "27/11/2025", "Plataforma": "Hapi", "Monto Transferido (COP)": 772506,
             "Notas": "Existente"}
        ])
        filas = [
            ["2025-11-27", "Hapi", 772506, "Duplicado con otro formato de fecha"],
            ["2025-11-28", "Hapi", 3072782, "Nuevo"],
        ]
        with patch.object(db, "read_aportes_inversion", return_value=existentes), \
             patch.object(db, "first_blank_row", return_value=80), \
             patch.object(db, "write_block_rows") as write_rows:
            agregados = db.agregar_aportes_inversion("dolares", filas)

        self.assertEqual(1, agregados)
        write_rows.assert_called_once_with("aportes_inversion_dolares", 80, [filas[1]])

    def test_set_aportes_inversion_overwrites_block_and_blanks_leftover_rows(self):
        worksheet = Mock()
        block = {"sheet": "Inversiones - Dólares", "header": 78, "first": 79, "last": 81, "cols": 4}

        with patch.dict(db.BLOCKS, {"aportes_inversion_dolares": block}, clear=False), \
             patch.object(db, "_worksheet", return_value=worksheet):
            db.set_aportes_inversion("dolares", [["2026-01-01", "Hapi", 100, "Nota"]])

        worksheet.update.assert_called_once_with(
            "A79:D81",
            [["2026-01-01", "Hapi", 100, "Nota"], ["", "", "", ""], ["", "", "", ""]],
            value_input_option="USER_ENTERED",
        )

    def test_set_aportes_inversion_rejects_more_rows_than_capacity(self):
        block = {"sheet": "Inversiones - Dólares", "header": 78, "first": 79, "last": 79, "cols": 4}
        with patch.dict(db.BLOCKS, {"aportes_inversion_dolares": block}, clear=False):
            with self.assertRaises(db.SinEspacioError):
                db.set_aportes_inversion("dolares", [["a"], ["b"]])

    def test_set_historial_inversion_clears_and_rewrites_from_row_two(self):
        worksheet = Mock()
        worksheet.row_count = 500
        filas = [["2026-01-02", "Interactive Brokers", "USD", "WMT", "COVER", 3, 110, 1, 28, "reporte.csv"]]

        with patch.object(db, "_worksheet", return_value=worksheet):
            db.set_historial_inversion(filas)

        worksheet.batch_clear.assert_called_once_with(["A2:J500"])
        worksheet.update.assert_called_once_with("A2:J2", filas, value_input_option="USER_ENTERED")

    def test_guardar_snapshot_cartera_updates_existing_row_for_same_day(self):
        worksheet = Mock()
        worksheet.row_count = 10

        with patch.object(db, "_worksheet", return_value=worksheet), \
             patch.object(db, "_get_raw", return_value=[["01/09/2026", "pesos", 100, 120, 90]]):
            db.guardar_snapshot_cartera("pesos", date(2026, 9, 1), 100, 150, 90)

        worksheet.update.assert_called_once_with(
            "A2:E2", [["2026-09-01", "pesos", 100, 150, 90]], value_input_option="USER_ENTERED")
        worksheet.append_rows.assert_not_called()

    def test_guardar_snapshot_cartera_appends_new_day(self):
        worksheet = Mock()
        worksheet.row_count = 10

        with patch.object(db, "_worksheet", return_value=worksheet), \
             patch.object(db, "_get_raw", return_value=[]):
            db.guardar_snapshot_cartera("dolares", date(2026, 9, 2), 50, 55, 40)

        worksheet.append_rows.assert_called_once_with(
            [["2026-09-02", "dolares", 50, 55, 40]], value_input_option="USER_ENTERED")

    def test_set_metas_asignacion_clears_and_rewrites_from_row_two(self):
        worksheet = Mock()
        worksheet.row_count = 50
        filas = [["pesos", "Acción", 0.6], ["pesos", "ETF", 0.4]]

        with patch.object(db, "_worksheet", return_value=worksheet):
            db.set_metas_asignacion(filas)

        worksheet.batch_clear.assert_called_once_with(["A2:C50"])
        worksheet.update.assert_called_once_with("A2:C3", filas, value_input_option="USER_ENTERED")

    def test_read_metas_asignacion_maps_columns_and_numbers(self):
        with patch.object(db, "_worksheet") as worksheet_mock, \
             patch.object(db, "_get_raw", return_value=[["dolares", "Cripto", 0.1]]):
            worksheet_mock.return_value.row_count = 10
            df = db.read_metas_asignacion()

        self.assertEqual(["Moneda", "Tipo", "Meta %"], list(df.columns))
        self.assertEqual("Cripto", df.iloc[0]["Tipo"])
        self.assertEqual(0.1, df.iloc[0]["Meta %"])

    def test_eliminar_otro_ingreso_clears_only_the_first_exact_match(self):
        worksheet = Mock()
        rows = [
            ["29/01/2026", "Intereses de Cesantías", "Cesantías", 2308696, "nota"],
            ["29/01/2026", "Intereses de Cesantías", "Cesantías", 2308696, "nota duplicada"],
        ]
        with patch.object(db, "_worksheet", return_value=worksheet), \
             patch.object(db, "_get_raw", return_value=rows):
            borrado = db.eliminar_otro_ingreso("29/01/2026", "Intereses de Cesantías", "Cesantías", 2308696)

        self.assertTrue(borrado)
        worksheet.batch_clear.assert_called_once_with(["A4:E4"])

    def test_eliminar_otro_ingreso_returns_false_when_nothing_matches(self):
        worksheet = Mock()
        with patch.object(db, "_worksheet", return_value=worksheet), \
             patch.object(db, "_get_raw", return_value=[]):
            borrado = db.eliminar_otro_ingreso("29/01/2026", "Intereses de Cesantías", "Cesantías", 2308696)

        self.assertFalse(borrado)
        worksheet.batch_clear.assert_not_called()

    def test_agregar_historial_inversion_is_idempotent_across_source_names(self):
        existente = pd.DataFrame([[
            "01/01/2026", "Interactive Brokers", "USD", "WMT", "SHORT", 3, 120, 1, 0,
            "reporte-viejo.csv",
        ]], columns=db.HISTORIAL_INVERSION_HEADERS)
        duplicada = ["2026-01-01", "Interactive Brokers", "USD", "WMT", "SHORT", 3, 120, 1, 0,
                     "reporte-nuevo.csv"]
        nueva = ["2026-01-02", "Interactive Brokers", "USD", "WMT", "COVER", 3, 110, 1, 28,
                 "reporte-nuevo.csv"]
        worksheet = Mock()

        with patch.object(db, "_worksheet", return_value=worksheet), \
             patch.object(db, "read_historial_inversion", return_value=existente):
            agregadas = db.agregar_historial_inversion([duplicada, nueva])

        self.assertEqual(1, agregadas)
        worksheet.append_rows.assert_called_once_with([nueva], value_input_option="USER_ENTERED")

    def test_read_declaraciones_renta_maps_columns_and_numbers(self):
        row = ["2024", "15/08/2025", "500000000", "120000000", "80000000", "3000000", "3500000",
               "-500000", "https://drive.google.com/file/d/abc", "nota"]
        with patch.object(db, "_worksheet") as worksheet_mock, \
             patch.object(db, "_get_raw", return_value=[row]):
            worksheet_mock.return_value.row_count = 10
            df = db.read_declaraciones_renta()

        self.assertEqual(db.DECLARACIONES_RENTA_HEADERS, list(df.columns))
        self.assertEqual("2024", df.iloc[0]["Año"])
        self.assertEqual(500000000, df.iloc[0]["Patrimonio Líquido"])
        self.assertEqual(-500000, df.iloc[0]["Saldo (+ a pagar / - a favor)"])

    def test_guardar_declaracion_renta_replaces_existing_year(self):
        existente = pd.DataFrame(
            [["2023", "10/08/2024", 400000000, 100000000, 70000000, 2000000, 2200000, -200000, "", ""],
             ["2024", "15/08/2025", 500000000, 120000000, 80000000, 3000000, 3500000, -500000, "", ""]],
            columns=db.DECLARACIONES_RENTA_HEADERS)
        actualizada = ["2024", "20/08/2025", 550000000, 130000000, 85000000, 3200000, 3500000, -300000,
                        "https://drive.google.com/file/d/xyz", "corregida"]
        worksheet = Mock()
        worksheet.row_count = 10

        with patch.object(db, "_worksheet", return_value=worksheet), \
             patch.object(db, "read_declaraciones_renta", return_value=existente):
            db.guardar_declaracion_renta(actualizada)

        worksheet.batch_clear.assert_called_once_with(["A2:J10"])
        filas_escritas = worksheet.update.call_args.args[1]
        self.assertEqual(2, len(filas_escritas))
        self.assertEqual(["2023", "10/08/2024", 400000000, 100000000, 70000000, 2000000, 2200000, -200000, "", ""],
                          filas_escritas[0])
        self.assertEqual(actualizada, filas_escritas[1])

    def test_guardar_declaracion_renta_appends_new_year(self):
        existente = pd.DataFrame(
            [["2023", "10/08/2024", 400000000, 100000000, 70000000, 2000000, 2200000, -200000, "", ""]],
            columns=db.DECLARACIONES_RENTA_HEADERS)
        nueva = ["2024", "15/08/2025", 500000000, 120000000, 80000000, 3000000, 3500000, -500000, "", ""]
        worksheet = Mock()
        worksheet.row_count = 10

        with patch.object(db, "_worksheet", return_value=worksheet), \
             patch.object(db, "read_declaraciones_renta", return_value=existente):
            db.guardar_declaracion_renta(nueva)

        filas_escritas = worksheet.update.call_args.args[1]
        self.assertEqual([r[0] for r in filas_escritas], ["2023", "2024"])


if __name__ == "__main__":
    unittest.main()
