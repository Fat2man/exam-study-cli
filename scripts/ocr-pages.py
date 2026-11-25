"""独立离线 OCR：逐物理页保存 MinerU 原始输出和请求证据，不修改原 PDF。"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import time


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(file, value):
    temporary = file.with_suffix(file.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(file)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--pdf', required=True)
    cli.add_argument('--pages', required=True, help='明确的 1-based 页码，如 97-122')
    cli.add_argument('--output', required=True)
    cli.add_argument('--tier', choices=['standard', 'basic'], default='standard')
    args = cli.parse_args()
    # 仅影响本次进程。关闭遥测，启用 HF/Transformers 离线模式；不调用远程 OCR/LLM。
    os.environ['MINERU_TELEMETRY_DISABLED'] = '1'
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    from mineru import MinerUParser
    from mineru.config import get_config
    from mineru.parser.writer import FileBasedDataWriter
    import pypdfium2 as pdfium

    source = Path(args.pdf).resolve(strict=True)
    output = Path(args.output).resolve()
    pages = set()
    for part in args.pages.split(','):
        bounds = part.split('-')
        if len(bounds) == 1:
            pages.add(int(bounds[0]))
        elif len(bounds) == 2:
            first, last = map(int, bounds)
            if last < first:
                raise ValueError('倒置页码范围')
            pages.update(range(first, last + 1))
        else:
            raise ValueError('无效页码范围')
    with pdfium.PdfDocument(str(source)) as pdf:
        total = len(pdf)
    if not pages or min(pages) < 1 or max(pages) > total:
        raise ValueError('物理页码越界')
    config = get_config()
    if config.model.vlm.server_url or any(config.llm_aided.features.model_dump().values()):
        raise ValueError('本工作流只允许本地模型，且必须关闭 LLM 辅助后处理')
    source_hash = digest(source)
    output.mkdir(parents=True, exist_ok=True)
    manifest_file = output / 'ocr-run.json'
    run = {'schemaVersion': 1, 'pdfPath': str(source), 'pdfSha256': source_hash, 'totalPages': total,
           'engine': 'MinerU', 'engineVersion': importlib.metadata.version('mineru'),
           'tier': args.tier, 'ocrMode': 'ocr', 'pages': []}
    if manifest_file.exists():
        previous = json.loads(manifest_file.read_text(encoding='utf-8'))
        for key in ['pdfSha256', 'totalPages', 'engineVersion', 'tier', 'ocrMode']:
            if previous.get(key) != run[key]:
                raise ValueError(f'现有 OCR 作业的 {key} 不匹配，请用新输出目录')
        run = previous
    parser = MinerUParser(tier=args.tier, parse_mode='ocr', image_analysis=True)
    for page_no in sorted(pages):
        saved = next((p for p in run['pages'] if p['pageNo'] == page_no), None)
        page_dir = output / f'page-{page_no:06d}'
        if saved:
            for key, relative in [('markdownSha256', 'markdown.md'), ('middleJsonSha256', 'middle_json.json')]:
                if digest(page_dir / relative) != saved[key]:
                    raise ValueError(f'已保存页 {page_no} 输出指纹改变，不覆盖')
            print(f'PAGE {page_no} cached / source index {saved["pageIdx"]}', flush=True)
            continue
        if page_dir.exists():
            raise FileExistsError(f'{page_dir} 是未完成输出，请检查后换目录重试，不能覆盖原始 OCR')
        print(f'PAGE {page_no} START / {len(pages)} requested', flush=True)
        started = time.monotonic()
        result = parser.parse(source, page_range=str(page_no))
        if len(result.pages) != 1 or result.pages[0].page_idx != page_no - 1:
            raise ValueError(f'页 {page_no} 的 OCR 原始 page_idx 不匹配，拒绝映射')
        page_dir.mkdir()
        result.save(FileBasedDataWriter(str(page_dir)))
        record = {'pageNo': page_no, 'pageIdx': result.pages[0].page_idx,
                  'requestPageRange': str(page_no), 'markdown': f'{page_dir.name}/markdown.md',
                  'markdownSha256': digest(page_dir / 'markdown.md'),
                  'middleJsonSha256': digest(page_dir / 'middle_json.json'),
                  'elapsedSeconds': round(time.monotonic() - started, 3)}
        run['pages'].append(record)
        run['pages'].sort(key=lambda p: p['pageNo'])
        write_json(manifest_file, run)
        print(f'PAGE {page_no} DONE / {record["elapsedSeconds"]}s', flush=True)
    if digest(source) != source_hash:
        raise ValueError('处理期间原 PDF 指纹变化，停止导入')
    print(f'COMPLETE {len(run["pages"])} pages; OCR remains unverified.', flush=True)


if __name__ == '__main__':
    main()
