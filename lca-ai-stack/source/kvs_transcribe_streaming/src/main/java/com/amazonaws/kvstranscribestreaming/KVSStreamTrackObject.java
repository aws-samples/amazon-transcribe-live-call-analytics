package com.amazonaws.kvstranscribestreaming;
 
import com.amazonaws.kinesisvideo.parser.mkv.StreamingMkvReader;
import com.amazonaws.kinesisvideo.parser.utilities.FragmentMetadataVisitor;
 
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.file.Path;
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
public class KVSStreamTrackObject {
    private InputStream inputStream;
    private StreamingMkvReader streamingMkvReader;
    private KVSContactTagProcessor tagProcessor;
    private FragmentMetadataVisitor fragmentVisitor;
    private Path saveAudioFilePath;
    private FileOutputStream outputStream;
    private String trackName;
 
    public KVSStreamTrackObject(InputStream inputStream, StreamingMkvReader streamingMkvReader,
                                KVSContactTagProcessor tagProcessor, FragmentMetadataVisitor fragmentVisitor,
                                Path saveAudioFilePath, FileOutputStream outputStream, String trackName) {
        this.inputStream = inputStream;
        this.streamingMkvReader = streamingMkvReader;
        this.tagProcessor = tagProcessor;
        this.fragmentVisitor = fragmentVisitor;
        this.saveAudioFilePath = saveAudioFilePath;
        this.outputStream = outputStream;
        this.trackName = trackName;
    }
 
    public InputStream getInputStream() {
        return inputStream;
    }
 
    public StreamingMkvReader getStreamingMkvReader() {
        return streamingMkvReader;
    }
 
    public void setStreamingMkvReader(StreamingMkvReader streamingMkvReader){
        this.streamingMkvReader = streamingMkvReader;
    }
 
    public KVSContactTagProcessor getTagProcessor() {
        return tagProcessor;
    }
 
    public FragmentMetadataVisitor getFragmentVisitor() {
        return fragmentVisitor;
    }
 
    public Path getSaveAudioFilePath() {
        return saveAudioFilePath;
    }
 
    public FileOutputStream getOutputStream() {
        return outputStream;
    }
 
    public void setInputStream(InputStream inputStream) {
        this.inputStream = inputStream;
    }
 
    public String getTrackName() {
        return trackName;
    }
}