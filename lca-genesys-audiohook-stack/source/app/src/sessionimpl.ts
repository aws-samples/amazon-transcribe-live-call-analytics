// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from 'events';
import { Logger } from './types';
import {
    ClientMessage,
    CloseMessage,
    DiscardedMessage,
    DisconnectReason,
    ErrorMessage,
    EventEntity,
    MediaParameter,
    MessageDispatcher,
    OpenMessage,
    PausedMessage,
    PingMessage,
    ReconnectedMessage,
    ReconnectingMessage,
    ResumedMessage,
    SelectParametersForType,
    ServerMessage,
    ServerMessageBase,
    ServerMessageType,
    UpdateMessage,
    Uuid,
} from './audiohook/message';
import {
    isNullUuid,
    isClientMessageBase,
    isClientMessage,
    isClientMessageType
} from './audiohook/validators';
import {
    MediaDataFrame,
    mediaDataFrameFromMessage
} from './audiohook/mediadata';
import StreamDuration from './audiohook/streamduration';
import { 
    normalizeError,
    isPromise
} from './utils';
import {
    Authenticator,
    CloseHandler,
    FiniHandler,
    MediaSelector,
    OnAudioHandler,
    OnClientMessageHandler,
    OnDiscardedHandler,
    OnPausedHandler,
    OnResumedHandler,
    OnServerMessageHandler,
    OnStatisticsHandler,
    OpenHandler,
    Session,
    State,
    StatisticsInfo,
} from './session';


type StateToBooleanMap = {
    readonly [state in State]: boolean
};

// Map that indicates whether errors are signaled to client in a state.
const suppressErrorSignalStateMap: StateToBooleanMap = {
    'PREPARING': false,
    'OPENING': false,
    'ACTIVE': false,
    'PAUSED': false,
    'CLOSING': false,
    'CLOSED': true,
    'SIGNALED-ERROR': true,
    'UNAUTHORIZED': true,
    'FINALIZING': true,
    'DISCONNECTED': true,
};

// Map that indicates whether we can send disconnect in a state.
const sendDisconnectInState: StateToBooleanMap = {
    'PREPARING': true,
    'OPENING': true,
    'ACTIVE': true,
    'PAUSED': true,
    'CLOSING': false,
    'CLOSED': false,
    'SIGNALED-ERROR': false,
    'UNAUTHORIZED': false,
    'FINALIZING': false,
    'DISCONNECTED': false,
};


/**
 * Interface of methods the AudioHook server Session implementation requires from the WebSocket connection 
 * 
 * @see createSession
 */
export interface SessionWebSocket  {
    close(): void;
    send(data: string | Uint8Array): void;
    on(event: 'close', listener: (this: SessionWebSocket, code: number) => void): this;
    on(event: 'error', listener: (this: SessionWebSocket, err: Error) => void): this;
    on(event: 'message', listener: (this: SessionWebSocket, data: Uint8Array, isBinary: boolean) => void): this;
}

export const createSession = (ws: SessionWebSocket, id: Uuid, logger: Logger): Session => {
    return SessionImpl.create(ws, id, logger);
};


class SessionImpl extends EventEmitter implements Session {
    readonly ws: SessionWebSocket;
    readonly logger: Logger;
    readonly messageDispatch: MessageDispatcher<ClientMessage>;

    id: Uuid;
    seq = 0;
    clientseq = 0;
    selectedMedia: Readonly<MediaParameter> | null = null;
    position: StreamDuration = StreamDuration.zero;
    startPaused = false;
    state: State = 'PREPARING';
    lastPingTimestamp = process.hrtime.bigint();

    authenticators: Authenticator[] = [];
    mediaSelectors: MediaSelector[] = [];
    openHandlers: OpenHandler[] = [];
    closeHandlers: CloseHandler[] = [];
    finiHandlers: FiniHandler[] = [];

