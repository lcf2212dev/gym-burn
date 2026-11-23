"""Lista os treinos gravados na cinta e baixa os arquivos FIT para a pasta dada.

  python3 tools/xoss/baixar.py tools/xoss/fixtures
"""
import atexit
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xoss import Strap, frame, hexs

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
strap = Strap()
strap.connect(scan_s=40)
atexit.register(strap.close)
space = strap.command(frame(0x09))
print('espaço (kB livres/total):', space[1:-1].decode() if space else 'sem resposta')
listing = b''
for attempt in range(1, 5):
    listing = strap.fetch('filelist.txt') or b''
    print('filelist.txt, leitura %d:' % attempt, listing.decode().strip() or '(vazio)', flush=True)
    if listing.strip() and '--insistir' not in sys.argv:
        break
    strap.pump(1.5)
for name in sorted(set(re.findall(rb'\d{14}\.fit', listing))):
    data = strap.fetch(name.decode())
    if data is not None:
        with open(os.path.join(out, name.decode()), 'wb') as handle:
            handle.write(data)
        print('salvo', name.decode(), len(data), 'bytes')
