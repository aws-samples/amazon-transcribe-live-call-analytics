package com.amazonaws.kvstranscribestreaming;

/**
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

import java.util.Optional;
import software.amazon.awssdk.services.transcribestreaming.model.LanguageCode;

public class TranscriptionRequest {

    String streamARN = null;
    String inputFileName = null;
    String startFragmentNum = null;
    String connectCallId = null;
    String transactionId = null;
    Optional<String> languageCode = Optional.empty();
    boolean transcriptionEnabled = false;
    Optional<Boolean> saveCallRecording = Optional.empty();
    boolean streamAudioFromCustomer = true;
    boolean streamAudioToCustomer = true;

    public String getStreamARN() {

        return this.streamARN;
    }

    public void setStreamARN(String streamARN) {

        this.streamARN = streamARN;
    }

    public String getInputFileName() {

        return this.inputFileName;
    }

    public void setInputFileName(String inputFileName) {

        this.inputFileName = inputFileName;
    }

    public String getStartFragmentNum() {

        return this.startFragmentNum;
    }

    public void setStartFragmentNum(String startFragmentNum) {

        this.startFragmentNum = startFragmentNum;
    }

    public String getConnectCallId() {

        return this.connectCallId;
    }

    public void setConnectCallId(String connectCallId) {

        this.connectCallId = connectCallId;
    }

    public String getTransactionId() {

        return this.transactionId;
    }

    public void setTransactionId(String transactionId) {

        this.transactionId = transactionId;
    }

    public Optional<String> getLanguageCode() {

        return this.languageCode;
    }

    public void setLanguageCode(String languageCode) {

        if ((languageCode != null) && (languageCode.length() > 0)) {

            this.languageCode = Optional.of(languageCode);
        }
    }

    public void setTranscriptionEnabled(boolean enabled) {
        transcriptionEnabled = enabled;
    }

    public boolean isTranscriptionEnabled() {
        return  transcriptionEnabled;
    }

    public void setStreamAudioFromCustomer(boolean enabled) {
        streamAudioFromCustomer = enabled;
    }

    public boolean isStreamAudioFromCustomer() {
        return  streamAudioFromCustomer;
    }

    public void setStreamAudioToCustomer(boolean enabled) {
        streamAudioToCustomer = enabled;
    }

    public boolean isStreamAudioToCustomer() {
        return  streamAudioToCustomer;
    }

    public void setSaveCallRecording(boolean shouldSaveCallRecording) {

        saveCallRecording = Optional.of(shouldSaveCallRecording);
    }

    public Optional<Boolean> getSaveCallRecording() {
        return saveCallRecording;
    }

    public boolean isSaveCallRecordingEnabled() {

        return (saveCallRecording.isPresent() ? saveCallRecording.get() : false);
    }

    public String toString() {

        return String.format("streamARN=%s, startFragmentNum=%s, connectCallId=%s, languageCode=%s, transcriptionEnabled=%s, saveCallRecording=%s, streamAudioFromCustomer=%s, streamAudioToCustomer=%s",
                getStreamARN(), getStartFragmentNum(), getConnectCallId(), getLanguageCode(), isTranscriptionEnabled(), isSaveCallRecordingEnabled(), isStreamAudioFromCustomer(), isStreamAudioToCustomer());
    }

    public void validate() throws IllegalArgumentException {

        // complain if both are provided
        if ((getStreamARN() != null) && (getInputFileName() != null))
            throw new IllegalArgumentException("At most one of streamARN or inputFileName must be provided");
        // complain if none are provided
        if ((getStreamARN() == null) && (getInputFileName() == null))
            throw new IllegalArgumentException("One of streamARN or inputFileName must be provided");

        // language code is optional; if provided, it should be one of the values accepted by
        // https://docs.aws.amazon.com/transcribe/latest/dg/API_streaming_StartStreamTranscription.html#API_streaming_StartStreamTranscription_RequestParameters
        if (languageCode.isPresent()) {
            if (!LanguageCode.knownValues().contains(LanguageCode.fromValue(languageCode.get()))) {
                throw new IllegalArgumentException("Incorrect language code");
            }
        }
    }

}