    private constructor(ws: SessionWebSocket, id: Uuid, logger: Logger) {
        super();
        this.ws = ws;
        this.id = id;
        this.logger = logger;
        this.registerHandlers();
        this.messageDispatch = {
            open: msg => this.onOpenMessage(msg),
            close: msg => this.onCloseMessage(msg),
            discarded: msg => this.onDiscardedMessage(msg),
            error: msg => this.onErrorMessage(msg),
            ping: msg => this.onPingMessage(msg),
            update: msg => this.onUpdateMessage(msg),
            paused: msg => this.onPausedMessage(msg),
            reconnected: msg => this.onReconnectedMessage(msg),
            reconnecting: msg => this.onReconnectingMessage(msg),
            resumed: msg => this.onResumedMessage(msg),
        } as const;
    }

    static create(ws: SessionWebSocket, id: Uuid, logger: Logger): Session {
        return new SessionImpl(ws, id, logger);
    }

    setState(state: State): void {
        this.state = state;
    }

    addAuthenticator(handler: Authenticator): this {
        if (this.state === 'PREPARING') {
            this.authenticators.push(handler);
        } else {
            throw new Error(`Cannot add authenticator in state ${this.state}`);
        }
        return this;
    }

    addMediaSelector(handler: MediaSelector): this {
        if (this.state === 'PREPARING') {
            this.mediaSelectors.push(handler);
        } else {
            throw new Error(`Cannot add media selector in state ${this.state}`);
        }
        return this;
    }

    addOpenHandler(handler: OpenHandler): this {
        if ((this.state === 'PREPARING') || (this.state === 'OPENING')) {
            this.openHandlers.push(handler);
        } else {
            throw new Error(`Cannot add open handler in state ${this.state}`);
        }
        return this;
    }

    addCloseHandler(handler: CloseHandler): this {
        if ((this.state !== 'FINALIZING') && (this.state !== 'DISCONNECTED')) {
            this.closeHandlers.push(handler);
        } else {
            throw new Error(`Cannot add close handler in state ${this.state}`);
        }
        return this;
    }

    addFiniHandler(handler: FiniHandler): this {
        if (this.state !== 'DISCONNECTED') {
            this.finiHandlers.push(handler);
        } else {
            throw new Error(`Cannot add fini handler in state ${this.state}`);
        }
        return this;
    }

    pause(): void {
        if ((this.state === 'OPENING') || (this.state === 'PREPARING')) {
            this.startPaused = true;
        } else if ((this.state === 'ACTIVE') || (this.state === 'PAUSED')) {
            // Note: We allow sending pause even if it's already paused (message is idempotent/interrogating)
            this.buildAndSendMessage('pause', {});
        }
    }

    resume(): void {
        if ((this.state === 'OPENING') || (this.state === 'PREPARING')) {
            this.startPaused = false;
        } else if ((this.state === 'ACTIVE') || (this.state === 'PAUSED')) {
            // Note: We allow sending resume even if it's already active (message is idempotent/interrogating)
            this.buildAndSendMessage('resume', {});
        }
    }

    disconnect(reason: DisconnectReason | Error, info?: string): void {
        if (sendDisconnectInState[this.state]) {
            if (reason instanceof Error) {
                this.signalError(reason);
            } else if (reason === 'error') {
                this.signalClientError(info ?? '');
            } else {
                if (reason === 'unauthorized') {
                    this.setState('UNAUTHORIZED');
                }
                this.buildAndSendMessage('disconnect', { reason, info });
            }
        }
    }

    sendEvent(entity: EventEntity): boolean {
        if ((this.state === 'ACTIVE') || (this.state === 'PAUSED') || (this.state === 'CLOSING')) {
            this.buildAndSendMessage('event', { entity });
            return true;
        } else {
            return false;
        }
    }

    registerHandlers(): void {
        this.ws.on('close', (code: number) => {
            try {
                this.onWsClose(code);
            } catch (err) {
                this.logger.error(`Error in WS close handler: ${normalizeError(err).stack}`);
            }
        });
        this.ws.on('message', (data, isBinary): void => {
            try {
                if (isBinary) {
                    this.onBinaryMessage(data);
                } else {
                    this.onTextMessage(Buffer.from(data).toString('utf8'));
                }
            } catch (err) {
                this.logger.error('Error processing message: ', normalizeError(err));
                this.signalError('Internal server error');
            }
        });
        this.ws.on('error', (error: Error) => {
            this.logger.error(`Websocket error, forcing close (SessionState: ${this.state}): `, error);
            this.ws.close();
        });
    }

