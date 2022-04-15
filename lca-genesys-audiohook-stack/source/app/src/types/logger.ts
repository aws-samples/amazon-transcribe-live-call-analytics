
export interface LeveledLogMethod {
    (msg: string): void;
    (msg: string, error: Error): void;
}

export interface Logger {
    fatal: LeveledLogMethod;
    error: LeveledLogMethod;
    warn: LeveledLogMethod;
    info: LeveledLogMethod;
    debug: LeveledLogMethod;
    trace: LeveledLogMethod;   
}

