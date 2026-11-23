#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Builds Commit's release files and the automatic update for them.
#
# Commit checks
#   github.com/EthanCave/commit-browser/releases/latest/download/update-<target>.xml
# (compiled in by src/build/moz-build.patch), so publishing a GitHub release
# with these files is what ships an update. Drafts are invisible to it.
#
#   scripts/commit-release.sh keygen     once: make the update signing key
#   scripts/commit-release.sh certs      put its public half in the updater
#                                        (then rebuild: cd engine && ./mach build)
#   scripts/commit-release.sh package    DMG + signed MAR + update XML in
#                                        dist/release-<version>/
#   scripts/commit-release.sh draft <notes.md>   a draft GitHub release with them
#
# The private key lives in ~/.commit-signing (override with
# COMMIT_SIGNING_DIR). Back it up: without it, installed copies of Commit
# can't be updated automatically any more.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENGINE="$ROOT/engine"
OBJ="$ENGINE/obj-aarch64-apple-darwin"
KEYS="${COMMIT_SIGNING_DIR:-$HOME/.commit-signing}"
NSS_DB="$KEYS/nss"
CERT_NAME="commit-mar"
PUBLIC_KEY="$ROOT/build/signing/public_key.der"
UPDATER_SRC="$ENGINE/toolkit/mozapps/update/updater"
UPDATER_CERTS=(release_primary release_secondary dep1 dep2 xpcshellCertificate)

REPO="EthanCave/commit-browser"
BRANCH="git-layer"
TARGET="Darwin_aarch64-gcc3"
MAR_CHANNEL_ID="commit"
# Where the MAR is downloaded from. Tests point this at a local server.
DOWNLOAD_BASE="${COMMIT_UPDATE_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download}"

VERSION=$(cat "$ENGINE/browser/config/version.txt")
OUT="$ROOT/dist/release-$VERSION"
DMG="$OUT/Commit-$VERSION.dmg"
MAR="$OUT/Commit-$VERSION-macos-arm64.mar"
UPDATE_XML="$OUT/update-$TARGET.xml"

die() {
  echo "error: $*" >&2
  exit 1
}

