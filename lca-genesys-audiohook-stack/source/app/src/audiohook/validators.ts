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

import {
    Uuid,
    Duration,
    JsonValue,
    JsonObject,
    MessageBase,
    ClientMessageBase,
    ServerMessageBase,
    ClientMessageType,
    ServerMessageType,
    CloseReason,
    DisconnectReason,
    ReconnectReason,
    MediaParameter,
    MediaParameters,
    MediaChannel,
    MediaChannels,
    MediaType,
    MediaRate,
    MediaFormat,
    Participant,
    SequenceNumber,
    EventEntity,
    ContinuedSession,
    ContinuedSessions,
    CloseParameters,
    ClosedParameters,
    DiscardedParameters,
    DisconnectParameters,
    ErrorParameters,
    EventParameters,
    OpenParameters,
    OpenedParameters,
    PauseParameters,
    PausedParameters,
    PingParameters,
    PongParameters,
    ReconnectParameters,
    ReconnectedParameters,
    ReconnectingParameters,
    ResumeParameters,
    ResumedParameters,
    UpdateParameters,
    UpdatedParameters,
    ClientMessage,
    ServerMessage
} from './message';

type OptionalKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never } [keyof T];

type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K } [keyof T];

type ValidatorFunctor = (value: JsonValue) => boolean;

type RequiredParameterValidator<T>  = {
    readonly [K in RequiredKeys<T>]: ValidatorFunctor;
};

type OptionalParameterValidator<T>  = {
    readonly [K in OptionalKeys<T>]: ValidatorFunctor;
};

type JsonObjectValidatorFunc<T> = (value: JsonObject) => value is T & JsonObject;

type JsonValueValidatorFunc<T extends string> = (value: JsonValue) => value is T;

function makeValidator<T>(required: RequiredParameterValidator<T>, optional: OptionalParameterValidator<T>): JsonObjectValidatorFunc<T> {
    const reqval = Object.entries(required) as Array<[string, ValidatorFunctor]>;
    const optval = Object.entries(optional) as Array<[string, ValidatorFunctor]>;
    return (
        (value: JsonObject): value is T & JsonObject => (
            reqval.every(([key, fn]) => {
                const v = value[key];
                return (v !== undefined) && fn(v);

            }) &&
            optval.every(([key, fn]) => {
                const v = value[key];
                return (v === undefined) || fn(v);
            })
        )
    );
}

function makeStringUnionValidator<T extends string>(set: {[K in T]: true}): JsonValueValidatorFunc<T> {
    // Note: This is an unfortunate hack to enforce we have a list of string union members. 
    // Ideal would be if TypeScript supported reifying unions to values (array or tuples). 
    // Unfortunately it doesn't. As the order of union members is undefined, creating a union-to-tuple 
    // type and then constraining a tuple value on that doesn't work reliably either. 
    // The only approach I found to work to enforce an exact match of a set of values and a union type
    // is using an object literal. 
    // We could allow values in the `message.ts` file instead of just types, then we could do something like:
    // ```
    // const myStringEnumValues = ['foo', 'bar', 'baz'] as const;
    // type MyStringEnum = typeof myStringEnumValues[number];
    // ```
    // However, I'd rather keep the `messages.ts` file to types only for now.
    const keys = Object.keys(set);
    return (value: JsonValue): value is T => (typeof value === 'string') && keys.includes(value);
}


function wrapForJsonValue<T>(validator: JsonObjectValidatorFunc<T>): (value: JsonValue) => value is T & JsonObject  {
    return (value: JsonValue): value is T & JsonObject => (
        isJsonObject(value) && validator(value)
    );
}


export const isJsonValue = (value: unknown): value is JsonValue => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (value as any)?.constructor;
    return (c === null) || (c === String) || (c === Boolean) || (c === Number) || (c === Array) || (c == Object);
};

export const isJsonObject = (value: unknown): value is JsonObject => (
    // Note: We assume that the keys of the object are strings, which is probably a safe assumption if the value comes from a JSON.parse().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((value as any)?.constructor === Object)
);  

