#!/usr/bin/env bash
# Regenerates the sha256 CSP hashes for frontend/index.html's inline
# <script> blocks. Run this whenever an inline <script> block's content
# changes, then paste the printed values into the script-src directive of
# the app.yourdomain.com server block in nginx/orgcomms-vps.conf.
#
# Why hashes instead of 'unsafe-inline': frontend/index.html has no
# external script host and no per-request templating (nginx serves it as a
# static file), so a fixed sha256 allowlist of each script block's exact
# content is possible and is strictly tighter than 'unsafe-inline' - it lets
# the browser refuse to execute any inline <script> that isn't one of these
# four known blocks, which is exactly the class of attack (injected inline
# <script>) that the XSS fixes in frontend/index.html closed off at the
# application layer. CSP here is the second line of defense.
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - << 'PYEOF'
import re, hashlib, base64

with open("frontend/index.html", "r", encoding="utf-8") as f:
    src = f.read()

pattern = re.compile(r'<script([^>]*)>(.*?)</script>', re.DOTALL)
n = 0
for m in pattern.finditer(src):
    attrs, content = m.group(1), m.group(2)
    if 'src=' in attrs:
        continue  # external script, not inline - no hash needed
    if not content.strip():
        continue  # empty script tag
    n += 1
    digest = hashlib.sha256(content.encode('utf-8')).digest()
    b64 = base64.b64encode(digest).decode('ascii')
    print("'sha256-%s'" % b64)

print("", file=__import__('sys').stderr)
print("Found %d inline script block(s) above." % n, file=__import__('sys').stderr)
PYEOF
