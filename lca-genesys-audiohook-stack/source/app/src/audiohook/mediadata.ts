/**
 *
 * @author felix.wyss@genesys.com 
 * @copyright (c) 2021 Genesys.  All rights reserved
 * 
 * This code is provided through a limited license and under NDA.  It is not intended for 
 * public disclosure or consumption or distribution outside of the AudioHook beta program.
 */
import { MediaParameter, MediaFormat, MediaRate, MediaChannel } from './message';
import { AudioFrame, createAudioFrame } from '../audio';

export type MediaDataFrame = AudioFrame<MediaChannel, MediaFormat, MediaRate>;

export const mediaDataFrameFromMessage = (data: Uint8Array, mediaParameter: MediaParameter): MediaDataFrame => {
    return createAudioFrame(data, mediaParameter);
};
