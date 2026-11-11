#!/usr/bin/env python3
"""Esteira FTMS de mentira, pelo rádio de verdade.

Transforma o Bluetooth deste computador (Linux + BlueZ) num periférico BLE que
anuncia o Fitness Machine Service e se comporta como uma esteira. Serve para
testar o app num celular de verdade — busca, conexão, leitura dos dados e
comandos — sem ir à academia. É uma terceira implementação do protocolo,
independente do codec do app (src/ftms) e da esteira simulada (src/simulator).

Uso:
    python3 tools/esteira-ble.py                # esteira que aceita comandos
    python3 tools/esteira-ble.py --countdown 3  # o Start só conclui depois de 3 s
    python3 tools/esteira-ble.py --read-only    # sem Control Point: só transmite

Requisitos: BlueZ rodando, adaptador com papel de periférico, python-dbus e
python-gobject. Cada leitura, escrita e indication é impressa com o horário.
"""

import argparse
import math
import signal
import struct
import sys
import time

import dbus
import dbus.exceptions
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

try:
    from gi.repository import GLibUnix
except ImportError:  # versões antigas do PyGObject
    GLibUnix = None

BLUEZ = "org.bluez"
OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager"
PROPERTIES = "org.freedesktop.DBus.Properties"
GATT_MANAGER = "org.bluez.GattManager1"
ADVERTISING_MANAGER = "org.bluez.LEAdvertisingManager1"
GATT_SERVICE = "org.bluez.GattService1"
GATT_CHARACTERISTIC = "org.bluez.GattCharacteristic1"
ADVERTISEMENT = "org.bluez.LEAdvertisement1"


def uuid16(short):
    return "0000%04x-0000-1000-8000-00805f9b34fb" % short


FTMS_SERVICE = uuid16(0x1826)
FEATURE = uuid16(0x2ACC)
TREADMILL_DATA = uuid16(0x2ACD)
TRAINING_STATUS = uuid16(0x2AD3)
SPEED_RANGE = uuid16(0x2AD4)
INCLINATION_RANGE = uuid16(0x2AD5)
CONTROL_POINT = uuid16(0x2AD9)
MACHINE_STATUS = uuid16(0x2ADA)

# Faixas da ficha técnica da Matrix T600X.
SPEED_MIN, SPEED_MAX, SPEED_STEP = 0.8, 22.0, 0.1
INCLINATION_MIN, INCLINATION_MAX, INCLINATION_STEP = 0.0, 15.0, 0.5

OP_NAMES = {
    0x00: "Request Control",
    0x01: "Reset",
    0x02: "Set Target Speed",
    0x03: "Set Target Inclination",
    0x07: "Start or Resume",
    0x08: "Stop or Pause",
}
RESULT_NAMES = {
    0x01: "Success",
    0x02: "Op Code Not Supported",
    0x03: "Invalid Parameter",
    0x04: "Operation Failed",
    0x05: "Control Not Permitted",
}
SUCCESS, NOT_SUPPORTED, INVALID_PARAMETER, OPERATION_FAILED, NOT_PERMITTED = 1, 2, 3, 4, 5


def log(text):
    now = time.time()
    stamp = time.strftime("%H:%M:%S", time.localtime(now)) + ".%03d" % int(now % 1 * 1000)
    print(f"{stamp} {text}", flush=True)


def hexa(data):
    return " ".join("%02X" % byte for byte in data)


