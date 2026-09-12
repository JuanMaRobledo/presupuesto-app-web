"""Lectores de formatos de movimientos para cuentas Bancolombia."""

import re
import unicodedata
from collections import Counter
from datetime import date, datetime


_MESES_ES = {
    "ENE": 1,
    "ENERO": 1,
    "FEB": 2,
    "FEBRERO": 2,
    "MAR": 3,
    "MARZO": 3,
    "ABR": 4,
    "ABRIL": 4,
    "MAY": 5,
    "MAYO": 5,
    "JUN": 6,
    "JUNIO": 6,
    "JUL": 7,
    "JULIO": 7,
    "AGO": 8,
    "AGOSTO": 8,
    "SEP": 9,
    "SEPT": 9,
    "SEPTIEMBRE": 9,
    "OCT": 10,
    "OCTUBRE": 10,
    "NOV": 11,
    "NOVIEMBRE": 11,
    "DIC": 12,
    "DICIEMBRE": 12,
}


def _normalizar_texto(valor):
    texto = unicodedata.normalize("NFKD", str(valor or ""))
    return " ".join(texto.encode("ascii", "ignore").decode().upper().split())


def periodo_colilla(texto, mes_abrev, anio, quincena_num):
    """Clasifica el período real de una colilla de pago.

    El Hospital reutiliza el encabezado de quincena en comprobantes de
    Prima y Cesantías. La clasificación debe depender del concepto impreso,
    no de ese encabezado, para que esos comprobantes no desplacen la
    quincena real del mismo período.
    """
    normalizado = _normalizar_texto(texto)
    if "PRIMA LEGAL" in normalizado:
        return f"Prima {mes_abrev}-{anio}"
    if "CESANTIAS" in normalizado:
        return f"Cesantías {mes_abrev}-{anio}"
    return f"{quincena_num} quincena {mes_abrev}-{anio}"


def _fecha_espanol(valor):
    if isinstance(valor, datetime):
        return valor.date()
    if isinstance(valor, date):
        return valor

    texto = _normalizar_texto(valor).replace(".", "")
    match = re.fullmatch(r"(\d{1,2})\s+([A-Z]+)\s+(\d{4})", texto)
    if not match:
        raise ValueError(f"Fecha no reconocida: {valor!r}")
    dia, mes_texto, anio = match.groups()
    mes = _MESES_ES.get(mes_texto)
    if not mes:
        raise ValueError(f"Mes no reconocido en la fecha: {valor!r}")
    return date(int(anio), mes, int(dia))


def concepto_cuenta(descripcion):
    """Unifica conceptos equivalentes entre las exportaciones del banco."""
    upper = _normalizar_texto(descripcion)
    solo_digitos = re.sub(r"\D", "", upper)
    if "SUCURSAL VIRTUAL" in upper and "10312780933" in solo_digitos:
        return "TRANSFERENCIA MAMA 10312780933"
    if "SUCURSAL VIRTUAL" in upper and ("10072477435" in solo_digitos or "10074277435" in solo_digitos):
        return "PAGO LILI 10072477435"
    if "SUCURSAL VIRTUAL" in upper and "23077460411" in solo_digitos:
        return "TRANSFERENCIA ESPOSA 23077460411"
    if "HOSPITAL HPTU" in upper:
        if "PGO NOMIN" in upper or "CONCEPTO NOMINA" in upper:
            return "PAGO DE NOMI HOSPITAL HPTU"
        return "PAGO DE PROV HOSPITAL HPTU"
    if "UDEA UNIVERSIDA" in upper and "NOMINA" in upper:
        return "PAGO DE NOMI UDEA UNIVERSIDA"
    if "SUCURSAL VIRTUAL" in upper and ("AL PRODUCTO" in upper or "DEL PRODUCTO" in upper):
        producto = re.search(r"(?:AL|DEL) PRODUCTO\s+(.+)$", upper)
        numero = re.sub(r"\D", "", producto.group(1)) if producto else ""
        return f"TRANSFERENCIA CTA SUC VIRTUAL {numero}".rstrip()
    if "TRANSFERENCIA" in upper and "DESDE NEQUI" in upper:
        return "TRANSFERENCIA DESDE NEQUI"
    if "TRANSFERENCIA" in upper and "NEQUI" in upper:
        return "TRANSFERENCIAS A NEQUI"
    if "RETIRO CAJERO" in upper:
        # El banco agrega el cajero puntual ("ATM HOSP PABLO", "SUC HOSPITAL
        # PA", "CAJERO TESORO E"...) al texto — auditoría 2026-09 encontró
        # ~10 retiros por cajero cayendo en "Otros" (sin categoría) porque
        # cada variante de cajero quedaba como concepto distinto. Es un
        # retiro de efectivo igual que "RETIRO TARJETA EN SUCURSAL": no es
        # gasto hasta que se use el efectivo.
        return "RETIRO CAJERO"
    return str(descripcion).strip()


