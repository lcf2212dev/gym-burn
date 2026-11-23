"""Cliente do canal proprietário da cinta XOSS X2 Pro (Nordic UART + YMODEM) sobre o BlueZ, por D-Bus.

Precisa de python-dbus e python-gobject, do bluetoothd rodando, da cinta no peito e de nenhum
outro aparelho conectado a ela (ela aceita uma conexão por vez).
"""
import time

import dbus
import dbus.mainloop.glib
from gi.repository import GLib

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
BLUEZ, PROPS, CHAR = 'org.bluez', 'org.freedesktop.DBus.Properties', 'org.bluez.GattCharacteristic1'
CTL, TX, RX, HR = '6e400004', '6e400003', '6e400002', '00002a37'
SOH, STX, EOT, ACK, NAK, CAN, C = 0x01, 0x02, 0x04, 0x06, 0x15, 0x18, 0x43


def hexs(raw):
    return ' '.join('%02x' % b for b in raw)


def xor(data):
    value = 0
    for b in data:
        value ^= b
    return value


def crc16_arc(data):
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc & 0xFFFF


def frame(opcode, content=b'\x00'):
    """Quadro de controle: código, conteúdo e XOR de tudo."""
    body = bytes([opcode]) + bytes(content)
    return body + bytes([xor(body)])


