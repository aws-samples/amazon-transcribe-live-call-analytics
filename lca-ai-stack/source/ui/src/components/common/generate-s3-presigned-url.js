// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { HttpRequest } from '@aws-sdk/protocol-http';
import { S3RequestPresigner } from '@aws-sdk/s3-request-presigner';
import { parseUrl } from '@aws-sdk/url-parser';
import { Sha256 } from '@aws-crypto/sha256-browser';
import { formatUrl } from '@aws-sdk/util-format-url';
import { Logger } from 'aws-amplify';

const logger = new Logger('generateS3PresignedUrl');

const generateS3PresignedUrl = async (url, credentials) => {
  if (!url) {
    logger.error('URL is undefined or empty');
    return null;
  }

  logger.debug('Original URL:', url);

  try {
    // Parse the URL correctly
    const parsedUrl = new URL(url);

    // Extract bucket name and region
    const hostnameParts = parsedUrl.hostname.split('.');
    let bucketName;
    let region;

    if (hostnameParts.length >= 4 && hostnameParts[1] === 's3') {
      // Format: bucket-name.s3.region.amazonaws.com
      bucketName = hostnameParts[0];
      region = hostnameParts[2];
    } else {
      logger.error('Invalid S3 URL format:', url);
      return null;
    }

    // Remove the leading slash from the path
    const key = parsedUrl.pathname.substring(1);

    if (!key || key === 'connect/us-connect') {
      logger.error('Invalid or incomplete S3 object path:', key);
      return null;
    }

    // Build the correct S3URL
    const s3Url = `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
    logger.debug('Constructed S3 URL:', s3Url);

    // Parse the S3URL
    const s3ObjectUrl = parseUrl(s3Url);

    // Generate the signed URL
    const presigner = new S3RequestPresigner({
      credentials,
      region,
      sha256: Sha256,
    });

    const presignedResponse = await presigner.presign(new HttpRequest(s3ObjectUrl));
    const presignedUrl = formatUrl(presignedResponse);

    logger.debug('Generated presigned URL (truncated):', presignedUrl.substring(0, 100) + '...');
    return presignedUrl;

  } catch (error) {
    logger.error('Error generating presigned URL:', error);
    return null;
  }
};

export default generateS3PresignedUrl;