def marcar_novedad_movimientos(movimientos, ya_ingresos, ya_egresos):
    """Marca movimientos nuevos respetando la multiplicidad real.

    Dos cargos idénticos del mismo archivo pueden ser operaciones legítimas.
    Si el mismo tramo aparece en otro archivo solapado, solo se conserva la
    mayor cantidad de apariciones observada en una fuente. Las filas ya
    guardadas también se cuentan, en vez de reducirlas a un ``set``.
    """
    existentes = {
        True: Counter((fecha, concepto, round(abs(float(valor)), 2))
                      for fecha, concepto, valor in ya_ingresos),
        False: Counter((fecha, concepto, round(abs(float(valor)), 2))
                       for fecha, concepto, valor in ya_egresos),
    }
    vistos_por_fuente = Counter()
    maximo_por_clave = Counter()
    for movimiento in movimientos:
        concepto = movimiento.get("concepto") or concepto_cuenta(movimiento["descripcion"])
        es_ingreso = movimiento["valor"] > 0
        clave_base = (movimiento["fecha"].strftime("%d/%m/%Y"), concepto,
                      round(abs(float(movimiento["valor"])), 2))
        clave_subida = (es_ingreso, *clave_base)
        fuente = (movimiento.get("_archivo"), movimiento.get("_sheet"))
        vistos_por_fuente[(fuente, clave_subida)] += 1
        aparicion = vistos_por_fuente[(fuente, clave_subida)]
        cantidad_existente = existentes[es_ingreso][clave_base]
        if concepto.startswith("TRANSFERENCIA CTA SUC VIRTUAL "):
            clave_generica = (clave_base[0], "TRANSFERENCIA CTA SUC VIRTUAL", clave_base[2])
            cantidad_existente = max(cantidad_existente, existentes[es_ingreso][clave_generica])
        ya_existe = aparicion <= cantidad_existente
        movimiento["_duplicado_subida"] = (not ya_existe
                                            and aparicion <= maximo_por_clave[clave_subida])
        movimiento["_nuevo"] = not ya_existe and not movimiento["_duplicado_subida"]
        maximo_por_clave[clave_subida] = max(maximo_por_clave[clave_subida], aparicion)
    return movimientos


NO_PRESUPUESTAR_SUFIJO = "(no presupuestar)"


def es_no_presupuestar(categoria):
    """True si la categoría es de las que se cargan solo para poder conciliar
    el saldo real de una cuenta (pago automático de tarjeta, transferencias
    entre tus propias cuentas, intereses...), sin contar en los totales de
    presupuesto. Por convención, toda categoría así termina en el sufijo
    "(no presupuestar)" — chequear el sufijo en vez de mantener una lista de
    nombres de categoría a mano evita que una categoría nueva quede afuera
    del chequeo por olvido."""
    return isinstance(categoria, str) and categoria.strip().lower().endswith(NO_PRESUPUESTAR_SUFIJO)


# Clasificación esencial / no esencial de cada categoría de GASTO — cubre
# las 23 categorías reales de la hoja "Categorías" del Sheet (verificadas
# ahí, no supuestas) al 2026-09-04. Es una primera aproximación razonable —
# quedó pendiente que el usuario la revise y corrija categoría por
# categoría; cualquier categoría que no esté en ninguna de las listas de
# abajo (p. ej. una agregada después en el Sheet) se muestra como "Sin
# clasificar" en vez de adivinar.
CATEGORIAS_ESENCIALES = {
    "Mercado y Supermercado",
    "Salud",
    "Seguros",
    "Vivienda y Servicios",
    "Transporte",
    "Educación y Profesional",
    "Servicio doméstico",
    "Cuidado Personal",
    "Apoyo familiar",
}
CATEGORIAS_NO_ESENCIALES = {
    "Restaurantes y Domicilios",
    "Entretenimiento",
    "Viajes",
    "Tecnología y Suscripciones",
    "Mascotas",
    "Compras Online / Varios",
    "Otros",
}
# Categorías que no son gasto de consumo (ahorro/inversión propia) — se
# excluyen de la vista esenciales/no esenciales en vez de clasificarse.
CATEGORIAS_NO_CONSUMO = {"Inversiones", "Ahorro"}