class Strap:
    def __init__(self, verbose=False):
        self.bus = dbus.SystemBus()
        self.om = dbus.Interface(self.bus.get_object(BLUEZ, '/'), 'org.freedesktop.DBus.ObjectManager')
        self.adapter = dbus.Interface(self.bus.get_object(BLUEZ, '/org/bluez/hci0'), 'org.bluez.Adapter1')
        self.ctx = GLib.MainContext.default()
        self.start = time.time()
        self.verbose = verbose
        self.chars, self.names = {}, {}
        self.ctl = []              # mensagens do canal de controle
        self.stream = bytearray()  # bytes do canal de dados (YMODEM)
        self.beats = []            # pacotes do 0x2A37
        self.path = None
        self.bus.add_signal_receiver(self._changed, dbus_interface=PROPS,
                                     signal_name='PropertiesChanged', path_keyword='path')

    def log(self, *args):
        if self.verbose:
            print('%7.2fs ' % (time.time() - self.start), *args, flush=True)

    def pump(self, seconds):
        end = time.time() + seconds
        while True:
            while self.ctx.iteration(False):
                pass
            if time.time() >= end:
                return
            time.sleep(0.005)

    def _changed(self, interface, changes, invalidated, path=None):
        if interface != CHAR or 'Value' not in changes:
            return
        raw = bytes(int(b) for b in changes['Value'])
        name = self.names.get(path)
        if name == CTL:
            self.ctl.append(raw)
            self.log('<ctl ', hexs(raw))
        elif name == TX:
            self.stream.extend(raw)
        elif name == HR:
            self.beats.append((time.time() - self.start, raw))

    def connect(self, scan_s=60):
        try:
            self.adapter.SetDiscoveryFilter({'Transport': dbus.String('le')})
            self.adapter.StartDiscovery()
        except dbus.DBusException:
            pass
        limit = time.time() + scan_s
        path = None
        while time.time() < limit and not path:
            self.pump(0.5)
            for p, ifaces in self.om.GetManagedObjects().items():
                dev = ifaces.get('org.bluez.Device1')
                if dev and str(dev.get('Name', '')).startswith('XOSS') and 'RSSI' in dev:
                    path = p
        if not path:
            raise SystemExit('Cinta não apareceu na busca (está no peito e desconectada do celular?).')
        self.device = dbus.Interface(self.bus.get_object(BLUEZ, path), 'org.bluez.Device1')
        props = dbus.Interface(self.bus.get_object(BLUEZ, path), PROPS)
        for _ in range(3):
            try:
                self.device.Connect(timeout=30)
                break
            except dbus.DBusException as error:
                self.log('conexão falhou:', error.get_dbus_name().split('.')[-1])
                self.pump(2)
        else:
            raise SystemExit('Não conectou.')
        try:
            self.adapter.StopDiscovery()
        except dbus.DBusException:
            pass
        limit = time.time() + 20
        while time.time() < limit and not props.Get('org.bluez.Device1', 'ServicesResolved'):
            self.pump(0.3)
        self.path = path
        for cpath, ifaces in self.om.GetManagedObjects().items():
            char = ifaces.get(CHAR)
            if char and cpath.startswith(path):
                name = str(char['UUID'])[:8]
                self.chars[name] = dbus.Interface(self.bus.get_object(BLUEZ, cpath), CHAR)
                self.names[cpath] = name
        for name in (CTL, TX, HR):
            self.chars[name].StartNotify()
        self.pump(1.0)

    def write(self, name, data, response=True):
        self.chars[name].WriteValue(dbus.Array([dbus.Byte(b) for b in data], signature='y'),
                                    {'type': dbus.String('request' if response else 'command')})

    def command(self, data, wait=6.0):
        """Envia um quadro no canal de controle e devolve a primeira resposta."""
        seen = len(self.ctl)
        self.log('>ctl ', hexs(data))
        self.write(CTL, data)
        limit = time.time() + wait
        while time.time() < limit and len(self.ctl) == seen:
            self.pump(0.02)
        return self.ctl[seen] if len(self.ctl) > seen else None

    def _take(self, count, wait=10.0):
        limit = time.time() + wait
        while len(self.stream) < count and time.time() < limit:
            self.pump(0.005)
        if len(self.stream) < count:
            return None
        data = bytes(self.stream[:count])
        del self.stream[:count]
        return data

    def _byte(self, wait=10.0):
        data = self._take(1, wait)
        return data[0] if data else None

    def _block(self):
        head = self._byte()
        if head is None:
            return 'timeout', None, None
        if head == EOT:
            return 'eot', None, None
        if head not in (SOH, STX):
            self.pump(0.3)
            self.stream.clear()
            return 'junk', None, None
        size = 128 if head == SOH else 1024
        rest = self._take(2 + size + 2)
        if rest is None:
            return 'timeout', None, None
        data, crc = rest[2:2 + size], int.from_bytes(rest[-2:], 'big')
        if rest[0] ^ rest[1] != 0xFF or crc16_arc(data) != crc:
            return 'crc', None, None
        return 'ok', rest[0], data

    def fetch(self, filename):
        """Baixa um arquivo da cinta. Devolve os bytes, ou None se ela não o tem."""
        self.stream.clear()
        reply = self.command(frame(0x05, filename.encode()))
        if reply is None or reply[0] != 0x06:
            return None
        self.write(RX, bytes([C]), response=False)
        kind, number, data = self._block()
        if kind != 'ok':
            self.write(RX, bytes([CAN]), response=False)
            return None
        # Bloco zero: nome e tamanho, separados por espaço (ou NUL em outros aparelhos).
        header = data.rstrip(b'\x00').replace(b'\x00', b' ').split()
        size = int(header[1]) if len(header) > 1 and header[1].isdigit() else None
        self.write(RX, bytes([ACK]), response=False)
        self.pump(0.05)
        self.write(RX, bytes([C]), response=False)
        out, errors, last = bytearray(), 0, 0
        while True:
            kind, number, data = self._block()
            if kind == 'ok' and number == 0 and not out:
                # A cinta repetiu o bloco zero: o ACK ou o 'C' se perdeu. Pede de novo.
                self.log('bloco zero repetido')
                self.write(RX, bytes([ACK]), response=False)
                self.pump(0.05)
                self.write(RX, bytes([C]), response=False)
            elif kind == 'ok' and number == last and out:
                self.write(RX, bytes([ACK]), response=False)  # retransmissão: o ACK anterior se perdeu
            elif kind == 'ok':
                out.extend(data)
                last = number
                self.write(RX, bytes([ACK]), response=False)
            elif kind == 'eot':
                break
            else:
                errors += 1
                if errors > 5:
                    self.write(RX, bytes([CAN]), response=False)
                    return None
                self.pump(0.2)
                self.stream.clear()
                self.write(RX, bytes([NAK]), response=False)
        self.pump(0.1)
        self.write(RX, bytes([NAK]), response=False)
        self._byte(5)  # segundo EOT
        self.pump(0.1)
        seen = len(self.ctl)
        self.write(RX, bytes([ACK]), response=False)
        limit = time.time() + 5
        while time.time() < limit and len(self.ctl) == seen:
            self.pump(0.02)
        return bytes(out[:size]) if size is not None else bytes(out).rstrip(b'\x00')

    def _send_block(self, number, payload):
        data = payload + bytes(128 - len(payload))
        block = bytes([SOH, number, 0xFF ^ number]) + data + crc16_arc(data).to_bytes(2, 'big')
        for i in range(0, len(block), 20):
            self.write(RX, block[i:i + 20], response=False)
            self.pump(0.01)

    def send(self, filename, data):
        """Envia um arquivo à cinta (0x07 + YMODEM). Devolve a resposta final do controle (04 00 04 = aceito)."""
        self.stream.clear()
        reply = self.command(frame(0x07, filename.encode()))
        if reply is None or reply[0] != 0x08:
            self.log('envio recusado:', hexs(reply) if reply else 'sem resposta')
            return None
        if self._byte() != C:
            self.log("sem 'C' inicial")
            return None
        self._send_block(0, ('%s %d' % (filename, len(data))).encode())
        first = self._byte()
        second = self._byte() if first == ACK else first
        if second != C:
            self.log('bloco zero não aceito:', first, second)
            self.write(RX, bytes([CAN]), response=False)
            return None
        number = 0
        for offset in range(0, len(data), 128):
            number = (number + 1) % 256
            for _ in range(3):
                self._send_block(number, data[offset:offset + 128])
                if self._byte() == ACK:
                    break
            else:
                self.log('bloco %d sem ACK' % number)
                self.write(RX, bytes([CAN]), response=False)
                return None
        seen = len(self.ctl)
        self.pump(0.1)
        self.write(RX, bytes([EOT]), response=False)
        if self._byte() != NAK:
            self.log('sem NAK depois do EOT')
        self.pump(0.1)
        self.write(RX, bytes([EOT]), response=False)
        if self._byte() != ACK:
            self.log('sem ACK depois do segundo EOT')
        limit = time.time() + 6
        while time.time() < limit and len(self.ctl) == seen:
            self.pump(0.02)
        return self.ctl[seen] if len(self.ctl) > seen else None

    def close(self):
        for name in (CTL, TX, HR):
            try:
                self.chars[name].StopNotify()
            except (dbus.DBusException, KeyError):
                pass
        try:
            self.device.Disconnect()
            self.adapter.RemoveDevice(self.path)
        except dbus.DBusException:
            pass
