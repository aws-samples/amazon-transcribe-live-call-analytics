export type Uuid = string;             // UUID as defined by RFC#4122

export type SequenceNumber = number;   // Non-negative integer

export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;

export type JsonArray = JsonValue[];

export type JsonObject = {
    [key: string]: JsonValue
};

export type EmptyObject = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [K in any] : never
}

export type Duration = `PT${number}S`; // ISO8601 duration in seconds, where 'number' in non-negative decimal representation

export type MessageBase<Type extends string = string, Parameters extends JsonObject = JsonObject> = {
    version: '2';
    id: Uuid;
    type: Type;
    seq: SequenceNumber;
    parameters: Parameters;
}

export type ClientMessageBase<T extends string = string, P extends JsonObject = JsonObject> = MessageBase<T, P> & {
    serverseq: SequenceNumber;
    position: Duration;
}


export type ServerMessageBase<T extends string = string, P extends JsonObject = JsonObject> = MessageBase<T, P> & {
    clientseq: SequenceNumber;
}


export type CloseReason = 'disconnect' | 'end' | 'error';


export type CloseParameters = {
    reason: CloseReason;
};

export type ClosedParameters = EmptyObject;


export type DiscardedParameters = {
    start: Duration;
    discarded: Duration;
}

export type DisconnectReason = 'completed' | 'unauthorized' | 'error';

export type DisconnectParameters = {
    reason: DisconnectReason;
    info?: string;
};


export type ErrorCode = 
    | 400
    | 405
    | 408
    | 409 
    | 413 
    | 415 
    | 429
    | 500
    | 503;

export type ErrorParameters = {
    code: ErrorCode;
    message: string;    
    retryAfter?: Duration;  // Used by client rate limiter (429)
}


export type EventEntityBase<T extends string, D extends JsonValue> = {
    type: T;
    data: D;
}

export type EventEntity =
    | EventEntityBase<string, JsonValue>;

export type EventParameters = {
    entity: EventEntity;
}


export type MediaChannel = 'external' | 'internal';

export type MediaChannels = MediaChannel[];

export type MediaType = 'audio';

export type MediaFormat = 'PCMU' | 'L16';

export type MediaRate = 8000;

export type MediaParameter = {
    type: MediaType;
    format: MediaFormat;
    channels: MediaChannels;
    rate: MediaRate;
}

export type MediaParameters = MediaParameter[];


export type Participant = {
    id: Uuid;
    ani: string;
    aniName: string;
    dnis: string;
}

export type ContinuedSession = {
    id: Uuid;
    serverseq: SequenceNumber;
    clientseq: SequenceNumber;
}

export type ContinuedSessions = ContinuedSession[];


export type OpenParameters = {
    organizationId: Uuid;
    conversationId: Uuid;
    participant: Participant;
    media: MediaParameters;
    continuedSessions?: ContinuedSessions;
    customConfig?: JsonObject;
};

export type OpenedParameters = {
    media: MediaParameters;
    startPaused?: boolean;
}


export type PauseParameters = EmptyObject;



export type PausedParameters = EmptyObject;


export type PingParameters = {
    rtt?: Duration;
};

export type PongParameters = EmptyObject;



export type ReconnectReason = 'rebalance' | 'error';

export type ReconnectParameters = {
    reason: ReconnectReason;
    info?: string;
};

export type ReconnectedParameters = EmptyObject;

export type ReconnectingParameters = EmptyObject;


export type ResumeParameters = EmptyObject;

export type ResumedParameters = {
    start: Duration;
    discarded: Duration;
};


export type UpdateParameters = EmptyObject;


export type UpdatedParameters = EmptyObject;



export type CloseMessage = ClientMessageBase<'close', CloseParameters>;

export type ClosedMessage = ServerMessageBase<'closed', ClosedParameters>;

export type DiscardedMessage = ClientMessageBase<'discarded', DiscardedParameters>;

export type DisconnectMessage = ServerMessageBase<'disconnect', DisconnectParameters>;

export type ErrorMessage = ClientMessageBase<'error', ErrorParameters>;

export type EventMessage = ServerMessageBase<'event', EventParameters>;

export type OpenMessage = ClientMessageBase<'open', OpenParameters>;

export type OpenedMessage = ServerMessageBase<'opened', OpenedParameters>;

export type PauseMessage = ServerMessageBase<'pause', PauseParameters>;

export type PausedMessage = ClientMessageBase<'paused', PausedParameters>;

export type PingMessage = ClientMessageBase<'ping', PingParameters> ;

export type PongMessage = ServerMessageBase<'pong', PongParameters> ;

export type ReconnectMessage = ServerMessageBase<'reconnect', ReconnectParameters>;

export type ReconnectedMessage = ClientMessageBase<'reconnected', ReconnectedParameters>;

export type ReconnectingMessage = ClientMessageBase<'reconnecting', ReconnectingParameters>;

export type ResumeMessage = ServerMessageBase<'resume', ResumeParameters>;

export type ResumedMessage = ClientMessageBase<'resumed', ResumedParameters>;

export type UpdateMessage = ClientMessageBase<'update', UpdateParameters>;

export type UpdatedMessage = ServerMessageBase<'updated', UpdatedParameters>;


export type ClientMessage =
    | CloseMessage
    | DiscardedMessage
    | ErrorMessage
    | OpenMessage
    | PausedMessage
    | PingMessage
    | ReconnectedMessage
    | ReconnectingMessage
    | ResumedMessage
    | UpdateMessage;

export type ServerMessage =
    | ClosedMessage
    | DisconnectMessage
    | EventMessage
    | OpenedMessage
    | PauseMessage
    | PongMessage
    | ReconnectMessage
    | ResumeMessage
    | UpdatedMessage;

export type Message = ClientMessage | ServerMessage;

export type ClientMessageType = ClientMessage['type'];
export type ClientMessageParameters = ClientMessage['parameters'];

export type ServerMessageType = ServerMessage['type'];
export type ServerMessageParameters = ServerMessage['parameters'];

export type MessageType = ClientMessageType | ServerMessageType;
export type MessageParameters = ClientMessageParameters | ServerMessageParameters;

export type SelectParametersForType<T extends string, M> = M extends {type: T, parameters: infer P} ? P : never;
export type SelectMessageForType<T extends string, M> = M extends {type: T} ? M : never;

export type MessageDispatcher<M extends Message, R = void> = {
    readonly [T in M['type']]: (message: SelectMessageForType<T, M>) => R;
}