def clasificar_esencial(categoria):
    """'Esencial', 'No esencial', 'No consumo' (ahorro/inversión) o
    'Sin clasificar' para una categoría de gasto. Las categorías
    "(no presupuestar)" no deberían llegar acá — filtralas antes con
    es_no_presupuestar()."""
    if categoria in CATEGORIAS_ESENCIALES:
        return "Esencial"
    if categoria in CATEGORIAS_NO_ESENCIALES:
        return "No esencial"
    if categoria in CATEGORIAS_NO_CONSUMO:
        return "No consumo (ahorro/inversión)"
    return "Sin clasificar"


# Antes, los movimientos de cuenta que ya estaban contabilizados en otro lado
# (intereses de ahorros, nómina del hospital ya cargada por Colillas de Pago,
# desembolsos de préstamo, transferencias entre tus propias cuentas) se
# descartaban por completo — nunca se escribían en el Sheet — para no
# duplicar cifras de presupuesto. El problema: sin registrarlos en ningún
# lado, es imposible conciliar el saldo real de la cuenta contra el extracto
# del banco (saldo inicial + ingresos - egresos ya no da el saldo final,
# porque faltan movimientos reales). Ahora se registran igual — en Otros
# Ingresos o en Egresos - Efectivo, según el signo — pero con una categoría
# "(no presupuestar)" para que sigan sin contar en los totales de
# presupuesto, tal como ya se hace del lado de egresos con el pago
# automático de tarjetas. Ver CUENTA_CATEGORY_INGRESO / CUENTA_CATEGORY_EGRESO
# más abajo.
CAT_NO_PRESUPUESTAR_INGRESO = "Ajustes y Reversiones (no presupuestar)"

# Plataformas de inversión externas conocidas — sin depender de en qué
# punto trunca Bancolombia el texto, el mismo concepto aparece con
# distintos cortes según la transacción. Dinero que sale de la cuenta hacia
# cualquiera de estas se categoriza "Inversiones" (no es gasto de consumo)
# y además se registra como un aporte —con fecha y monto— en la hoja de
# Inversiones que corresponda, según en qué moneda maneja posiciones esa
# plataforma (Acciones y Valores/Trii operan en pesos; Plenti/Binance/Hapi,
# en dólares). El monto registrado siempre es el peso transferido desde el
# banco — no hay conversión a dólares automática, ver nota en cada hoja.
PLATAFORMAS_INVERSION_PESOS = {
    # "ACCIONES Y VAL" (sin "ORES") cubre tanto el nombre completo como el
    # texto truncado que deja WOMPI al procesar el pago (ej. "WOMPI*Acciones
    # y Val") — antes ese truncamiento no calzaba con ninguna palabra clave
    # y el aporte quedaba sin reconocer como plataforma de inversión.
    "ACCIONES Y VAL": "Acciones y Valores",
    "ACCIONES-Y-VALO": "Acciones y Valores",
    "TRII": "Trii",
}
PLATAFORMAS_INVERSION_DOLARES = {
    "PLENTI": "Plenti",
    "BINANCE": "Binance",
    "HAPI": "Hapi",
    # Los nombres del broker no siempre aparecen en el débito bancario:
    # Hapi recauda por Mono Colombia e Interactive Brokers se fondea por
    # Bridge/Arx, cuyo PSE figura como Soluciones de Pagos.
    "MONO COLOMBIA": "Hapi",
    "SOLUCIONES DE PAGOS": "Interactive Brokers",
}
FONDO_INVERSION_PALABRAS_CLAVE = ("FONDO DE INVERSION", "FONDO DE INVERS")


