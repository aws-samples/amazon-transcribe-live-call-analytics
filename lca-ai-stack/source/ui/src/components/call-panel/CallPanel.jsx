// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Box,
  ColumnLayout,
  Container,
  Grid,
  Header,
  Popover,
  SpaceBetween,
  StatusIndicator,
  TextContent,
  Toggle,
} from '@awsui/components-react';
import rehypeRaw from 'rehype-raw';
import ReactMarkdown from 'react-markdown';

import RecordingPlayer from '../recording-player';

import { DONE_STATUS, IN_PROGRESS_STATUS } from '../common/get-recording-status';
import { InfoLink } from '../common/info-link';
import { getWeightedSentimentLabel } from '../common/sentiment';

import { SentimentFluctuationChart, SentimentPerQuarterChart } from './sentiment-charts';

import './CallPanel.css';
import { SentimentTrendIcon } from '../sentiment-trend-icon/SentimentTrendIcon';
import { SentimentIcon } from '../sentiment-icon/SentimentIcon';

// comprehend PII types
const piiTypes = [
  'BANK_ACCOUNT_NUMBER',
  'BANK_ROUTING',
  'CREDIT_DEBIT_NUMBER',
  'CREDIT_DEBIT_CVV',
  'CREDIT_DEBIT_EXPIRY',
  'PIN',
  'EMAIL',
  'ADDRESS',
  'NAME',
  'PHONE',
  'SSN',
];
const piiTypesSplitRegEx = new RegExp(`\\[(${piiTypes.join('|')})\\]`);

/* eslint-disable react/prop-types, react/destructuring-assignment */
const CallAttributes = ({ item, setToolsOpen }) => (
  <Container
    header={
      <Header variant="h4" info={<InfoLink onFollow={() => setToolsOpen(true)} />}>
        Call Attributes
      </Header>
    }
  >
    <ColumnLayout columns={6} variant="text-grid">
      <SpaceBetween size="xs">
        <div>
          <Box margin={{ bottom: 'xxxs' }} color="text-label">
            <strong>Call ID</strong>
          </Box>
          <div>{item.callId}</div>
        </div>
      </SpaceBetween>

      <SpaceBetween size="xs">
        <div>
          <Box margin={{ bottom: 'xxxs' }} color="text-label">
            <strong>Agent</strong>
          </Box>
          <div>{item.agentId}</div>
        </div>
      </SpaceBetween>

      <SpaceBetween size="xs">
        <div>
          <Box margin={{ bottom: 'xxxs' }} color="text-label">
            <strong>Initiation Timestamp</strong>
          </Box>
          <div>{item.initiationTimeStamp}</div>
        </div>
      </SpaceBetween>

      <SpaceBetween size="xs">
        <div>
          <Box margin={{ bottom: 'xxxs' }} color="text-label">
            <strong>Last Update Timestamp</strong>
          </Box>
          <div>{item.updatedAt}</div>
        </div>
      </SpaceBetween>

      <SpaceBetween size="xs">
        <div>
          <Box margin={{ bottom: 'xxxs' }} color="text-label">
            <strong>Duration</strong>
          </Box>
          <div>{item.conversationDurationTimeStamp}</div>
        </div>
      </SpaceBetween>

      <SpaceBetween size="xs">
        <div>
          <Box margin={{ bottom: 'xxxs' }} color="text-label">
            <strong>Caller Phone Number</strong>
          </Box>
          <div>{item.callerPhoneNumber}</div>
        </div>
      </SpaceBetween>

      <SpaceBetween size="xs">
        <div>
          <Box margin={{ bottom: 'xxxs' }} color="text-label">
            <strong>System Phone Number</strong>
          </Box>
          <div>{item.systemPhoneNumber}</div>
        </div>
      </SpaceBetween>

      <SpaceBetween size="xs">
        <div>
          <Box margin={{ bottom: 'xxxs' }} color="text-label">
            <strong>Status</strong>
          </Box>
          <StatusIndicator type={item.recordingStatusIcon}>
            {` ${item.recordingStatusLabel} `}
          </StatusIndicator>
        </div>
      </SpaceBetween>
      {item?.recordingUrl?.length && (
        <SpaceBetween size="xs">
          <div>
            <Box margin={{ bottom: 'xxxs' }} color="text-label">
              <strong>Recording Audio</strong>
            </Box>
            <RecordingPlayer recordingUrl={item.recordingUrl} />
          </div>
        </SpaceBetween>
      )}
    </ColumnLayout>
  </Container>
);

