import { Duration } from './message';

export default class StreamDuration {
    static readonly maxValue = Number.MAX_SAFE_INTEGER;
    private readonly value: number;
    private constructor(arg: Duration | string | number | bigint) {
        if(typeof arg === 'number') {
            const tmp = Math.round(arg);
            if(tmp >= StreamDuration.maxValue) {
                throw new RangeError('Value too large');
            } else if(tmp >= 0) {
                this.value = tmp;
            } else {
                throw new RangeError('Value must be non-negative');
            }
        } else if(typeof arg === 'bigint') {
            if(arg >= StreamDuration.maxValue) {
                throw new RangeError('Value too large');
            } else if(arg >= 0) {
                this.value = Number(arg);
            } else {
                throw new RangeError('Value must be non-negative');
            }
        } else {
            const match = /^PT(\d+\.\d*|\.?\d+)S$/.exec(arg);
            if(!match) {
                throw new RangeError('Argument must be of format "PT{number}S"');
            }
            const val = parseFloat(match[1]) * 1000000000;
            if(!(val < StreamDuration.maxValue)) {
                // Note: using the negated less-than ensures this triggers on NaN.
                throw new RangeError('Value too large');
            }
            this.value = val;
        }
    }

    static zero = new StreamDuration(0);

    static fromDuration(value: Duration): StreamDuration {
        return new StreamDuration(value);
    }

    static fromString(value: string): StreamDuration {
        return new StreamDuration(value);
    }

    static fromSeconds(value: number): StreamDuration {
        return new StreamDuration(value * 1000000000);
    }

    static fromMilliseconds(value: number): StreamDuration {
        return new StreamDuration(value * 1000000);
    }

    static fromNanoseconds(value: number | bigint): StreamDuration {
        return new StreamDuration(value);
    }

    static fromSamples(samples: number, rate: number): StreamDuration {
        return new StreamDuration((samples/rate)*1000000000);
    }

    get nanoseconds(): number {
        return this.value;
    } 

    get milliseconds(): number {
        return Math.round(this.value/1000000);
    } 

    get seconds(): number {
        return this.value/1000000000;
    }

    withAddedSeconds(value: number): StreamDuration {
        return new StreamDuration(this.value + value * 1000000000);
    }

    withAddedMilliseconds(value: number): StreamDuration {
        return new StreamDuration(this.value + value * 1000000);
    }

    withAddedNanoseconds(value: number | bigint): StreamDuration {
        if(typeof value === 'number') {
            return new StreamDuration(this.value + value);
        } else {
            return new StreamDuration(BigInt(this.value) + value);
        }
    }

    withAddedSamples(samples: number, rate: number): StreamDuration {
        return new StreamDuration(this.value + (samples/rate)*1000000000);
    }

    absDelta(other: StreamDuration): StreamDuration {
        return new StreamDuration(Math.abs(other.value - this.value));
    }

    asDuration(): Duration {
        return this.toString();
    }

    toString(): Duration {
        // Note: The following conversion is sufficient because we enforce: 0 <= this.value < 2^53-1 in constructor
        return (`PT${(this.value/1000000000).toString()}S` as unknown) as Duration;
    }

    valueOf(): number {
        return this.value;
    }
}