def plataforma_inversion(descripcion):
    """(nombre_plataforma, 'pesos'/'dolares') si la descripción menciona una
    de las plataformas de inversión externas conocidas — para saber en cuál
    hoja de Inversiones registrar el aporte. None si no aplica (p. ej. un
    fondo de inversión interno de Bancolombia, que no tiene hoja propia)."""
    upper = descripcion.upper()
    for kw, nombre in PLATAFORMAS_INVERSION_PESOS.items():
        if kw in upper:
            return nombre, "pesos"
    for kw, nombre in PLATAFORMAS_INVERSION_DOLARES.items():
        if kw in upper:
            return nombre, "dolares"
    return None


def posiciones_desde_operaciones(operaciones, plataforma):
    """Calcula posiciones abiertas con costo promedio, incluidos cortos.

    Cada operación trae symbol, type (BUY/SELL), quantity, price,
    commission y, opcionalmente, current_price/name. El prefijo de
    plataforma mantiene separadas posiciones del mismo ticker en brokers
    distintos.
    """
    posiciones, _ = resumen_operaciones_inversion(operaciones, plataforma)
    return posiciones


def resumen_operaciones_inversion(operaciones, plataforma):
    """Reconstruye posiciones abiertas y el historial realizado.

    Entiende las cuatro operaciones de una cuenta de margen: BUY/SELL para
    largos y SHORT/COVER para cortos. Las comisiones se incorporan al costo
    de entrada y al resultado realizado. Devuelve ``(posiciones, historial)``;
    el historial conserva también los activos ya cerrados.
    """
    estado = {}
    # Los extractos suelen venir en orden descendente. Dentro de una misma
    # fecha procesamos compras antes que ventas para no ignorar una venta
    # que aparece visualmente antes que la compra del mismo día.
    prioridad = {"BUY": 0, "SHORT": 0, "SELL": 1, "COVER": 1}
    ordenadas = sorted(enumerate(operaciones), key=lambda par: (
        par[1].get("date") or date.min, str(par[1].get("time") or ""),
        prioridad.get(str(par[1].get("type")).upper(), 9), par[0]))
    historial = []
    for _, op in ordenadas:
        simbolo = str(op.get("symbol") or "").strip().upper()
        tipo = str(op.get("type") or "").strip().upper()
        if not simbolo or tipo not in {"BUY", "SELL", "SHORT", "COVER"}:
            continue
        cantidad = abs(float(op.get("quantity") or 0))
        precio = float(op.get("price") or 0)
        comision = abs(float(op.get("commission") or 0))
        if cantidad <= 0 or precio <= 0:
            continue
        pos = estado.setdefault(simbolo, {"largos": 0.0, "costo_largos": 0.0,
                                          "cortos": 0.0, "ingreso_cortos": 0.0,
                                          "realizado": 0.0, "ultimo_precio": 0.0,
                                          "precio_actual": 0.0, "nombre": "",
                                          "tuvo_corto": False})
        realizado_op = 0.0
        if tipo == "BUY":
            pos["largos"] += cantidad
            pos["costo_largos"] += cantidad * precio + comision
        elif tipo == "SELL" and pos["largos"] > 0:
            cierre = min(cantidad, pos["largos"])
            costo_promedio = pos["costo_largos"] / pos["largos"]
            comision_cierre = comision * cierre / cantidad
            realizado_op = cierre * precio - comision_cierre - cierre * costo_promedio
            pos["largos"] -= cierre
            pos["costo_largos"] -= cierre * costo_promedio
            if pos["largos"] < 1e-8:
                pos["largos"] = pos["costo_largos"] = 0.0
        elif tipo == "SHORT":
            pos["tuvo_corto"] = True
            pos["cortos"] += cantidad
            pos["ingreso_cortos"] += cantidad * precio - comision
        elif tipo == "COVER" and pos["cortos"] > 0:
            cierre = min(cantidad, pos["cortos"])
            ingreso_promedio = pos["ingreso_cortos"] / pos["cortos"]
            comision_cierre = comision * cierre / cantidad
            realizado_op = cierre * ingreso_promedio - cierre * precio - comision_cierre
            pos["cortos"] -= cierre
            pos["ingreso_cortos"] -= cierre * ingreso_promedio
            if pos["cortos"] < 1e-8:
                pos["cortos"] = pos["ingreso_cortos"] = 0.0
        pos["realizado"] += realizado_op
        pos["ultimo_precio"] = precio
        if op.get("current_price") not in (None, ""):
            pos["precio_actual"] = float(op["current_price"])
        pos["nombre"] = str(op.get("name") or pos["nombre"])
        historial.append(dict(
            fecha=op.get("date"), plataforma=plataforma, moneda=op.get("moneda", "USD"),
            activo=simbolo, operacion=tipo, cantidad=cantidad, precio=precio,
            comision=comision, resultado_realizado=realizado_op,
            fuente=str(op.get("source") or "")))

    etfs = {"KWEB", "SPYL", "USO", "XOP", "IUES", "IWVL", "VOO", "CSPXCO", "IUESCO"}
    resultado = []
    for simbolo, pos in sorted(estado.items()):
        cantidad = pos["largos"] - pos["cortos"]
        if abs(cantidad) <= 1e-8:
            continue
        if cantidad > 0:
            precio_compra = pos["costo_largos"] / pos["largos"]
        else:
            precio_compra = pos["ingreso_cortos"] / pos["cortos"]
        resultado.append(dict(
            ticker=f"{plataforma} - {simbolo}",
            tipo="ETF" if simbolo in etfs else "Acción",
            cantidad=cantidad,
            precio_compra=precio_compra,
            precio_actual=pos["precio_actual"] or pos["ultimo_precio"],
        ))
    estados_finales = {}
    for simbolo, pos in estado.items():
        neta = pos["largos"] - pos["cortos"]
        estados_finales[simbolo] = ("Abierta larga" if neta > 1e-8 else
                                    "Abierta corta" if neta < -1e-8 else "Cerrada")
    for fila in historial:
        fila["estado"] = estados_finales[fila["activo"]]
    return resultado, historial


