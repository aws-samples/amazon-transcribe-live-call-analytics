LCA Client utility makes it easier to test Call Event Processors and LCA UI without having to actually make a phone call.
Simulates LCA call events required by Call Event Processor. Uses call recording (stereo file) as input and writes
the events to LCA's KDS (integration layer). Supports both TCA and Standard transcribe modes.

## How to use
The code runs locally from your terminal command line or from cloud shell/cloud9 command line. 
git clone the repo to your local environment.

1. `npm run setup` to setup the package dependencies
2. `npm run build` to build and check for build errors
3.  Update environment variableS `KINESIS_STREAM_NAME` with LCA's KDS stream name and `SAVE_PARTIAL_TRANSCRIPTS` to either true or false

    `export KINESIS_STREAM_NAME=XXXXXXXXXXXXXXXXXXXXXXXXXX`

    `export SAVE_PARTIAL_TRANSCRIPTS=true`

4. `npm run exec <mediaFileName> [api-mode] [Region]`

    where `api-mode` - standard or analytics

    e.g. `npm run exec data/sample90seconds.wav standard us-east-1`

Sample audio files are provided in `data/` directory.