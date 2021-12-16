package com.amazonaws.kvstranscribestreaming;

import com.amazonaws.services.dynamodbv2.document.DynamoDB;
import com.amazonaws.services.dynamodbv2.document.Item;
import org.apache.commons.lang3.Validate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;

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
public class TranscriptionStatusWriter {
    private String callId;
    private DynamoDB ddbClient;
    private String transactionId;
    private String streamARN;
    private static final Integer EXPIRATION_IN_DAYS = Integer.parseInt(System.getenv().getOrDefault("EXPIRATION_IN_DAYS", "90"));
    private static final Logger logger = LoggerFactory.getLogger(TranscriptionStatusWriter.class);

    public TranscriptionStatusWriter(String callId, String transactionId, String streamARN, DynamoDB ddbClient) {
        this.callId = Validate.notNull(callId);
        this.ddbClient = Validate.notNull(ddbClient);
        this.transactionId = Validate.notNull(transactionId);
        this.streamARN = Validate.notNull(streamARN);
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

    public void writeToDynamoDB(String tableName, String channel, String status) {
        logger.info(
            "Transcription status - table: {} callId: {} channel: {} status: {}",
            tableName, this.getCallId(), channel, status
        );
        try {
            Item ddbItem = toDynamoDbItem(status, channel);
            if (ddbItem != null) {
                getDdbClient().getTable(tableName).putItem(ddbItem);
            }
        } catch (Exception e) {
            logger.error("Exception while writing transcription status to DDB: ", e);
        }
    }

    private Item toDynamoDbItem(String status, String channel) {

        String callId = this.getCallId();
        String transactionId = this.getTransactionId();
        String streamARN = this.getStreamARN();
        Item ddbItem = null;

        Instant now = Instant.now();
        ddbItem = new Item()
            .withKeyComponent("PK", String.format("ce#%s", callId))
            .withKeyComponent("SK", String.format("ts#%s#et%s#c#%s", now.toString(), status, channel))
            .withString("CallId", callId)
            .withString("Channel", channel)
            .withString("StreamArn", streamARN)
            .withString("TransactionId", transactionId)
            .withString("EventType", status)
            .withString("CreatedAt", now.toString())
            .withDouble("ExpiresAfter", now.plusSeconds(EXPIRATION_IN_DAYS * 24 * 3600).toEpochMilli() / 1000);

        return ddbItem;
    }
}
