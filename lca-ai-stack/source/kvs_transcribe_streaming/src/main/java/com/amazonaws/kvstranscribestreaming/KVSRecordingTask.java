package com.amazonaws.kvstranscribestreaming;

import com.amazonaws.auth.AWSCredentialsProvider;
import com.amazonaws.auth.DefaultAWSCredentialsProviderChain;
import com.amazonaws.kinesisvideo.parser.ebml.InputStreamParserByteSource;
import com.amazonaws.kinesisvideo.parser.mkv.StreamingMkvReader;
import com.amazonaws.kinesisvideo.parser.utilities.FragmentMetadata;
import com.amazonaws.kinesisvideo.parser.utilities.FragmentMetadataVisitor;
import com.amazonaws.regions.Regions;
import com.amazonaws.services.cloudwatch.AmazonCloudWatchClientBuilder;
import com.amazonaws.services.dynamodbv2.AmazonDynamoDBClientBuilder;
import com.amazonaws.services.dynamodbv2.document.DynamoDB;
import com.amazonaws.transcribestreaming.FileByteToAudioEventSubscription;
import com.amazonaws.transcribestreaming.KVSByteToAudioEventSubscription;
import com.amazonaws.transcribestreaming.StreamTranscriptionBehaviorImpl;
import com.amazonaws.transcribestreaming.TranscribeStreamingRetryClient;
import org.reactivestreams.Publisher;
import org.reactivestreams.Subscriber;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import software.amazon.awssdk.auth.credentials.AwsCredentialsProvider;
import software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider;
import software.amazon.awssdk.services.transcribestreaming.model.AudioStream;
import software.amazon.awssdk.services.transcribestreaming.model.LanguageCode;
import software.amazon.awssdk.services.transcribestreaming.model.MediaEncoding;
import software.amazon.awssdk.services.transcribestreaming.model.StartStreamTranscriptionRequest;


import java.io.*;
import java.nio.ByteBuffer;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.text.DateFormat;
import java.text.SimpleDateFormat;

import java.util.Optional;
import java.util.Date;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Demonstrate Amazon Connect's real-time transcription feature using AWS Kinesis Video Streams and AWS Transcribe.
 * The data flow is :
 * <p>
 * Amazon Connect => AWS KVS => AWS Transcribe => AWS DynamoDB
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
public class KVSRecordingTask {

    private static final Regions REGION = Regions.fromName(System.getenv("AWS_REGION"));
    private static final Regions TRANSCRIBE_REGION = Regions.fromName(System.getenv("TRANSCRIBE_REGION"));
    private static final String TRANSCRIBE_ENDPOINT = "https://transcribestreaming." + TRANSCRIBE_REGION.getName() + ".amazonaws.com";

    private static final String RECORDINGS_BUCKET_NAME = System.getenv("RECORDINGS_BUCKET_NAME");
    private static final String RECORDINGS_KEY_PREFIX = System.getenv("RECORDINGS_KEY_PREFIX");
    private static final boolean CONSOLE_LOG_TRANSCRIPT_FLAG = Boolean.parseBoolean(System.getenv("CONSOLE_LOG_TRANSCRIPT_FLAG"));

    private static final boolean RECORDINGS_PUBLIC_READ_ACL = Boolean.parseBoolean(System.getenv("RECORDINGS_PUBLIC_READ_ACL"));
    private static final String START_SELECTOR_TYPE = System.getenv("START_SELECTOR_TYPE");

    private static final String EVENT_SOURCING_TABLE_NAME = System.getenv("EVENT_SOURCING_TABLE_NAME");

    private static final Logger logger = LoggerFactory.getLogger(KVSRecordingTask.class);
    public static final MetricsUtil metricsUtil = new MetricsUtil(AmazonCloudWatchClientBuilder.defaultClient());
    private static final DateFormat DATE_FORMAT = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS");

    // SegmentWriter saves Transcription segments to DynamoDB
    private TranscribedSegmentWriter segmentWriter = null;
    private TranscriptionStatusWriter statusWriter = null;