def posiciones_binance_desde_movimientos(movimientos):
    """Suma saldos por activo sin duplicar transferencias internas de Binance."""
    saldos = {}
    for movimiento in movimientos:
        moneda = str(movimiento.get("Moneda") or "").strip().upper()
        if not moneda or moneda == "COP":
            continue
        try:
            monto = float(str(movimiento.get("Cambiar") or 0).replace(",", ""))
        except ValueError:
            continue
        saldos[moneda] = saldos.get(moneda, 0.0) + monto
    return [dict(ticker=f"Binance - {moneda}", tipo="Cripto", cantidad=monto,
                 precio_compra=0.0, precio_actual=0.0, moneda="dolares")
            for moneda, monto in sorted(saldos.items()) if monto > 1e-10]


def simbolo_cotizacion(ticker, moneda, tipo=""):
    """Traduce una posición guardada al símbolo público usado por Yahoo."""
    if str(tipo).strip() == "Fondo de Inversión":
        return None
    nombre = str(ticker or "").strip()
    if not nombre:
        return None
    if " - " in nombre:
        plataforma, activo = nombre.split(" - ", 1)
    else:
        plataforma, activo = "", nombre
    activo = activo.strip().upper()
    if not activo or activo in {"CASH", "EFECTIVO/MARGEN", "EFECTIVO", "MARGEN"}:
        return None
    if plataforma in {"Acciones y Valores", "Trii"} or moneda == "pesos":
        return activo if activo.endswith(".CL") else f"{activo}.CL"
    if plataforma == "Binance" or str(tipo).strip() == "Cripto":
        return activo if "-" in activo else f"{activo}-USD"
    return activo.replace(".", "-")


def _es_movimiento_broker(descripcion):
    upper = descripcion.upper()
    return (plataforma_inversion(descripcion) is not None
            or any(kw in upper for kw in FONDO_INVERSION_PALABRAS_CLAVE))


