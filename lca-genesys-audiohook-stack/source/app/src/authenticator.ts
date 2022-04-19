import { randomBytes } from 'crypto';
import { IncomingMessage } from 'http';
import { Logger } from './types';
import { Session } from './session';
import {
    VerifyResult,
    verifySignature,
    withFailure,
    queryCanonicalizedHeaderField
} from './httpsignature';


const verifyRequestSignature = (request: IncomingMessage, logger?: Logger): Promise<VerifyResult> => {
    return verifySignature({
        headerFields: request.headers,
        requiredComponents: [
            '@request-target',
            '@authority',
            'audiohook-organization-id',
            'audiohook-session-id',
            'audiohook-correlation-id',
            'x-api-key'
        ],
        maxSignatureAge: 10,
        derivedComponentLookup: (name) => {
            if (name === '@request-target') {
                return request.url ?? null;
            }
            return null;
        },
        keyResolver: async (parameters) => {

            logger?.info(`Signature Parameters: ${JSON.stringify(parameters)}`);
            if (!parameters.nonce) {
                return withFailure('PRECONDITION', 'Missing "nonce" signature parameter');
            } else if (parameters.nonce.length < 22) {
                return withFailure('PRECONDITION', 'Provided "nonce" signature parameter is too small');
            }

            // Simulate sporadic API key resolution delay (database lookup due to cache miss)
            if(Math.random() < 0.25) {
                await new Promise(resolve => setTimeout(resolve, 50 + 200*Math.random()));
            }

            //TODO: Replace hard code API key with secrets manager
            if (parameters.keyid === 'SGVsbG8sIEkgYW0gdGhlIEFQSSBrZXkh') {
                return {
                    code: 'GOODKEY',
                    key: Buffer.from('TXlTdXBlclNlY3JldEtleVRlbGxOby0xITJAMyM0JDU=', 'base64')
                };
            } else {
                // Wrong API Key. We use a dummy of the same size as what we'd expect and perform a signature check.
                // The signature check will be reported as failed whether the result "accidentally" matches or not.
                return {
                    code: 'BADKEY',
                    key: randomBytes(32)
                };
            }
        }
    });
};


export const initiateRequestAuthentication = (session: Session, request: IncomingMessage): void => {

    // Add an authenticator that checks that the orgid in the header matches the parameter in the open message.
    session.addAuthenticator(async (session, openParams) => {
        const organizationId = queryCanonicalizedHeaderField(request.headers, 'audiohook-organization-id');
        if(!organizationId) {
            session.logger.warn('No "audiohook-organization-id" header field');
            return 'Missing "audiohook-organization-id" header field';

        } else if(openParams.organizationId !== organizationId) {
            session.logger.warn(`Organization ID mismatch! Header field: ${organizationId}, 'open' message: ${openParams.organizationId}`);
            return 'Mismatch "organizationId" open parameter and "audiohook-organization-id" header field';
        }
        return true;
    });

    //TODO: The hard coded api validation is used only for Dev/testing. To be removed before production
    const apiKey = queryCanonicalizedHeaderField(request.headers, 'x-api-key');
    if (apiKey === '3783cc5c3ef91bc25ccd2e39a7a2b4c8') {

        // Test API key that does not require a signature check
        session.logger.warn('WARNING - This session has "disable signature check" API key!');
        return;
    }

    // Initiate the signature verification asynchronously and attach an authentication handler for it.
    // The authentication handler will then wait until the signature verification has completed 
    // (if it hasn't fulfilled by the time the 'open' message arrives).
    //
    // We have two options on how to signal the failure itself
    //  1) Wait until the open message arrives and then signal the disconnect in its context.
    //  2) Immediately signal as part of the the verification completing (after delay).

    const failureSignalingMode: 'immediate'|'open' = 'immediate';

    // Minimum response delay on signature failure to reduce risk of timing leaks.
    const minFailureDelayMs = 500;

    const startTime = Date.now();
    const resultPromise = (
        verifyRequestSignature(request, session.logger)
            .then(result => {
                session.logger.info(`Signature verification resolved: ${JSON.stringify(result)}`);
                if (result.code === 'VERIFIED') {
                    return result;
                } else {
                    // delay the response to a fixed amount from start of signature verification to reduce timing side channel.
                    const delay = Math.max(0, startTime + minFailureDelayMs - Date.now());
                    return new Promise<VerifyResult>((resolve) => setTimeout(() => resolve(result), delay));
                }
            }).then(result => {
                if ((result.code !== 'VERIFIED') && (failureSignalingMode === 'immediate')) {
                    // IMPORTANT-TODO: Probably too much information included for production use!!!
                    session.disconnect('unauthorized', result.reason ? `${result.code}: ${result.reason}` : result.code);
                }
                return result;
            })
    );

    session.addAuthenticator(async (session) => {

        // Note: In 'immediate' failureSignalingMode mode we might not get here if the open message was after result.

        const result = await resultPromise;
        session.logger.debug(`Authenticator - Signature verification result: ${JSON.stringify(result)}`);
        
        if(result.code !== 'VERIFIED') {
            // IMPORTANT-TODO: Probably too much information included for production use!!!
            return result.reason ? `${result.code}: ${result.reason}` : result.code;
        } else {
            return true;
        }
    });  
};

