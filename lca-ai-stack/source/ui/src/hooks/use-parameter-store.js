// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from 'react';

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
// import { useState, useEffect } from 'react';
import awsExports from '../aws-exports';

const LCA_PARAMETER_NAME = process.env.REACT_APP_SETTINGS_PARAMETER;

const useParameterStore = (creds) => {
  const [settings, setSettings] = useState({});

  const refreshSettings = async (credentials) => {
    let lcaSettings = {};

    if (credentials) {
      const ssmClient = new SSMClient({ credentials, region: awsExports.aws_project_region });
      const getParameterCmd = new GetParameterCommand({ Name: LCA_PARAMETER_NAME });
      const response = await ssmClient.send(getParameterCmd);
      if (response.Parameter?.Value) {
        lcaSettings = JSON.parse(response.Parameter.Value);
        console.log(response.Parameter.Value);
      }
    }
    setSettings(lcaSettings);
  };

  useEffect(() => {
    (async () => {
      refreshSettings(creds);
    })();
  }, []);

  return settings;
};

export default useParameterStore;
