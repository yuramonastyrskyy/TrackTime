#!/usr/bin/env bash
# Builds the Pages site: the live app at the root, a pull request's copy in
# preview/. Usage: build-pages.sh <live-dir> <pr-dir> <pr-number or ""> <out-dir>
set -euo pipefail
live=$1 pr=$2 num=$3 out=$4
copy() { # app files only (no git, tests, workflows)
  mkdir -p "$2"
  (cd "$1" && tar --exclude=.git --exclude=.github --exclude=test --exclude=scripts --exclude=node_modules --exclude=android --exclude=native --exclude=capacitor.config.json --exclude='package*.json' -cf - .) | (cd "$2" && tar -xf -)
}
rm -rf "$out"
copy "$live" "$out"
mkdir -p "$out/preview"
if [ -z "$num" ] || [ ! -d "$pr" ]; then
  cat > "$out/preview/index.html" <<'HTML'
<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TrackTime preview</title>
<body style="background:#0a1622;color:#f4f1ea;font:17px system-ui;padding:24px">
<h1>No preview right now</h1><p>There is no open pull request. The live app is <a style="color:#3e9bff" href="../">here</a>.</p>
HTML
  exit 0
fi
p="$out/preview"
copy "$pr" "$p"
# Own storage: settings and plan (localStorage/sessionStorage keys), sessions
# and recordings (IndexedDB) and the offline cache, so trying the preview never
# touches the live app's data.
sed -i "s/'tracktime\./'tracktime-preview./g" "$p"/js/*.js
sed -i "s/'tracktime-rec'/'tracktime-preview-rec'/" "$p"/js/recorder.js
sed -i "s/'tracktime-v/'tracktime-preview-v/g" "$p"/sw.js
# Older sw.js deleted every other cache on the site: keep to its own.
sed -i "s/keys.filter((k) => k !== VERSION)/keys.filter((k) => k !== VERSION \&\& k.startsWith('tracktime-preview-'))/" "$p"/sw.js
sed -i "s/k.startsWith('tracktime-v')/k.startsWith('tracktime-preview-v')/" "$p"/sw.js
# Badge and title, so it is never mistaken for the live app.
sed -i "s|<title>TrackTime</title>|<title>TrackTime preview (PR #$num)</title>|" "$p"/index.html
sed -i "s|</body>|<div aria-hidden=\"true\" style=\"position:fixed;top:calc(env(safe-area-inset-top) + 4px);right:6px;z-index:2147483647;background:#f5c84c;color:#0a1622;font:800 11px/1.4 system-ui,sans-serif;letter-spacing:.06em;padding:2px 7px;border-radius:6px;pointer-events:none\">PREVIEW · PR #$num</div>\n</body>|" "$p"/index.html
echo "preview: PR #$num"
