"""Render the LINE rich menu (requires Pillow and a Japanese-capable font)."""
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

font_path = os.environ.get('RICH_MENU_FONT', '/System/Library/Fonts/Hiragino Sans GB.ttc')
image = Image.new('RGB', (2500, 843), '#f2f7f3')
d = ImageDraw.Draw(image)
def font(size): return ImageFont.truetype(font_path, size)
def centered(text, x, y, size, fill):
    d.text((x, y), text, anchor='mt', font=font(size), fill=fill)

d.text((80, 45), 'LINE Talk bot', font=font(48), fill='#17312b')
d.text((2420, 53), 'KNOWLEDGE ASSISTANT', anchor='rt', font=font(28), fill='#5e7d6d')
for index, (title, subtitle) in enumerate([('管理画面', 'ログイン・参加トーク'), ('ナレッジ追加', 'ファイル・ノートを登録'), ('利用状況', '直近24時間の利用額')]):
    left = [0, 834, 1667][index] + 28
    right = [834, 1667, 2500][index] - 28
    cx = (left + right) // 2
    bg = '#e0f6e7' if index == 1 else '#ffffff'
    d.rounded_rectangle((left, 135, right, 815), radius=30, fill=bg, outline='#d5e4da', width=2)
    color = '#079549' if index == 1 else '#285f49'
    if index == 0:
        d.rounded_rectangle((cx-90, 260, cx+90, 405), radius=14, outline=color, width=10)
        d.line((cx-90, 305, cx+90, 305), fill=color, width=10)
        d.ellipse((cx-63, 276, cx-51, 288), fill=color)
        d.line((cx-48, 345, cx+48, 345), fill=color, width=9)
        d.line((cx-48, 374, cx+24, 374), fill=color, width=9)
    elif index == 1:
        d.rounded_rectangle((cx-78, 240, cx+78, 425), radius=10, outline=color, width=10)
        d.line((cx, 380, cx, 295), fill=color, width=12)
        d.line((cx-32, 330, cx, 294, cx+32, 330), fill=color, width=12)
    else:
        d.arc((cx-88, 245, cx+88, 421), 0, 300, fill=color, width=14)
        d.line((cx, 333, cx, 266), fill=color, width=10)
        d.line((cx, 333, cx+48, 358), fill=color, width=10)
        d.ellipse((cx-9, 324, cx+9, 342), fill=color)
    centered(title, cx, 480, 100, '#17312b')
    centered(subtitle, cx, 625, 42, '#587366')

path = Path(__file__).resolve().parent.parent / 'assets' / 'rich-menu.png'
image.save(path, optimize=True)
print(f'{path.name}: {path.stat().st_size} bytes, 2500 x 843')