const getSentimentImage = (segment) => {
  const { sentiment, sentimentScore, sentimentWeighted } = segment;
  if (!sentiment) {
    // returns an empty div to maintain spacing
    return <div className="sentiment-image" />;
  }
  const weightedSentimentLabel = getWeightedSentimentLabel(sentimentWeighted);
  return (
    <Popover
      dismissAriaLabel="Close"
      header="Sentiment"
      size="medium"
      triggerType="custom"
      content={
        <SpaceBetween size="s">
          <div>
            <Box margin={{ bottom: 'xxxs' }} color="text-label">
              Sentiment
            </Box>
            <div>{sentiment}</div>
          </div>
          <div>
            <Box margin={{ bottom: 'xxxs' }} color="text-label">
              Sentiment Scores
            </Box>
            <div>{JSON.stringify(sentimentScore)}</div>
          </div>
          <div>
            <Box margin={{ bottom: 'xxxs' }} color="text-label">
              Weighted Sentiment
            </Box>
            <div>{sentimentWeighted}</div>
          </div>
        </SpaceBetween>
      }
    >
      <div className="sentiment-image-popover">
        <SentimentIcon sentiment={weightedSentimentLabel} />
      </div>
    </Popover>
  );
};

const getTimestampFromSeconds = (secs) => {
  if (!secs || Number.isNaN(secs)) {
    return '00:00.0';
  }
  return new Date(secs * 1000).toISOString().substr(14, 7);
};

const TranscriptContent = ({ segment }) => {
  const { transcript, segmentId, channel } = segment;
  const transcriptPiiSplit = transcript.split(piiTypesSplitRegEx);
  const transcriptComponents = transcriptPiiSplit.map((t, i) => {
    if (piiTypes.includes(t)) {
      // eslint-disable-next-line react/no-array-index-key
      return <Badge key={`${segmentId}-pii-${i}`} color="red">{`${t}`}</Badge>;
    }
    let className = '';
    let text = t;
    switch (channel) {
      case 'AGENT_ASSISTANT':
        className = 'transcript-segment-agent-assist';
        break;
      case 'CATEGORY_MATCH':
        className = 'transcript-segment-category-match';
        text = `Category Match: ${text}`;
        break;
      default:
        break;
    }
    // if(channel === 'AGENT_ASSISTANT' ? 'transcript-segment-agent-assist' : '';
    return (
      // eslint-disable-next-line react/no-array-index-key
      <TextContent key={`${segmentId}-text-${i}`} color="gray" className={className}>
        <ReactMarkdown rehypePlugins={[rehypeRaw]}>{text.trim()}</ReactMarkdown>
        {/* {t.trim()} */}
      </TextContent>
    );
  });

  return (
    <SpaceBetween direction="horizontal" size="xxs">
      {transcriptComponents}
    </SpaceBetween>
  );
};

