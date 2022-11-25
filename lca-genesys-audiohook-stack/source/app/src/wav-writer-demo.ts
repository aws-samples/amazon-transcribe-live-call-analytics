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

import { Session, OpenHandler } from './session';
import { MediaDataFrame, MediaFormat, MediaChannel } from './audiohook';
import { WavFileWriter } from './audio';
import { MaybePromise } from './utils';
import path from 'path';

export type WavWriterCompletionHandler = (filename: string, samplesWritten: number, session: Session) => MaybePromise<void>;

export const createMonoWavWriter = (outDir: string, onCompleted: WavWriterCompletionHandler, channel: MediaChannel, format?: MediaFormat): OpenHandler => {
    return async (session, selectedMedia, openParms) => {
        if(!selectedMedia?.channels.includes(channel)) {
            return;
        }
        const fmt = format ?? selectedMedia.format;
        const writer = await WavFileWriter.create(path.join(outDir, `${openParms.conversationId}-${fmt.toLowerCase()}-${channel}.wav`), fmt, 8000, 1);
        const handler = (frame: MediaDataFrame) => {
            const external = frame.getChannelView(channel, fmt);
            writer.writeAudio(external.data);
        };

        session.on('audio', handler);

        return async () => {
            session.off('audio', handler);
            const written = await writer.close();
            await onCompleted(writer.filename, written, session);
        };
    };
};

export const createWavWriter = (outDir: string, onCompleted: WavWriterCompletionHandler, format?: MediaFormat): OpenHandler => {
    return async (session, selectedMedia, openParms) => {
        if(!selectedMedia) {
            return;
        }
        
        const fmt = format ?? selectedMedia.format;
        const writer = await WavFileWriter.create(path.join(outDir, `${openParms.conversationId}.wav`), fmt, 8000, selectedMedia?.channels.length ?? 0);

        const handler = (frame: MediaDataFrame) => {
            writer.writeAudio(frame.as(fmt).audio.data);
        };

        session.on('audio', handler);

        return async () => {
            session.off('audio', handler);
            const written = await writer.close();
            await onCompleted(writer.filename, written, session);
        };
    };
};
