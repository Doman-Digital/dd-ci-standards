#!/usr/bin/env bash
# Install the pinned gitleaks for the policy check, checked on every path.
#
# 8 November 2026: the release download answered 504 three times in one
# morning, the old one-line curl exited 22, the scan then ran into
# `gitleaks: command not found`, and every open pull request in the estate
# went red until someone re-ran it. So, in order:
#
#   1. the release tarball the cache restored (action.yml), if its sha256 is
#      GITLEAKS_SHA256; a tarball that is not is thrown away;
#   2. the release tarball from GitHub releases, retried with exponential
#      backoff, sha256 GITLEAKS_SHA256 (it is then left for the cache to save);
#   3. only if 2 could not be downloaded: the gitleaks project's own image of
#      the same version on ghcr.io, a separate service. The image layer is
#      fetched by its digest, GITLEAKS_IMAGE_LAYER, which is its sha256, and
#      the binary in it must be GITLEAKS_IMAGE_BINARY_SHA256. The image's
#      binary is a different build of the same tag, so it has its own pin.
#
# A checksum that does not match is never an outage: it stops here and the
# next source is not tried. Both sources down fails with an error that names
# the outage and both URLs, and the scan step does not run.
#
# Inputs (environment): GITLEAKS_VERSION, GITLEAKS_SHA256, GITLEAKS_IMAGE (which
# must be ghcr.io/<path>:v<GITLEAKS_VERSION>, so a bump that misses it stops here), GITLEAKS_IMAGE_LAYER,
# GITLEAKS_IMAGE_BINARY_SHA256, GITLEAKS_CACHE_DIR, GITLEAKS_DEST. The sources
# and the retry count can be pointed elsewhere for tests: GITLEAKS_RELEASE_BASE,
# GITLEAKS_REGISTRY, GITLEAKS_RETRIES. Writes source=cache|release|ghcr to
# GITHUB_OUTPUT and the binary's directory to GITHUB_PATH.
set -euo pipefail

: "${GITLEAKS_VERSION:?}" "${GITLEAKS_SHA256:?}" "${GITLEAKS_IMAGE:?}" "${GITLEAKS_IMAGE_LAYER:?}" "${GITLEAKS_IMAGE_BINARY_SHA256:?}"
: "${GITLEAKS_CACHE_DIR:?}" "${GITLEAKS_DEST:?}"
release_base="${GITLEAKS_RELEASE_BASE:-https://github.com/gitleaks/gitleaks/releases/download}"
registry="${GITLEAKS_REGISTRY:-https://ghcr.io}"
retries="${GITLEAKS_RETRIES:-6}"
case "$GITLEAKS_IMAGE" in
  "ghcr.io/"*":v${GITLEAKS_VERSION}") image="${GITLEAKS_IMAGE#ghcr.io/}"; image="${image%:*}" ;;
  *) echo "::error title=gitleaks pins disagree::GITLEAKS_IMAGE is ${GITLEAKS_IMAGE}, not the ghcr.io image of v${GITLEAKS_VERSION}. Bump the image, its layer and its binary pins with the version."; exit 1 ;;
esac
tarball="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
release_url="${release_base}/v${GITLEAKS_VERSION}/${tarball}"
image_url="${registry}/v2/${image}/blobs/${GITLEAKS_IMAGE_LAYER}"
cached="${GITLEAKS_CACHE_DIR}/gitleaks.tgz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
# --retry without --retry-delay backs off 1, 2, 4, 8, 16, 32 seconds (curl caps the
# whole wait at --retry-max-time). --retry-all-errors retries a 504 too.
fetch() { curl -fsSL --connect-timeout 10 --max-time 90 --retry "$retries" --retry-all-errors --retry-max-time 150 "$@"; }
mismatch() {
  echo "::error title=gitleaks checksum mismatch::$1 has sha256 $2, the pin is $3. Not an outage: the file is not the one pinned, so nothing is installed and no other source is tried."
  exit 1
}
install_binary() {
  mkdir -p "$GITLEAKS_DEST"
  install -m 0755 "$1" "$GITLEAKS_DEST/gitleaks"
  [ -z "${GITHUB_PATH:-}" ] || echo "$GITLEAKS_DEST" >> "$GITHUB_PATH"
  [ -z "${GITHUB_OUTPUT:-}" ] || echo "source=$2" >> "$GITHUB_OUTPUT"
  echo "gitleaks ${GITLEAKS_VERSION} installed from the $2, sha256 checked."
}
from_tarball() {
  tar -xzf "$1" -C "$work" gitleaks
  install_binary "$work/gitleaks" "$2"
}

# 1. The cache.
if [ -f "$cached" ]; then
  got="$(sha256 "$cached")"
  if [ "$got" = "$GITLEAKS_SHA256" ]; then from_tarball "$cached" cache; exit 0; fi
  echo "::warning title=gitleaks cache discarded::the cached tarball has sha256 $got, the pin is ${GITLEAKS_SHA256}. Downloading it again."
  rm -f "$cached"
fi

# 2. GitHub releases.
if fetch -o "$work/gitleaks.tgz" "$release_url" 2> "$work/release.err"; then
  got="$(sha256 "$work/gitleaks.tgz")"
  [ "$got" = "$GITLEAKS_SHA256" ] || mismatch "$release_url" "$got" "$GITLEAKS_SHA256"
  mkdir -p "$GITLEAKS_CACHE_DIR"
  cp "$work/gitleaks.tgz" "$cached"
  from_tarball "$cached" release
  exit 0
fi
release_err="$(tail -n 1 "$work/release.err")"
echo "::warning title=gitleaks release download failed::${release_url}: ${release_err}. Trying the gitleaks image on ${registry}."

# 3. The gitleaks image on ghcr.io, by digest. An anonymous pull token first.
image_err=""
if fetch -o "$work/token.json" "${registry}/token?scope=repository:${image}:pull" 2> "$work/image.err"; then
  token="$(sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p' "$work/token.json")"
  if fetch -H "Authorization: Bearer ${token}" -o "$work/layer.tgz" "$image_url" 2> "$work/image.err"; then
    got="sha256:$(sha256 "$work/layer.tgz")"
    [ "$got" = "$GITLEAKS_IMAGE_LAYER" ] || mismatch "$image_url" "$got" "$GITLEAKS_IMAGE_LAYER"
    tar -xzf "$work/layer.tgz" -C "$work" usr/bin/gitleaks
    got="$(sha256 "$work/usr/bin/gitleaks")"
    [ "$got" = "$GITLEAKS_IMAGE_BINARY_SHA256" ] || mismatch "usr/bin/gitleaks in $image_url" "$got" "$GITLEAKS_IMAGE_BINARY_SHA256"
    install_binary "$work/usr/bin/gitleaks" "ghcr.io image"
    exit 0
  fi
fi
image_err="$(tail -n 1 "$work/image.err")"

echo "::error title=gitleaks download outage::gitleaks ${GITLEAKS_VERSION} could not be downloaded, so this pull request was not scanned for secrets. GitHub releases (${release_url}): ${release_err}. The gitleaks image on ${registry}: ${image_err}. Nothing was cached for this pull request yet. This is an outage upstream, not a finding: re-run the job once github.com/gitleaks/gitleaks/releases answers (githubstatus.com)."
exit 1
