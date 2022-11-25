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

import { ulawToL16, ulawFromL16 } from './ulaw';

const int16ArrayFromUInt8 = (src: Uint8Array): Int16Array => {
    if ((src.byteOffset % 2) !== 0) {
        // Buffer for Int16Array must be byte-aligned. Create with copy.
        const tmp = src.slice();
        return new Int16Array(tmp.buffer, 0, (tmp.byteLength / 2) | 0);
    } else {
        return new Int16Array(src.buffer, src.byteOffset, (src.byteLength / 2) | 0);
    }
};

export type AudioFormat = 'PCMU' | 'L16';
export type SampleRate = 8000 | 16000 | 44100 | 48000;

export type AudioSampleDataType<F extends AudioFormat> = (
    F extends 'PCMU' ? (
        Uint8Array
    ) : F extends 'L16' ? (
        Int16Array
    ) : (
        never
    )
);

export type TypedAudioSampleData<F extends AudioFormat> = (
    F extends 'PCMU' ? {
        readonly format: 'PCMU';
        readonly data: Uint8Array;
    } : F extends 'L16' ? {
        readonly format: 'L16';
        readonly data: Int16Array;
    } : never
);

export type AudioParameter<C extends string, F extends AudioFormat = AudioFormat, R extends SampleRate = SampleRate> = {
    readonly format: F;
    readonly rate: R;
    readonly channels: readonly C[];
};


export type MonoChannelView<C extends string, F extends AudioFormat = AudioFormat, R extends SampleRate = SampleRate> = {
    readonly rate: R;
    readonly channel: C;
} & TypedAudioSampleData<F>;

export type MultiChannelView<C extends string, F extends AudioFormat = AudioFormat, R extends SampleRate = SampleRate> = {
    readonly rate: R;
    readonly channels: readonly C[];
} & TypedAudioSampleData<F>;


export interface AudioFrame<
    ChannelName extends string,
    Format extends AudioFormat = AudioFormat,
    Rate extends SampleRate = SampleRate,
> {
    readonly format: Format;
    readonly rate: Rate;
    readonly channels: readonly ChannelName[];
    readonly duration: number;
    readonly sampleCount: number;
    readonly audio: MultiChannelView<ChannelName, Format, Rate>;

    getChannelView<C extends ChannelName>(channel: C): MonoChannelView<C, AudioFormat, Rate>;
    getChannelView<C extends ChannelName, F extends AudioFormat>(channel: C, format: F): MonoChannelView<C, F, Rate>;

    getChannelViews(): Array<MonoChannelView<ChannelName, AudioFormat, Rate>>;
    getChannelViews<F extends AudioFormat>(format: F): Array<MonoChannelView<ChannelName, F, Rate>>;

    as<F extends Format>(format: F): AudioFrame<ChannelName, F, Rate>;

}


type DataHolder<ChannelName extends string, Rate extends SampleRate> = {
    multi: {
        [F in AudioFormat]?: MultiChannelView<ChannelName, F, Rate>;
    },
    mono: {
        [K in ChannelName]?: {
            [F in AudioFormat]?: MonoChannelView<K, F, Rate>;
        };
    };
};

class AudioFrameImpl<
    ChannelName extends string,
    Format extends AudioFormat,
    Rate extends SampleRate
