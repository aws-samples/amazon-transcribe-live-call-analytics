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
      console.log('no media recorder available to stop');
      setRecording(false);
    }
    if (streamingStarted && !recording) {
      callMetaData.callEvent = 'END';
      sendMessage(JSON.stringify(callMetaData));
      setStreamingStarted(false);
      setCallMetaData({
        ...callMetaData,
        callId: crypto.randomUUID(),
      });
    }
  };

  const startRecording = async () => {
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
      sendMessage(JSON.stringify(callMetaData));
      setStreamingStarted(true);

      displayAudioSource.current = audioContext.current.createMediaStreamSource(
        displayStream.current,
      );
      micAudioSource.current = audioContext.current.createMediaStreamSource(micStream.current);

      const monoDisplaySource = convertToMono(displayAudioSource.current);
      const monoMicSource = convertToMono(micAudioSource.current);

      channelMerger.current = audioContext.current.createChannelMerger(2);
      monoMicSource.connect(channelMerger.current, 0, 0);
      monoDisplaySource.connect(channelMerger.current, 0, 1);

      try {
        await audioContext.current.audioWorklet.addModule('./worklets/recording-processor.js');
      } catch (error) {
        console.log(`Add module error ${error}`);
      }

      audioProcessor.current = new AudioWorkletNode(audioContext.current, 'recording-processor');
      audioProcessor.current.port.onmessageerror = (error) => {
        console.log(`Error receving message from worklet ${error}`);
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
