// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import React, { useState, useRef, useCallback, useEffect } from 'react';

import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Container from '@cloudscape-design/components/container';
import Button from '@cloudscape-design/components/button';
import Input from '@cloudscape-design/components/input';
import Header from '@cloudscape-design/components/header';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Select from '@cloudscape-design/components/select';

import useWebSocket from 'react-use-websocket';

import useAppContext from '../../contexts/app';
import useSettingsContext from '../../contexts/settings';

let SOURCE_SAMPLING_RATE;

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
  const [micInputOption, setMicInputOption] = useState({ label: 'AGENT', value: 'agent' });

  const getSocketUrl = useCallback(() => {
    console.log(`DEBUG - [${new Date().toISOString()}]: Trying to resolve websocket url...`);
    return new Promise((resolve) => {
      if (settings.WSEndpoint) {
        console.log(`
          DEBUG - [${new Date().toISOString()}]: Resolved Websocket URL to ${settings.WSEndpoint}
        `);
        resolve(settings.WSEndpoint);
      }
    });
  }, [settings.WSEndpoint]);

  const { sendMessage } = useWebSocket(getSocketUrl, {
    queryParams: {
      authorization: `Bearer ${JWT_TOKEN}`,
    },
    onOpen: (event) => {
      console.log(`
        DEBUG - [${new Date().toISOString()}]: Websocket onOpen Event: ${JSON.stringify(event)}
      `);
    },
    onClose: (event) => {
      console.log(`
        DEBUG - [${new Date().toISOString()}]: Websocket onClose Event: ${JSON.stringify(event)}
      `);
    },
    onError: (event) => {
      console.log(`
        DEBUG - [${new Date().toISOString()}]: Websocket onError Event: ${JSON.stringify(event)}
      `);
    },
    shouldReconnect: () => true,
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

  const handleMicInputOptionSelection = (e) => {
    setMicInputOption(e.detail.selectedOption);
  };

  const audioProcessor = useRef();
  const audioContext = useRef();
  const displayStream = useRef();
  const micStream = useRef();
  const displayAudioSource = useRef();
  const micAudioSource = useRef();
  const channelMerger = useRef();

  const convertToMono = (audioSource) => {
    const splitter = audioContext.current.createChannelSplitter(2);
    const merger = audioContext.current.createChannelMerger(1);
    audioSource.connect(splitter);
    splitter.connect(merger, 0, 0);
    splitter.connect(merger, 1, 0);
    return merger;
  };

  const stopRecording = async () => {
    console.log(`DEBUG - [${new Date().toISOString()}]: Stopping recording...`);

    if (audioProcessor.current) {
      audioProcessor.current.port.postMessage({
        message: 'UPDATE_RECORDING_STATE',
        setRecording: false,
      });
      audioProcessor.current.port.close();
      audioProcessor.current.disconnect();

      displayStream.current.getTracks().forEach((track) => {
        track.stop();
      });

      micStream.current.getTracks().forEach((track) => {
        track.stop();
      });

      audioContext.current.close().then(() => {
        console.log('AudioContext closed.');
      });
    } else {
      console.log(`
        DEBUG - [${new Date().toISOString()}]: Error trying to stop recording. AudioWorklet Processor node is not active.
      `);
      setRecording(false);
    }
    if (streamingStarted && !recording) {
      callMetaData.callEvent = 'END';
      // eslint-disable-next-line prettier/prettier
      console.log(`
        DEBUG - [${new Date().toISOString()}]: Send Call END msg: ${JSON.stringify(callMetaData)}
      `);
      sendMessage(JSON.stringify(callMetaData));
      setStreamingStarted(false);
      setCallMetaData({
        ...callMetaData,
        callId: crypto.randomUUID(),
      });
    }
  };

  const startRecording = async () => {
    console.log(`
      DEBUG - [${new Date().toISOString()}]: Start Recording and Streaming Audio to Websocket server.
    `);

    try {
      audioContext.current = new window.AudioContext();
      displayStream.current = await window.navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      micStream.current = await window.navigator.mediaDevices.getUserMedia({
        video: false,
        audio: true,
      });
      SOURCE_SAMPLING_RATE = audioContext.current.sampleRate;

      // callMetaData.samplingRate = TARGET_SAMPLING_RATE;
      callMetaData.samplingRate = SOURCE_SAMPLING_RATE;

      callMetaData.callEvent = 'START';
      // eslint-disable-next-line prettier/prettier
      console.log(`
        DEBUG - [${new Date().toISOString()}]: Send Call START msg: ${JSON.stringify(callMetaData)}
      `);
      sendMessage(JSON.stringify(callMetaData));
      setStreamingStarted(true);

      displayAudioSource.current = audioContext.current.createMediaStreamSource(
        displayStream.current,
      );
      micAudioSource.current = audioContext.current.createMediaStreamSource(micStream.current);

      const monoDisplaySource = convertToMono(displayAudioSource.current);
      const monoMicSource = convertToMono(micAudioSource.current);

      channelMerger.current = audioContext.current.createChannelMerger(2);
      if (micInputOption.value === 'agent') {
        monoMicSource.connect(channelMerger.current, 0, 0);
        monoDisplaySource.connect(channelMerger.current, 0, 1);
      } else {
        monoMicSource.connect(channelMerger.current, 0, 1);
        monoDisplaySource.connect(channelMerger.current, 0, 0);        
      }

      console.log(`
        DEBUG - [${new Date().toISOString()}]: Registering and adding AudioWorklet processor to capture audio
      `);

      try {
        await audioContext.current.audioWorklet.addModule('./worklets/recording-processor.js');
      } catch (error) {
        console.log(`
          DEBUG - [${new Date().toISOString()}]: Error registering AudioWorklet processor: ${error}
        `);
      }

      audioProcessor.current = new AudioWorkletNode(audioContext.current, 'recording-processor');
      audioProcessor.current.port.onmessageerror = (error) => {
        console.log(`
          DEBUG - [${new Date().toISOString()}]: Error receving message from worklet ${error}
        `);
      };
      audioProcessor.current.port.onmessage = (event) => {
        // this is pcm audio
        sendMessage(event.data);
      };
      channelMerger.current.connect(audioProcessor.current);
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
    if (settings.WSEndpoint) {
      setRecording(!recording);
    } else {
      alert('Enable Websocket Audio input to use this feature');
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
            <FormField label="Microphone Role" stretch required description="Mic input">
              <Select
                selectedOption={micInputOption}
                onChange={handleMicInputOptionSelection}
                options={[
                  { label: 'CALLER', value: 'caller' },
                  { label: 'AGENT', value: 'agent' },
                ]}
              />
            </FormField>
          </ColumnLayout>
        </Container>
      </Form>
    </form>
  );
};

export default StreamAudio;