export const isString = (value: JsonValue): value is string => (
    typeof value === 'string'
);

export const isBoolean = (value: JsonValue): value is boolean => (
    typeof value === 'boolean'
);

export const isSequenceNumber = (value: JsonValue): value is SequenceNumber => (
    // Note: we need the type assertion because isInteger() doesn't have a type guard (https://github.com/microsoft/TypeScript/issues/15048).
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    Number.isInteger(value) && (value! >= 0)
);

export const uuidRegex = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000)$/;

export const nullUuid = '00000000-0000-0000-0000-000000000000';

export const isNullUuid = (uuid: Uuid): boolean => (uuid === nullUuid);

export const isUuid = (value: JsonValue): value is Uuid => (
    isString(value) && uuidRegex.test(value)
);

export const durationRegex = /^PT(?:\d*\.)?\d+S$/;

export const isDuration = (value: JsonValue): value is Duration => (
    isString(value) && durationRegex.test(value)
);


export const isMediaType = (value: JsonValue): value is MediaType => (
    (value === 'audio')
);

export const isMediaRate = (value: JsonValue): value is MediaRate => (
    (value === 8000)
);

export const isMediaFormat = makeStringUnionValidator<MediaFormat>({ 'PCMU': true, 'L16': true });

export const isMediaChannel = makeStringUnionValidator<MediaChannel>({ 'external': true, 'internal': true });

export const isMediaChannels = (value: JsonValue): value is MediaChannels => (
    Array.isArray(value) && (value.length >= 1) && (value.length <= 2) && value.every(ch => isMediaChannel(ch))
);

export const isMediaParameter = wrapForJsonValue(
    makeValidator<MediaParameter>(
        {
            type: isMediaType,
            format: isMediaFormat,
            rate: isMediaRate,
            channels: isMediaChannels
        },
        {}
    )
);

export const isMediaParameters = (value: JsonValue): value is MediaParameters => (
    Array.isArray(value) && value.every(v => isMediaParameter(v))
);

export const isParticipant = wrapForJsonValue(
    makeValidator<Participant>(
        {
            id: isUuid,
            ani: isString,
            aniName: isString,
            dnis: isString,
        },
        {}
    )
);

export const isContinuedSession = wrapForJsonValue(
    makeValidator<ContinuedSession>(
        {
            id: isUuid,
            clientseq: isSequenceNumber,
            serverseq: isSequenceNumber
        },
        {}
    )
);

export const isContinuedSessions = (value: JsonValue): value is ContinuedSessions => (
    Array.isArray(value) && value.every(v => isContinuedSession(v))
);

export const isErrorCode = (value: JsonValue): value is number => (
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    (Number.isInteger(value) && ((value! >= 400) && (value! < 10000)))
);

export const isEventEntity = (value: JsonValue): value is EventEntity & JsonObject => {
    if(!isJsonObject(value) || !isString(value['type']) || !isJsonValue(value['data'])) {
        return false;
    }
    return true;
};


export const isCloseReason = makeStringUnionValidator<CloseReason>({ 'disconnect': true, 'end': true, 'error': true });


export const isCloseParameters = makeValidator<CloseParameters>(
    {
        reason: isCloseReason
    },
    {}
);

export const isClosedParameters = makeValidator<ClosedParameters>(
    {},
    {}
);
    
export const isDisconnectReason = makeStringUnionValidator<DisconnectReason>({ 'error': true, 'unauthorized': true, 'completed': true });

export const isDisconnectParameters = makeValidator<DisconnectParameters>(
    {
        reason: isDisconnectReason
    },
    {
        info: isString
    }
);


export const isDiscardedParameters = makeValidator<DiscardedParameters>(
    {
        start: isDuration,
        discarded: isDuration
    },
    {}
);

export const isEventParameters = makeValidator<EventParameters>(
    {
        entity: isEventEntity
    },
    {}
);

export const isErrorParameters = makeValidator<ErrorParameters>(
    {
        code:   isErrorCode,
        message: isString
    },
    {
        retryAfter: isDuration
    }
);


