"""Mostra o estado da cinta: passos, gravação, modo, alerta e espaço. Com --ouvir N, repete a consulta de passos por N segundos."""
import atexit
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xoss import Strap, frame, hexs

strap = Strap()
strap.connect(scan_s=40)
atexit.register(strap.close)


def steps():
    reply = strap.command(frame(0x72, b'\x00'))
    if not reply or len(reply) < 8:
        return 'sem resposta'
    return 'ligados=%d cadência=%d passos/min total=%d' % (reply[1], reply[2], int.from_bytes(reply[3:7], 'little'))


print('passos:', steps())
for label, opcode, payload in (('gravação (ff=livre, 01=gravando)', 0x75, b'\x00'), ('modo (00=manual)', 0x76, b'\xff'),
                               ('alerta (bpm)', 0x71, b'\x00\x00'), ('espaço', 0x09, b'\x00')):
    reply = strap.command(frame(opcode, payload))
    print('%s: %s' % (label, hexs(reply) if reply else 'sem resposta'))
if '--ouvir' in sys.argv:
    seconds = int(sys.argv[sys.argv.index('--ouvir') + 1])
    for _ in range(seconds // 3):
        strap.pump(3)
        print('passos:', steps(), flush=True)