# Categorías para GASTOS → Egresos - Efectivo (usan la lista general de Categorías).
CUENTA_CATEGORY_EGRESO = {
    "PAGO AUTOM TC VISA": ("Pago Tarjeta de Crédito (no presupuestar)",
                           "Pago automático de la tarjeta Visa, ya contabilizado en el detalle de la tarjeta"),
    "PAGO AUTOM TC MASTER PESOS": ("Pago Tarjeta de Crédito (no presupuestar)",
                                   "Pago automático Mastercard (pesos), ya contabilizado en el detalle de la tarjeta"),
    "PAGO AUTOM TC MASTER DOLAR": ("Pago Tarjeta de Crédito (no presupuestar)",
                                   "Pago automático Mastercard (dólares), ya contabilizado en el detalle de la tarjeta"),
    "TRANSFERENCIA CTA SUC VIRTUAL": ("Ajustes y Reversiones (no presupuestar)",
                                      "Transferencia entre tus propias cuentas"),
    "TRANSFERENCIA ESPOSA 23077460411": ("Ajustes y Reversiones (no presupuestar)",
                                          "Transferencia enviada a la cuenta de tu esposa"),
    "TRANSFERENCIA MAMA 10312780933": ("Apoyo familiar", "Ayuda familiar — dinero enviado a tu mamá"),
    "PAGO LILI 10072477435": ("Servicio doméstico", "Pago a Lili por el servicio de aseo"),
    "TRANSFERENCIAS A NEQUI": ("Ajustes y Reversiones (no presupuestar)", "Transferencia a tu cuenta Nequi"),
    "CUOTA MANEJO CUPO ROTATIVO": ("Intereses y Cargos Financieros (no presupuestar)", ""),
    "IVA CUOTA MANEJO CUPO ROTATIVO": ("Intereses y Cargos Financieros (no presupuestar)", ""),
    "IMPTO GOBIERNO 4X1000": ("Intereses y Cargos Financieros (no presupuestar)", "Impuesto 4x1000"),
    "PAGO SURAMERICANA DE SEGUROS": ("Seguros", ""),
    "Recarga de Tarjeta Civica": ("Transporte", "Recarga tarjeta Cívica"),
    "PAGO PSE EMPRESAS PUBLICAS DE": ("Vivienda y Servicios", "EPM — servicios públicos"),
    "PAGO PSE PAGOS ELECTRONICOS S": ("Vivienda y Servicios",
                                       "Cuota del leasing habitacional pagada por PSE (el resto de la cuota "
                                       "la cubre el ahorro AFC que se descuenta de la nómina)"),
    "AJUSTE INTERES AHORROS DB": ("Intereses y Cargos Financieros (no presupuestar)",
                                  "Ajuste/corrección en contra de intereses de ahorros"),
    "PAGO INTERBANC JUAN": ("Ajustes y Reversiones (no presupuestar)",
                            "Transferencia entre tus propias cuentas"),
    # Débitos automáticos de cuotas de deuda — ya contabilizadas en su
    # propia hoja de Deuda (Bancolombia/Sufi/Scotiabank/Fondo de
    # Empleados), no duplicar como gasto de consumo.
    "DEBITO OBLIGACION SUFI": ("Pago de deuda (no presupuestar)",
                               "Cuota automática del crédito Sufi, ya contabilizada en Deuda - Sufi"),
    "DEBITO POR ABONO CARTERA": ("Pago de deuda (no presupuestar)",
                                 "Abono automático a cartera/crédito, ya contabilizado en su hoja de Deuda"),
    "PAGO CREDITO SUC VIRTUAL": ("Pago de deuda (no presupuestar)",
                                 "Pago a un crédito hecho por Sucursal Virtual, ya contabilizado en su hoja de Deuda"),
    "DB A CUENTA POR ABONO CARTERA": ("Pago de deuda (no presupuestar)",
                                      "Abono automático a cartera/crédito, ya contabilizado en su hoja de Deuda"),
    # Encontrados en la auditoría 2025: quedaban en "Otros" (55% del gasto
    # operativo del año) porque no tenían regla — un retiro de efectivo y
    # una transferencia a otro banco tuyo no son gasto de consumo en sí
    # mismos, solo cambian de forma la misma plata.
    "RETIRO TARJETA EN SUCURSAL": ("Ajustes y Reversiones (no presupuestar)",
                                    "Retiro de efectivo en sucursal — no es gasto hasta que se use el efectivo"),
    "RETIRO CAJERO": ("Ajustes y Reversiones (no presupuestar)",
                      "Retiro de efectivo en cajero — no es gasto hasta que se use el efectivo"),
    "TRASLADO VIRTUAL OTROS BANCOS": ("Ajustes y Reversiones (no presupuestar)",
                                       "Transferencia a una cuenta tuya en otro banco"),
}

