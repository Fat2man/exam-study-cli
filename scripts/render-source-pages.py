"""离线来源核对：按 PDF 物理页渲染，只读取原 PDF，不进行 OCR 或推断映射。"""
import argparse
import hashlib
import json
from pathlib import Path

import pypdfium2 as pdfium


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', required=True)
    parser.add_argument('--pages', required=True, help='1-based，如 27-29,53,58,60')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    source = Path(args.pdf).resolve(strict=True)
    output = Path(args.output).resolve()
    pages = set()
    for part in args.pages.split(','):
        bounds = part.strip().split('-')
        if len(bounds) == 1:
            pages.add(int(bounds[0]))
        elif len(bounds) == 2:
            first, last = map(int, bounds)
            if last < first:
                raise ValueError('页码范围倒置')
            pages.update(range(first, last + 1))
        else:
            raise ValueError('无效页码范围')
    pdf = pdfium.PdfDocument(str(source))
    if not pages or min(pages) < 1 or max(pages) > len(pdf):
        raise ValueError('页码超出实际 PDF 范围')
    if output.exists():
        raise FileExistsError('输出目录已存在，请使用新目录；不覆盖旧证据')
    output.mkdir(parents=True)
    records = []
    for page_no in sorted(pages):
        page = pdf[page_no - 1]
        bitmap = page.render(scale=2)
        image = bitmap.to_pil()
        target = output / f'page-{page_no:06d}.png'
        image.save(target)
        image.close()
        bitmap.close()
        page.close()
        records.append({'pageNo': page_no, 'image': target.name, 'sha256': digest(target)})
    manifest = {'schemaVersion': 1, 'pdfPath': str(source), 'pdfSha256': digest(source),
                'totalPages': len(pdf), 'renderer': 'pypdfium2', 'scale': 2, 'pages': records}
    (output / 'pages.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    pdf.close()
    print(f'Rendered {len(records)} physical pages. Evidence: {output / "pages.json"}')


if __name__ == '__main__':
    main()
