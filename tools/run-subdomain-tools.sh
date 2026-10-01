#!/bin/bash
set -euo pipefail

ENGAGEMENT_CODE="${ENGAGEMENT_CODE:-nasa-vdp}"
TARGET_DOMAINS="${TARGET_DOMAINS:-${TARGET_DOMAIN:-nasa.gov}}"
OUTPUT_DIR="${OUTPUT_DIR:-/app/subdomains/$ENGAGEMENT_CODE}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TMP_DIR="$OUTPUT_DIR/.tmp_$TIMESTAMP"
FINAL_FILE="$OUTPUT_DIR/subdomains_$TIMESTAMP.txt"
LATEST_DIR="$OUTPUT_DIR/latest"

mkdir -p "$OUTPUT_DIR" "$TMP_DIR" "$LATEST_DIR"

for TARGET_DOMAIN in $TARGET_DOMAINS; do
    SAFE_DOMAIN=$(printf '%s' "$TARGET_DOMAIN" | sed 's/[^[:alnum:]._-]/_/g')
    echo "[+] Scanning $TARGET_DOMAIN at $(date)"

    subfinder -d "$TARGET_DOMAIN" -all -silent -o "$TMP_DIR/${SAFE_DOMAIN}-subfinder.txt" 2>/dev/null || true
    assetfinder --subs-only "$TARGET_DOMAIN" > "$TMP_DIR/${SAFE_DOMAIN}-assetfinder.txt" 2>/dev/null || true
    findomain -t "$TARGET_DOMAIN" -q > "$TMP_DIR/${SAFE_DOMAIN}-findomain.txt" 2>/dev/null || true
    amass enum -passive -d "$TARGET_DOMAIN" -oA "$TMP_DIR/${SAFE_DOMAIN}-amass" 2>/dev/null || true
    sublist3r -d "$TARGET_DOMAIN" -o "$TMP_DIR/${SAFE_DOMAIN}-sublist3r.txt" 2>/dev/null || true

    echo "[i] Querying crt.sh for $TARGET_DOMAIN"
    curl --connect-timeout 10 --max-time 30 -fsS "https://crt.sh/?q=%25.${TARGET_DOMAIN}&output=json" 2>/dev/null |
        jq -r '.[].name_value' 2>/dev/null |
        sed 's/^\*\.//g' > "$TMP_DIR/${SAFE_DOMAIN}-crtsh.txt" || true

    if [ -n "${C99_API_KEY:-}" ]; then
        echo "[i] Querying C99 for $TARGET_DOMAIN"
        curl --connect-timeout 10 --max-time 30 -fsS "https://api.c99.nl/subdomainfinder?key=$C99_API_KEY&domain=$TARGET_DOMAIN&json" 2>/dev/null |
            jq -r '.subdomains[]?' 2>/dev/null > "$TMP_DIR/${SAFE_DOMAIN}-c99.txt" || true
    fi
done

: > "$TMP_DIR/all-subdomains.txt"
for TARGET_DOMAIN in $TARGET_DOMAINS; do
    while IFS= read -r candidate; do
        candidate=$(printf '%s' "$candidate" | sed -E 's#^https?://##I; s#/.*$##; s/:[0-9]+$//; s/^\*\.//')
        candidate=$(printf '%s' "$candidate" | tr '[:upper:]' '[:lower:]')
        case "$candidate" in
            "$TARGET_DOMAIN"|*."$TARGET_DOMAIN") printf '%s\n' "$candidate" >> "$TMP_DIR/all-subdomains.txt" ;;
        esac
    done < <(cat "$TMP_DIR"/*.txt 2>/dev/null | sort -u)
done

sort -u "$TMP_DIR/all-subdomains.txt" > "$TMP_DIR/candidates.txt"
if [ -s "$TMP_DIR/candidates.txt" ]; then
    CANDIDATE_COUNT=$(wc -l < "$TMP_DIR/candidates.txt" | tr -d ' ')
    echo "[i] Probing $CANDIDATE_COUNT discovered candidates with httpx"
    httpx -l "$TMP_DIR/candidates.txt" -silent -no-color -timeout 10 -retries 1 > "$TMP_DIR/live-urls.txt"
else
    echo "[i] No in-scope candidates to probe with httpx"
    : > "$TMP_DIR/live-urls.txt"
fi

: > "$TMP_DIR/live-hosts.txt"
while IFS= read -r live_url; do
    live_host=$(printf '%s' "$live_url" | sed -E 's#^https?://##I; s#/.*$##; s/:[0-9]+$//')
    live_host=$(printf '%s' "$live_host" | tr '[:upper:]' '[:lower:]')
    for TARGET_DOMAIN in $TARGET_DOMAINS; do
        case "$live_host" in
            "$TARGET_DOMAIN"|*."$TARGET_DOMAIN") printf '%s\n' "$live_host" >> "$TMP_DIR/live-hosts.txt" ;;
        esac
    done
done < "$TMP_DIR/live-urls.txt"

sort -u "$TMP_DIR/live-hosts.txt" > "$FINAL_FILE"
cp "$FINAL_FILE" "$LATEST_DIR/subdomains.txt.tmp"
mv "$LATEST_DIR/subdomains.txt.tmp" "$LATEST_DIR/subdomains.txt"

COUNT=$(wc -l < "$FINAL_FILE" | tr -d ' ')
echo "[+] Found $COUNT subdomains -> $FINAL_FILE"
echo "[+] Latest subdomain inventory -> $LATEST_DIR/subdomains.txt"

rm -rf "$TMP_DIR"