# Categorías para INGRESOS → Otros Ingresos (usan la lista propia de esa
# hoja, la misma que el desplegable de la columna 'Categoría' en el Sheet).
CATEGORIAS_OTROS_INGRESOS = [
    "Reembolso (esposa/otros)",
    "Honorarios / Consultoría",
    "Rendimientos Financieros",
    "Cesantías",
    "Regalo",
    "Venta",
    "Ajustes y Reversiones (no presupuestar)",
    "Otro",
]

CUENTA_CATEGORY_INGRESO = {
    "PAGO DE NOMI UDEA UNIVERSIDA": ("Honorarios / Consultoría", "Nómina UDEA"),
    "PAGO DE NOMI UNIVERSIDAD EIA": ("Honorarios / Consultoría", "Nómina EIA"),
    "PAGO DE NOMI UNIVERSIDAD PON": ("Honorarios / Consultoría", "Nómina UPB"),
    "PAGO DE PROV UNIVERSIDAD EIA": ("Honorarios / Consultoría", ""),
    "PAGO INTERBANC ASTRAZENECA COL": ("Honorarios / Consultoría", ""),
    "PAGO INTERBANC UNIVERSIDAD DE": ("Honorarios / Consultoría", ""),
    "PAGO DE PROV HOSPITAL HPTU": ("Honorarios / Consultoría", "Pago del hospital, fuera de tu nómina quincenal"),
    "DEVOLUCION ABONO TC": ("Otro", "Devolución/reversión de un abono a tarjeta"),
    "TRANSFERENCIA CTA SUC VIRTUAL": ("Otro", "Transferencia recibida por Sucursal Virtual — revisá de quién es si querés más detalle"),
    "TRANSFERENCIA ESPOSA 23077460411": ("Reembolso (esposa/otros)",
                                          "Transferencia recibida desde la cuenta de tu esposa"),
    "TRANSFERENCIAS A NEQUI": ("Otro", "Transferencia recibida vía Nequi — revisá de quién es si querés más detalle"),
    "TRANSFERENCIA DESDE NEQUI": ("Otro", "Transferencia recibida vía Nequi — revisá de quién es si querés más detalle"),
    # Antes se descartaban sin registrar (ver comentario arriba de
    # CAT_NO_PRESUPUESTAR_INGRESO) — ahora quedan acá para poder conciliar
    # el saldo real de la cuenta, sin inflar el ingreso presupuestado.
    "ABONO INTERESES AHORROS": ("Rendimientos Financieros", "Interés pagado por el banco sobre el saldo de ahorros"),
    "AJUSTE INTERES AHORROS CR": (CAT_NO_PRESUPUESTAR_INGRESO, "Ajuste/corrección a favor de intereses de ahorros"),
    "PAGO DE NOMI HOSPITAL HPTU": (CAT_NO_PRESUPUESTAR_INGRESO,
                                    "Nómina del hospital — ya contabilizada en Colillas de Pago, no duplicar"),
    "REV CUOTA MANEJO CUPO ROTATIVO": (CAT_NO_PRESUPUESTAR_INGRESO, "Reversión de la cuota de manejo"),
    "REV IVA CUOTA MANEJO CUPO ROTA": (CAT_NO_PRESUPUESTAR_INGRESO, "Reversión del IVA de la cuota de manejo"),
    "REV IMPTO GOBIERNO 4X1000": (CAT_NO_PRESUPUESTAR_INGRESO, "Reversión del 4x1000"),
    "TRASLADO DE FONDO DE INVERS": (CAT_NO_PRESUPUESTAR_INGRESO,
                                     "Traslado desde tu fondo de inversión — no es ingreso nuevo"),
    "PAGO DE PROV FONDO DE EMPLEA": (CAT_NO_PRESUPUESTAR_INGRESO,
                                      "Desembolso de préstamo del Fondo de Empleados — no es ingreso nuevo, "
                                      "se paga vía nómina"),
    "DESEMBOLSO CREDIAGIL APP": (CAT_NO_PRESUPUESTAR_INGRESO,
                                  "Desembolso de préstamo Crediagil — no es ingreso nuevo"),
    "PAGO INTERBANC JUAN": (CAT_NO_PRESUPUESTAR_INGRESO, "Transferencia entre tus propias cuentas"),
}


