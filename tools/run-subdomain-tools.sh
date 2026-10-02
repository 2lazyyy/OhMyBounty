#!/bin/bash
set -euo pipefail

ENGAGEMENT_CODE="${ENGAGEMENT_CODE:-nasa-vdp}"
TARGET_DOMAINS="${TARGET_DOMAINS:-${TARGET_DOMAIN:-nasa.gov}}"
OUTPUT_DIR="${OUTPUT_DIR:-/app/subdomains/$ENGAGEMENT_CODE}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TMP_DIR="$OUTPUT_DIR/.tmp_$TIMESTAMP"
FINAL_FILE="$OUTPUT_DIR/subdomains_$TIMESTAMP.txt"
LATEST_DIR="$OUTPUT_DIR/latest"
STOP_ENUMERATION=false

mkdir -p "$OUTPUT_DIR" "$TMP_DIR" "$LATEST_DIR"

run_tool() {
    local tool_name="$1"
    local stdout_file="$2"
    local stop_on_timeout="$3"
    local stderr_file="$TMP_DIR/${SAFE_DOMAIN}-${tool_name}.stderr.log"
    local status=0
    shift 3

    echo "[+] Running $tool_name for $TARGET_DOMAIN (20-minute limit)"
    if timeout --signal=TERM --kill-after=30s 20m "$@" > "$stdout_file" 2> "$stderr_file"; then
        echo "[+] $tool_name completed for $TARGET_DOMAIN"
        return 0
    else
        status=$?
    fi

    if [[ "$status" -eq 124 || "$status" -eq 137 || "$status" -eq 143 ]]; then
        if [[ "$stop_on_timeout" == "true" ]]; then
            echo "[!] $tool_name timed out after 20 minutes; stopping remaining enumeration"
            STOP_ENUMERATION=true
        else
            echo "[!] $tool_name timed out after 20 minutes; moving to the next tool"
        fi
    else
        echo "[!] $tool_name failed with exit code $status; moving to the next tool"
    fi
    return 0
}

LAST_TARGET_DOMAIN=""
for domain in $TARGET_DOMAINS; do
    LAST_TARGET_DOMAIN="$domain"
done
FINAL_TOOL="crt.sh"
if [ -n "${C99_API_KEY:-}" ]; then
    FINAL_TOOL="c99"
fi

for TARGET_DOMAIN in $TARGET_DOMAINS; do
    SAFE_DOMAIN=$(printf '%s' "$TARGET_DOMAIN" | sed 's/[^[:alnum:]._-]/_/g')
    echo "[+] Scanning $TARGET_DOMAIN at $(date)"

    FINAL_TIMEOUT=false
    if [[ "$TARGET_DOMAIN" == "$LAST_TARGET_DOMAIN" && "$FINAL_TOOL" == "subfinder" ]]; then FINAL_TIMEOUT=true; fi
    run_tool "subfinder" /dev/null "$FINAL_TIMEOUT" subfinder -d "$TARGET_DOMAIN" -all -silent -o "$TMP_DIR/${SAFE_DOMAIN}-subfinder.txt"
    if [[ "$STOP_ENUMERATION" == "true" ]]; then break; fi

    if [[ "$TARGET_DOMAIN" == "$LAST_TARGET_DOMAIN" && "$FINAL_TOOL" == "assetfinder" ]]; then FINAL_TIMEOUT=true; else FINAL_TIMEOUT=false; fi
    run_tool "assetfinder" "$TMP_DIR/${SAFE_DOMAIN}-assetfinder.txt" "$FINAL_TIMEOUT" assetfinder --subs-only "$TARGET_DOMAIN"
    if [[ "$STOP_ENUMERATION" == "true" ]]; then break; fi

    if [[ "$TARGET_DOMAIN" == "$LAST_TARGET_DOMAIN" && "$FINAL_TOOL" == "findomain" ]]; then FINAL_TIMEOUT=true; else FINAL_TIMEOUT=false; fi
    run_tool "findomain" "$TMP_DIR/${SAFE_DOMAIN}-findomain.txt" "$FINAL_TIMEOUT" findomain -t "$TARGET_DOMAIN" -q
    if [[ "$STOP_ENUMERATION" == "true" ]]; then break; fi

    if [[ "$TARGET_DOMAIN" == "$LAST_TARGET_DOMAIN" && "$FINAL_TOOL" == "sublist3r" ]]; then FINAL_TIMEOUT=true; else FINAL_TIMEOUT=false; fi
    run_tool "sublist3r" /dev/null "$FINAL_TIMEOUT" sublist3r -d "$TARGET_DOMAIN" -o "$TMP_DIR/${SAFE_DOMAIN}-sublist3r.txt"
    if [[ "$STOP_ENUMERATION" == "true" ]]; then break; fi

    echo "[i] Querying crt.sh for $TARGET_DOMAIN"
    if [[ "$TARGET_DOMAIN" == "$LAST_TARGET_DOMAIN" && "$FINAL_TOOL" == "crt.sh" ]]; then FINAL_TIMEOUT=true; else FINAL_TIMEOUT=false; fi
    run_tool "crt.sh" "$TMP_DIR/${SAFE_DOMAIN}-crtsh.json" "$FINAL_TIMEOUT" curl --connect-timeout 10 --max-time 30 -fsS "https://crt.sh/?q=%25.${TARGET_DOMAIN}&output=json"
    jq --stream -r 'select(length == 2 and .[0][-1] == "name_value") | .[1]' "$TMP_DIR/${SAFE_DOMAIN}-crtsh.json" 2>/dev/null | sed 's/^\*\.//g' > "$TMP_DIR/${SAFE_DOMAIN}-crtsh.txt" || true
    if [[ "$STOP_ENUMERATION" == "true" ]]; then break; fi

    if [ -n "${C99_API_KEY:-}" ]; then
        echo "[i] Querying C99 for $TARGET_DOMAIN"
        FINAL_TIMEOUT=false
        if [[ "$TARGET_DOMAIN" == "$LAST_TARGET_DOMAIN" ]]; then FINAL_TIMEOUT=true; fi
        run_tool "c99" "$TMP_DIR/${SAFE_DOMAIN}-c99.json" "$FINAL_TIMEOUT" curl --connect-timeout 10 --max-time 30 -fsS "https://api.c99.nl/subdomainfinder?key=$C99_API_KEY&domain=$TARGET_DOMAIN&json"
        jq --stream -r 'select(length == 2 and .[0][0] == "subdomains") | .[1]' "$TMP_DIR/${SAFE_DOMAIN}-c99.json" 2>/dev/null > "$TMP_DIR/${SAFE_DOMAIN}-c99.txt" || true
        if [[ "$STOP_ENUMERATION" == "true" ]]; then break; fi
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

sort -u "$TMP_DIR/all-subdomains.txt" > "$FINAL_FILE"
cp "$FINAL_FILE" "$LATEST_DIR/subdomains.txt.tmp"
mv "$LATEST_DIR/subdomains.txt.tmp" "$LATEST_DIR/subdomains.txt"

COUNT=$(wc -l < "$FINAL_FILE" | tr -d ' ')
echo "[+] Discovered $COUNT in-scope subdomains -> $FINAL_FILE"
echo "[+] Latest subdomain inventory -> $LATEST_DIR/subdomains.txt"

rm -rf "$TMP_DIR"
