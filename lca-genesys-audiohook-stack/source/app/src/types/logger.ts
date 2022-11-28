// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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

