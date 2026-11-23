#!/usr/bin/env bash
# Erzeugt die Symbole der Konfigurations-UI aus dem App-Symbol des UI-Layers. Die Ergebnisse sind
# eingecheckt; nur nach einer Änderung des SVG neu ausführen (braucht rsvg-convert und ImageMagick 7,
# `cargo tauri icon` ist nicht nötig).
#   windows/pds-config/icons/generate.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
svg="$here/../../../packages/ui/app/assets/siemens/pds.svg"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

png() { rsvg-convert --width "$1" --height "$1" --output "$2" "$svg"; }

png 32 "$here/32x32.png"
png 128 "$here/128x128.png"
png 256 "$here/128x128@2x.png"
png 512 "$here/icon.png"

# Windows: EXE-Ressource und Fenstersymbol; jede Größe einzeln gerendert statt herunterskaliert
frames=()
for size in 16 20 24 32 40 48 64; do
  png "$size" "$work/$size.png"
  frames+=("$work/$size.png")
done
magick "${frames[@]}" "$work/small.ico"
png 256 "$work/256.png"

# 256 px als PNG wie in Windows-Symbolen üblich (ImageMagick schreibt BMP, ~270 KB), dahinter
# die kleinen Stufen als BMP
python3 - "$work/small.ico" "$work/256.png" "$here/icon.ico" <<'EOF'
import struct, sys
small, large, out = sys.argv[1:]
data = open(small, "rb").read()
count = struct.unpack_from("<H", data, 4)[0]
entries = [struct.unpack_from("<BBBBHHII", data, 6 + 16 * i) for i in range(count)]
images = [data[entry[7]:entry[7] + entry[6]] for entry in entries]
entries.append((0, 0, 0, 0, 1, 32, 0, 0))
images.append(open(large, "rb").read())
offset = 6 + 16 * len(entries)
table = b""
for entry, image in zip(entries, images):
    table += struct.pack("<BBBBHHII", *entry[:6], len(image), offset)
    offset += len(image)
open(out, "wb").write(struct.pack("<HHH", 0, 1, len(entries)) + table + b"".join(images))
EOF
