#!/usr/bin/env python3
"""Builds dist/container-builder.html: the whole site as one page (styles
and scripts inlined, no <html>/<head>/<body> wrapper), which is the form a
Claude artifact is published from. Run from anywhere:

    python3 website/tools/build_single_page.py
"""
import pathlib, re

root = pathlib.Path(__file__).resolve().parent.parent
page = (root / "index.html").read_text()
body = page.split("<!-- app:start -->")[1].split("<!-- app:end -->")[0].strip()
fonts = re.search(r'<link rel="stylesheet" href="(https://fonts\.googleapis\.com[^"]+)">', page).group(1)
three = re.search(r'<script src="(https://cdnjs\.cloudflare\.com[^"]+)"></script>', page).group(1)
# The one-file version cannot reach the accounts service (a Claude artifact
# may not call other servers), so it is built without the connection
# settings and works on its own.
scripts = [s for s in re.findall(r'<script src="(js/[^"]+)"></script>', page) if s != "js/config.js"]

out = [
    "<title>CubePlanner</title>",
    '<meta name="claude:viewport-fit-sides" content="cover">',
    f'<link rel="stylesheet" href="{fonts}">',
    "<style>\n" + (root / "styles.css").read_text() + "</style>",
    body,
    f'<script src="{three}"></script>',
]
for src in scripts:
    code = (root / src).read_text()
    assert "</script" not in code, src
    out.append("<script>\n" + code + "</script>")
target = root / "dist" / "container-builder.html"
target.write_text("\n".join(out) + "\n")
print(target, f"{target.stat().st_size / 1024:.0f} KB")
