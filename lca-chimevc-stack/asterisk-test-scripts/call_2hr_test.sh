#!/usr/bin/env bash

set -eu

CALLER_VC_ENDPOINT='abcdef.voiceconnector.chime.aws'
CALLER_PHONE_NUMBER='+1571AAABBBB'
AGENT_PHONE_NUMBER='+1618CCCDDDD'

RECORDING_FILE_CALLER="/root/recordings/AutoRepairs-2hr-calleraudio-1ch.wav"
[[ -f "$RECORDING_FILE_CALLER" ]] || {
    echo "[ERROR] could not find caller recording file: ${RECORDING_FILE_CALLER}" >&2
    exit 1
}
RECORDING_FILE_AGENT="/var/lib/asterisk/sounds/en/AutoRepairs-2hr-calleraudio-1ch.wav"
[[ -f "$RECORDING_FILE_AGENT" ]] || {
    echo "[ERROR] could not find agent recording file: ${RECORDING_FILE_AGENT}" >&2
    exit 1
}

LISTEN_PORT="60002"


RECORDING_AGENT_BASENAME=$(basename "$RECORDING_FILE_AGENT")
RECORDING_AGENT_EXTENSION="${RECORDING_AGENT_BASENAME##*.}"
RECORDING_AGENT_FILENAME="${RECORDING_AGENT_BASENAME%.*}"
ASTERISK_RECORDING_FILE_AGENT=$(basename "$RECORDING_AGENT_FILENAME" ".${RECORDING_AGENT_EXTENSION}")
ASTERISK_EXTENSIONS_FILE='/etc/asterisk/extensions.conf'

sed -i -E -e '/catch-all/,/from-phone/ s/^( *[^;].*Playback\()[^)]+(.*)/\1'"$ASTERISK_RECORDING_FILE_AGENT"'\2/' \
  "$ASTERISK_EXTENSIONS_FILE"

rasterisk -x "core reload"

/root/pjproject/pjsip-apps/bin/pjsua-aarch64-unknown-linux-gnu \
    --id "sip:${CALLER_PHONE_NUMBER}@127.0.0.1" \
    --local-port "$LISTEN_PORT" \
    --play-file "$RECORDING_FILE_CALLER" \
    --auto-play \
    --null-audio \
    --no-vad \
    "sip:${AGENT_PHONE_NUMBER}@${CALLER_VC_ENDPOINT}"

