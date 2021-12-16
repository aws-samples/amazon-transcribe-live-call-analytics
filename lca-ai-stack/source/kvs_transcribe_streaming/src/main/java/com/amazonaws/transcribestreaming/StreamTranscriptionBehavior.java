package com.amazonaws.transcribestreaming;

import software.amazon.awssdk.services.transcribestreaming.model.StartStreamTranscriptionResponse;
import software.amazon.awssdk.services.transcribestreaming.model.TranscriptResultStream;

/**
 * Defines how a stream response should be handled.
 * You should build a class implementing this interface to define the behavior.
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
public interface StreamTranscriptionBehavior {
    /**
     * Defines how to respond when encountering an error on the stream transcription.
     *
     * @param e The exception
     */
    void onError(Throwable e);

    /**
     * Defines how to respond to the Transcript result stream.
     *
     * @param e The TranscriptResultStream event
     */
    void onStream(TranscriptResultStream e);

    /**
     * Defines what to do on initiating a stream connection with the service.
     *
     * @param r StartStreamTranscriptionResponse
     */
    void onResponse(StartStreamTranscriptionResponse r);

    /**
     * Defines what to do on stream completion
     */
    void onComplete();
}