class Failed(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.Failed"


class InProgress(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.InProgress"


class NotSupported(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.NotSupported"


class Characteristic(dbus.service.Object):
    """Uma característica GATT exposta ao BlueZ."""

    def __init__(self, bus, path, service_path, uuid, flags, name):
        self.path = path
        self.service_path = service_path
        self.uuid = uuid
        self.flags = flags
        self.name = name
        self.notifying = False
        super().__init__(bus, path)

    def properties(self):
        return {
            GATT_CHARACTERISTIC: {
                "Service": dbus.ObjectPath(self.service_path),
                "UUID": self.uuid,
                "Flags": dbus.Array(self.flags, signature="s"),
            }
        }

    def value(self):
        raise NotSupported()

    def written(self, data):
        raise NotSupported()

    def send(self, data, kind="NOTIFY  "):
        """Notifica (ou indica) um valor novo aos assinantes."""
        if not self.notifying:
            return
        log(f"{kind} {self.name}: {hexa(data)}")
        self.PropertiesChanged(
            GATT_CHARACTERISTIC, {"Value": dbus.Array(data, signature="y")}, []
        )

    @dbus.service.method(PROPERTIES, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return self.properties()[GATT_CHARACTERISTIC]

    @dbus.service.method(GATT_CHARACTERISTIC, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        data = self.value()
        log(f"READ     {self.name}: {hexa(data)}")
        return dbus.Array(data, signature="y")

    @dbus.service.method(GATT_CHARACTERISTIC, in_signature="aya{sv}")
    def WriteValue(self, value, options):
        self.written(bytes(value))

    @dbus.service.method(GATT_CHARACTERISTIC)
    def StartNotify(self):
        self.notifying = True
        log(f"SUBSCRIBE {self.name}")

    @dbus.service.method(GATT_CHARACTERISTIC)
    def StopNotify(self):
        self.notifying = False
        log(f"UNSUBSCRIBE {self.name}")

    @dbus.service.signal(PROPERTIES, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass


class ReadOnly(Characteristic):
    def __init__(self, bus, path, service_path, uuid, name, read, flags=("read",)):
        super().__init__(bus, path, service_path, uuid, list(flags), name)
        self.read = read

    def value(self):
        return self.read()


class ControlPoint(Characteristic):
    def __init__(self, bus, path, service_path, treadmill):
        super().__init__(
            bus, path, service_path, CONTROL_POINT, ["write", "indicate"], "Control Point"
        )
        self.treadmill = treadmill

    def written(self, data):
        if not self.notifying:
            log(f"WRITE    Control Point: {hexa(data)}  -> recusada: indications desabilitadas")
            raise Failed("0xFD")  # CCCD Improperly Configured
        self.treadmill.command(data)


class Treadmill:
    """O estado da esteira e as regras do Control Point (FTMS 1.0, seção 4.16)."""

    def __init__(self, options):
        self.options = options
        self.belt = "stopped"  # stopped | running | paused
        self.has_control = False
        self.busy = False  # um procedimento ainda não foi concluído
        self.speed = 0.0
        self.target_speed = 0.0
        self.inclination = 0.0
        self.target_inclination = 0.0
        self.distance = 0.0
        self.elapsed = 0.0
        self.energy = 0.0
        self.heart_rate = 70.0
        self.data = None
        self.control_point = None
        self.status = None
        self.training = None

    # --- valores lidos -----------------------------------------------------

    def feature(self):
        # mede: distância (2), inclinação (3), energia (9), FC (10), tempo (12)
        machine = (1 << 2) | (1 << 3) | (1 << 9) | (1 << 10) | (1 << 12)
        # aceita alvo de velocidade (0) e de inclinação (1)
        targets = 0 if self.options.read_only else 0b11
        return struct.pack("<II", machine, targets)

    def speed_range(self):
        return struct.pack(
            "<HHH", round(SPEED_MIN * 100), round(SPEED_MAX * 100), round(SPEED_STEP * 100)
        )

    def inclination_range(self):
        return struct.pack(
            "<hhH",
            round(INCLINATION_MIN * 10),
            round(INCLINATION_MAX * 10),
            round(INCLINATION_STEP * 10),
        )

    def training_status(self):
        code = {"stopped": 0x01, "running": 0x0D, "paused": 0x0F}[self.belt]
        return bytes([0x00, code])

    def treadmill_data(self):
        # flags: distância (2), inclinação e rampa (3), energia (7), FC (8), tempo (10)
        flags = (1 << 2) | (1 << 3) | (1 << 7) | (1 << 8) | (1 << 10)
        distance = round(self.distance)
        ramp = math.degrees(math.atan(self.inclination / 100))
        per_minute = self.kcal_per_minute()
        return (
            struct.pack("<HH", flags, round(self.speed * 100))
            + struct.pack("<I", distance)[:3]
            + struct.pack("<hh", round(self.inclination * 10), round(ramp * 10))
            + struct.pack("<HHB", round(self.energy), round(per_minute * 60), round(per_minute))
            + struct.pack("<B", round(self.heart_rate))
            + struct.pack("<H", round(self.elapsed))
        )

    def kcal_per_minute(self):
        if self.speed <= 0:
            return 0.0
        metres_per_minute = self.speed * 1000 / 60
        vo2 = 0.2 * metres_per_minute + 0.9 * metres_per_minute * self.inclination / 100 + 3.5
        return vo2 * 70 / 1000 * 5

    # --- física ------------------------------------------------------------

    def tick(self):
        goal = self.target_speed if self.belt == "running" else 0.0
        if self.speed < goal:
            self.speed = min(goal, self.speed + 1.0)
        elif self.speed > goal:
            self.speed = max(goal, self.speed - 2.0)
        if self.inclination < self.target_inclination:
            self.inclination = min(self.target_inclination, self.inclination + 1.0)
        elif self.inclination > self.target_inclination:
            self.inclination = max(self.target_inclination, self.inclination - 1.0)
        self.distance += self.speed / 3.6
        if self.belt == "running":
            self.elapsed += 1
        self.energy += self.kcal_per_minute() / 60
        wanted = min(185.0, 70 + 6 * self.speed + 2 * self.inclination)
        self.heart_rate += max(-1.0, min(1.0, wanted - self.heart_rate))
        if self.data.notifying:
            self.data.send(self.treadmill_data())
        return True

    # --- Control Point -----------------------------------------------------

    def command(self, data):
        if not data:
            raise Failed("escrita vazia")
        op = data[0]
        name = OP_NAMES.get(op, "op code 0x%02X" % op)
        if self.busy:
            log(f"WRITE    Control Point: {hexa(data)}  ({name}) -> recusada: procedimento em andamento")
            raise InProgress("Procedure Already In Progress")
        log(f"WRITE    Control Point: {hexa(data)}  ({name})")
        result, delay, after = self.execute(op, data[1:])
        self.busy = True

        def respond():
            self.busy = False
            if after:
                after()
            log(f"         -> {RESULT_NAMES[result]}")
            self.control_point.send(bytes([0x80, op, result]), kind="INDICATE")
            return False

        GLib.timeout_add(delay, respond)

    def execute(self, op, parameter):
        """Devolve (result code, atraso da resposta em ms, efeito a aplicar junto com a resposta)."""
        quick = self.options.response_ms
        if op == 0x00:
            self.has_control = True
            return SUCCESS, quick, None
        if op not in OP_NAMES:
            return NOT_SUPPORTED, quick, None
        if not self.has_control:
            return NOT_PERMITTED, quick, None
        if op == 0x01:
            def reset():
                self.belt = "stopped"
                self.target_speed = self.target_inclination = 0.0
                self.distance = self.elapsed = self.energy = 0.0
                self.has_control = False
                self.changed()
            return SUCCESS, quick, reset
        if op == 0x02:
            if len(parameter) != 2:
                return INVALID_PARAMETER, quick, None
            speed = struct.unpack("<H", parameter)[0] / 100
            if not SPEED_MIN - 1e-9 <= speed <= SPEED_MAX + 1e-9:
                return INVALID_PARAMETER, quick, None
            self.target_speed = speed
            log(f"         alvo de velocidade: {speed:.2f} km/h")
            return SUCCESS, quick, None
        if op == 0x03:
            if len(parameter) != 2:
                return INVALID_PARAMETER, quick, None
            inclination = struct.unpack("<h", parameter)[0] / 10
            if not INCLINATION_MIN - 1e-9 <= inclination <= INCLINATION_MAX + 1e-9:
                return INVALID_PARAMETER, quick, None
            self.target_inclination = inclination
            log(f"         alvo de inclinação: {inclination:.1f} %")
            return SUCCESS, quick, None
        if op == 0x07:
            if self.belt == "running":
                return OPERATION_FAILED, quick, None

            def start():
                self.belt = "running"
                self.target_speed = max(self.target_speed, SPEED_MIN)
                self.changed()

            # Com contagem regressiva, o procedimento só conclui quando a lona parte.
            return SUCCESS, max(quick, int(self.options.countdown * 1000)), start
        if op == 0x08:
            action = parameter[0] if len(parameter) == 1 else 0
            if action == 0x01:
                if self.belt == "stopped":
                    return OPERATION_FAILED, quick, None
                self.belt = "stopped"
                self.target_speed = 0.0
                self.changed()
                return SUCCESS, quick, None
            if action == 0x02:
                if self.belt != "running":
                    return OPERATION_FAILED, quick, None
                self.belt = "paused"
                self.changed()
                return SUCCESS, quick, None
            return INVALID_PARAMETER, quick, None
        return NOT_SUPPORTED, quick, None

    def changed(self):
        log(f"         lona: {self.belt}")
        if self.training.notifying:
            self.training.send(self.training_status())


class Application(dbus.service.Object):
    """O serviço FTMS e suas características, como o BlueZ espera recebê-los."""

    PATH = "/br/gymburn/esteira"

    def __init__(self, bus, treadmill, read_only):
        super().__init__(bus, self.PATH)
        service = self.PATH + "/service0"
        self.service_path = service
        make = lambda index: f"{service}/char{index}"
        treadmill.data = Characteristic(
            bus, make(1), service, TREADMILL_DATA, ["notify"], "Treadmill Data"
        )
        treadmill.training = ReadOnly(
            bus, make(2), service, TRAINING_STATUS, "Training Status",
            treadmill.training_status, flags=("read", "notify"),
        )
        self.characteristics = [
            ReadOnly(bus, make(0), service, FEATURE, "Feature", treadmill.feature),
            treadmill.data,
            treadmill.training,
            ReadOnly(bus, make(3), service, SPEED_RANGE, "Supported Speed Range", treadmill.speed_range),
            ReadOnly(
                bus, make(4), service, INCLINATION_RANGE, "Supported Inclination Range",
                treadmill.inclination_range,
            ),
        ]
        if not read_only:
            treadmill.control_point = ControlPoint(bus, make(5), service, treadmill)
            treadmill.status = Characteristic(
                bus, make(6), service, MACHINE_STATUS, ["notify"], "Machine Status"
            )
            self.characteristics += [treadmill.control_point, treadmill.status]

    @dbus.service.method(OBJECT_MANAGER, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        objects = {
            dbus.ObjectPath(self.service_path): {
                GATT_SERVICE: {
                    "UUID": FTMS_SERVICE,
                    "Primary": True,
                    "Characteristics": dbus.Array(
                        [dbus.ObjectPath(c.path) for c in self.characteristics], signature="o"
                    ),
                }
            }
        }
        for characteristic in self.characteristics:
            objects[dbus.ObjectPath(characteristic.path)] = characteristic.properties()
        return objects


class Advertisement(dbus.service.Object):
    PATH = "/br/gymburn/esteira/advertisement0"

    def __init__(self, bus, name):
        super().__init__(bus, self.PATH)
        self.name = name

    @dbus.service.method(PROPERTIES, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return {
            "Type": "peripheral",
            "LocalName": self.name,
            "ServiceUUIDs": dbus.Array([FTMS_SERVICE], signature="s"),
            # Service Data do FTMS: flags (disponível) + tipo de equipamento (esteira).
            "ServiceData": dbus.Dictionary(
                {FTMS_SERVICE: dbus.Array([0x01, 0x01, 0x00], signature="y")}, signature="sv"
            ),
        }

    @dbus.service.method(ADVERTISEMENT)
    def Release(self):
        log("anúncio liberado pelo BlueZ")


def find_adapter(bus):
    manager = dbus.Interface(bus.get_object(BLUEZ, "/"), OBJECT_MANAGER)
    for path, interfaces in manager.GetManagedObjects().items():
        if GATT_MANAGER in interfaces and ADVERTISING_MANAGER in interfaces:
            return path
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--name", default="CTM781TESTE01", help="nome anunciado (até 13 caracteres)")
    parser.add_argument("--countdown", type=float, default=0, help="segundos até o Start concluir")
    parser.add_argument("--response-ms", type=int, default=50, help="atraso das respostas do Control Point")
    parser.add_argument("--read-only", action="store_true", help="sem Control Point: só transmite dados")
    options = parser.parse_args()

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    adapter = find_adapter(bus)
    if not adapter:
        sys.exit("Nenhum adaptador Bluetooth com suporte a periférico (GattManager1 + LEAdvertisingManager1).")

    treadmill = Treadmill(options)
    application = Application(bus, treadmill, options.read_only)
    advertisement = Advertisement(bus, options.name)
    loop = GLib.MainLoop()

    def failed(what):
        def handler(error):
            log(f"ERRO ao registrar {what}: {error}")
            loop.quit()
        return handler

    gatt = dbus.Interface(bus.get_object(BLUEZ, adapter), GATT_MANAGER)
    advertising = dbus.Interface(bus.get_object(BLUEZ, adapter), ADVERTISING_MANAGER)
    gatt.RegisterApplication(
        application.PATH, {},
        reply_handler=lambda: log("serviço FTMS registrado"),
        error_handler=failed("o serviço"),
    )
    advertising.RegisterAdvertisement(
        advertisement.PATH, {},
        reply_handler=lambda: log(f'anunciando como "{options.name}"'),
        error_handler=failed("o anúncio"),
    )
    GLib.timeout_add(1000, treadmill.tick)

    def stop(*_):
        loop.quit()
        return False

    signal_add = getattr(GLibUnix, "signal_add", None) or GLib.unix_signal_add
    signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, stop)
    signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, stop)
    try:
        loop.run()
    finally:
        for call in (
            lambda: advertising.UnregisterAdvertisement(advertisement.PATH),
            lambda: gatt.UnregisterApplication(application.PATH),
        ):
            try:
                call()
            except dbus.exceptions.DBusException:
                pass
        log("encerrado")


if __name__ == "__main__":
    main()