const TranscriptSegment = ({ segment }) => {
  const { channel } = segment;

  if (channel === 'CATEGORY_MATCH') {
    const categoryText = `${segment.transcript}`;
    const newSegment = segment;
    newSegment.transcript = categoryText;
    // We will return a special version of the grid thats specifically only for category.
    return (
      <Grid
        className="transcript-segment"
        disableGutters
        gridDefinition={[{ colspan: 1 }, { colspan: 11 }]}
      >
        {getSentimentImage(segment)}
        <SpaceBetween direction="vertical" size="xxs">
          <TranscriptContent segment={newSegment} />
        </SpaceBetween>
      </Grid>
    );
  }

  const channelClass = channel === 'AGENT_ASSISTANT' ? 'transcript-segment-agent-assist' : '';
  return (
    <Grid
      className="transcript-segment"
      disableGutters
      gridDefinition={[{ colspan: 1 }, { colspan: 11 }]}
    >
      {getSentimentImage(segment)}
      <SpaceBetween direction="vertical" size="xxs" className={channelClass}>
        <SpaceBetween direction="horizontal" size="xs">
          <TextContent>
            <strong>{segment.channel}</strong>
          </TextContent>
          <TextContent>
            {`${getTimestampFromSeconds(segment.startTime)} -
              ${getTimestampFromSeconds(segment.endTime)}`}
          </TextContent>
        </SpaceBetween>
        <TranscriptContent segment={segment} />
      </SpaceBetween>
    </Grid>
  );
};

const CallInProgressTranscript = ({ item, callTranscriptPerCallId, autoScroll }) => {
  const bottomRef = useRef();
  const [turnByTurnSegments, setTurnByTurnSegments] = useState([]);
  // channels: AGENT, AGENT_ASSIST, CALLER, CATEGORY_MATCH
  const maxChannels = 4;
  const { callId } = item;
  const transcriptsForThisCallId = callTranscriptPerCallId[callId] || {};
  const transcriptChannels = Object.keys(transcriptsForThisCallId).slice(0, maxChannels);

  const getTurnByTurnSegments = () => {
    const currentTurnByTurnSegments = transcriptChannels
      .map((c) => {
        const { segments } = transcriptsForThisCallId[c];
        return segments;
      })
      // sort entries by end time
      .reduce((p, c) => [...p, ...c].sort((a, b) => a.endTime - b.endTime), [])
      .map(
        // prettier-ignore
        (s) => (
          s?.segmentId
          && s?.createdAt
          && <TranscriptSegment key={`${s.segmentId}-${s.createdAt}}`} segment={s} />
        ),
      );

    // this element is used for scrolling to bottom and to provide padding
    currentTurnByTurnSegments.push(<div key="bottom" ref={bottomRef} />);

    return currentTurnByTurnSegments;
  };

  useEffect(() => {
    setTurnByTurnSegments(getTurnByTurnSegments());
  }, [callTranscriptPerCallId, item.recordingStatusLabel]);

  useEffect(() => {
    // prettier-ignore
    if (
      item.recordingStatusLabel === IN_PROGRESS_STATUS
      && autoScroll
      && bottomRef.current?.scrollIntoView
    ) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [turnByTurnSegments, autoScroll, item.recordingStatusLabel]);

  return (
    <Box className="transcript-box" padding="l">
      <ColumnLayout borders="horizontal" columns={1}>
        {turnByTurnSegments}
      </ColumnLayout>
    </Box>
  );
};

const getTranscriptContent = ({ item, callTranscriptPerCallId, autoScroll }) => {
  switch (item.recordingStatusLabel) {
    case DONE_STATUS:
    case IN_PROGRESS_STATUS:
    default:
      return (
        <CallInProgressTranscript
          item={item}
          callTranscriptPerCallId={callTranscriptPerCallId}
          autoScroll={autoScroll}
        />
      );
  }
};

const CallTranscriptContainer = ({ setToolsOpen, item, callTranscriptPerCallId }) => {
  // defaults to auto scroll when call is in progress
  const [autoScroll, setAutoScroll] = useState(item.recordingStatusLabel === IN_PROGRESS_STATUS);
  const [autoScrollDisabled, setAutoScrollDisabled] = useState(
    item.recordingStatusLabel !== IN_PROGRESS_STATUS,
  );

  useEffect(() => {
    setAutoScrollDisabled(item.recordingStatusLabel !== IN_PROGRESS_STATUS);
    setAutoScroll(item.recordingStatusLabel === IN_PROGRESS_STATUS);
  }, [item.recordingStatusLabel]);

  return (
    <Container
      disableContentPaddings
      header={
        <Header
          variant="h4"
          info={<InfoLink onFollow={() => setToolsOpen(true)} />}
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Toggle
                onChange={({ detail }) => setAutoScroll(detail.checked)}
                checked={autoScroll}
                disabled={autoScrollDisabled}
              >
                Auto scroll
              </Toggle>
            </SpaceBetween>
          }
        >
          Call Transcript
        </Header>
      }
    >
      {getTranscriptContent({ item, callTranscriptPerCallId, autoScroll })}
    </Container>
  );
};

