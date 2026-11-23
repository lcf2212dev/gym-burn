"""Lê o perfil guardado na cinta; com quatro argumentos, grava peso (g), altura (mm), idade e FC máxima.

  python3 tools/xoss/perfil.py                      # só lê
  python3 tools/xoss/perfil.py 82500 1760 35 185    # grava e lê de volta
"""
import datetime
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xoss import Strap, frame, hexs

strap = Strap(verbose='-v' in sys.argv)
args = [a for a in sys.argv[1:] if a != '-v']
strap.connect()
import atexit
atexit.register(strap.close)  # um erro no meio não pode deixar a cinta presa ao computador
print('estado:', hexs(strap.command(frame(0xFF)) or b''))
before = strap.fetch('user_profile.json')
if before is None:
    sys.exit('não li o perfil')
print('perfil na cinta:\n' + before.decode())
if len(args) == 4:
    weight_g, height_mm, age, max_hr = map(int, args)
    today = datetime.date.today()
    birthday = int(datetime.datetime(today.year - age, today.month, today.day,
                                     tzinfo=datetime.timezone.utc).timestamp())
    text = before.decode()
    for key, value in (('updated_at', int(time.time())), ('birthday', birthday), ('weight', weight_g),
                       ('height', height_mm), ('MAXHR', max_hr)):
        text, count = re.subn(r'("%s":\s*)-?\d+' % key, lambda m: m.group(1) + str(value), text, count=1)
        assert count == 1, key
    print('enviando %d bytes' % len(text.encode()))
    print('resposta final:', hexs(strap.send('user_profile.json', text.encode()) or b''))
    strap.pump(1.0)
    after = strap.fetch('user_profile.json')
    print('igual ao enviado:', after == text.encode())
    print('perfil na cinta agora:\n' + (after or b'').decode())
    print('estado:', hexs(strap.command(frame(0xFF)) or b''))
