// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
