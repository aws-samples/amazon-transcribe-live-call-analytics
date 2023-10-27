// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import React, { useState, useEffect } from 'react';
import { Alert, Button } from '@awsui/components-react';
import '@awsui/global-styles/index.css';

const BrowserRecorder = () => {
  const [stream, setStream] = useState(null);
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    if (!stream) {
      setIsActive(false);
    } else {
      setIsActive(true);
    }
  }, [stream]);

  const getBrowserRecorder = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      if (mediaStream) {
        setStream(mediaStream);
        setIsActive(true);
      } else {
        setIsActive(false);
      }
      console.log(stream.id);
      console.log(isActive);
    } catch (err) {
      <Alert />;
    }
  };

  return (
    <div>
      <Button type="button" iconName="download" onClick={getBrowserRecorder} />
    </div>
  );
};

export default BrowserRecorder;
