// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import React from 'react';

import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';

import { STREAM_AUDIO_PATH, DEFAULT_PATH } from '../../routes/constants';

export const callListBreadcrumbItems = [
  { text: 'Call Analytics', href: `#${DEFAULT_PATH}` },
  { text: 'Stream Audio', href: `#${STREAM_AUDIO_PATH}` },
];

const Breadcrumbs = () => (
  <BreadcrumbGroup ariaLabel="Breadcrumbs" items={callListBreadcrumbItems} />
);

export default Breadcrumbs;
