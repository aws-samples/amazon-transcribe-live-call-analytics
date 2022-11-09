#!/usr/bin/env bash

set -eu

CALLER_VC_ENDPOINT='abcdef.voiceconnector.chime.aws'
CALLER_PHONE_NUMBER='+1703AAABBBB'
AGENT_PHONE_NUMBER='+1618CCCDDDD' 

CONCURRENT_COUNT=${1:-3}
SLEEP_BETWEEN_CALLS_IN_SECS=${2:-2}
MAX_CALL_TIME_IN_SECS=${3:-480}
RECORDING_ID=${4:-47}
BASE_PORT=${5:-62000}

ASTERISK_EXTENSIONS_FILE='/etc/asterisk/extensions.conf'
RECORDING_FILE_CALLER="/root/recordings/Auto_Repairs_${RECORDING_ID}_UTC_caller.wav"
[[ -f "$RECORDING_FILE_CALLER" ]] || {
    echo "[ERROR] could not find caller recording file: ${RECORDING_FILE_CALLER}" >&2
    exit 1
}
RECORDING_FILE_AGENT="/var/lib/asterisk/sounds/en/Auto_Repairs_${RECORDING_ID}_UTC_agent.wav"
[[ -f "$RECORDING_FILE_AGENT" ]] || {
    echo "[ERROR] could not find agent recording file: ${RECORDING_FILE_AGENT}" >&2
    exit 1
}

function setup_asterisk() {
    local RECORDING_AGENT_BASENAME=$(basename "$RECORDING_FILE_AGENT")
    local RECORDING_AGENT_EXTENSION="${RECORDING_AGENT_BASENAME##*.}"
    local RECORDING_AGENT_FILENAME="${RECORDING_AGENT_BASENAME%.*}"
    local ASTERISK_RECORDING_FILE_AGENT=$(basename "$RECORDING_AGENT_FILENAME" ".${RECORDING_AGENT_EXTENSION}")
    
    sed -i -E -e '/catch-all/,/from-phone/ s/^( *[^;].*Playback\()[^)]+(.*)/\1'"$ASTERISK_RECORDING_FILE_AGENT"'\2/' \
      "$ASTERISK_EXTENSIONS_FILE"
    
    rasterisk -x "core reload"
}

setup_asterisk

for i in $(seq $CONCURRENT_COUNT)
do
    LISTEN_PORT="$((${BASE_PORT} + ${i}))"
    sleep "$SLEEP_BETWEEN_CALLS_IN_SECS"
    echo "sleep ${MAX_CALL_TIME_IN_SECS}000" | /root/pjproject/pjsip-apps/bin/pjsua-aarch64-unknown-linux-gnu \
        --id "sip:${CALLER_PHONE_NUMBER}@127.0.0.1" \
        --local-port "$LISTEN_PORT" \
        --play-file "$RECORDING_FILE_CALLER" \
        --auto-play \
        --null-audio \
        --no-vad \
        "sip:${AGENT_PHONE_NUMBER}@${CALLER_VC_ENDPOINT}" &
    PIDS[${i}]=$!
done

for pid in ${PIDS[*]}; do
    echo "[INFO] waiting for process id: [$pid]"
    wait $pid
done