export const isOpenParameters = makeValidator<OpenParameters>(
    {
        organizationId: isUuid, 
        conversationId: isUuid,
        participant: isParticipant,
        media: isMediaParameters
    },
    {
        continuedSessions: isContinuedSessions,
        customConfig: isJsonObject       
    }
);


export const isOpenedParameters = makeValidator<OpenedParameters>(
    {
        media: isMediaParameters
    },
    {
        startPaused: isBoolean
    }
);


export const isPauseParameters = makeValidator<PauseParameters>(
    {},
    {}
);

export const isPausedParameters = makeValidator<PausedParameters>(
    {},
    {}
);

export const isPingParameters = makeValidator<PingParameters>(
    {},
    {
        rtt: isDuration
    }
);

export const isPongParameters = makeValidator<PongParameters>(
    {},
    {}
);

export const isReconnectReason = makeStringUnionValidator<ReconnectReason>({ 'error': true, 'rebalance': true });

export const isReconnectParameters = makeValidator<ReconnectParameters>(
    {
        reason: isReconnectReason
    },
    {
        info: isString
    }
);
    
export const isReconnectedParameters = makeValidator<ReconnectedParameters>(
    {},
    {}
);
    
export const isReconnectingParameters = makeValidator<ReconnectingParameters>(
    {},
    {}
);
    
export const isResumeParameters = makeValidator<ResumeParameters>(
    {},
    {}
);
    
export const isResumedParameters = makeValidator<ResumedParameters>(
    {
        start: isDuration,
        discarded: isDuration
    },
    {}
);

export const isUpdateParameters = makeValidator<UpdateParameters>(
    {},
    {}
);

export const isUpdatedParameters = makeValidator<UpdatedParameters>(
    {},
    {}
);



export const isMessageBase = (msg: unknown): msg is MessageBase & JsonObject => (
    isJsonObject(msg) &&
    (msg['version'] === '2') &&
    isUuid(msg['id']) && 
    isString(msg['type']) && 
    isSequenceNumber(msg['seq']) && 
    isJsonObject(msg['parameters'])
);

export const isClientMessageBase = (msg: unknown): msg is ClientMessageBase & JsonObject => (
    isMessageBase(msg) &&
    isDuration(msg['position']) &&
    isSequenceNumber(msg['serverseq'])
);

export const isServerMessageBase = (msg: unknown): msg is ServerMessageBase & JsonObject => (
    isMessageBase(msg) &&
    isSequenceNumber(msg['clientseq'])
);



const clientMessageChecker: {
    readonly [key in ClientMessage['type']]: (params: JsonObject) => boolean 
} = {
    close:          isCloseParameters,
    discarded:      isDiscardedParameters,
    error:          isErrorParameters,
    open:           isOpenParameters,
    paused:         isPausedParameters,
    ping:           isPingParameters,
    reconnected:    isReconnectedParameters,
    reconnecting:   isReconnectingParameters,
    resumed:        isResumedParameters,
    update:         isUpdateParameters,
};


const serverMessageChecker: {
    readonly [key in ServerMessage['type']]: (params: JsonObject) => boolean 
} = {
    closed:         isClosedParameters,
    disconnect:     isDisconnectParameters,
    event:          isEventParameters,
    opened:         isOpenedParameters,
    pong:           isPongParameters,
    pause:          isPauseParameters,
    reconnect:      isReconnectParameters,
    resume:         isResumeParameters,
    updated:        isUpdatedParameters,
};


export const isClientMessageType = (type: string): type is ClientMessageType => {
    return type in clientMessageChecker;
};

export const isServerMessageType = (type: string): type is ServerMessageType => {
    return type in serverMessageChecker;
};

export const isClientMessage = (message: ClientMessageBase): message is ClientMessage => {
    const type = message.type;
    if(isClientMessageType(type)) {
        return clientMessageChecker[type](message.parameters);
    }
    return false;
};

export const isServerMessage = (message: ServerMessageBase): message is ServerMessage => {
    const type = message.type;
    if(isServerMessageType(type)) {
        return serverMessageChecker[type](message.parameters);
    }
    return false;
};

