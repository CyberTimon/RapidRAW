"""Build a local contact sheet from the native auto-evaluate report (stdlib only)."""
import html
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
report = json.loads((root / 'report.json').read_text())
preferences_file = root.parent / 'preferences.json'
preferences = json.loads(preferences_file.read_text()) if preferences_file.exists() else {}
rows = []
for item in report['comparisons']:
    photo_number = re.search(r'(\d+)(?=\.[^.]+$)', item['photo'])
    preference = preferences.get(str(int(photo_number.group(1))), '') if photo_number else ''
    images = []
    for key, label in [('original', 'Original'), ('existing', 'Existing edit'), ('auto', 'Scene-aware Auto')]:
        if key == 'existing' and not item.get('savedReference', True):
            label = 'Old Auto (recomputed)'
        filename = item.get(key)
        image = f'<img loading="lazy" src="{html.escape(filename)}" alt="{label}">' if filename else '<div class="missing">No existing edit</div>'
        images.append(f'<figure>{image}<figcaption>{label}</figcaption></figure>')
    before, after = item['before'], item['after']
    metrics = {k: {'before': round(before[k], 3), 'after': round(after[k], 3), 'reference': round(item.get('reference', after)[k], 3)} for k in ['subject', 'background', 'clipped', 'warmth', 'tint']}
    metrics['faces'] = len(before['faces'])
    metrics['scene'] = before['scene']
    metrics['adjustments'] = {k: item['adjustments'].get(k) for k in ['exposure', 'brightness', 'shadows', 'highlights', 'temperature', 'tint']}
    rows.append(f'<section><h2>{html.escape(item["photo"])}</h2><p>{html.escape(str(preference))}</p><div class="images">{"".join(images)}</div><details><summary>Measurements</summary><pre>{html.escape(json.dumps(metrics, indent=2))}</pre></details></section>')
status = report['status']
summary = f'{report["photos"]} photos · {report["elapsedSeconds"]:.1f} seconds · {len(report["groups"])} lighting groups · {len(status["failures"])} failures'
page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Scene-aware Auto evaluation</title>
<style>body{margin:24px;font:14px Verdana,Inter,sans-serif;background:#f5f5f5;color:#202020}h1{font-size:20px}h2{font-size:14px;font-weight:500;margin-top:26px}section{margin-bottom:32px}.images{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}figure{margin:0}img{display:block;width:100%;height:auto;max-height:65vh;object-fit:contain;background:#171717}figcaption{padding:8px 0}.missing{min-height:220px;display:grid;place-items:center;background:#eee;color:#555}summary{cursor:pointer}pre{font-size:12px;overflow:auto}@media(max-width:700px){.images{grid-template-columns:1fr}body{margin:12px}}</style>'''
page += f'<h1>Scene-aware Auto evaluation</h1><p>{html.escape(summary)}</p><p>Existing edits are comparison examples, not assumed preferred results.</p>' + ''.join(rows) + '</html>'
(root / 'index.html').write_text(page)
print(summary)
print(root / 'index.html')