    onWsClose(code: number): void {
        if (this.state !== 'CLOSED') {
            this.logger.warn(`onWsClose - Websocket closed in state ${this.state}! Code: ${code}"`);
        } else {
            this.logger.info(`onWsClose - Websocket closed. Code: ${code}`);
        }
        this.setState('FINALIZING');

        // Run close handlers in case we didn't get a close or if there are any stragglers. After that run all fini handlers.
        this.runCloseHandlers()
            .finally(() => {
                return this.runFiniHandlers();
            })
            .finally(() => {
                this.setState('DISCONNECTED');
                this.logger.info('onWsClose - All fini handlers completed, changed state to DISCONNECTED');
            });
    }

    buildAndSendMessage<Type extends ServerMessageType, Message extends ServerMessage>(type: Type, parameters: SelectParametersForType<Type, Message>): void {
        const msg: ServerMessageBase<Type, typeof parameters> = {
            version: '2',
            type,
            id: this.id,
            seq: ++this.seq,
            clientseq: this.clientseq,
            parameters
        };
        this.sendMessage(msg as ServerMessage);
    }

    sendMessage(message: ServerMessage): void {
        this.emit('serverMessage', message);
        const json = JSON.stringify(message);
        this.logger.debug(`sendMessage - ${json.substring(0, 2048)}`);
        this.ws.send(json);
    }

    signalError(error: Error): void;
    signalError(message: string): void;
    signalError(message: string, error: Error): void;
    signalError(messageOrError: Error | string, error?: Error): void {
        try {
            let info;
            if (messageOrError instanceof Error) {
                info = `Server error: ${messageOrError.message}`;
            } else if (error) {
                info = `${messageOrError}: ${error.message}`;
            } else {
                info = messageOrError;
            }
            if (suppressErrorSignalStateMap[this.state]) {
                this.logger.warn(`Server error signaling suppressed in state ${this.state}: ${info}`);
            } else {
                this.logger.warn(`Server error (state: ${this.state}): ${info}`);
                this.setState('SIGNALED-ERROR');
                this.buildAndSendMessage('disconnect', { reason: 'error', info: 'Internal Server Error' });
            }
        } catch (err) {
            this.logger.error(`signalError - Error signaling error: ${normalizeError(err).stack}`);
        }
    }

    signalClientError(info: string): void {
        try {
            if (suppressErrorSignalStateMap[this.state]) {
                this.logger.warn(`Client error signaling suppressed in state ${this.state}: ${info}`);
            } else {
                this.logger.warn(`Signaling error (state: ${this.state}): ${info}`);
                this.setState('SIGNALED-ERROR');
                this.buildAndSendMessage('disconnect', { reason: 'error', info: `Client Error: ${info}` });
            }
        } catch (err) {
            this.logger.error(`signalClientError - Error signaling error: ${normalizeError(err).stack}`);
        }
    }

