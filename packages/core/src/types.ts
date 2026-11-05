export type StandardMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'OPTIONS'
  | 'HEAD'
  | 'QUERY'
  | (string & {})

export type StandardUrl =
  | `/${string}`
  | `/${string}?${string}`
  | `/${string}#${string}`
  | `/${string}?${string}#${string}`

export interface StandardHeaders {
  [key: string]: string | string[] | undefined
}

export type StandardBodyHint =
  | 'json' // application/json
  | 'form-data' // multipart/form-data
  | 'url-search-params' // application/x-www-form-urlencoded
  | 'event-stream' // text/event-stream
  | 'octet-stream' // generic binary stream (any content-type)
  | 'file' // binary - file is also a blob (any content-type)
  | 'none' // undefined (any content-type)

/**
 * A parsed body. Its shape depends on the content type:
 *
 * - JSON value: `application/json`
 * - `URLSearchParams`: `application/x-www-form-urlencoded`
 * - `FormData`: `multipart/form-data`
 * - `AsyncIterator<unknown, unknown, undefined>`: `text/event-stream`
 * - `ReadableStream<Uint8Array<ArrayBuffer>>`: generic binary stream (any content-type)
 * - `Blob`: binary, a file is also a blob (any content-type)
 * - `undefined`: empty (any content-type)
 */
export type StandardBody = unknown

export interface StandardRequest {
  /**
   * @example 'GET', 'POST', etc.
   */
  method: StandardMethod
  /**
   * @example `/example`, `/example?query=param#fragment`
   */
  url: StandardUrl
  /**
   * @example { 'content-type': 'application/json' }
   */
  headers: StandardHeaders
  /**
   * The body has been parsed based on the content headers.
   */
  body?: StandardBody
  /**
   * An AbortSignal to communicate aborting of request.
   */
  signal?: AbortSignal | undefined
}

export interface StandardLazyRequest extends Omit<StandardRequest, 'body'> {
  /**
   * Lazily resolves the body.
   *
   * The body is parsed on first call based on the `Content-Type` header
   * or the provided hint.
   *
   * Calling this method may consume the underlying stream.
   */
  resolveBody: (hint?: StandardBodyHint) => Promise<StandardBody>
}

export interface StandardResponse {
  /**
   * @example 200, 404, 500, etc.
   */
  status: number
  /**
   * @example { 'set-cookie': ['sessionId=abc123; HttpOnly'] }
   */
  headers: StandardHeaders
  /**
   * The body has been parsed based on the content headers.
   */
  body?: StandardBody
}

export interface StandardLazyResponse extends Omit<StandardResponse, 'body'> {
  /**
   * Lazily resolves the body.
   *
   * The body is parsed on first call based on the `Content-Type` header
   * or the provided hint.
   *
   * Calling this method may consume the underlying stream.
   */
  resolveBody: (hint?: StandardBodyHint) => Promise<StandardBody>
}
