import { Command  } from 'commander';
import { CallSimulator } from './CallSimulator';
import * as fs from 'fs';

new Command()
    .description('Call Analytics Streaming API')
    
    .showHelpAfterError()
    
    .argument('<media-filename>', 'Required: Call recording file name - stereo only')
    .argument('[api-mode]', 'Optional: Transcribe api mode - standard vs. analytics. Defaults to standard')
    .argument('[region]', 'Optional: AWS Region. Default to AWS_REGION or us-east-1')

    .action((mediaFileName: string, apiMode:string, region: string): void => {
        try {
            fs.accessSync(mediaFileName, fs.constants.R_OK);
        } catch (err) {
            console.error('File does not exist or you do not have read permissions');
            console.error(err);
            process.exit(1);
        }
        if (!region) {
            region = 'us-east-1';
            console.info('Region parameter was not provided. Defaulted to us-east-1');
        }
        if (!apiMode) {
            apiMode = 'standard';
        }
        const callsimulator = new CallSimulator(mediaFileName, apiMode, region);
        (async () => {
            await callsimulator.startCall();
            await callsimulator.writeTranscriptEvents();
            await callsimulator.endCall();
        })();

    })
    .parse(process.argv);