    onTextMessage(data: string): void {
        if (data.length > 65535) {
            return this.signalClientError(`Text message too large (>64K). Length: ${data.length}`);
        }
        let message;
        try {
            message = JSON.parse(data);
        } catch (error) {
            this.logger.warn(`onTextMessage - Error parsing message as JSON (${normalizeError(error).message}). Data: ${JSON.stringify(data.substring(0, 512))}`);
            return this.signalClientError('Text message not valid JSON');
        }

        if (!isClientMessageBase(message)) {
            // Note: This does not check whether it's a message type we support; we do that below.
            this.logger.warn(`onTextMessage - Message not a valid client message: ${data.substr(0, 2048)}}`);
            return this.signalClientError('Message not a well-formed client message');
        }
        if (message.seq !== this.clientseq + 1) {
            this.logger.warn(`onTextMessage - Sequence number mismatch. CurClientseq=${this.clientseq}, message.seq=${message.seq} (Type: ${message.type})`);
            return this.signalClientError('Invalid seq value (not monotonically increasing)');
        }
        this.clientseq = message.seq;

        if (message.serverseq > this.seq) {
            // The serverseq reported by the client can't be higher than what we sent out.
            this.logger.warn(`onTextMessage - Client message serverseq (${message.serverseq}) is higher than servers's seq (${this.seq})`);
            return this.signalClientError('Invalid serverseq value');
        }

        if (message.id !== this.id) {
            if (isNullUuid(this.id)) {
                // ID wasn't set and this is the first message. Set it now!
                this.id = message.id;
            } else {
                this.logger.warn(`onTextMessage - Session id mismatch. Expected=${this.id}, Message: ${message.id}`);
                return this.signalClientError('Session identifier mismatch');
            }
        }

        if (!isClientMessage(message)) {
            if (isClientMessageType(message.type)) {
                // It's a client message we know, but the parameters are bad
                this.logger.warn(`onTextMessage - Invalid '${message.type}' message (parameters bad): ${JSON.stringify(message.parameters).substr(0, 1024)}`);
                return this.signalClientError('Invalid Message: Invalid/missing parameters');
            } else {
                // it's not a client message type we know
                this.logger.warn(`onTextMessage - Unknown client message type: '${message.type}'`);
                return this.signalClientError(`Invalid Message: '${message.type}' is not a supported client message`);
            }
        }
        this.position = StreamDuration.fromDuration(message.position);
        this.emit('clientMessage', message);
        this.messageDispatch[message.type](message as never);
    }

    onBinaryMessage(data: Uint8Array): void {
        this.logger.trace(`Binary message. Size: ${data.length}`);

        if (this.state !== 'ACTIVE') {
            this.signalClientError(`Received audio in state ${this.state}`);
            return;
        }
        if (!this.selectedMedia) {
            this.signalClientError('Unexpected binary message: No media selected');
            return;
        }

        let audioFrame;
        try {
            audioFrame = mediaDataFrameFromMessage(data, this.selectedMedia);
        } catch (err) {
            const info = `Binary data not a valid audio frame. Error: ${normalizeError(err).message}`;
            this.logger.warn(info);
            this.signalClientError(info);
            return;
        }
        this.onAudioData(audioFrame);
        this.position = this.position.withAddedSamples(audioFrame.sampleCount, audioFrame.rate);
    }

    onOpenMessage(message: OpenMessage): void {
        this.logger.debug(`onOpenMessage - ${JSON.stringify(message, null, 1)}`);
        if (this.state !== 'PREPARING') {
            this.logger.warn(`onOpenMessage - Ignoring 'open' message in state ${this.state}`);
            return;
        }
        this.setState('OPENING');
        
        /* eslint-disable @typescript-eslint/indent */
        this.runAuthenticators(message)
            .then<true|void>(() => {
                if (this.state === 'OPENING') {
                    return this.runMediaSelectors(message);
                } else {
                    this.logger.info(`onOpenMessage - State changed to ${this.state} during authentication`);
                    return true;
                }
            })
            .then<true|void>((logged) => {
                if (this.state === 'OPENING') {
                    this.logger.info(`onOpenMessage - Selected media: ${JSON.stringify(this.selectedMedia)}`);
                    return this.runOpenHandlers(message);
                } else {
                    if (!logged) {
                        this.logger.info(`onOpenMessage - State changed to ${this.state} during media selection`);
                    }
                    return true;
                }
            })
            .then((logged) => {
                if (this.state === 'OPENING') {
                    this.logger.info('onOpenMessage - Open handlers complete, session opened');
                    this.buildAndSendMessage('opened', {
                        media: this.selectedMedia ? [this.selectedMedia] : [],
                        startPaused: this.startPaused
                    });
                    this.setState('ACTIVE');
                } else if (!logged) {
                    this.logger.info(`onOpenMessage - State changed to ${this.state} during open handlers`);
                }
            })
            .catch(err => {
                const error = normalizeError(err);
                this.logger.error('onOpenMessage - Error during open transaction: ', error);
                this.signalError(error);
            });
        /* eslint-enable @typescript-eslint/indent */
    }

