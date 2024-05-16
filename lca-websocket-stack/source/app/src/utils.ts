// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';

export const posixifyFilename = function (filename: string) {
    // Replace all invalid characters with underscores.
    const regex = /[^a-zA-Z0-9_.]/g;
    const posixFilename = filename.replace(regex, '_');
    // Remove leading and trailing underscores.
    return posixFilename.replace(/^_+/g, '').replace(/_+$/g, '');
};

export const deleteTempFile = async(sourceFile:string) => {
    try {
        console.log('deleting tmp file');
        await fs.promises.unlink(sourceFile);
    } catch (err) {
        console.error('error deleting: ', err);
    }
};

export const isError = (arg: unknown): arg is Error => (
    arg instanceof Error
);

export const normalizeError = (arg: unknown): Error => {
    if(arg instanceof Error) {
        return arg;
    } else if(typeof arg === 'string') {
        return new Error(`String raised as error: "${arg.substring(0, 2048)}"`);
    } else {
        return new Error(`Object not extending Error raised. Type: ${typeof arg}`);
    }
};

export const createWavHeader = (sampleRate: number, length: number) => {
    const buffer = Buffer.alloc(44);
  
    // RIFF identifier 'RIFF'
    buffer.writeUInt32BE(1380533830, 0);
    // file length minus RIFF identifier length and file description length
    buffer.writeUInt32LE(36 + length, 4);
    // RIFF type 'WAVE'
    buffer.writeUInt32BE(1463899717, 8);
    // format chunk identifier 'fmt '
    buffer.writeUInt32BE(1718449184, 12);
    // format chunk length
    buffer.writeUInt32LE(16, 16);
    // sample format (raw)
    buffer.writeUInt16LE(1, 20);
    // channel count
    buffer.writeUInt16LE(2, 22);
    // sample rate
    buffer.writeUInt32LE(sampleRate, 24);
    // byte rate (sample rate * block align)
    buffer.writeUInt32LE(sampleRate * 2 * 2, 28);
    // block align (channel count * bytes per sample)
    buffer.writeUInt16LE(2 * 2, 32);
    // bits per sample
    buffer.writeUInt16LE(16, 34);
    // data chunk identifier 'data'
    buffer.writeUInt32BE(1684108385, 36);
    buffer.writeUInt32LE(length, 40);
  
    return buffer;
};