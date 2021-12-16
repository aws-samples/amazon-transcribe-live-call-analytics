package com.amazonaws.transcribestreaming;

import com.amazonaws.kvstranscribestreaming.TranscribedSegmentWriter;
import com.amazonaws.kvstranscribestreaming.TranscriptionStatusWriter;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.services.transcribestreaming.model.StartStreamTranscriptionResponse;
import software.amazon.awssdk.services.transcribestreaming.model.TranscriptEvent;
import software.amazon.awssdk.services.transcribestreaming.model.TranscriptResultStream;

/**
 * Implementation of StreamTranscriptionBehavior to define how a stream response is handled.
 *
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * 
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
public class StreamTranscriptionBehaviorImpl implements StreamTranscriptionBehavior {

    private static final Logger logger = LoggerFactory.getLogger(StreamTranscriptionBehaviorImpl.class);
    private final TranscribedSegmentWriter segmentWriter;
    private final TranscriptionStatusWriter statusWriter;
    private final String tableName;
    private final String channel;

    public StreamTranscriptionBehaviorImpl(
        TranscribedSegmentWriter segmentWriter, TranscriptionStatusWriter statusWriter, String tableName, String channel
    ) {
        this.segmentWriter = segmentWriter;
        this.statusWriter = statusWriter;
        this.tableName = tableName;
        this.channel = channel;
    }

    @Override
    public void onError(Throwable e) {
        statusWriter.writeToDynamoDB(tableName, channel, "TRANSCRIPT_ERROR");
        logger.error("Error in middle of stream: ", e);
    }

    @Override
    public void onStream(TranscriptResultStream e) {
        // EventResultStream has other fields related to the timestamp of the transcripts in it.
        // Please refer to the javadoc of TranscriptResultStream for more details
        segmentWriter.writeToDynamoDB((TranscriptEvent) e, tableName, channel);
    }

    @Override
    public void onResponse(StartStreamTranscriptionResponse r) {
        logger.info(String.format("%d Received Initial response from Transcribe. Request Id: %s",
                System.currentTimeMillis(), r.requestId()));
        statusWriter.writeToDynamoDB(tableName, channel, "START_TRANSCRIPT");
    }

    @Override
    public void onComplete() {
        logger.info("Transcribe stream completed");
        statusWriter.writeToDynamoDB(tableName, channel, "END_TRANSCRIPT");
    }
}

