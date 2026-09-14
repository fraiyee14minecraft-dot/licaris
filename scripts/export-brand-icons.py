"""Export our rendered SVG mark to Windows and Minecraft icon formats.

Requires Pillow and scripts/render-installer.cjs. Supplied illustrations remain unchanged.
"""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
logo = Image.open(root / 'ui/licaris-mark.png').convert('RGBA')
logo.save(root / 'ui/icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
logo.resize((64,64), Image.Resampling.LANCZOS).save(root / 'build/server-icon.png')
Image.open(root / 'build/installer-art.png').convert('RGB').save(root / 'build/installer-background.bmp')
print('Windows, Minecraft and installer formats exported.')