keygen() {
  [ -e "$KEYS" ] && die "$KEYS already exists; refusing to replace the signing key"
  mkdir -m 700 "$KEYS"
  openssl genrsa -out "$KEYS/mar-key.pem" 4096 2>/dev/null
  openssl req -new -x509 -key "$KEYS/mar-key.pem" -out "$KEYS/mar-cert.pem" \
    -subj "/CN=Commit Update Signing" -days 36500
  chmod 600 "$KEYS"/*.pem

  # signmar reads keys from an NSS database.
  mkdir -m 700 "$NSS_DB"
  certutil -N -d "$NSS_DB" --empty-password
  openssl pkcs12 -export -inkey "$KEYS/mar-key.pem" -in "$KEYS/mar-cert.pem" \
    -name "$CERT_NAME" -passout pass: -out "$KEYS/mar.p12"
  pk12util -i "$KEYS/mar.p12" -d "$NSS_DB" -W "" -K "" >/dev/null
  rm -f "$KEYS/mar.p12"
  chmod 600 "$NSS_DB"/*

  openssl x509 -in "$KEYS/mar-cert.pem" -outform DER -out "$PUBLIC_KEY"
  echo "Signing key: $KEYS (back this folder up somewhere safe)"
  echo "Public key:  $PUBLIC_KEY (commit this)"
}

certs() {
  [ -f "$PUBLIC_KEY" ] || die "no $PUBLIC_KEY; run keygen first"
  local changed=0
  for name in "${UPDATER_CERTS[@]}"; do
    if ! cmp -s "$PUBLIC_KEY" "$UPDATER_SRC/$name.der"; then
      cp "$PUBLIC_KEY" "$UPDATER_SRC/$name.der"
      changed=1
    fi
  done
  if [ "$changed" = 1 ]; then
    echo "Updater now trusts Commit's key. Rebuild: cd engine && ./mach build"
  else
    echo "Updater already trusts Commit's key."
  fi
}

# The updater compiles the trusted certificate in as bytes; make sure the one
# being shipped has ours, or this version could never update itself again.
check_updater_trusts_key() {
  local updater="$1/Contents/MacOS/updater.app/Contents/MacOS/org.mozilla.updater"
  [ -f "$updater" ] || die "no updater in $1"
  python3 - "$PUBLIC_KEY" "$updater" <<'PY' || die "the built updater doesn't trust Commit's key (run certs, then rebuild)"
import sys
key, binary = (open(p, "rb").read() for p in sys.argv[1:3])
sys.exit(0 if key in binary else 1)
PY
}

ini_value() {
  # ini_value <file> <key>
  sed -n "s/^$2=//p" "$1" | head -1
}

package() {
  [ -d "$NSS_DB" ] || die "no signing key in $KEYS (run keygen)"
  local app="$OBJ/dist/zen/Commit.app"
  echo "== Packaging Commit $VERSION"
  (cd "$ENGINE" && ./mach package >/dev/null)
  local built_version
  built_version=$(ini_value "$app/Contents/Resources/application.ini" Version)
  [ "$built_version" = "$VERSION" ] || die "the build is $built_version, not $VERSION (rebuild first)"
  check_updater_trusts_key "$app"

  rm -rf "${OUT:?}"
  mkdir -p "$OUT/stage" "$OUT/dmg"
  # The bundle signature is broken by packaging; sign it ad hoc again. The MAR
  # is made from this signed copy, so updated installs keep a valid signature.
  ditto "$app" "$OUT/stage/Commit.app"
  xattr -cr "$OUT/stage/Commit.app"
  codesign --force --deep --sign - "$OUT/stage/Commit.app" 2>/dev/null
  codesign --verify --deep --strict "$OUT/stage/Commit.app"

  echo "== Disk image"
  ditto "$OUT/stage/Commit.app" "$OUT/dmg/Commit.app"
  ln -s /Applications "$OUT/dmg/Applications"
  hdiutil create -quiet -volname Commit -srcfolder "$OUT/dmg" -format UDZO -ov "$DMG"
  rm -rf "${OUT:?}/dmg"

  echo "== Update (MAR)"
  MAR="$OBJ/dist/host/bin/mar" MOZ_PRODUCT_VERSION="$VERSION" MAR_CHANNEL_ID="$MAR_CHANNEL_ID" \
    bash "$ENGINE/tools/update-packaging/make_full_update.sh" -q "$OUT/unsigned.mar" "$OUT/stage/Commit.app" >/dev/null
  "$OBJ/dist/bin/signmar" -d "$NSS_DB" -n "$CERT_NAME" -s "$OUT/unsigned.mar" "$MAR"
  rm -f "$OUT/unsigned.mar"
  "$OBJ/dist/bin/signmar" -D "$PUBLIC_KEY" -v "$MAR" || die "the MAR's signature didn't verify"

  local build_id platform size hash
  build_id=$(ini_value "$OUT/stage/Commit.app/Contents/Resources/application.ini" BuildID)
  platform=$(ini_value "$OUT/stage/Commit.app/Contents/Resources/platform.ini" Milestone)
  size=$(stat -f %z "$MAR")
  hash=$(shasum -a 512 "$MAR" | cut -d' ' -f1)
  cat >"$UPDATE_XML" <<XML
<?xml version="1.0"?>
<updates>
  <update type="minor" displayVersion="$VERSION" appVersion="$VERSION" platformVersion="$platform" buildID="$build_id" detailsURL="https://github.com/$REPO/releases/tag/v$VERSION">
    <patch type="complete" URL="$DOWNLOAD_BASE/v$VERSION/$(basename "$MAR")" hashFunction="sha512" hashValue="$hash" size="$size"/>
  </update>
</updates>
XML

  echo
  ls -lh "$DMG" "$MAR" "$UPDATE_XML" | awk '{print $5, $NF}'
  echo "Next: scripts/commit-release.sh draft <notes.md>"
}

draft() {
  local notes="${1:-}"
  [ -f "$notes" ] || die "usage: $0 draft <release-notes.md>"
  for f in "$DMG" "$MAR" "$UPDATE_XML"; do
    [ -f "$f" ] || die "missing $f (run package)"
  done
  gh release create "v$VERSION" --repo "$REPO" --target "$BRANCH" --draft \
    --title "Commit $VERSION" --notes-file "$notes" "$DMG" "$MAR" "$UPDATE_XML"
  echo "Draft created. Publishing it ships the update to every Commit that checks."
}

case "${1:-}" in
  keygen) keygen ;;
  certs) certs ;;
  package) package ;;
  draft) draft "${2:-}" ;;
  *)
    sed -n '/^# Builds/,/^# COMMIT_SIGNING_DIR/p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
