import { open, FileHandle } from 'fs/promises';

export type AudioFormat = 'PCMU' | 'L16';
export type SampleRate = 8000 | 16000 | 44100 | 48000;
export const defaultSupportedRates: readonly SampleRate[] = [8000, 16000, 44100, 48000] as const;

export const createWavHeader = function createHeader(length: number, samplingRate: number) {
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

export interface WavReader {
    readonly format: AudioFormat;
    readonly rate: SampleRate;
    readonly channels: number;
    close(): Promise<void>;
    readNext(samples: number): Promise<Uint8Array | Int16Array | null>;
};

class WavFileReader implements WavReader {
    private file: FileHandle;
    private dataStartPos: number;
    private readPos: number;
    private dataChunkSize: number;
    private bytesPerSample: number;
    private maxFrameSamples: number;
    private bufferFactory: (bytes: number) => Int16Array | Uint8Array;
    readonly format: AudioFormat;
    readonly rate: SampleRate;
    readonly channels: number;

    constructor(file: FileHandle, startPos: number, dataChunkSize: number, format: AudioFormat, rate: SampleRate, channels: number) {
        this.file = file;
        this.format = format;
        this.rate = rate;
        this.channels = channels;
        this.dataStartPos = startPos;
        this.readPos = 0;
        this.dataChunkSize = dataChunkSize;
        this.maxFrameSamples = 10 * this.rate; // Read at most 10s at a time
        if (format === 'L16') {
            this.bytesPerSample = 2 * channels;
            this.bufferFactory = (bytes) => new Int16Array(bytes / 2);
        } else {
            this.bytesPerSample = channels;
            this.bufferFactory = (bytes) => new Uint8Array(bytes);
        }
    }

    async close(): Promise<void> {
        this.readPos = this.dataChunkSize;
        await this.file.close();
    }

    async readNext(samples: number): Promise<Uint8Array | Int16Array | null> {
        const ask = (
            (samples <= 0) ? (
                this.rate
            ) : (samples > this.maxFrameSamples) ? (
                this.maxFrameSamples
            ) : (
                samples
            )
        ) * this.bytesPerSample;
        const pos = this.readPos;
        const available = Math.min(this.dataChunkSize - pos, ask);
        if (available === 0) {
            return null;
        }
        this.readPos += available;
        const buf = this.bufferFactory(available);
        const res = await this.file.read({
            buffer: buf,
            position: this.dataStartPos + pos,
        });
        if (res.bytesRead !== available) {
            throw new Error('Corrupt file: Truncated data chunk.');
        }
        return buf;
    }
};

export type WavFileReaderOptions = {
    allowedRates?: readonly SampleRate[];
    channelMin?: number;
    channelMax?: number;
};

export const createWavFileReader = async (filename: string, options: WavFileReaderOptions): Promise<WavReader> => {
    let file: FileHandle | null = null;
    try {
        file = await open(filename, 'r');
        const headerSize = 44;
        const headerData = await file.read({
            buffer: Buffer.alloc(headerSize),
            offset: 0,
            length: headerSize,
            position: 0,
        });
        if (headerData.bytesRead !== headerSize) {
            throw new Error('File too small for valid WAV file');
        }
        const headerView = new DataView(headerData.buffer.buffer);
        if (headerView.getUint32(0, false) !== 0x52494646) {    // 'RIFF'
            throw new Error('Not a valid/supported WAV file (RIFF tag missing)');
        }
        if (headerView.getUint32(8, false) !== 0x57415645) {    // 'WAVE'
            throw new Error('Not a valid/supported WAV file (no WAVE chunk');
        }
        if (headerView.getUint32(12, false) !== 0x666d7420) {   // 'fmt '
            throw new Error('Not a valid/supported WAV file (no fmt chunk)');
        }
        const fmtChunkSize = headerView.getUint32(16, true);
        if ((fmtChunkSize !== 16) && (fmtChunkSize !== 18) && (fmtChunkSize !== 40)) {
            throw new Error('Not a valid/supported WAV file (bad fmt chunk size)');
        }

        const formatTag = headerView.getUint16(20, true);
        let format: AudioFormat;
        if (formatTag === 1) {
            format = 'L16';
        } else if (formatTag === 7) {
            format = 'PCMU';
        } else {
            throw new Error(`Unsupported WAV format tag (${formatTag}). Only supporting 1(L16) and 7(PCMU)`);
        }

        const channels = headerView.getUint16(22, true);
        if ((channels < (options.channelMin ?? 1)) || (channels > (options.channelMax ?? 16))) {
            throw new Error(`Invalid number of channels: ${channels}`);
        }
        const rate = headerView.getUint32(24, true);
        const allowedRates: readonly number[] = (options.allowedRates ?? defaultSupportedRates);
        if (!allowedRates.includes(rate)) {
            throw new Error(`Unsupported sample rate (${rate}). Supported: ${allowedRates.join(',')}`);
        }
        const bytesPerSample = headerView.getUint16(32, true);
        if (bytesPerSample !== (channels * ((formatTag === 1) ? 2 : 1))) {
            throw new Error(`Invalid bytesPerSample for ${channels} channel ${format}`);
        }

        // Now search for 'data' chunk
        // Start after 'fmt ' chunk
        let pos = 20 + fmtChunkSize;
        const chunk = Buffer.alloc(8);
        for(;;) {
            const res = await file.read({
                buffer: chunk,
                offset: 0,
                length: chunk.byteLength,
                position: pos,
            });
            if(res.bytesRead !== chunk.byteLength) {
                throw new Error('Corrupt or invalid WAV file (no data chunk found)');
            }
            const view = new DataView(chunk.buffer);
            let dataSize = view.getUint32(4, true);
            if (view.getUint32(0, false) === 0x64617461) {      // 'data' chunk
                if(dataSize === 0xffffffff) {
                    // Data chunk spans to end of file
                    const stats = await file.stat();
                    dataSize = stats.size - 8 - pos;
                }
                const reader = new WavFileReader(file, pos + 8, dataSize, format, rate as SampleRate, channels);
                file = null;    // File is now owned by reader
                return reader;
            }
            pos += 8 + dataSize + (dataSize % 2);
        }
    } finally {
        await file?.close();
    }
};
