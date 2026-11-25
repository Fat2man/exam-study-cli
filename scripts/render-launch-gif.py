import json
import os
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont


WIDTH, HEIGHT = 1080, 630
FONT = Path(os.environ.get('DEMO_FONT', 'C:/Windows/Fonts/msyh.ttc'))
BG, PANEL = '#0b1524', '#14243a'
INK, MUTED, ACCENT = '#edf4ff', '#a9bfd6', '#8ce9d3'


def render(scene, index, count):
    image = Image.new('RGB', (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)
    body = ImageFont.truetype(str(FONT), 19)
    small = ImageFont.truetype(str(FONT), 16)
    title = ImageFont.truetype(str(FONT), 28)
    draw.text((38, 23), 'EXAM STUDY CLI  /  开发预览', font=small, fill=ACCENT)
    draw.text((38, 55), scene['title'], font=title, fill=INK)
    draw.text((1042, 54), f'{index:02d} / {count:02d}', anchor='rt', font=body, fill=ACCENT)
    draw.rounded_rectangle((38, 109, 1042, 552), radius=16, fill=PANEL)
    if 'image' in scene:
        with Image.open(scene['image']) as original:
            original.thumbnail((970, 415), Image.Resampling.LANCZOS)
            image.paste(original, ((WIDTH - original.width) // 2, 109 + (443 - original.height) // 2))
    else:
        lines = [line.rstrip() for line in scene['screen'].split('\n')]
        lines = [line for line in lines if line]
        spacing = min(31, 397 // len(lines))
        for offset, line in enumerate(lines):
            if draw.textlength(line, font=body) > 944:
                raise ValueError(f'Terminal line exceeds GIF bounds: {line}')
            color = ACCENT if offset == 0 or line.lstrip().startswith(('›', '原页图选择', 'PDF 物理页', '已恢复')) else INK
            draw.text((63, 126 + spacing * offset), line, font=body, fill=color)
    draw.text((38, 579), scene['caption'], font=body, fill=MUTED)
    draw.line((38, 613, 1042, 613), fill='#324960', width=3)
    draw.line((38, 613, 38 + 1004 * index // count, 613), fill=ACCENT, width=3)
    return image


def main():
    scenes = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    durations = [scene['ms'] for scene in scenes]
    if sum(durations) != 20_000:
        raise ValueError('Demo must last exactly 20 seconds')
    frames = [render(scene, index, len(scenes)) for index, scene in enumerate(scenes, 1)]
    frames[0].save(sys.argv[2], save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)


if __name__ == '__main__':
    main()
