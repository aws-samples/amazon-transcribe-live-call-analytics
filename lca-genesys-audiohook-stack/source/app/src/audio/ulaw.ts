/**
 * Lookup table to convert u-Law bytes to their Linear-16 sample values
 */
const ulawToL16Lut = new Int16Array([
    -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
    -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
    -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
    -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
    -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
    -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
    -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
    -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
    -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
    -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
    -876, -844, -812, -780, -748, -716, -684, -652,
    -620, -588, -556, -524, -492, -460, -428, -396,
    -372, -356, -340, -324, -308, -292, -276, -260,
    -244, -228, -212, -196, -180, -164, -148, -132,
    -120, -112, -104, -96, -88, -80, -72, -64,
    -56, -48, -40, -32, -24, -16, -8, -1,
    32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
    23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
    15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
    11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
    7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
    5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
    3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
    2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
    1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
    1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
    876, 844, 812, 780, 748, 716, 684, 652,
    620, 588, 556, 524, 492, 460, 428, 396,
    372, 356, 340, 324, 308, 292, 276, 260,
    244, 228, 212, 196, 180, 164, 148, 132,
    120, 112, 104, 96, 88, 80, 72, 64,
    56, 48, 40, 32, 24, 16, 8, 0
]);

/**
 * Lookup table to determine u-Law exponent from clamped absolute sample value.
 */
const ulawExpLut = new Uint8Array([
    0, 1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7
]);

/**
 * Encodes a sample of Linear16 encoded audio samples in range [-32768, 32767] to u-Law
 *
 * Values outside range of signed 16-bit [-32768, 32767] are clamped/saturated.
 * 
 * @param sample Sample to encode, valid range [-32768, 32767]
 * @returns U-law encoded sample 
 */
export const ulawFromL16Sample = (sample: number): number => {
    let x: number;
    let ulaw: number;
    if (sample < 0) {
        x = ((sample <= -32635) ? 32635 : -sample) + 132;     // Negate sample, clamp, and add bias (4*33)
        ulaw = 0x7f;
    } else {
        x = ((sample >= 32635) ? 32635 : sample) + 132;     // Clamp sample and add bias (4*33)
        ulaw = 0xff;
    }
    const exp = ulawExpLut[x >> 8];
    return ulaw - ((exp << 4) | ((x >> (exp + 3)) & 0x0f));
};

/**
 * Decodes a u-law encoded sample to Linear16.
 * 
 * Input is expected to be in range 0...255 (8bit unsigned).
 * 
 * @param sample Byte value representing sample encoded in u-law
 * @returns Linear16 sample value [-32768, 32767]
 */
export const ulawToL16Sample = (sample: number): number => {
    return ulawToL16Lut[sample] ?? 0;
};


const encodeFromArray = (data: Int16Array | number[]): Uint8Array => {
    const size = data.length;
    const res = new Uint8Array(size);
    for (let i = 0; i < size; ++i) {
        res[i] = ulawFromL16Sample(data[i]);
    }
    return res;
};

const encodeFromDataView = (dataview: DataView): Uint8Array => {
    const size = dataview.byteLength / 2;
    const res = new Uint8Array(size);
    let s = 0;
    for (let i = 0; i < size; ++i, s += 2) {
        res[i] = ulawFromL16Sample(dataview.getInt16(s, true));
    }
    return res;
};

/**
 * Decodes an array of audio samples encoded with u-Law to Linear16
 * 
 * @param {Uint8Array} ulawBuf Array of u-Law bytes to convert to Linear16
 * @returns {Int16Array} Array of Linear16 samples [-32768, 32767]
 */
export const ulawToL16 = (ulawBuf: Uint8Array): Int16Array => {
    const size = ulawBuf.length;
    const res = new Int16Array(size);
    for (let i = 0; i < size; ++i) {
        res[i] = ulawToL16Lut[ulawBuf[i]];
    }
    return res;
};

/**
 * Encodes an array of Linear16 encoded audio samples in range [-32768, 32767] to u-Law
 * 
 * Values outside range of signed 16-bit [-32768, 32767] are clamped/saturated.
 * 
 * @param src Typed array of Linear16 audio samples in range [-32768, 32767]. If the argument is a Uint8Array or DataView, 
 *            it is assumed to contain the audio as little-endian 16-bit samples.
 *              
 * @returns Array of samples encoded in u-Law
 */
export const ulawFromL16 = (src: Int16Array | number[] | Uint8Array | DataView): Uint8Array => {
    if (src instanceof Int16Array) {
        return encodeFromArray(src);
    } else if (src instanceof DataView) {
        return encodeFromDataView(src);
    } else if (src instanceof Uint8Array) {
        return encodeFromDataView(new DataView(src.buffer, src.byteOffset, src.byteLength));
    } else {
        return encodeFromArray(src);
    }
};
