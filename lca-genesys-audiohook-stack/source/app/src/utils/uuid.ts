// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Uuid } from '../audiohook/message';
import { isUuid } from '../audiohook/validators';
export { v4 as uuid } from 'uuid';
export { Uuid };
export { isUuid };

export const checkedUuid = (value: string): Uuid => {
    if(isUuid(value)) {
        return value;
    }
    throw new RangeError('String representing a UUID expected');
};
