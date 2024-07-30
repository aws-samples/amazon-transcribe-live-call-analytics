Talkdesk Websocket Client utility makes it easier to test LCA/Agent Assist using a call recording. Websocket client utility reads call recording in stereo WAV file (PCMU - mulaw) and streams the audio data to the websocket server. 

## How to use
The websocket client can be run from a local command line (such MacOs terminal) or from Cloud9/Cloud Shell command line. 
This command line environmentshould have access to AWS resources. 

To get started, cd to `utilities/talkdesk-client` directory in LCA repo.

1. Setup the package dependencies (first time you run the utility)

    `npm run setup`

2. Build and check for build errors (optional, but recommended whenever you make changes)

    `npm run build`

3.  Update following environment variables (export them or update them in .env file)

    `ACCOUNT_SID=xxxxxxxxxx`

4. Run the websocket client using npm run command 

    `npm run start -- --uri <<Websocket Server Endpoint>>  --wavfile <<wav file name - PCMU>>`

        `Websocket Server Endpoint` - obtain this from the "Outputs" section of LCA cloudformation console.
E.g. 
    `npm run start -- --uri wss://xxxxxxxxxxxxxx.cloudfront.net/api/v1/ws --wavfile data/mulaw.wav`