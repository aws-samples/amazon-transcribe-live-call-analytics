// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import Table from '@cloudscape-design/components/table';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Box from '@cloudscape-design/components/box';
import Link from '@cloudscape-design/components/link';
import { SELECTION_LABELS } from './calls-table-config';
import { CALLS_PATH } from '../../routes/constants';

import CallPanel from '../call-panel';
import { IN_PROGRESS_STATUS } from '../common/get-recording-status';

export const SPLIT_PANEL_I18NSTRINGS = {
  preferencesTitle: 'Split panel preferences',
  preferencesPositionLabel: 'Split panel position',
  preferencesPositionDescription: 'Choose the default split panel position for the service.',
  preferencesPositionSide: 'Side',
  preferencesPositionBottom: 'Bottom',
  preferencesConfirm: 'Confirm',
  preferencesCancel: 'Cancel',
  closeButtonAriaLabel: 'Close panel',
  openButtonAriaLabel: 'Open panel',
  resizeHandleAriaLabel: 'Resize split panel',
};

const EMPTY_PANEL_CONTENT = {
  header: '0 calls selected',
  body: 'Select a call to see its details.',
};

const getPanelContentSingle = ({ items, setToolsOpen, callTranscriptPerCallId }) => {
  if (!items.length) {
    return EMPTY_PANEL_CONTENT;
  }

  const item = items[0];

  return {
    header: 'Call Details',
    body: (
      <CallPanel
        item={item}
        setToolsOpen={setToolsOpen}
        callTranscriptPerCallId={callTranscriptPerCallId}
      />
    ),
  };
};

const getPanelContentMultiple = ({ items, setToolsOpen, callTranscriptPerCallId }) => {
  if (!items.length) {
    return EMPTY_PANEL_CONTENT;
  }

  if (items.length === 1) {
    return getPanelContentSingle({ items, setToolsOpen, callTranscriptPerCallId });
  }

  return {
    header: `${items.length} calls selected`,
    body: (
      <ColumnLayout columns="4" variant="text-grid">
        <div>
          <Box margin={{ bottom: 'xxxs' }} color="text-label">
            Live calls
          </Box>
          <Link fontSize="display-l" href={`#${CALLS_PATH}`}>
            <span className="custom-link-font-weight-light">
              {
                items.filter(
                  ({ recordingStatusLabel }) => recordingStatusLabel === IN_PROGRESS_STATUS,
                ).length
              }
            </span>
          </Link>
        </div>
      </ColumnLayout>
    ),
  };
};

// XXX to be implemented - not sure if needed
const getPanelContentComparison = ({ items }) => {
  if (!items.length) {
    return {
      header: '0 calls selected',
      body: 'Select a call to see its details. Select multiple calls to compare.',
    };
  }

  if (items.length === 1) {
    return getPanelContentSingle({ items });
  }
  const keyHeaderMap = {
    callId: 'Call ID',
    initiationTimeStamp: 'Initiation Timestramp',
  };
  const transformedData = ['callId', 'initiationTimeStamp'].map((key) => {
    const data = { comparisonType: keyHeaderMap[key] };

    items.forEach((item) => {
      data[item.id] = item[key];
    });

    return data;
  });

  const columnDefinitions = [
    {
      id: 'comparisonType',
      header: '',
      cell: ({ comparisonType }) => <b>{comparisonType}</b>,
    },
    ...items.map(({ id }) => ({
      id,
      header: id,
      cell: (item) => (Array.isArray(item[id]) ? item[id].join(', ') : item[id]),
    })),
  ];

  return {
    header: `${items.length} calls selected`,
    body: (
      <Box padding={{ bottom: 'l' }}>
        <Table
          ariaLabels={SELECTION_LABELS}
          header={<h2>Compare details</h2>}
          items={transformedData}
          columnDefinitions={columnDefinitions}
        />
      </Box>
    ),
  };
};

export const getPanelContent = (items, type, setToolsOpen, callTranscriptPerCallId) => {
  if (type === 'single') {
    return getPanelContentSingle({ items, setToolsOpen, callTranscriptPerCallId });
  }
  if (type === 'multiple') {
    return getPanelContentMultiple({ items, setToolsOpen, callTranscriptPerCallId });
  }
  return getPanelContentComparison({ items });
};
