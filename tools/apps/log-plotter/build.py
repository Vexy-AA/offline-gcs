import argparse
import pathlib
ROOT = pathlib.Path(__file__).resolve().parent
ap = argparse.ArgumentParser(description='Build the DataFlash Log Plotter page from src/.')
ap.add_argument('--host-script', metavar='URL',
                help='load this script before the page\'s own scripts, so the hosting site can set window.DFPLOT_HOST '
                     '(its own map imagery and terrain); e.g. /log-plotter/config.js')
ap.add_argument('--out', default=str(ROOT / 'out'), help='output folder (default: out/)')
opt = ap.parse_args()
S = ROOT / 'src'
css = (S/'style.css').read_text()
body = (S/'body.html').read_text()
core = (S/'core.js').read_text(); expr = (S/'expr.js').read_text()
app = '\n'.join((S/f'app{i}.js').read_text() for i in range(1, 8))
geo = (S/'geo.js').read_text().replace('__GEOID_B64__', (S/'geoid1deg.b64').read_text().strip())
V = ROOT / 'vendor'
three_inline = (V/'three.min.js').read_text() + '\n' + (V/'three-extras.min.js').read_text()
assert '</script' not in three_inline.lower()
CDN = 'https://cdn.jsdelivr.net/npm/three@0.147.0/'
three_cdn = '\n'.join(f'<script src="{CDN}{f}"></script>' for f in ['build/three.min.js', 'examples/js/loaders/GLTFLoader.js', 'examples/js/loaders/OBJLoader.js', 'examples/js/loaders/STLLoader.js', 'examples/js/lines/LineSegmentsGeometry.js', 'examples/js/lines/LineMaterial.js', 'examples/js/lines/LineSegments2.js'])
import base64
FD = ROOT / 'fonts'
RANGE = 'U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+0192,U+02C6,U+02DA,U+02DC,U+2009,U+2013-2014,U+2018-201E,U+2022,U+2026,U+2032-2033,U+2190-2193,U+2212,U+221E,U+2248,U+2264-2265'
faces = [('Barlow', 400, 'barlow-latin-400-normal'), ('Barlow', 500, 'barlow-latin-500-normal'), ('Barlow', 600, 'barlow-latin-600-normal'),
         ('Barlow Semi Condensed', 500, 'barlow-semi-condensed-latin-500-normal'), ('Barlow Semi Condensed', 600, 'barlow-semi-condensed-latin-600-normal'),
         ('JetBrains Mono', 400, 'jetbrains-mono-latin-400-normal'), ('JetBrains Mono', 500, 'jetbrains-mono-latin-500-normal'), ('JetBrains Mono', 600, 'jetbrains-mono-latin-600-normal')]
font_css = '/* Fonts are embedded so the page needs no network. Barlow and Barlow Semi Condensed: The Barlow Project Authors. JetBrains Mono: The JetBrains Mono Project Authors. Both under the SIL Open Font License 1.1. */\n'
for fam, w, fn in faces:
    b64 = base64.b64encode((FD / (fn + '.woff2')).read_bytes()).decode()
    font_css += f"@font-face {{ font-family: '{fam}'; font-style: normal; font-weight: {w}; font-display: swap; src: url(data:font/woff2;base64,{b64}) format('woff2'); unicode-range: {RANGE}; }}\n"
fonts = '<style>\n' + font_css + '</style>'
host = ''
if opt.host_script:
    assert '"' not in opt.host_script and '<' not in opt.host_script
    host = f'<script src="{opt.host_script}"></script>\n'
head = f'''<title>DataFlash Log Plotter</title>
<meta name="claude:viewport-fit-sides" content="cover">
{host}{fonts}
<style>
{css}
</style>
'''
tail = f'''{body}
__THREE__
<script>
{geo}
</script>
<script>
{core}
</script>
<script>
{expr}
</script>
<script>
(() => {{
'use strict';
{app}
}})();
</script>
'''
page = head + tail.replace('__THREE__', three_cdn)
out = pathlib.Path(opt.out); out.mkdir(parents=True, exist_ok=True)
(out/'dataflash-log-plotter.artifact.html').write_text(page)
tail = tail.replace('__THREE__', '<script>\n/* three.js r147 and its glTF, OBJ, STL loaders and thick lines (MIT licence, three.js authors) */\n' + three_inline + '\n</script>')
standalone = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + head + '</head>\n<body>\n' + tail + '</body>\n</html>\n'
(out/'dataflash-log-plotter.html').write_text(standalone)
print(len(page), 'bytes')
