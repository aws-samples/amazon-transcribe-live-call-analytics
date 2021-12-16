package com.amazonaws.kvstranscribestreaming;

import com.amazonaws.SdkClientException;
import com.amazonaws.auth.AWSCredentialsProvider;
import com.amazonaws.regions.Regions;
import com.amazonaws.services.s3.AmazonS3;
import com.amazonaws.services.s3.AmazonS3ClientBuilder;
import com.amazonaws.services.s3.model.CannedAccessControlList;
import com.amazonaws.services.s3.model.GetObjectRequest;
import com.amazonaws.services.s3.model.ObjectMetadata;
import com.amazonaws.services.s3.model.PutObjectRequest;
import com.amazonaws.services.s3.model.PutObjectResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.sound.sampled.AudioFileFormat;
import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.UnsupportedAudioFileException;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * Utility class to download/upload audio files from/to S3
  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
  
  Licensed under the Apache License, Version 2.0 (the "License").
  You may not use this file except in compliance with the License.
  You may obtain a copy of the License at
  
      http://www.apache.org/licenses/LICENSE-2.0
  
  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
 */
public final class AudioUtils {

    private static final Logger logger = LoggerFactory.getLogger(AudioUtils.class);

    /**
     * Fetches the audio file from S3 and saves it locally
     * @param region
     * @param bucketName
     * @param objectKey
     * @param audioFilePath
     * @param awsCredentials
     * @throws SdkClientException
     */
    public static void fetchAudio(Regions region, String bucketName, String objectKey, String audioFilePath, AWSCredentialsProvider awsCredentials) {

        AmazonS3 s3Client = AmazonS3ClientBuilder.standard()
                .withRegion(region)
                .withCredentials(awsCredentials)
                .build();

        // save the object locally
        logger.info(String.format("Fetching %s/%s to %s", bucketName, objectKey, audioFilePath));

        File localFile = new File(audioFilePath);
        GetObjectRequest getObjectRequest = new GetObjectRequest(bucketName, objectKey);
        ObjectMetadata metaData = s3Client.getObject(getObjectRequest, localFile);

        logger.info(String.format("fetchAudio:  getObject completed successfully %d byte(s) %s",
                metaData.getContentLength(), metaData.getETag()));
    }

    /**
     * Converts the given raw audio data into a wav file. Returns the wav file back.
     */
    private static File convertToWav(String audioFilePath) throws IOException, UnsupportedAudioFileException {
        File outputFile = new File(audioFilePath.replace(".raw", ".wav"));
        AudioInputStream source = new AudioInputStream(Files.newInputStream(Paths.get(audioFilePath)),
                new AudioFormat(8000, 16, 1, true, false), -1); // 8KHz, 16 bit, 1 channel, signed, little-endian
        AudioSystem.write(source, AudioFileFormat.Type.WAVE, outputFile);
        source.close();
        return outputFile;
    }

    /**
     * Saves the raw audio file as an S3 object
     *
     * @param region
     * @param bucketName
     * @param keyPrefix
     * @param audioFilePath
     * @param awsCredentials
     */
    public static void uploadRawAudio(Regions region, String bucketName, String keyPrefix, String audioFilePath, String callId, String channel, boolean publicReadAcl, AWSCredentialsProvider awsCredentials) {
        File wavFile = null;
        try {

            AmazonS3 s3Client = AmazonS3ClientBuilder.standard()
                    .withRegion(region)
                    .withCredentials(awsCredentials)
                    .build();

            wavFile = convertToWav(audioFilePath);

            // upload the raw audio file to the designated S3 location
            String objectKey = keyPrefix + wavFile.getName();

            logger.info(String.format("Uploading Audio: to %s/%s from %s", bucketName, objectKey, wavFile));
            PutObjectRequest request = new PutObjectRequest(bucketName, objectKey, wavFile);
            ObjectMetadata metadata = new ObjectMetadata();
            metadata.setContentType("audio/wav");
            metadata.addUserMetadata("contact-id", callId);
            metadata.addUserMetadata("channel", channel);
            request.setMetadata(metadata);

            if (publicReadAcl) {
                request.setCannedAcl(CannedAccessControlList.PublicRead);
            }

            PutObjectResult s3result = s3Client.putObject(request);

            logger.info("putObject completed successfully " + s3result.getETag());

        } catch (SdkClientException e) {
            logger.error("Audio upload to S3 failed: ", e);
            throw e;
        } catch (UnsupportedAudioFileException|IOException e) {
            logger.error("Failed to convert to wav: ", e);
        }
        finally {
            if (wavFile != null) {
                wavFile.delete();
            }
        }
    }
}
