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

import useAppContext from '../contexts/app';

// eslint-disable-next-line prettier/prettier
const WSS_ENDPOINT = 'wss://babusri.people.aws.dev/api/v1/ws';

const pcmEncode = (input) => {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
};

const StreamAudio = () => {
  const { currentSession } = useAppContext();
  const JWT_TOKEN = currentSession.getAccessToken().getJwtToken();

  const [callMetaData, setCallMetaData] = useState({
    callId: crypto.randomUUID(),
    agentId: 'AudioStream',
    fromNumber: '+9165551234',
    toNumber: '+8001112222',
    samplingRate: 48000,
  });
  const { sendMessage } = useWebSocket(WSS_ENDPOINT, {
    queryParams: {
      authorization: `Bearer ${JWT_TOKEN}`,
    },
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
  // const [mediaRecorder, setMediaRecorder] = useState();
  let mediaRecorder;
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
    setCallMetaData({      ...callMetaData,
      toNumber: e.detail.value,
    });
  };

  const stopRecording = async () => {
    if (mediaRecorder) {
      mediaRecorder.port.postMessage({
        message: 'UPDATE_RECORDING_STATE',
        setRecording: false,
      });
      mediaRecorder.port.close();
      mediaRecorder.disconnect();
    } else {
      console.log('no media recorder available to stop');
    }
  };

  const startRecording = async () => {
    try {
      const audioContext = new window.AudioContext();

      const stream = await window.navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      const source1 = audioContext.createMediaStreamSource(stream);
      
      const recordingprops = {
        numberOfChannels: 1,
        sampleRate: audioContext.sampleRate,
        maxFrameCount: (audioContext.sampleRate * 1) / 10,
      };
      
      setCallMetaData({
        ...callMetaData,
        samplingRate: recordingprops.sampleRate,
      });
      sendMessage(JSON.stringify(callMetaData));
      
      try {
        await audioContext.audioWorklet.addModule('./worklets/recording-processor.js');
      } catch (error) {
        console.log(`Add module error ${error}`);
      }
      mediaRecorder = new AudioWorkletNode(audioContext, 'recording-processor', {
        processorOptions: recordingprops,
      });

      const destination = audioContext.createMediaStreamDestination();
      mediaRecorder.port.postMessage({
        message: 'UPDATE_RECORDING_STATE',
        setRecording: true,
      });
      source1.connect(mediaRecorder).connect(destination);
      mediaRecorder.port.onmessageerror = (error) => {
        console.log(`Error receving message from worklet ${error}`);
      };
      mediaRecorder.port.onmessage = (event) => {
        const abuffer = pcmEncode(event.data.buffer[0]);
        const audiodata = new Uint8Array(abuffer);
        sendMessage(audiodata);
      };
    } catch (error) {
      alert(`An error occurred while recording: ${error}`);
      await stopRecording();
    }
  };

  async function toggleRecording() {
    if (recording) {
      console.log('startRecording');
      await startRecording();
    } else {
      console.log('stopRecording');
      await stopRecording();
    }
  }

  useEffect(() => {
    toggleRecording();
  }, [recording]);

  const handleRecording = () => {
    setRecording(!recording);
    if (recording) {
      console.log('Stopping transcription');
    } else {
      console.log('Starting transcription');
    }
    return recording;
  };

  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <Form
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="primary" onClick={handleRecording}>
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
