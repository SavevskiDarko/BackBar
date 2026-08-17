#!/bin/bash
set -e
[ -f backbar-repo.zip ] || { echo "No backbar-repo.zip — git pull first"; exit 1; }
unzip -oq backbar-repo.zip -d /tmp/bb
cp -a /tmp/bb/backbar/. "$PWD"
rm -rf /tmp/bb backbar-repo.zip
git add -A
git commit -m "${1:-update}"
git push
echo "Pushed. Cloudflare is building."
