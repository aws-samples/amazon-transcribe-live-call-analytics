// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { Route, Switch } from 'react-router-dom';
import { SideNavigation } from '@awsui/components-react';

import { CALLS_PATH, DEFAULT_PATH } from '../../routes/constants';

export const callsNavHeader = { text: 'Call Analytics', href: `#${DEFAULT_PATH}` };
export const callsNavItems = [
  { type: 'link', text: 'Calls', href: `#${CALLS_PATH}` },
  {
    type: 'section',
    text: 'Resources',
    items: [
      {
        type: 'link',
        text: 'Blog Post',
        href: 'https://www.amazon.com/live-call-analytics',
        external: true,
      },
      {
        type: 'link',
        text: 'Source Code',
        href: 'https://github.com/aws-samples/amazon-transcribe-live-call-analytics',
        external: true,
      },
    ],
  },
];

const defaultOnFollowHandler = (ev) => {
  // XXX keep the locked href for our demo pages
  ev.preventDefault();
};

/* eslint-disable react/prop-types */
const Navigation = ({
  activeHref = `#${CALLS_PATH}`,
  header = callsNavHeader,
  items = callsNavItems,
  onFollowHandler = defaultOnFollowHandler,
}) => (
  <Switch>
    <Route path={CALLS_PATH}>
      <SideNavigation
        items={items || callsNavHeader}
        header={header || callsNavItems}
        activeHref={activeHref || `#${CALLS_PATH}`}
        onFollow={onFollowHandler}
      />
    </Route>
  </Switch>
);

export default Navigation;
