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

import { EventEmitter } from 'events';
import { Logger } from './types';
import {
    Uuid,
    ServerMessage,
    ClientMessage,
    MediaParameter,
    MediaParameters,
    OpenParameters,
    DiscardedParameters,
    DisconnectReason,
    EventEntity,
    MediaDataFrame,
    StreamDuration,
} from './audiohook';
import { MaybePromise } from './utils';

export type State = 
    | 'PREPARING' 
    | 'OPENING' 
    | 'ACTIVE' 
    | 'PAUSED' 
    | 'CLOSING' 
    | 'CLOSED' 
    | 'SIGNALED-ERROR' 
    | 'UNAUTHORIZED' 
    | 'FINALIZING'
    | 'DISCONNECTED';

export type Authenticator = (session: Session, openParams: OpenParameters) => MaybePromise<void | boolean | string>;

export type MediaSelector = (session: Session, offered: MediaParameters, openParams: OpenParameters) => MaybePromise<MediaParameters>;

export type OpenHandler = (session: Session, selectedMedia: MediaParameter | null, openParams: OpenParameters) => MaybePromise<CloseHandler | void>;

export type CloseHandler = (session: Session) => MaybePromise<FiniHandler | void>;

export type FiniHandler = (session: Session) => MaybePromise<void>;

export type StatisticsInfo = {
    rtt: StreamDuration;
    // TODO: Add more
};

export type OnPausedHandler         = (this: Session) => void;
export type OnResumedHandler        = (this: Session) => void;
export type OnAudioHandler          = (this: Session, frame: MediaDataFrame) => void;
export type OnDiscardedHandler      = (this: Session, parameter: DiscardedParameters) => void;
export type OnStatisticsHandler     = (this: Session, info: StatisticsInfo) => void;
export type OnServerMessageHandler  = (this: Session, message: ServerMessage) => void;
export type OnClientMessageHandler  = (this: Session, message: ClientMessage) => void;

export interface Session extends EventEmitter {
    readonly id: Uuid;
    readonly logger: Logger;
    readonly selectedMedia: Readonly<MediaParameter> | null;
    readonly state: State;
    readonly position: StreamDuration;

    pause(): void;
    
    resume(): void;
    
    disconnect(reason: DisconnectReason, info?: string): void;
    disconnect(error: Error): void;
    
    sendEvent(entity: EventEntity): boolean;
    
    addAuthenticator(handler: Authenticator): this;
    addMediaSelector(handler: MediaSelector): this;
    addOpenHandler(handler: OpenHandler): this;
    addCloseHandler(handler: CloseHandler): this;
    addFiniHandler(handler: FiniHandler): this;

    on(event: 'paused', listener: OnPausedHandler): this;
    on(event: 'resumed', listener: OnResumedHandler): this;
    on(event: 'audio', listener: OnAudioHandler): this;
    on(event: 'discarded', listener: OnDiscardedHandler): this;
    on(event: 'statistics', listener: OnStatisticsHandler): this;
    on(event: 'serverMessage', listener: OnServerMessageHandler): this;
    on(event: 'clientMessage', listener: OnClientMessageHandler): this;

    off(event: 'paused', listener: OnPausedHandler): this;
    off(event: 'resumed', listener: OnResumedHandler): this;
    off(event: 'audio', listener: OnAudioHandler): this;
    off(event: 'discarded', listener: OnDiscardedHandler): this;
    off(event: 'statistics', listener: OnStatisticsHandler): this;
    off(event: 'serverMessage', listener: OnServerMessageHandler): this;
    off(event: 'clientMessage', listener: OnClientMessageHandler): this;

    once(event: 'paused', listener: OnPausedHandler): this;
    once(event: 'resumed', listener: OnResumedHandler): this;
    once(event: 'audio', listener: OnAudioHandler): this;
    once(event: 'discarded', listener: OnDiscardedHandler): this;
    once(event: 'statistics', listener: OnStatisticsHandler): this;
    once(event: 'serverMessage', listener: OnServerMessageHandler): this;
    once(event: 'clientMessage', listener: OnClientMessageHandler): this;

    addListener(event: 'paused', listener: OnPausedHandler): this;
    addListener(event: 'resumed', listener: OnResumedHandler): this;
    addListener(event: 'audio', listener: OnAudioHandler): this;
    addListener(event: 'discarded', listener: OnDiscardedHandler): this;
    addListener(event: 'statistics', listener: OnStatisticsHandler): this;
    addListener(event: 'serverMessage', listener: OnServerMessageHandler): this;
    addListener(event: 'clientMessage', listener: OnClientMessageHandler): this;

    removeListener(event: 'paused', listener: OnPausedHandler): this;
    removeListener(event: 'resumed', listener: OnResumedHandler): this;
    removeListener(event: 'audio', listener: OnAudioHandler): this;
    removeListener(event: 'discarded', listener: OnDiscardedHandler): this;
    removeListener(event: 'statistics', listener: OnStatisticsHandler): this;
    removeListener(event: 'serverMessage', listener: OnServerMessageHandler): this;
    removeListener(event: 'clientMessage', listener: OnClientMessageHandler): this;
}
