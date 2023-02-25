CALLER_VC_ENDPOINT='abcdef.voiceconnector.chime.aws'
CALLER_PHONE_NUMBER='+1571AAABBBB'
AGENT_PHONE_NUMBER='+1618CCCDDDD'


function setup_asterisk() {
  local ASTERISK_EXTENSIONS_FILE='/etc/asterisk/extensions.conf'
  if [ -f $ASTERISK_EXTENSIONS_FILE ]; then
    echo "Configure Asterisk"
    local ASTERISK_RECORDING_DIR='/var/lib/asterisk/sounds/en/'
    local RECORDING_AGENT_BASENAME=$(basename "$1")
    local RECORDING_AGENT_EXTENSION="${RECORDING_AGENT_BASENAME##*.}"
    local RECORDING_AGENT_FILENAME="${RECORDING_AGENT_BASENAME%.*}"
    local ASTERISK_RECORDING_FILE_AGENT=$(basename "$RECORDING_AGENT_FILENAME" ".${RECORDING_AGENT_EXTENSION}")

    # copy agent recording to asterisk dir
    echo "cp -f $RECORDING_FILE_AGENT $ASTERISK_RECORDING_DIR/$RECORDING_AGENT_BASENAME"
    cp -f $RECORDING_FILE_AGENT $ASTERISK_RECORDING_DIR/$RECORDING_AGENT_BASENAME

    sed -i -E -e '/catch-all/,/from-phone/ s/^( *[^;].*Playback\()[^)]+(.*)/\1'"$ASTERISK_RECORDING_FILE_AGENT"'\2/' \
      "$ASTERISK_EXTENSIONS_FILE"
    
    rasterisk -x "core reload"
  else
    echo "Asterisk not installed locally. Skipping."
  fi
}
