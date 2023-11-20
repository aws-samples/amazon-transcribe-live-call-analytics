// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState, useRef } from 'react';
// import MultiStreamsMixer from 'multistreamsmixer';

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

const WSS_ENDPOINT = 'wss://d59lqabyazbry.cloudfront.net/api/v1/ws';
// const WSS_ENDPOINT = 'ws://127.0.0.1:8080/api/v1/ws';

const StreamAudio = () => {
  const { currentSession } = useAppContext();
  const JWT_TOKEN = currentSession.getAccessToken().getJwtToken();
  const [callMetaData, setCallMetaData] = useState({
    callId: crypto.randomUUID(),
    agentId: 'AudioStream',
    fromNumber: '+9165551234',
    toNumber: '+8001112222',
    samplingRate: 48000,
    shouldRecordCall: true,
  });
  const [recording, setRecording] = useState(false);

  // audio components:
  const processor = useRef();
  const finalMerger = useRef();
  const micSource = useRef();
  const displaySource = useRef();
  const audioContext = useRef();
  const displayStream = useRef();
  const micStream = useRef();

  const { sendMessage } = useWebSocket(WSS_ENDPOINT, {
    queryParams: {
      authorization: `Bearer ${JWT_TOKEN}`,
    },
    onOpen: () => {
      console.log('websocket opened');
    },
    onClose: (event) => {
      console.log(event);
      setRecording(false);
    },
    onError: (event) => {
      console.log(event);
      setRecording(false);
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

  const floatTo16BitPCM = (input) => {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return output;
  };

  const decodeWebMToAudioBuffer = (audioBuffer) => {
    const left32Bit = audioBuffer.getChannelData(0);
    const right32Bit = audioBuffer.getChannelData(1);
    const left16Bit = floatTo16BitPCM(left32Bit);
    const right16Bit = floatTo16BitPCM(right32Bit);
    const length = left16Bit.length + right16Bit.length;
    const interleaved = new Int16Array(length);

    for (let i = 0, j = 0; i < length; j += 1) {
      interleaved[(i += 1)] = left16Bit[j];
      interleaved[(i += 1)] = right16Bit[j];
    }

    return interleaved;
  };

  const stopRecording = () => {
    // console.log(`total blob length: ${tempBlob.size}`);
    if (processor.current) {
      processor.current.onaudioprocess = null;

      // clean up nodes
      processor.current.disconnect();
      finalMerger.current.disconnect();

      displayStream.current.getTracks().forEach((track) => {
        track.stop();
      });

      micStream.current.getTracks().forEach((track) => {
        track.stop();
      });

      micSource.current.disconnect();
      displaySource.current.disconnect();

      audioContext.current.close().then(() => {
        console.log('AudioContext closed.');
      });
      // processor = undefined;

      setCallMetaData({
        ...callMetaData,
        callId: crypto.randomUUID(),
      });
    }
  };

  const convertToMono = (audioSource) => {
    const splitter = audioContext.current.createChannelSplitter(2);
    const merger = audioContext.current.createChannelMerger(1);
    audioSource.connect(splitter);
    splitter.connect(merger, 0, 0);
    splitter.connect(merger, 1, 0);
    return merger;
  };

  const startRecording = async () => {
    try {
      audioContext.current = new window.AudioContext();

      displayStream.current = await window.navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      displaySource.current = audioContext.current.createMediaStreamSource(displayStream.current);

      micStream.current = await window.navigator.mediaDevices.getUserMedia({
        video: false,
        audio: true,
      });
      micSource.current = audioContext.current.createMediaStreamSource(micStream.current);

      const recordingprops = {
        numberOfChannels: 2,
        sampleRate: audioContext.current.sampleRate,
        maxFrameCount: (audioContext.current.sampleRate * 1) / 10,
      };

      console.log(`Sample rate: ${audioContext.current.sampleRate}`);

      setCallMetaData({
        ...callMetaData,
        samplingRate: recordingprops.sampleRate,
      });
      console.log('sending initial metadata:');
      sendMessage(JSON.stringify(callMetaData));

      const monoDisplaySource = convertToMono(displaySource.current);
      const monoMicSource = convertToMono(micSource.current);

      finalMerger.current = audioContext.current.createChannelMerger(2);
      monoMicSource.connect(finalMerger.current, 0, 0);
      monoDisplaySource.connect(finalMerger.current, 0, 1);

      processor.current = audioContext.current.createScriptProcessor(4096, 2, 2);
      finalMerger.current.connect(processor.current);
      processor.current.connect(audioContext.current.destination);

      processor.current.onaudioprocess = function (event) {
        const pcm = decodeWebMToAudioBuffer(event.inputBuffer);
        // console.log('received pcm', pcm);
        sendMessage(pcm);
      };
    } catch (error) {
      alert(`An error occurred while recording: ${error}`);
      stopRecording();
    }
  };

  const handleRecording = () => {
    setRecording(!recording);
  };

  useEffect(() => {
    console.log('recording is set to: ', recording);
    if (recording) {
      console.log('startRecording');
      startRecording();
    } else {
      console.log('stopRecording');
      stopRecording();
    }
  }, [recording]);

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
        <Container header={<Header variant="h2">Call Metadata</Header>}>
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