    /**
     * Fargate Task
     *
     * @param request
     * @return
     */
    public String handleRequest(RecordingRequest request) throws Exception {
        logger.info("received request : " + request.toString());

        try {

            // validate the request
            request.validate();

            // create a SegmentWriter to be able to save off transcription results
            AmazonDynamoDBClientBuilder builder = AmazonDynamoDBClientBuilder.standard();
            builder.setRegion(REGION.getName());
            segmentWriter = new TranscribedSegmentWriter(request.getCallId(), request.getTransactionId(), request.getStreamARN(), new DynamoDB(builder.build()),
                CONSOLE_LOG_TRANSCRIPT_FLAG);

            // writes call transcript status events (e.g. start, end, error)
            statusWriter = new TranscriptionStatusWriter(request.getCallId(), request.getTransactionId(), request.getStreamARN(), new DynamoDB(builder.build()));;

            String channel = Optional.ofNullable(request.getChannel().get()).orElse("UNKNOWN_CHANNEL");

            // stream audio from the KVS to Transcribe
            startKVSToTranscribeStreaming(request.getStreamARN(), request.getStartFragmentNum(), request.getCallId(), request.getTransactionId(), channel,
                        request.isTranscriptionEnabled(), request.getLanguageCode(), request.getSaveCallRecording());
             return "";
        } catch (Exception e) {
            logger.error("KVS to Transcribe Streaming failed with: ", e);
            return "{ \"result\": \"Failed\" }";
        }
    }

    /**
     * Starts streaming between KVS and Transcribe
     * The transcript segments are continuously saved to the Dynamo DB table
     * At end of the streaming session, the raw audio is saved as an s3 object
     *
     * @param streamARN
     * @param startFragmentNum
     * @param callId
     * @param transactionId
     * @param languageCode
     * @throws Exception
     */
    private void startKVSToTranscribeStreaming(String streamARN, String startFragmentNum, String callId, String transactionId, String channel, boolean transcribeEnabled,
        Optional < String > languageCode, Optional < Boolean > saveCallRecording) throws Exception {
        String streamName = streamARN.substring(streamARN.indexOf("/") + 1, streamARN.lastIndexOf("/"));

        KVSStreamTrackObject kvsStreamTrackObject = null;

        // Get the track name of CHIME_AUDIO since only 1 track is filled in the KVS stream
        kvsStreamTrackObject = getKVSStreamTrackObject(streamName, startFragmentNum, KVSUtils.TrackName.CHIME_AUDIO.getName(), callId, transactionId, channel);

        boolean isKVSTimedOut = startStreaming(transcribeEnabled, kvsStreamTrackObject,
            languageCode, callId, channel, streamName, saveCallRecording);

        while (isKVSTimedOut) {
            Optional < FragmentMetadata > fragmentMetadata = kvsStreamTrackObject.getFragmentVisitor().getCurrentFragmentMetadata();
            String fragmentNumber = fragmentMetadata.get().getFragmentNumberString();
            getKVSStreamTrackObjectAfterTimedOut(streamName, fragmentNumber, kvsStreamTrackObject);

            isKVSTimedOut = startStreaming(transcribeEnabled, kvsStreamTrackObject,
                languageCode, callId, channel, streamName, saveCallRecording);
        }
    }