> implements AudioFrame<ChannelName, Format, Rate> {

    readonly rate: Rate;
    readonly format: Format;

    get channels(): readonly ChannelName[] {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return this._holder.multi[this.format]!.channels;
    }

    get duration(): number {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const audio = this._holder.multi[this.format]!;
        return (audio.data.length * audio.rate) / audio.channels.length;
    }

    get sampleCount(): number {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const audio = this._holder.multi[this.format]!;
        return audio.data.length / audio.channels.length;
    }

    get audio(): MultiChannelView<ChannelName, Format, Rate> {
        return this._holder.multi[this.format as AudioFormat] as MultiChannelView<ChannelName, Format, Rate>;
    }

    private _holder: DataHolder<ChannelName, Rate>;

    constructor(format: Format, holder: DataHolder<ChannelName, Rate>) {
        this.format = format;
        this._holder = holder;
        const tmp = this._holder.multi[this.format];
        if (!tmp) {
            throw new RangeError(`No data for format ${format} in audio frame data`);
        }
        this.rate = tmp.rate;
    }

    private _convertTo(format: AudioFormat): MultiChannelView<ChannelName, typeof format, Rate> {
        if (format === 'PCMU') {
            if(!this._holder.multi.PCMU) {
                const other = this._holder.multi.L16;
                if (!other) {
                    throw new Error(`No complementary format set for ${format}`); // This should never happen
                }
                this._holder.multi.PCMU = {
                    channels: other.channels,
                    rate: other.rate,
                    format: 'PCMU',
                    data: ulawFromL16(other.data)
                };
            }
            return this._holder.multi.PCMU;
        } else {
            if(!this._holder.multi.L16) {
                const other = this._holder.multi.PCMU;
                if (!other) {
                    throw new Error(`No complementary format set for ${format}`); // This should never happen
                }
                this._holder.multi.L16 = {
                    channels: other.channels,
                    rate: other.rate,
                    format: 'L16',
                    data: ulawToL16(other.data)
                };
            }
            return this._holder.multi.L16;
        }
    }

    getChannelView<C extends ChannelName>(channel: C): MonoChannelView<C, AudioFormat, Rate>;
    getChannelView<C extends ChannelName, F extends AudioFormat>(channel: C, format: F): MonoChannelView<C, F, Rate>;
    getChannelView(channel: ChannelName, format?: AudioFormat): MonoChannelView<ChannelName, AudioFormat, Rate> {
        let chan = this._holder.mono[channel];
        if (!chan) {
            chan = this._holder.mono[channel] = {};
        }
        const fmt = format ?? this.format;
        const data = chan[fmt];
        if (data) {
            // Nice, we already have this one in cache
            return data;
        }

        let src = this._holder.multi[fmt];
        if (!src) {
            // We don't yet have the multichannel in our format, convert.
            // We convert the multi-channel audio even though we don't know whether both channels will be used.
            // It's easier to do the whole array at once (and it seems likely both/all channels will be used)
            src = this._convertTo(fmt);
        }
        const offs = src.channels.indexOf(channel);
        if (offs < 0) {
            throw new RangeError(`Unknown channel '${channel}'`);
        }
        const stride = src.channels.length;
        if (stride === 1) {
            // The multi-channel entry is already a single channel, we don't have to de-interleave.
            if (src.format === 'PCMU') {
                return chan.PCMU = { channel, rate: src.rate, format: src.format, data: src.data };
            } else {
                return chan.L16 = { channel, rate: src.rate, format: src.format, data: src.data };
            }
        } else {
            // It's actually multiple channels, de-interleave starting at 'offs' with 'stride'
            const size = src.data.length / stride;
            if (src.format === 'PCMU') {
                const data = new Uint8Array(size);
                const sd = src.data;
                let s = offs;
                for (let i = 0; i !== size; ++i, s += stride) {
                    data[i] = sd[s];
                }
                return chan.PCMU = { channel, rate: src.rate, format: src.format, data };
            } else {
                const data = new Int16Array(size);
                const sd = src.data;
                let s = offs;
                for (let i = 0; i !== size; ++i, s += stride) {
                    data[i] = sd[s];
                }
                return chan.L16 = { channel, rate: src.rate, format: src.format, data };
            }
        }
    }

    getChannelViews(): Array<MonoChannelView<ChannelName, AudioFormat, Rate>>;
    getChannelViews<F extends AudioFormat>(format: F): Array<MonoChannelView<ChannelName, F, Rate>>;
    getChannelViews(format?: AudioFormat): Array<MonoChannelView<ChannelName, AudioFormat, Rate>> {
        const fmt = format ?? this.format;
        return this.audio.channels.map((channel) => this.getChannelView(channel, fmt));
    }

    as<F extends AudioFormat>(format: F): AudioFrame<ChannelName, F, Rate> {
        this._convertTo(format);
        return new AudioFrameImpl<ChannelName, F, Rate>(format, this._holder);
    }
}

export function createAudioFrame<
    C extends string,
    F extends AudioFormat,
    R extends SampleRate
>(
    data: Uint8Array | Int16Array,
    parameter: AudioParameter<C, F, R>
): AudioFrame<C, F, R> {
    if (parameter.channels.length === 0) {
        throw new RangeError('Cannot create audio frame with no channels');
    }
    if (parameter.format === 'PCMU') {
        if (!(data instanceof Uint8Array)) {
            throw new RangeError('Require Uint8Array for PCMU data');
        }
        const bps = parameter.channels.length;
        if ((data.length % bps) !== 0) {
            throw new RangeError(`Audio data size must be multiple of bytes per sample (${bps})`);
        }
        return new AudioFrameImpl<C, F, R>(
            'PCMU' as F,
            {
                multi: {
                    PCMU: { channels: parameter.channels, rate: parameter.rate, format: 'PCMU', data }
                },
                mono: {}
            }
        );
    } else if (parameter.format === 'L16') {
        let l16data: Int16Array;
        if (data instanceof Int16Array) {
            if ((data.length % parameter.channels.length) !== 0) {
                throw new RangeError(`Audio data size must be multiple of bytes per sample (${2 * parameter.channels.length})`);
            }
            l16data = data;
        } else {
            if ((data.length % 2 * parameter.channels.length) !== 0) {
                throw new RangeError(`Audio data size must be multiple of bytes per sample (${2 * parameter.channels.length})`);
            }
            l16data = int16ArrayFromUInt8(data);
        }
        return new AudioFrameImpl<C, F, R>(
            'L16' as F,
            {
                multi: {
                    L16: { channels: parameter.channels, rate: parameter.rate, format: 'L16', data: l16data }
                },
                mono: {}
            }
        );
    } else {
        const fmt: never = parameter.format;
        throw new RangeError(`Unexpected audio format ${fmt}`);
    }
}

export function createAudioFrameForChannelView<
    C extends string,
    F extends AudioFormat,
    R extends SampleRate
>(
    view: MonoChannelView<C, F, R>
): AudioFrame<C, F, R> {
    return new AudioFrameImpl<C, F, R>(
        view.format as F,
        {
            multi: {
                [view.format]: { channels: [view.channel], rate: view.rate, format: view.format, data: view.data }
            },
            mono: {}
        }
    );
}

