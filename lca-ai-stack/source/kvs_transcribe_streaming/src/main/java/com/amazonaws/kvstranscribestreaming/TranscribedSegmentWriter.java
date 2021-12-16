package com.amazonaws.kvstranscribestreaming;

import com.amazonaws.services.dynamodbv2.document.DynamoDB;
import com.amazonaws.services.dynamodbv2.document.Item;
import org.apache.commons.lang3.Validate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.services.transcribestreaming.model.Result;
import software.amazon.awssdk.services.transcribestreaming.model.TranscriptEvent;

import java.text.NumberFormat;
import java.time.Instant;
import java.util.List;

/**
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
public class TranscribedSegmentWriter {

    private String callId;
    private String transactionId;
    private String streamARN;
    private DynamoDB ddbClient;
    private Boolean consoleLogTranscriptFlag;
    private static final boolean SAVE_PARTIAL_TRANSCRIPTS = Boolean.parseBoolean(System.getenv().getOrDefault("SAVE_PARTIAL_TRANSCRIPTS", "TRUE"));
    private static final Integer EXPIRATION_IN_DAYS = Integer.parseInt(System.getenv().getOrDefault("EXPIRATION_IN_DAYS", "90"));
    private static final Logger logger = LoggerFactory.getLogger(TranscribedSegmentWriter.class);
    private static final String eventType = "ADD_TRANSCRIPT_SEGMENT";

    public TranscribedSegmentWriter(String callId, String transactionId, String streamARN, DynamoDB ddbClient, Boolean consoleLogTranscriptFlag) {

        this.callId = Validate.notNull(callId);
        this.transactionId = Validate.notNull(transactionId);
        this.streamARN = Validate.notNull(streamARN);
        this.ddbClient = Validate.notNull(ddbClient);
        this.consoleLogTranscriptFlag = Validate.notNull(consoleLogTranscriptFlag);
    }

    public String getCallId() {

        return this.callId;
    }

    public String getTransactionId() {

        return this.transactionId;
    }

    public String getStreamARN() {

        return this.streamARN;
    }

    public DynamoDB getDdbClient() {

        return this.ddbClient;
    }

    public void writeToDynamoDB(TranscriptEvent transcriptEvent, String tableName, String channel) {
        logger.info("table name: " + tableName);
        logger.info("Transcription event: " + transcriptEvent.transcript().toString());
        List<Result> results = transcriptEvent.transcript().results();
        if (results.size() > 0) {

            Result result = results.get(0);

            if (SAVE_PARTIAL_TRANSCRIPTS || !result.isPartial()) {
                try {
                    Item ddbItem = toDynamoDbItem(result, channel);
                    if (ddbItem != null) {
                        getDdbClient().getTable(tableName).putItem(ddbItem);
                    }

                } catch (Exception e) {
                    logger.error("Exception while writing to DDB: ", e);
                }
            }
        }
    }

    private Item toDynamoDbItem(Result result, String channel) {

        String callId = this.getCallId();
        String transactionId = this.getTransactionId();
        String streamARN = this.getStreamARN();
        Item ddbItem = null;

        NumberFormat nf = NumberFormat.getInstance();
        nf.setMinimumFractionDigits(3);
        nf.setMaximumFractionDigits(3);

        if (result.alternatives().size() > 0) {
            if (!result.alternatives().get(0).transcript().isEmpty()) {

                Instant now = Instant.now();
                ddbItem = new Item()
                        .withKeyComponent("PK", String.format("ce#%s", callId))
                        .withKeyComponent("SK", String.format("ts#%s#et#%s#c#%s", now.toString(), eventType, channel))
                        .withString("Channel", channel)
                        .withString("StreamArn", streamARN)
                        .withString("TransactionId", transactionId)
                        .withString("CallId", callId)
                        .withString("SegmentId", result.resultId())
                        .withDouble("StartTime", result.startTime())
                        .withDouble("EndTime", result.endTime())
                        .withString("Transcript", result.alternatives().get(0).transcript())
                        .withBoolean("IsPartial", result.isPartial())
                        .withString("EventType", eventType)
                        .withString("CreatedAt", now.toString())
                        .withDouble("ExpiresAfter", now.plusSeconds(EXPIRATION_IN_DAYS * 24 * 3600).toEpochMilli() / 1000);

                if (consoleLogTranscriptFlag) {
                    logger.info(String.format("Thread %s %d: [%s, %s] - %s",
                            Thread.currentThread().getName(),
                            System.currentTimeMillis(),
                            nf.format(result.startTime()),
                            nf.format(result.endTime()),
                            result.alternatives().get(0).transcript()));
                }
            }
        }

        return ddbItem;
    }
}
