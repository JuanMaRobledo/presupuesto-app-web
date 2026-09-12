import unittest
from pathlib import Path

from streamlit.testing.v1 import AppTest


class AppTests(unittest.TestCase):
    def test_missing_secrets_shows_configuration_error_without_crashing(self):
        app = AppTest.from_file(Path(__file__).resolve().parents[1] / "app_presupuesto.py")
        app.secrets = {}

        app.run(timeout=30)

        self.assertFalse(app.exception)
        self.assertEqual(1, len(app.error))
        self.assertIn("Faltan", app.error[0].value)


if __name__ == "__main__":
    unittest.main()
