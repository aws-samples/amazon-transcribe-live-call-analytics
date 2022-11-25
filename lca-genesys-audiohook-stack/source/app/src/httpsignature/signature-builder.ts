// # Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// #
// # Licensed under the Apache License, Version 2.0 (the "License").
// # You may not use this file except in compliance with the License.
// # You may obtain a copy of the License at
// #
// # http://www.apache.org/licenses/LICENSE-2.0
// #
// # Unless required by applicable law or agreed to in writing, software
// # distributed under the License is distributed on an "AS IS" BASIS,
// # WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// # See the License for the specific language governing permissions and
// # limitations under the License.

import { createHmac, randomBytes } from 'crypto';
import {
    Item,
    InnerList,
    Parameters,
    encodeItem,
    encodeInnerList,
    encodeDictionary
} from './structured-fields';

export type SignatureHeaders = {
    'signature-input': string;
    'signature': string;
};

export type SignatureOptions = {
    keyid: string;
    key: Uint8Array;
    created?: number;
    expires?: number;
    label?: string;
    alg?: 'hmac-sha256';
    nonce?: string;
};

export class SignatureBuilder {
    private components: Array<{
        item: Item;
        value: string;
    }> = [];

    addComponent(identifier: string, value: string): SignatureBuilder {
        const id = identifier.toLowerCase();
        const val = value.trim();
        const tmp = this.components.find(({ item }) => (item.value === id));
        if (tmp) {
            tmp.value = `${tmp.value}, ${val}`;
        } else {
            this.components.push({ item: { value: id }, value: val });
        }
        return this;
    }

    createSignature({ keyid, key, created, expires, label, alg, nonce }: SignatureOptions): SignatureHeaders {
        if (alg && alg !== 'hmac-sha256') {
            throw new RangeError('Currently only hmac-sha256 signature supported');
        }
        const createdInt = Math.floor(created ?? (Date.now() / 1000));
        const params: Parameters = [
            { key: 'keyid', value: keyid },
            { key: 'nonce', value: nonce ?? randomBytes(18).toString('base64') },
            { key: 'alg', value: 'hmac-sha256' },
            { key: 'created', value: createdInt },
            { key: 'expires', value: createdInt + Math.floor(expires ?? 30) },   // Default lifetime
        ];
        const sigParams: InnerList = {
            value: this.components.map(({ item }) => item),
            params: params
        };
        const encodedSigParams = encodeInnerList(sigParams);
        const inputLines = this.components.map(({ item, value }) => `${encodeItem(item)}: ${value}`);
        inputLines.push(`"@signature-params": ${encodedSigParams}`);
        const sigData = inputLines.join('\n');
        const signature = createHmac('sha256', key).update(sigData).digest();
        const id = label ?? 'sig1';
        return {
            'signature-input': encodeDictionary({ [id]: sigParams }),
            'signature': encodeDictionary({ [id]: { value: signature } }),
        };
    }
}
