import { IncomingMessage, ServerResponse } from 'http';
import { URL, UrlWithParsedQuery } from 'url';

import {
  imageOptimizer as pixel,
  ImageOptimizerOptions as PixelOptions,
} from '@millihq/pixel-core';
import { ImageConfig } from 'next/dist/server/image-config';
import nodeFetch from 'node-fetch';
import S3 from 'aws-sdk/clients/s3';

/* -----------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------------*/

type S3Config = {
  s3: S3;
  bucket: string;
};

type ImageOptimizerOptions = {
  baseOriginUrl?: string;
  parsedUrl: UrlWithParsedQuery;
  s3Config?: S3Config;
};

/* -----------------------------------------------------------------------------
 * imageOptimizer
 * ---------------------------------------------------------------------------*/

async function imageOptimizer(
  imageConfig: ImageConfig,
  req: IncomingMessage,
  res: ServerResponse,
  options: ImageOptimizerOptions
): ReturnType<typeof pixel> {
  const { baseOriginUrl, parsedUrl, s3Config } = options;
  const pixelOptions: PixelOptions = {
    /**
     * Use default temporary folder from AWS Lambda
     */
    distDir: '/tmp',

    imageConfig: {
      ...imageConfig,
      loader: 'default',
    },

    /**
     * Is called when the path is an absolute URI, e.g. `/my/image.png`.
     *
     * @param req - Incoming client request
     * @param res - Outgoing mocked response
     * @param url - Parsed url object from the client request,
     *              e.g. `/my/image.png`
     */
    async requestHandler({ headers }, res, url) {
      if (!url) {
        throw new Error('URL is missing from request.');
      }

      if (s3Config) {
        // S3 expects keys without leading `/`
        const trimmedKey = url.href.startsWith('/')
          ? url.href.substring(1)
          : url.href;

        const object = await s3Config.s3
          .getObject({
            Key: trimmedKey,
            Bucket: s3Config.bucket,
          })
          .promise();

        if (!object.Body) {
          throw new Error(`Could not fetch image ${trimmedKey} from bucket.`);
        }

        res.statusCode = 200;

        if (object.ContentType) {
          res.setHeader('Content-Type', object.ContentType);
        }

        if (object.CacheControl) {
          res.setHeader('Cache-Control', object.CacheControl);
          // originCacheControl = object.CacheControl;
        }

        res.write(object.Body);
        res.end();
      } else if (baseOriginUrl || headers.referer) {
        let originBaseUrl = '';

        // When `baseOriginUrl` is set it should take precedence over the
        // referer header
        if (baseOriginUrl) {
          originBaseUrl = baseOriginUrl;
        } else if (headers.referer) {
          // Referer header is a full URL with path
          // e.g. https://test.example.com/some-path/?foo=bar
          // So we need to parse it first and then extract the host from it
          const { origin: refererBaseUrl } = new URL(headers.referer);
          originBaseUrl = refererBaseUrl;
        }

        const origin = `${originBaseUrl}${url.href}`;
        const upstreamRes = await nodeFetch(origin);

        if (!upstreamRes.ok) {
          throw new Error(`Could not fetch image from ${origin}.`);
        }

        res.statusCode = upstreamRes.status;
        const upstreamType = upstreamRes.headers.get('Content-Type');
        const originCacheControl = upstreamRes.headers.get('Cache-Control');

        if (upstreamType) {
          res.setHeader('Content-Type', upstreamType);
        }

        if (originCacheControl) {
          res.setHeader('Cache-Control', originCacheControl);
        }

        const upstreamBuffer = Buffer.from(await upstreamRes.arrayBuffer());
        res.write(upstreamBuffer);
        res.end();
      }
    },
  };

  return pixel(req, res, parsedUrl, pixelOptions);
}

export type { S3Config };
export { imageOptimizer };
