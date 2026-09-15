import type { Writable } from 'node:stream'

/**
 * AWS API Gateway proxy event, payload format 1.0.
 *
 * A structural subset of the same-named type from `@types/aws-lambda`.
 */
export interface APIGatewayProxyEvent {
  /**
   * @example 'GET', 'POST', etc.
   */
  httpMethod: string
  /**
   * Url-decoded when delivered by an HTTP API, still encoded from a REST API.
   *
   * @example '/example'
   */
  path: string
  /**
   * Keys can be any case.
   */
  headers?: Record<string, string | undefined> | null
  /**
   * Preferred over `headers`, it can carry duplicated headers.
   */
  multiValueHeaders?: Record<string, string[] | undefined> | null
  /**
   * Values are already url-decoded.
   */
  queryStringParameters?: Record<string, string | undefined> | null
  /**
   * Preferred over `queryStringParameters`, it can carry duplicated parameters.
   */
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null
  /**
   * Base64-encoded when `isBase64Encoded` is `true`.
   */
  body?: string | null
  isBase64Encoded?: boolean
}

/**
 * AWS API Gateway proxy event, payload format 2.0, also used by Lambda Function URLs.
 *
 * A structural subset of the same-named type from `@types/aws-lambda`.
 */
export interface APIGatewayProxyEventV2 {
  /**
   * Url-decoded when delivered by an HTTP API, still encoded from a Lambda Function URL.
   *
   * @example '/example'
   */
  rawPath: string
  /**
   * Already url-encoded, without the leading `?`.
   */
  rawQueryString?: string
  /**
   * Keys can be any case, duplicated headers arrive joined with commas.
   */
  headers?: Record<string, string | undefined> | null
  /**
   * Extracted from the `cookie` header.
   */
  cookies?: string[] | null
  requestContext: {
    http: {
      /**
       * @example 'GET', 'POST', etc.
       */
      method: string
    }
  }
  /**
   * Base64-encoded when `isBase64Encoded` is `true`.
   */
  body?: string | null
  isBase64Encoded?: boolean
}

/**
 * Any supported API Gateway proxy event.
 * Payload format 1.0 is detected by its top-level `httpMethod` field.
 */
export type AnyAPIGatewayProxyEvent = APIGatewayProxyEvent | APIGatewayProxyEventV2

/**
 * The stream `awslambda.streamifyResponse` provides to write the response to.
 */
export interface HttpResponseStream extends Writable {
  setContentType: (contentType: string) => void
}

/**
 * Shape of the `awslambda` global the Lambda Node.js runtime injects
 * when response streaming is enabled.
 *
 * Not declared globally to keep the consumer's global types clean,
 * declare it yourself: `declare const awslambda: AwsLambdaGlobal`
 */
export interface AwsLambdaGlobal {
  streamifyResponse<TEvent = unknown, TContext = unknown>(
    handler: (event: TEvent, responseStream: HttpResponseStream, context: TContext) => Promise<void> | void,
  ): (event: TEvent, responseStream: HttpResponseStream, context: TContext) => Promise<void> | void

  HttpResponseStream: {
    /**
     * Sends the metadata prelude and returns the stream to write the body to.
     */
    from(
      responseStream: HttpResponseStream,
      metadata: { statusCode: number, headers: Record<string, string>, cookies: string[] } & Record<string, unknown>,
    ): HttpResponseStream
  }
}
