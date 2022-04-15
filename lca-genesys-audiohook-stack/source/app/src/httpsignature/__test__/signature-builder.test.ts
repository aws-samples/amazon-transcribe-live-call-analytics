import { SignatureBuilder } from '../signature-builder';

describe('Signature builder tests', () => {

    test('AudioHook documentation example', () => {
        const signature = (new SignatureBuilder()
            .addComponent('@request-target', '/api/v1/voicebiometrics/ws')
            .addComponent('host', 'audiohook.example.com')
            .addComponent('audiohook-organization-id', 'd7934305-0972-4844-938e-9060eef73d05')
            .addComponent('audiohook-session-id', '30b0e395-84d3-4570-ac13-9a62d8f514c0')
            .addComponent('audiohook-correlation-id', 'e160e428-53e2-487c-977d-96989bf5c99d')
            .addComponent('x-api-key', 'SGVsbG8sIEkgYW0gdGhlIEFQSSBrZXkh')
            .createSignature({
                keyid: 'SGVsbG8sIEkgYW0gdGhlIEFQSSBrZXkh',
                key: Buffer.from('TXlTdXBlclNlY3JldEtleVRlbGxOby0xITJAMyM0JDU=', 'base64'),
                created: 1641013200,
                expires: 1641013230,
                nonce: 'VGhpc0lzQVVuaXF1ZU5vbmNl'
            })
        );
        expect(signature).toStrictEqual({
            'signature': 'sig1=:zupMJUMfd/kMuvKc5zhRyfJPE3jTROuz1S1hn8SCTpE=:',
            'signature-input': 'sig1=("@request-target" "host" "audiohook-organization-id" "audiohook-session-id" "audiohook-correlation-id" "x-api-key");keyid="SGVsbG8sIEkgYW0gdGhlIEFQSSBrZXkh";nonce="VGhpc0lzQVVuaXF1ZU5vbmNl";alg="hmac-sha256";created=1641013200;expires=3282026430'
        });
    });

});