const CallStatsContainer = ({ setToolsOpen, item, callTranscriptPerCallId }) => (
  <Container
    header={
      <Header variant="h4" info={<InfoLink onFollow={() => setToolsOpen(true)} />}>
        Call Statistics
      </Header>
    }
  >
    <Grid gridDefinition={[{ colspan: 4 }, { colspan: 4 }, { colspan: 4 }]}>
      <SentimentFluctuationChart item={item} callTranscriptPerCallId={callTranscriptPerCallId} />
      <SentimentPerQuarterChart item={item} callTranscriptPerCallId={callTranscriptPerCallId} />
      <SpaceBetween direction="vertical" size="xs">
        <SpaceBetween size="xs">
          <Box margin={{ bottom: 'xxxs' }} color="text-label">
            <strong>Caller Average Sentiment</strong>
            &nbsp;(min: -5, max: +5)
          </Box>
          <SpaceBetween direction="horizontal" size="xs">
            <SentimentIcon sentiment={item.callerSentimentLabel} />
            <div>{item.callerAverageSentiment.toFixed(3)}</div>
          </SpaceBetween>
        </SpaceBetween>
        <SpaceBetween size="xs">
          <Box margin={{ bottom: 'xxxs' }} color="text-label">
            <strong>Caller Sentiment Trend</strong>
          </Box>
          <SpaceBetween direction="horizontal" size="xs">
            <SentimentTrendIcon trend={item.callerSentimentTrendLabel} />
          </SpaceBetween>
        </SpaceBetween>
        <SpaceBetween size="xs">
          <Box margin={{ bottom: 'xxxs' }} color="text-label">
            <strong>Agent Average Sentiment</strong>
            &nbsp;(min: -5, max: +5)
          </Box>
          <SpaceBetween direction="horizontal" size="xs">
            <SentimentIcon sentiment={item.agentSentimentLabel} />
            <div>{item.agentAverageSentiment.toFixed(3)}</div>
          </SpaceBetween>
        </SpaceBetween>
        <SpaceBetween size="xs">
          <Box margin={{ bottom: 'xxxs' }} color="text-label">
            <strong>Agent Sentiment Trend</strong>
          </Box>
          <SpaceBetween direction="horizontal" size="xs">
            <SentimentTrendIcon trend={item.agentSentimentTrendLabel} />
          </SpaceBetween>
        </SpaceBetween>
      </SpaceBetween>
    </Grid>
  </Container>
);

export const CallPanel = ({ item, callTranscriptPerCallId, setToolsOpen }) => (
  <SpaceBetween size="s">
    <CallAttributes item={item} setToolsOpen={setToolsOpen} />
    <CallStatsContainer
      item={item}
      setToolsOpen={setToolsOpen}
      callTranscriptPerCallId={callTranscriptPerCallId}
    />
    <CallTranscriptContainer
      item={item}
      setToolsOpen={setToolsOpen}
      callTranscriptPerCallId={callTranscriptPerCallId}
    />
  </SpaceBetween>
);

export default CallPanel;
