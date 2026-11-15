#!/usr/bin/env bash
# Build the site and publish dist/ to the gh-pages branch (served by GitHub Pages).
#   npm run deploy
set -euo pipefail
cd "$(dirname "$0")/.."
remote="$(git remote get-url origin)"
npm run build
cd dist
touch .nojekyll
rm -rf .git
git init -q -b gh-pages
git add -A
git commit -q -m "Deploy $(git -C .. rev-parse --short HEAD)"
git push -q -f "$remote" gh-pages
rm -rf .git
echo "Deployed. Live in about a minute at https://rohit-v-gore.github.io/flight-simulator-gore/"
