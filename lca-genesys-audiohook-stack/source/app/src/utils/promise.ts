
export type MaybePromise<T> = T | Promise<T>;

export const isPromise = <T>(arg: MaybePromise<T>): arg is Promise<T> => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    !!arg && (typeof arg === 'object' || typeof arg === 'function') && typeof (arg as any).then === 'function'
);