    onCloseMessage(message: CloseMessage): void {
        this.logger.debug(`onCloseMessage - ${JSON.stringify(message, null, 1)}`);
        if (this.state === 'CLOSING') {
            this.logger.info(`onCloseMessage - Ignoring message in state ${this.state}`);
            return;
        }

        // Note: Close transaction is pretty much OK in any state (other than if we're already closing)
        // TODO: Do we need to behave differently if state is UNAUTHORIZED?
        this.logger.info(`onCloseMessage - Closing session (state: ${this.state})...`);
        this.setState('CLOSING');
        this.runCloseHandlers()
            .finally(() => {
                this.logger.info('onCloseMessage - Close handlers completed, session closed');
                if (this.state === 'CLOSING') {
                    this.buildAndSendMessage('closed', {});
                    this.setState('CLOSED');
                }
            });
    }

    onErrorMessage(message: ErrorMessage): void {
        this.logger.warn(`onErrorMessage - ${JSON.stringify(message, null, 1)}`);
        // TODO: Handle
    }

    onPingMessage(message: PingMessage): void {
        this.logger.debug(`onPingMessage - RTT: ${message.parameters.rtt ?? ''}`);
        this.buildAndSendMessage('pong', {});
        this.lastPingTimestamp = process.hrtime.bigint();
        if (message.parameters.rtt) {
            const info: StatisticsInfo = {
                rtt: StreamDuration.fromDuration(message.parameters.rtt)
            };
            this.emit('statistics', info);
        }
    }

    onDiscardedMessage(message: DiscardedMessage): void {
        this.logger.debug(`onDiscardedMessage - ${JSON.stringify(message, null, 1)}`);
        this.emit('discarded', message.parameters);
    }

    onUpdateMessage(message: UpdateMessage): void {
        this.logger.info(`onUpdateMessage - ${JSON.stringify(message, null, 1)}`);
    }

    onPausedMessage(message: PausedMessage): void {
        this.logger.debug(`onPausedMessage - ${JSON.stringify(message, null, 1)}`);
        if (this.state === 'ACTIVE') {
            this.setState('PAUSED');
            this.emit('paused');
        }
    }

    onReconnectedMessage(message: ReconnectedMessage): void {
        this.logger.info(`onReconnectedMessage - ${JSON.stringify(message, null, 1)}`);
    }

    onReconnectingMessage(message: ReconnectingMessage): void {
        this.logger.info(`onReconnectingMessage - ${JSON.stringify(message, null, 1)}`);
    }

    onResumedMessage(message: ResumedMessage): void {
        this.logger.debug(`onResumedMessage - ${JSON.stringify(message, null, 1)}`);
        if (this.state === 'PAUSED') {
            this.setState('ACTIVE');
            this.emit('resumed');
        }
    }

    onAudioData(frame: MediaDataFrame): void {
        this.emit('audio', frame);
    }

    async runAuthenticators(message: OpenMessage): Promise<void> {
        for (let handler = this.authenticators.shift(); (handler && (this.state === 'OPENING')); handler = this.authenticators.shift()) {
            try {
                // We allow handlers to fail the authentication by returning false, a non-empty string, or invoke disconnect() with 'unauthorized' itself.
                // Errors are signaled as regular server error (disconnect with reason 'error')
                const result = await handler(this, message.parameters);
                if (this.state !== 'OPENING') {
                    // State changed while we were out, we're done here.
                    break;
                }
                if (typeof result === 'boolean') {
                    if (!result) {
                        this.disconnect('unauthorized');
                    }
                } else if (typeof result === 'string') {
                    if (result.length !== 0) {
                        this.disconnect('unauthorized', result);
                    }
                }
            } catch (err) {
                const error = normalizeError(err);
                this.logger.error('runAuthenticators - Error running authentication handler: ', error);
                this.signalError(error);
            }
        }
    }

