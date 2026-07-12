#!/bin/bash
set -e

ENGAGEMENT_CODE="${ENGAGEMENT_CODE:-nasa-vdp}"
TARGET_DOMAIN="${TARGET_DOMAIN:-nasa.gov}"
OUTPUT_DIR="${OUTPUT_DIR:-/app/subdomains/$ENGAGEMENT_CODE}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TMP_DIR="$OUTPUT_DIR/.tmp_$TIMESTAMP"
FINAL_FILE="$OUTPUT_DIR/subdomains_$TIMESTAMP.txt"

mkdir -p "$OUTPUT_DIR" "$TMP_DIR"

echo "[+] Scanning $TARGET_DOMAIN at $(date)"

subfinder -d "$TARGET_DOMAIN" -all -silent -o "$TMP_DIR/subfinder.txt" 2>/dev/null || true

sublist3r -d "$TARGET_DOMAIN" -o "$TMP_DIR/sublist3r_raw.txt" 2>/dev/null || true
if [ -f "$TMP_DIR/sublist3r_raw.txt" ]; then
    grep -oE "[a-zA-Z0-9.-]+\.${TARGET_DOMAIN}" "$TMP_DIR/sublist3r_raw.txt" 2>/dev/null | sort -u > "$TMP_DIR/sublist3r.txt" || true
fi

amass enum -passive -d "$TARGET_DOMAIN" -o "$TMP_DIR/amass.txt" 2>/dev/null || true

curl -s "https://crt.sh/?q=%.${TARGET_DOMAIN}&output=json" 2>/dev/null | \
    jq -r '.[].name_value' 2>/dev/null | \
    sed 's/^\*\.//g' | \
    sort -u > "$TMP_DIR/crtsh.txt" || true

if [ -n "$C99_API_KEY" ]; then
    curl -s "https://api.c99.nl/subdomainfinder?key=$C99_API_KEY&domain=$TARGET_DOMAIN&json" 2>/dev/null | \
        jq -r '.subdomains[]?' 2>/dev/null | \
        sort -u > "$TMP_DIR/c99.txt" || true
else
    echo "[i] Skipping c99.nl (no C99_API_KEY)"
fi

cat "$TMP_DIR"/*.txt 2>/dev/null | \
    grep -E '^[a-zA-Z0-9]' | \
    sed 's/^https\?:\/\///g' | \
    sed 's/\/.*$//g' | \
    tr '[:upper:]' '[:lower:]' | \
    sort -u | \
    grep -E "\.${TARGET_DOMAIN}$|^${TARGET_DOMAIN}$" > "$FINAL_FILE"

COUNT=$(wc -l < "$FINAL_FILE" | tr -d ' ')
echo "[+] Found $COUNT subdomains -> $FINAL_FILE"

rm -rf "$TMP_DIR"
