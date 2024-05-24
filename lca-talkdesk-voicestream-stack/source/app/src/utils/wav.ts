
export const createWavHeader = function createHeader(length:number, samplingRate:number) {
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
    buffer.writeUInt32LE(samplingRate, 24);
    // byte rate (sample rate * block align)
    buffer.writeUInt32LE(samplingRate * 2 * 2, 28);
    // block align (channel count * bytes per sample)
    buffer.writeUInt16LE(2 * 2, 32);
    // bits per sample
    buffer.writeUInt16LE(16, 34);
    // data chunk identifier 'data'
    buffer.writeUInt32BE(1684108385, 36);
    buffer.writeUInt32LE(length, 40);

    return buffer;
};