    private boolean startStreaming(boolean transcribeEnabled, KVSStreamTrackObject kvsStreamTrackObject,
        Optional < String > languageCode, String callId, String channel,
        String streamName, Optional < Boolean > saveCallRecording) throws Exception {

        boolean isKVSTimedOut = false;

        if (transcribeEnabled) {
            try (TranscribeStreamingRetryClient client = new TranscribeStreamingRetryClient(getTranscribeCredentials(),
                TRANSCRIBE_ENDPOINT, TRANSCRIBE_REGION, metricsUtil)) {

                logger.info("Calling Transcribe service..");
                CompletableFuture < Void > transcribeResult = null;

                if (kvsStreamTrackObject != null) {
                    transcribeResult = getStartStreamingTranscriptionFuture(kvsStreamTrackObject,
                        languageCode, callId, channel, client, segmentWriter, statusWriter, EVENT_SOURCING_TABLE_NAME);
                }

                // Synchronous wait for stream to close, and close client connection
                // Timeout of 42 minutes because the Max connection duration of Amazon Kinesis Video Streams is 45 mins. The backend closes the connection after this time. The SDK rotates the token and establishes a new connection within this time.

                if (null != transcribeResult) {
                    transcribeResult.get(2520, TimeUnit.SECONDS);
                }


            } catch (TimeoutException e) {
                logger.info("Timing out KVS to Transcribe Streaming after 42 minutes");
                isKVSTimedOut = true;
            } catch (Exception e) {
                logger.error("Error during streaming: ", e);
                throw e;

            } finally {
                if (kvsStreamTrackObject != null && !isKVSTimedOut) {
                    closeFileAndUploadRawAudio(kvsStreamTrackObject, callId, channel, saveCallRecording);
                }
            }
        } else {
            try {
                logger.info("Saving audio bytes to location");

                //Write audio bytes from the KVS stream to the temporary file
                if (kvsStreamTrackObject != null) {
                    writeAudioBytesToKvsStream(kvsStreamTrackObject, callId);
                }
            } finally {
                if (kvsStreamTrackObject != null) {
                    closeFileAndUploadRawAudio(kvsStreamTrackObject, callId, channel, saveCallRecording);
                }
            }
        }
        return isKVSTimedOut;
    }


/**
 * Closes the FileOutputStream and uploads the Raw audio file to S3
 *
 * @param kvsStreamTrackObject
 * @param saveCallRecording should the call recording be uploaded to S3?
 * @throws IOException
 */
private void closeFileAndUploadRawAudio(KVSStreamTrackObject kvsStreamTrackObject, String callId, String channel, Optional < Boolean > saveCallRecording) throws IOException {

    kvsStreamTrackObject.getInputStream().close();
    kvsStreamTrackObject.getOutputStream().close();

    //Upload the Raw Audio file to S3
    if ((saveCallRecording.isPresent() ? saveCallRecording.get() : false) && (new File(kvsStreamTrackObject.getSaveAudioFilePath().toString()).length() > 0)) {
    	logger.info("Uploading file ");
        AudioUtils.uploadRawAudio(REGION, RECORDINGS_BUCKET_NAME, RECORDINGS_KEY_PREFIX, kvsStreamTrackObject.getSaveAudioFilePath().toString(), callId, channel, RECORDINGS_PUBLIC_READ_ACL,
            getAWSCredentials());
    } else {
        logger.info("Skipping upload to S3.  saveCallRecording was disabled or audio file has 0 bytes: " + kvsStreamTrackObject.getSaveAudioFilePath().toString());
    }

}

/**
 * Create all objects necessary for KVS streaming from each track
 *
 * @param streamName
 * @param startFragmentNum
 * @param trackName
 * @param callId
 * @return
 * @throws FileNotFoundException
 */
//TODO: CHIME IS DOING THE SAME THING HERE - WITHOUT A FUNCTION
private KVSStreamTrackObject getKVSStreamTrackObject(String streamName, String startFragmentNum, String trackName,
    String callId, String transactionId, String channel) throws FileNotFoundException {
    InputStream kvsInputStream = KVSUtils.getInputStreamFromKVS(streamName, REGION, startFragmentNum, getAWSCredentials(), START_SELECTOR_TYPE);
    StreamingMkvReader streamingMkvReader = StreamingMkvReader.createDefault(new InputStreamParserByteSource(kvsInputStream));

    KVSContactTagProcessor tagProcessor = new KVSContactTagProcessor(transactionId);
    FragmentMetadataVisitor fragmentVisitor = FragmentMetadataVisitor.create(Optional.of(tagProcessor));

    String fileName = String.format("%s_%s_%s.raw", callId, channel, DATE_FORMAT.format(new Date()));
    Path saveAudioFilePath = Paths.get("/tmp", fileName);
    FileOutputStream fileOutputStream = new FileOutputStream(saveAudioFilePath.toString());

    return new KVSStreamTrackObject(kvsInputStream, streamingMkvReader, tagProcessor, fragmentVisitor, saveAudioFilePath, fileOutputStream, trackName);
}

private KVSStreamTrackObject getKVSStreamTrackObjectAfterTimedOut(String streamName, String startFragmentNum, KVSStreamTrackObject kvsStreamTrackObject) throws FileNotFoundException {
    InputStream kvsInputStream = KVSUtils.getInputStreamFromKVS(streamName, REGION, startFragmentNum, getAWSCredentials(), START_SELECTOR_TYPE);
    StreamingMkvReader streamingMkvReader = StreamingMkvReader.createDefault(new InputStreamParserByteSource(kvsInputStream));
    kvsStreamTrackObject.setInputStream(kvsInputStream);
    kvsStreamTrackObject.setStreamingMkvReader(streamingMkvReader);
    return kvsStreamTrackObject;
}

private CompletableFuture < Void > getStartStreamingTranscriptionFuture(KVSStreamTrackObject kvsStreamTrackObject, Optional < String > languageCode,
    String callId, String channel, TranscribeStreamingRetryClient client,
    TranscribedSegmentWriter transcribedSegmentWriter,
    TranscriptionStatusWriter transcriptionStatusWriter,
    String tableName) {
    return client.startStreamTranscription(
        // since we're definitely working with telephony audio, we know that's 8 kHz
        getRequest(8000, languageCode),
        new KVSAudioStreamPublisher(
            kvsStreamTrackObject.getStreamingMkvReader(),
            callId,
            kvsStreamTrackObject.getOutputStream(),
            kvsStreamTrackObject.getTagProcessor(),
            kvsStreamTrackObject.getFragmentVisitor(),
            kvsStreamTrackObject.getTrackName()),
        new StreamTranscriptionBehaviorImpl(transcribedSegmentWriter, transcriptionStatusWriter, tableName, channel),
        "0"
    );
}

/**
 * Write the kvs stream to the output buffer
 *
 * @param kvsStreamTrackObject
 * @param callId
 * @throws Exception
 */
private void writeAudioBytesToKvsStream(KVSStreamTrackObject kvsStreamTrackObject, String callId) throws Exception {

    ByteBuffer audioBuffer = KVSUtils.getByteBufferFromStream(kvsStreamTrackObject.getStreamingMkvReader(),
        kvsStreamTrackObject.getFragmentVisitor(), kvsStreamTrackObject.getTagProcessor());

    while (audioBuffer.remaining() > 0) {
        byte[] audioBytes = new byte[audioBuffer.remaining()];
        audioBuffer.get(audioBytes);
        kvsStreamTrackObject.getOutputStream().write(audioBytes);
        audioBuffer = KVSUtils.getByteBufferFromStream(kvsStreamTrackObject.getStreamingMkvReader(),
            kvsStreamTrackObject.getFragmentVisitor(), kvsStreamTrackObject.getTagProcessor());
    }
}

/**
 * @return AWS credentials to be used to connect to s3 (for fetching and uploading audio) and KVS
 */
private static AWSCredentialsProvider getAWSCredentials() {
    return DefaultAWSCredentialsProviderChain.getInstance();
}

/**
 * @return AWS credentials to be used to connect to Transcribe service. This example uses the default credentials
 * provider, which looks for environment variables (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY) or a credentials
 * file on the system running this program.
 */
private static AwsCredentialsProvider getTranscribeCredentials() {
    return DefaultCredentialsProvider.create();
}

/**
 * Build StartStreamTranscriptionRequestObject containing required parameters to open a streaming transcription
 * request, such as audio sample rate and language spoken in audio
 *
 * @param mediaSampleRateHertz sample rate of the audio to be streamed to the service in Hertz
 * @param languageCode the language code to be used for Transcription (optional; see https://docs.aws.amazon.com/transcribe/latest/dg/API_streaming_StartStreamTranscription.html#API_streaming_StartStreamTranscription_RequestParameters )
 * @return StartStreamTranscriptionRequest to be used to open a stream to transcription service
 */
private static StartStreamTranscriptionRequest getRequest(Integer mediaSampleRateHertz, Optional < String > languageCode) {

    return StartStreamTranscriptionRequest.builder()
        .languageCode(languageCode.isPresent() ? languageCode.get() : LanguageCode.EN_US.toString())
        .mediaEncoding(MediaEncoding.PCM)
        .mediaSampleRateHertz(mediaSampleRateHertz)
        .build();
}


/**
 * KVSAudioStreamPublisher implements audio stream publisher.
 * It emits audio events from a KVS stream asynchronously in a separate thread
 */
private static class KVSAudioStreamPublisher implements Publisher < AudioStream > {
    private final StreamingMkvReader streamingMkvReader;
    private String callId;
    private OutputStream outputStream;
    private KVSContactTagProcessor tagProcessor;
    private FragmentMetadataVisitor fragmentVisitor;
    private String track;

    private KVSAudioStreamPublisher(StreamingMkvReader streamingMkvReader, String callId, OutputStream outputStream,
        KVSContactTagProcessor tagProcessor, FragmentMetadataVisitor fragmentVisitor,
        String track) {
        this.streamingMkvReader = streamingMkvReader;
        this.callId = callId;
        this.outputStream = outputStream;
        this.tagProcessor = tagProcessor;
        this.fragmentVisitor = fragmentVisitor;
        this.track = track;
    }

    @Override
    public void subscribe(Subscriber<? super AudioStream> s) {
        s.onSubscribe(new KVSByteToAudioEventSubscription(s, streamingMkvReader, callId, outputStream, tagProcessor, fragmentVisitor, track));
    }
}

/**
 * FileAudioStreamPublisher implements audio stream publisher.
 * It emits audio events from a File InputStream asynchronously in a separate thread
 */
private static class FileAudioStreamPublisher implements Publisher < AudioStream > {

    private final InputStream inputStream;

    private FileAudioStreamPublisher(InputStream inputStream) {
        this.inputStream = inputStream;
    }

    @Override
    public void subscribe(Subscriber<? super AudioStream> s) {
        s.onSubscribe(new FileByteToAudioEventSubscription(s, inputStream));

    }
}
}