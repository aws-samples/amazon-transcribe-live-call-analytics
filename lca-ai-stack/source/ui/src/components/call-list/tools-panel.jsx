// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import HelpPanel from '@cloudscape-design/components/help-panel';

const header = <h2>Calls</h2>;
const content = (
  <>
    <p>
      View a list of calls and related information such as phone number, initiation time, sentiment
      and duration.
    </p>
    <p>Use the search bar to filter on any field.</p>
    <p>To drill down even further into the details, select an individual call.</p>
  </>
);

const ToolsPanel = () => <HelpPanel header={header}>{content}</HelpPanel>;

export default ToolsPanel;
