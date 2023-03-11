#!/usr/bin/env bash

set -eu

# set configuration variables
. ./common.sh

RECORDINGS_DIR=`pwd`/recordings
RECORDING_FILE_CALLER="${RECORDINGS_DIR}/AutoRepairs-2hr-calleraudio-1ch.wav"
[[ -f "$RECORDING_FILE_CALLER" ]] || {
    echo "[ERROR] could not find caller recording file: ${RECORDING_FILE_CALLER}" >&2
    exit 1
}
RECORDING_FILE_AGENT="${RECORDINGS_DIR}/AutoRepairs-2hr-calleraudio-1ch.wav"
[[ -f "$RECORDING_FILE_AGENT" ]] || {
    echo "[ERROR] could not find agent recording file: ${RECORDING_FILE_AGENT}" >&2
    exit 1
}

# configure audio file in Asterisk
setup_asterisk $RECORDING_FILE_AGENT

LISTEN_PORT="60002"
/root/pjproject/pjsip-apps/bin/pjsua-*-unknown-linux-gnu \
    --id "sip:${CALLER_PHONE_NUMBER}@127.0.0.1" \
    --local-port "$LISTEN_PORT" \
    --play-file "$RECORDING_FILE_CALLER" \
    --auto-play \
    --null-audio \
    --no-vad \
    "sip:${AGENT_PHONE_NUMBER}@${CALLER_VC_ENDPOINT}"

