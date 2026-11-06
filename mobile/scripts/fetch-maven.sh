#!/usr/bin/env bash
# Resumable download of large Maven artifacts into ~/.m2 (mavenLocal) for slow/unstable connections.
# Gradle can't resume a broken download and fails with "Read timed out"; curl -C - can.
#
# Usage: bash mobile/scripts/fetch-maven.sh com.facebook.react react-android 0.88.1 release
#        bash mobile/scripts/fetch-maven.sh org.jetbrains.kotlin kotlin-compiler-embeddable 2.2.10 "" jar
# Then build with mavenLocal() first in android/build.gradle (build-apk.sh does that).
set -uo pipefail

GROUP="$1"; ARTIFACT="$2"; VERSION="$3"; CLASSIFIER="${4:-}"; EXT="${5:-aar}"
REPO="https://repo.maven.apache.org/maven2"
GPATH="${GROUP//.//}/$ARTIFACT/$VERSION"
DEST="$HOME/.m2/repository/$GPATH"
mkdir -p "$DEST"

fetch() { # resume until curl succeeds
  local file="$1"
  until curl -fL -C - --retry 20 --retry-all-errors --retry-delay 5 --connect-timeout 30 \
             --speed-limit 1 --speed-time 120 -o "$DEST/$file" "$REPO/$GPATH/$file"; do
    echo "$(date +%H:%M:%S) $file interrupted at $(stat -c%s "$DEST/$file" 2>/dev/null || echo 0) bytes — resuming in 10s"
    sleep 10
  done
  echo "$(date +%H:%M:%S) $file done ($(stat -c%s "$DEST/$file") bytes)"
}

fetch "$ARTIFACT-$VERSION.pom"
# Gradle module metadata is optional (not every artifact publishes it) — one attempt, no retry loop.
curl -fsL --retry 5 --retry-all-errors -o "$DEST/$ARTIFACT-$VERSION.module" "$REPO/$GPATH/$ARTIFACT-$VERSION.module" \
  || { rm -f "$DEST/$ARTIFACT-$VERSION.module"; echo "no .module for $ARTIFACT (ok)"; }
fetch "$ARTIFACT-$VERSION${CLASSIFIER:+-$CLASSIFIER}.$EXT"

# Verify against the published SHA-1.
want=$(curl -fsL --retry 20 --retry-all-errors "$REPO/$GPATH/$ARTIFACT-$VERSION${CLASSIFIER:+-$CLASSIFIER}.$EXT.sha1" | cut -c1-40)
have=$(sha1sum "$DEST/$ARTIFACT-$VERSION${CLASSIFIER:+-$CLASSIFIER}.$EXT" | cut -c1-40)
if [[ "$want" == "$have" ]]; then echo "SHA-1 OK ($have)"; else echo "SHA-1 MISMATCH want=$want have=$have"; exit 1; fi
