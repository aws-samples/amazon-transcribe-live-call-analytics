// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import React, { useState, useCallback, useEffect } from 'react';

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

import useAppContext from '../../contexts/app';
import useSettingsContext from '../../contexts/settings';

// const TARGET_SAMPLING_RATE = 8000;
let SOURCE_SAMPLING_RATE;

// export const downsampleBuffer = (buffer, inputSampleRate = 44100, outputSampleRate = 16000) => {
//   if (outputSampleRate === inputSampleRate) {
//     return buffer;
//   }

//   const sampleRateRatio = inputSampleRate / outputSampleRate;
//   const newLength = Math.round(buffer.length / sampleRateRatio);
//   const result = new Float32Array(newLength);
//   let offsetResult = 0;
//   let offsetBuffer = 0;

//   while (offsetResult < result.length) {
//     const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
//     let accum = 0;
//     let count = 0;

//     for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
//       accum += buffer[i];
//       count += 1;
//     }
//     result[offsetResult] = accum / count;
//     offsetResult += 1;
//     offsetBuffer = nextOffsetBuffer;
//   }
//   return result;
// };

const pcmEncode = (input) => {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
};

const interleave = (lbuffer, rbuffer) => {
  // const leftAudioBuffer = pcmEncode(
  //   downsampleBuffer(lbuffer, SOURCE_SAMPLING_RATE, TARGET_SAMPLING_RATE),
  // );
  const leftAudioBuffer = pcmEncode(lbuffer);
  const leftView = new DataView(leftAudioBuffer);

  // const rightAudioBuffer = pcmEncode(
  //   downsampleBuffer(rbuffer, SOURCE_SAMPLING_RATE, TARGET_SAMPLING_RATE),
  // );
  const rightAudioBuffer = pcmEncode(rbuffer);
  const rightView = new DataView(rightAudioBuffer);

  const buffer = new ArrayBuffer(leftAudioBuffer.byteLength * 2);
  const view = new DataView(buffer);

  for (let i = 0, j = 0; i < leftAudioBuffer.byteLength; i += 2, j += 4) {
    view.setInt16(j, leftView.getInt16(i, true), true);
    view.setInt16(j + 2, rightView.getInt16(i, true), true);
  }
  return buffer;
};

const StreamAudio = () => {
  const { currentSession } = useAppContext();
  const { settings } = useSettingsContext();
  const JWT_TOKEN = currentSession.getAccessToken().getJwtToken();

  const [callMetaData, setCallMetaData] = useState({
    callId: crypto.randomUUID(),
    agentId: 'AudioStream',
    fromNumber: '+9165551234',
    toNumber: '+8001112222',
  });
  const [recording, setRecording] = useState(false);
  const [streamingStarted, setStreamingStarted] = useState(false);

  let mediaRecorder;

  const getSocketUrl = useCallback(() => {
    console.log('Trying to resolve websocket url...');
    return new Promise((resolve) => {
      if (settings.WSEndpoint) {
        console.log(`Resolved Websocket URL to ${settings.WSEndpoint}`);
        resolve(settings.WSEndpoint);
      }
    });
  }, [settings.WSEndpoint]);

  const { sendMessage } = useWebSocket(getSocketUrl, {
    queryParams: {
      authorization: `Bearer ${JWT_TOKEN}`,
    },
    onOpen: (event) => {
      console.log(event);
    },
    onClose: (event) => {
      console.log(event);
    },
    onError: (event) => {
      console.log(event);
    },
  });

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
    if (streamingStarted && !recording) {
      callMetaData.callEvent = 'END';
      sendMessage(JSON.stringify(callMetaData));
      setStreamingStarted(false);
    }
  };

  const startRecording = async () => {
    try {
      const audioContext = new window.AudioContext();
      const videostream = await window.navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          noiseSuppression: true,
          autoGainControl: true,
          echoCancellation: true,
        },
      });
      const track1 = videostream.getAudioTracks()[0];

      const micstream = await window.navigator.mediaDevices.getUserMedia({
        video: false,
        audio: true,
      });
      const track2 = micstream.getAudioTracks()[0];
      SOURCE_SAMPLING_RATE = audioContext.sampleRate;

      // callMetaData.samplingRate = TARGET_SAMPLING_RATE;
      callMetaData.samplingRate = SOURCE_SAMPLING_RATE;

      callMetaData.callEvent = 'START';
      sendMessage(JSON.stringify(callMetaData));
      setStreamingStarted(true);

      const source1 = audioContext.createMediaStreamSource(new MediaStream([track2]));
      const source2 = audioContext.createMediaStreamSource(new MediaStream([track1]));

      const merger = audioContext.createChannelMerger(2);
      source1.connect(merger, 0, 0);
      source2.connect(merger, 0, 1);

      try {
        await audioContext.audioWorklet.addModule('./worklets/recording-processor.js');
      } catch (error) {
        console.log(`Add module error ${error}`);
      }

      mediaRecorder = new AudioWorkletNode(audioContext, 'recording-processor', {
        processorOptions: {
          numberOfChannels: 2,
          sampleRate: SOURCE_SAMPLING_RATE,
          maxFrameCount: (audioContext.sampleRate * 1) / 10,
        },
      });

      mediaRecorder.port.postMessage({
        message: 'UPDATE_RECORDING_STATE',
        setRecording: true,
      });

      const destination = audioContext.createMediaStreamDestination();
      merger.connect(mediaRecorder).connect(destination);

      mediaRecorder.port.onmessageerror = (error) => {
        console.log(`Error receving message from worklet ${error}`);
      };

      mediaRecorder.port.onmessage = (event) => {
        const audiodata = new Uint8Array(interleave(event.data.buffer[1], event.data.buffer[0]));
        sendMessage(audiodata);
      };
    } catch (error) {
      alert(`An error occurred while recording: ${error}`);
      await stopRecording();
    }
  };

  async function toggleRecording() {
    if (recording) {
      await startRecording();
    } else {
      await stopRecording();
    }
  }

  useEffect(() => {
    toggleRecording();
  }, [recording]);

  const handleRecording = () => {
    setRecording(!recording);
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
            <FormField label="Call ID" stretch required description="Auto-generated Unique call ID">
              <Input value={callMetaData.callId} onChange={handleCallIdChange} />
            </FormField>
            <FormField label="Agent ID" stretch required description="Agent ID">
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