    async runMediaSelectors(message: OpenMessage): Promise<void> {
        let offered = message.parameters.media;
        for (let handler = this.mediaSelectors.shift(); (handler && (this.state === 'OPENING')); handler = this.mediaSelectors.shift()) {
            offered = await handler(this, offered, message.parameters);
        }
        if (this.state === 'OPENING') {
            // Pick the first media format from the ones that survived the selectors' filters. 
            // If there weren't any media selectors, this will just pick the first offered.
            this.selectedMedia = offered[0] ?? null;
        }
    }

    async runOpenHandlers(message: OpenMessage): Promise<void> {
        // Run all open handlers. We allow registering of open handlers while other open handlers run.
        // So we just run through the list until the list is empty.
        while ((this.openHandlers.length !== 0) && (this.state === 'OPENING')) {
            // Note: we initiate all handlers in parallel and then wait for the promises to settle
            const promises: Array<PromiseLike<CloseHandler | void>> = [];
            for (let handler = this.openHandlers.shift(); handler; handler = this.openHandlers.shift()) {
                try {
                    const result = handler(this, this.selectedMedia, message.parameters);
                    if (isPromise(result)) {
                        promises.push(result);
                    } else if (result) {
                        this.closeHandlers.push(result);
                    }
                } catch (err) {
                    promises.push(Promise.reject(err));
                }
            }
            const results = await Promise.allSettled(promises);
            let err: unknown = null;
            results.forEach(result => {
                if (result.status === 'rejected') {
                    err = result.reason;
                } else if (result.value) {
                    this.closeHandlers.push(result.value);
                }
            });
            if (err) {
                throw err;  // Rethrow the last one 
            }
        }
    }

    async runCloseHandlers(): Promise<void> {
        // Run all close handlers. We allow close handlers getting added while the close handlers run.
        while (this.closeHandlers.length !== 0) {
            const promises: Array<PromiseLike<FiniHandler | void>> = [];
            for (let handler = this.closeHandlers.shift(); handler; handler = this.closeHandlers.shift()) {
                try {
                    const result = handler(this);
                    if (isPromise(result)) {
                        promises.push(result);
                    } else if (result) {
                        this.finiHandlers.push(result);
                    }
                } catch (err) {
                    promises.push(Promise.reject(err));
                }
            }
            const results = await Promise.allSettled(promises);
            results.forEach(result => {
                if (result.status === 'rejected') {
                    this.logger.warn('Error executing close handler: ', normalizeError(result.reason));
                } else if (result.value) {
                    this.finiHandlers.push(result.value);
                }
            });
        }
    }

    async runFiniHandlers(): Promise<void> {
        while (this.finiHandlers.length !== 0) {
            const promises: Array<PromiseLike<void>> = [];
            for (let handler = this.finiHandlers.shift(); handler; handler = this.finiHandlers.shift()) {
                try {
                    const result = handler(this);
                    if (isPromise(result)) {
                        promises.push(result);
                    }
                } catch (err) {
                    promises.push(Promise.reject(err));
                }
            }
            const results = await Promise.allSettled(promises);
            results.forEach(result => {
                if (result.status === 'rejected') {
                    this.logger.warn('Error executing fini handler: ', normalizeError(result.reason));
                }
            });
        }
    }

    override emit(eventName: 'paused', ...args: Parameters<OmitThisParameter<OnPausedHandler>>): boolean;
    override emit(eventName: 'resumed', ...args: Parameters<OmitThisParameter<OnResumedHandler>>): boolean;
    override emit(eventName: 'audio', ...args: Parameters<OmitThisParameter<OnAudioHandler>>): boolean;
    override emit(eventName: 'discarded', ...args: Parameters<OmitThisParameter<OnDiscardedHandler>>): boolean;
    override emit(eventName: 'statistics', ...args: Parameters<OmitThisParameter<OnStatisticsHandler>>): boolean;
    override emit(eventName: 'serverMessage', ...args: Parameters<OmitThisParameter<OnServerMessageHandler>>): boolean;
    override emit(eventName: 'clientMessage', ...args: Parameters<OmitThisParameter<OnClientMessageHandler>>): boolean;
    override emit(eventName: string, ...args: unknown[]): boolean {
        return super.emit(eventName, ...args);
    }
}
