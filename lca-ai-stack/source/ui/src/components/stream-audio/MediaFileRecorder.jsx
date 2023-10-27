// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import React, { useState } from 'react';
import { FileUpload } from '@awsui/components-react';
import '@awsui/global-styles/index.css';

const MediaFileRecorder = () => {
  const [value, setValue] = useState(null);

  return (
    <FileUpload
      onChange={({ detail }) => setValue(detail.value)}
      value={value}
      i18nStrings={{
        uploadButtonText: () => {
          'Choose file';
        },
        dropzoneText: () => {
          'Drag and drop your file here';
        },
        removeFileAriaLabel: () => {
          'Remove file';
        },
      }}
      showFileLastModified
      showFileSize
      showFileThumbnail
      tokenLimit={3}
    />
  );
};

export default MediaFileRecorder;
