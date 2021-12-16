package com.amazonaws.kvstranscribestreaming;

import com.amazonaws.services.cloudwatch.AmazonCloudWatch;
import com.amazonaws.services.cloudwatch.AmazonCloudWatchClientBuilder;
import com.amazonaws.services.sqs.AmazonSQS;
import com.amazonaws.services.sqs.AmazonSQSClientBuilder;
import com.amazonaws.services.sqs.model.Message;
import com.amazonaws.services.sqs.model.ReceiveMessageRequest;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
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

public class SQSProcessor {
    private static final Logger logger = LoggerFactory.getLogger(SQSProcessor.class);
    private static final String QUEUE_NAME = System.getenv("QUEUE_NAME");
    private static final int MAX_THREADS = Integer.parseInt(System.getenv().getOrDefault("MAX_THREADS", "30"));

    private static class RecordingThread implements Runnable {
        private String message;
        private static final Logger logger = LoggerFactory.getLogger(RecordingThread.class);
        private ObjectMapper mapper = new ObjectMapper()
                .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
        private final AmazonCloudWatch cw = AmazonCloudWatchClientBuilder.defaultClient();

        public RecordingThread(String message) {
            this.message = message;
        }

        public void run() {
            KVSRecordingTask task = new KVSRecordingTask();
            try {
                RecordingRequest request = mapper.readValue(this.message, RecordingRequest.class);
                logger.info("Got a request");
                task.handleRequest(request);
            } catch (IOException e ) {
                e.printStackTrace();
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
    }

    public static void main(String ... args) {
        ThreadPoolExecutor threadPool = (ThreadPoolExecutor) Executors.newFixedThreadPool(MAX_THREADS);

        /* Print a status every 10 seconds */
        ScheduledExecutorService statusThread = Executors.newSingleThreadScheduledExecutor();
        statusThread.scheduleAtFixedRate(() -> {
            String status = String.format("Active Threads: %d", threadPool.getActiveCount());
            logger.info(status);
        }, 1, 10, TimeUnit.SECONDS);


        AmazonSQS sqs = AmazonSQSClientBuilder.defaultClient();
        String queueUrl = sqs.getQueueUrl(QUEUE_NAME).getQueueUrl();

        int active = 0;
        while(true) {
            active = threadPool.getActiveCount();
            if (active == MAX_THREADS) {
                Thread.yield();
                continue;
            }
            ReceiveMessageRequest receiveMessageRequest = new ReceiveMessageRequest(queueUrl)
                    .withWaitTimeSeconds(20)
                    .withMaxNumberOfMessages(10);
            List<Message> messages = sqs.receiveMessage(receiveMessageRequest).getMessages();
            for (Message message : messages) {
                threadPool.execute(new RecordingThread(message.getBody()));
                sqs.deleteMessage(queueUrl, message.getReceiptHandle());
            }
        }
    }
}