import { VerifyResult, verifySignature } from '../signature-verifier';

describe('Verify RFC test vectors', () => {

    test('hmac-sha256', async () => {

        // https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-message-signatures-08#appendix-B.1.4
        const key = Buffer.from('uzvJfB4u3N0Jy4T7NZ75MDVcr8zSTInedJtkgcu46YW4XByzNJjxBdtjUkdJPBtbmHhIDi6pcl8jsasjlTMtDQ==', 'base64');

        const result1 = await verifySignature({
            headerFields: {
                // https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-message-signatures-08#appendix-B.2.5
                'date': 'Tue, 20 Apr 2021 02:07:55 GMT',
                'content-type': 'application/json',
                'signature-input': 'sig-b25=("date" "@authority" "content-type");created=1618884473;keyid="test-shared-secret"',
                'signature': 'sig-b25=:pxcQw6G3AjtMBQjwo8XzkZf/bws5LelbaMk5rGIGtE8=:',
            },
            derivedComponentLookup: (name) => (
                (name === '@authority') ? 'example.com' : null
            ),
            keyResolver: (parameters) => (
                (parameters.keyid === 'test-shared-secret') ? ({
                    code: 'GOODKEY',
                    key
                }) : ({
                    code: 'BADKEY',
                    key: Buffer.alloc(64, 0)
                })
            ),
        });
        expect(result1).toStrictEqual<VerifyResult>({ code: 'VERIFIED' });
     
    });

});

describe('Verify AudioHook documentation example', () => {

    test('Example 1 - base', async () => {
        const result1 = await verifySignature({
            headerFields: {
                'host': 'audiohook.example.com',
                'audiohook-organization-id': 'd7934305-0972-4844-938e-9060eef73d05',
                'audiohook-session-id': '30b0e395-84d3-4570-ac13-9a62d8f514c0',
                'audiohook-correlation-id': 'e160e428-53e2-487c-977d-96989bf5c99d',
                'x-api-key': 'SGVsbG8sIEkgYW0gdGhlIEFQSSBrZXkh',
                'signature': 'sig1=:zupMJUMfd/kMuvKc5zhRyfJPE3jTROuz1S1hn8SCTpE=:',
                'signature-input': 'sig1=("@request-target" "host" "audiohook-organization-id" "audiohook-session-id" "audiohook-correlation-id" "x-api-key");keyid="SGVsbG8sIEkgYW0gdGhlIEFQSSBrZXkh";nonce="VGhpc0lzQVVuaXF1ZU5vbmNl";alg="hmac-sha256";created=1641013200;expires=3282026430'
    
            },
            derivedComponentLookup: (name) => (
                (name === '@request-target') ? '/api/v1/voicebiometrics/ws' : null
            ),
            keyResolver: (parameters) => (
                (parameters.keyid === 'SGVsbG8sIEkgYW0gdGhlIEFQSSBrZXkh') ? ({
                    code: 'GOODKEY',
                    key: Buffer.from('TXlTdXBlclNlY3JldEtleVRlbGxOby0xITJAMyM0JDU=', 'base64')
                }) : ({
                    code: 'BADKEY',
                    key: Buffer.alloc(32, 0)
                })
            ),
        });
        expect(result1).toStrictEqual<VerifyResult>({ code: 'VERIFIED' });
    });
    test('Example 1 - header order', async () => {
        const result1 = await verifySignature({
            headerFields: {
                'signature-input': 'sig1=("@request-target" "host" "audiohook-organization-id" "audiohook-session-id" "audiohook-correlation-id" "x-api-key");keyid="SGVsbG8sIEkgYW0gdGhlIEFQSSBrZXkh";nonce="VGhpc0lzQVVuaXF1ZU5vbmNl";alg="hmac-sha256";created=1641013200;expires=3282026430',
                'audiohook-organization-id': 'd7934305-0972-4844-938e-9060eef73d05',
                'host': 'audiohook.example.com',
                'audiohook-correlation-id': 'e160e428-53e2-487c-977d-96989bf5c99d',
                'signature': 'sig1=:zupMJUMfd/kMuvKc5zhRyfJPE3jTROuz1S1hn8SCTpE=:',
                'x-api-key': 'SGVsbG8sIEkgYW0gdGhlIEFQSSBrZXkh',
                'audiohook-session-id': '30b0e395-84d3-4570-ac13-9a62d8f514c0',    
            },
            derivedComponentLookup: (name) => (
                (name === '@request-target') ? '/api/v1/voicebiometrics/ws' : null
            ),
            keyResolver: (parameters) => (
                (parameters.keyid === 'SGVsbG8sIEkgYW0gdGhlIEFQSSBrZXkh') ? ({
                    code: 'GOODKEY',
                    key: Buffer.from('TXlTdXBlclNlY3JldEtleVRlbGxOby0xITJAMyM0JDU=', 'base64')
                }) : ({
                    code: 'BADKEY',
                    key: Buffer.alloc(32, 0)
                })
            ),
        });
        expect(result1).toStrictEqual<VerifyResult>({ code: 'VERIFIED' });
    });

});