def categorize_cuenta(concepto, es_ingreso):
    """Recibe el CONCEPTO ya canónico (salida de concepto_cuenta), no la
    descripción cruda del banco — no lo vuelve a pasar por concepto_cuenta()
    acá, porque esa función no es idempotente para todo (p. ej. "PAGO DE
    NOMI HOSPITAL HPTU" ya canónico, pasado de nuevo, se reclasificaría como
    "PAGO DE PROV HOSPITAL HPTU" porque no contiene el texto crudo "PGO
    NOMIN" que dispara esa rama)."""
    tabla = CUENTA_CATEGORY_INGRESO if es_ingreso else CUENTA_CATEGORY_EGRESO
    if concepto in tabla:
        return tabla[concepto]
    if concepto.startswith("TRANSFERENCIA CTA SUC VIRTUAL "):
        return tabla["TRANSFERENCIA CTA SUC VIRTUAL"]
    if _es_movimiento_broker(concepto):
        if es_ingreso:
            return (CAT_NO_PRESUPUESTAR_INGRESO, "Dinero que vuelve desde tu cuenta de inversión/broker — no es ingreso nuevo")
        return ("Inversiones", "Fondeo de tu cuenta de inversión/broker (Plenti, Acciones y Valores, Binance, Hapi)")
    return ("Otro" if es_ingreso else "Otros", "Movimiento no reconocido, clasificar manualmente")


def movimiento_cuenta(fecha, descripcion, valor):
    """Arma el movimiento de cuenta ya categorizado (concepto canónico,
    categoría, nota y si es "no presupuestar"), listo para mostrar en la UI
    o escribir al Sheet. Si es un egreso hacia una plataforma de inversión
    conocida, "aporte_inversion" trae (plataforma, moneda) para que además
    se registre como aporte en la hoja de Inversiones correspondiente."""
    concepto = concepto_cuenta(descripcion)
    es_ingreso = valor > 0
    categoria, nota = categorize_cuenta(concepto, es_ingreso)
    plataforma = plataforma_inversion(concepto)
    if plataforma is None and any(kw in concepto.upper() for kw in FONDO_INVERSION_PALABRAS_CLAVE):
        plataforma = ("Fondo de inversión", "pesos")
    aporte = plataforma if not es_ingreso else None
    return dict(fecha=fecha, descripcion=descripcion, concepto=concepto, valor=valor,
                categoria=categoria, nota=nota, no_presupuestar=es_no_presupuestar(categoria),
                aporte_inversion=aporte, flujo_inversion=plataforma)


def parse_detalle_transacciones_sheet(ws):
    """Lee la exportación tabular "Detalle de transacciones".

    Devuelve ``None`` cuando la hoja no corresponde a este formato, para que
    el llamador pueda intentar el lector del extracto impreso tradicional.
    """
    rows = list(ws.iter_rows(values_only=True))
    required = {"FECHA", "DESCRIPCION", "VALOR"}
    header_row = None
    indices = None

    for row_number, row in enumerate(rows[:20]):
        headers = {_normalizar_texto(value): idx for idx, value in enumerate(row) if value not in (None, "")}
        if required.issubset(headers):
            header_row = row_number
            indices = headers
            break

    if header_row is None:
        return None

    txns = []
    for row_number, row in enumerate(rows[header_row + 1:], start=header_row + 2):
        if not row or all(value in (None, "") for value in row):
            continue
        try:
            fecha = _fecha_espanol(row[indices["FECHA"]])
            descripcion = str(row[indices["DESCRIPCION"]] or "").strip()
            valor_raw = row[indices["VALOR"]]
            valor = float(valor_raw)
        except (IndexError, TypeError, ValueError) as exc:
            raise ValueError(f"Fila {row_number} inválida en el detalle de transacciones: {exc}") from exc

        if not descripcion:
            raise ValueError(f"Fila {row_number} sin descripción en el detalle de transacciones")
        if "TIPO DE TRANSACCION" in indices:
            tipo = _normalizar_texto(row[indices["TIPO DE TRANSACCION"]])
            if tipo == "DEBITO":
                valor = -abs(valor)
            elif tipo == "CREDITO":
                valor = abs(valor)
            else:
                raise ValueError(f"Fila {row_number} con tipo de transacción no reconocido: {tipo!r}")

        txns.append(dict(fecha=fecha, descripcion=descripcion, valor=valor))

    return txns
