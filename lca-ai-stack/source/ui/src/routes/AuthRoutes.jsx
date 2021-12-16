// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import PropTypes from 'prop-types';
import { Redirect, Route, Switch } from 'react-router-dom';

import { AmplifySignOut } from '@aws-amplify/ui-react';

import CallsRoutes from './CallsRoutes';

import { CALLS_PATH, DEFAULT_PATH, LOGIN_PATH, LOGOUT_PATH } from './constants';

const AuthRoutes = ({ redirectParam }) => (
  <Switch>
    <Route path={CALLS_PATH}>
      <CallsRoutes />
    </Route>
    <Route path={LOGIN_PATH}>
      <Redirect
        to={!redirectParam || redirectParam === LOGIN_PATH ? DEFAULT_PATH : `${redirectParam}`}
      />
    </Route>
    <Route path={LOGOUT_PATH}>
      <AmplifySignOut />
    </Route>
    <Route>
      <Redirect to={DEFAULT_PATH} />
    </Route>
  </Switch>
);

AuthRoutes.propTypes = {
  redirectParam: PropTypes.string.isRequired,
};

export default AuthRoutes;
