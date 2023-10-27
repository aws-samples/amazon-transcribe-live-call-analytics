// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import React, { useState, useEffect } from 'react';
// import bufferFrom from 'buffer-from';

import {
  Form,
  FormField,
  SpaceBetween,
  Container,
  Button,
  Input,
  Header,
  ColumnLayout,
} from '@awsui/components-react';
import '@awsui/global-styles/index.css';
import useWebSocket from 'react-use-websocket';

// eslint-disable-next-line prettier/prettier
// const JWT_TOKEN =
// const WSS_ENDPOINT = 'wss://d2ydfdkcykyfr0.cloudfront.net/api/v1/ws';
const WSS_ENDPOINT = 'ws://127.0.0.1:8080/api/v1/ws';
// const tone1kHz8kUlaw2ch = Uint8Array.from(
//   new Array(1000)
//     .fill([
//       0xff, 0xff, 0x0d, 0x0d, 0x06, 0x06, 0x0d, 0x0d, 0xff, 0xff, 0x8d, 0x8d, 0x86, 0x86, 0x8d,
//       0x8d,
//     ])
//     .flat(),
// );
const StreamAudio = () => {
  const [callMetaData, setCallMetaData] = useState({
    callId: crypto.randomUUID(),
    agentId: 'AudioStream',
    fromNumber: '+9165551234',
    toNumber: '+8001112222',
  });
  const { sendMessage } = useWebSocket(WSS_ENDPOINT, {
    // queryParams: {
    //   authorization: `Bearer ${JWT_TOKEN}`,
    // },
    onClose: (event) => {
      console.log(event);
      // eslint-disable-next-line no-use-before-define
      setRecording(false);
    },
    onError: (event) => {
      console.log(event);
      // eslint-disable-next-line no-use-before-define
      setRecording(false);
    },
  });
  const [recording, setRecording] = useState(false);

  const handleCallIdChange = (e) => {
    setCallMetaData({
      ...callMetaData,
      callId: e.detail.value,
    });
  };

  const handleAgentIdChange = (e) => {
    setCallMetaData({
      ...callMetaData,
      agentId: e.detail.value,
    });
  };

  const handlefromNumberChange = (e) => {
    setCallMetaData({
      ...callMetaData,
      fromNumber: e.detail.value,
    });
  };

  const handletoNumberChange = (e) => {
    setCallMetaData({
      ...callMetaData,
      toNumber: e.detail.value,
    });
  };
  useEffect(() => {
    let mediaRecorder;
    let dstream;
    let audioContext;

    // const encodePCMChunk = (input) => {
    //   let offset = 0;
    //   const buffer = new ArrayBuffer(input.length * 2);
    //   const view = new DataView(buffer);
    //   // eslint-disable-next-line no-plusplus
    //   for (let i = 0; i < input.length; i++, offset += 2) {
    //     const s = Math.max(-1, Math.min(1, input[i]));
    //     view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    //   }
    //   return Buffer.from(buffer);
    // };

    const startRecording = async () => {
      dstream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100,
        },
      });

      audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      const source1 = audioContext.createMediaStreamSource(dstream);

      mediaRecorder = audioContext.createScriptProcessor(4096, 1, 1);
      source1.connect(mediaRecorder).connect(destination);

      const recorderProcess = (e) => {
        const { inputBuffer } = e;
        const inputData = inputBuffer.getChannelData(0);
        console.log('Buffer size ', inputData.length);
        sendMessage(inputData);
      };
      mediaRecorder.onaudioprocess = recorderProcess;
    };

    const stopRecording = () => {
      try {
        dstream.getAudioTracks()[0].stop();
      } catch (error) {
        console.log(error);
      }
      // mediaRecorder.disconnect();
      try {
        audioContext.close();
      } catch (error) {
        console.log(error);
      }
      if (mediaRecorder) {
        mediaRecorder.getTracks().forEach((track) => track.stop());
        mediaRecorder.stop();
      }
      setRecording(false);
    };

    if (recording) {
      startRecording();
    } else {
      stopRecording();
    }

    return () => {
      if (mediaRecorder) {
        mediaRecorder.getTracks().forEach((track) => track.stop());
      }
    };
  }, [recording, sendMessage]);

  const startCall = () => {
    if (!recording) {
      sendMessage(JSON.stringify(callMetaData));
    }
    setRecording(!recording);
    // eslint-disable-next-line max-len
    // sendMessage(tone1kHz8kUlaw2ch);
  };

  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <Form
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="primary" onClick={startCall}>
              {recording ? 'Stop Streaming' : 'Start Streaming'}
            </Button>
          </SpaceBetween>
        }
      >
        <Container header={<Header variant="h2">Call Meta data</Header>}>
          <ColumnLayout columns={2}>
            <FormField label="Call ID" stretch required description="Auto-enerated Unique call ID">
              <Input value={callMetaData.callId} onChange={handleCallIdChange} />
            </FormField>
            <FormField label="Agent ID" stretch required description="Unique Agent ID">
              <Input value={callMetaData.agentId} onChange={handleAgentIdChange} />
            </FormField>
            <FormField label="Customer Phone" stretch required description="Customer Phone">
              <Input value={callMetaData.fromNumber} onChange={handlefromNumberChange} />
            </FormField>
            <FormField label="System Phone" stretch required description="System Phone">
              <Input value={callMetaData.toNumber} onChange={handletoNumberChange} />
            </FormField>
          </ColumnLayout>
        </Container>
      </Form>
    </form>
  );
};

export default StreamAudio;
