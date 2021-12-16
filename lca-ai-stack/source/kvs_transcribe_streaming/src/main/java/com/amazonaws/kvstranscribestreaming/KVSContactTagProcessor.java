package com.amazonaws.kvstranscribestreaming;

import com.amazonaws.kinesisvideo.parser.utilities.FragmentMetadata;
import com.amazonaws.kinesisvideo.parser.utilities.FragmentMetadataVisitor;
import com.amazonaws.kinesisvideo.parser.utilities.MkvTag;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Optional;

/**
 * An MkvTagProcessor that will ensure that we are only reading until end of stream OR the call id changes
 * from what is expected.
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
public class KVSContactTagProcessor implements FragmentMetadataVisitor.MkvTagProcessor {
    private static final Logger logger = LoggerFactory.getLogger(KVSContactTagProcessor.class);

    private final String transactionId;

    private boolean sameContact = true;
    private boolean stopStreaming = false;

    public KVSContactTagProcessor(String transactionId) {
        this.transactionId = transactionId;
    }

    public void process(MkvTag mkvTag, Optional<FragmentMetadata> currentFragmentMetadata) {
        if ("TransactionId".equals(mkvTag.getTagName())) {
            if (this.transactionId.equals(mkvTag.getTagValue())) {
                sameContact = true;
            }
            else {
                logger.info("Call ID in tag does not match expected, will stop streaming. "
                                + "call id: %s, expected: %s",
                        mkvTag.getTagValue(), transactionId);
                sameContact = false;
            }
        }
        if ("STOP_STREAMING".equals(mkvTag.getTagName())) {
            if ("true".equals(mkvTag.getTagValue())) {
                logger.info("STOP_STREAMING tag detected, will stop streaming");
                stopStreaming = true;
            }
        }
    }

    public boolean shouldStopProcessing() {
        return sameContact == false || stopStreaming == true;
    }
}
