import { Session, OpenHandler } from './session';
import { MediaDataFrame, MediaFormat, MediaChannel } from './audiohook';
import { WavFileWriter } from './audio';
import { MaybePromise } from './utils';
import path from 'path';

export type WavWriterCompletionHandler = (filename: string, samplesWritten: number, session: Session) => MaybePromise<void>;

export const createMonoWavWriter = (outDir: string, onCompleted: WavWriterCompletionHandler, channel: MediaChannel, format?: MediaFormat): OpenHandler => {
    return async (session, selectedMedia) => {
        if(!selectedMedia?.channels.includes(channel)) {
            return;
        }
        const fmt = format ?? selectedMedia.format;
        const writer = await WavFileWriter.create(path.join(outDir, `${session.id}-${fmt.toLowerCase()}-${channel}.wav`), fmt, 8000, 1);
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
    return async (session, selectedMedia) => {
        if(!selectedMedia) {
            return;
        }
        const fmt = format ?? selectedMedia.format;
        const writer = await WavFileWriter.create(path.join(outDir, `${session.id}-${fmt.toLowerCase()}.wav`), fmt, 8000, selectedMedia?.channels.length ?? 0);

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
