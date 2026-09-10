# Standard Server

<div align="center">
  <a href="https://codecov.io/gh/middleapi/standard-server">
    <img alt="codecov" src="https://codecov.io/gh/middleapi/standard-server/branch/main/graph/badge.svg">
  </a>
  <a href="https://www.npmjs.com/package/@standard-server/core">
    <img alt="weekly downloads" src="https://img.shields.io/npm/dw/%40standard-server%2Fcore?logo=npm" />
  </a>
  <a href="https://app.codspeed.io/middleapi/standard-server?utm_source=badge">
    <img src="https://img.shields.io/endpoint?url=https://codspeed.io/badge.json" alt="CodSpeed" />
  </a>
  <a href="https://github.com/middleapi/standard-server/blob/main/LICENSE">
    <img alt="MIT License" src="https://img.shields.io/github/license/middleapi/standard-server?logo=open-source-initiative" />
  </a>
  <a href="https://discord.gg/TXEbwRBvQn">
    <img alt="Discord" src="https://img.shields.io/discord/1308966753044398161?color=7389D8&label&logo=discord&logoColor=ffffff" />
  </a>
  <a href="https://deepwiki.com/middleapi/standard-server">
    <img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki">
  </a>
</div>

`@standard-server/core` is the shared contract package for **Standard Server** — a unified interface for client-server communication across HTTP and message-based transports. It lets you keep handler and client code transport-agnostic by working with the same request, response, body, and streaming abstractions whether the transport is Fetch, Node.js HTTP, or a peer-style message channel.

Standard Server ships as a small ecosystem of packages:

| Package                                                                                                               | Description                                                                 |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`@standard-server/core`](https://github.com/middleapi/standard-server/blob/main/packages/core/README.md)             | The shared contract: types, body parsing rules, validators, and SSE helpers |
| [`@standard-server/fetch`](https://github.com/middleapi/standard-server/blob/main/packages/fetch/README.md)           | Fetch API adapter for browsers, workers, and other Fetch-based runtimes     |
| [`@standard-server/node`](https://github.com/middleapi/standard-server/blob/main/packages/node/README.md)             | Node.js HTTP and HTTP/2 adapter                                             |
| [`@standard-server/fastify`](https://github.com/middleapi/standard-server/blob/main/packages/fastify/README.md)       | Fastify adapter built on the Node.js adapter                                |
| [`@standard-server/aws-lambda`](https://github.com/middleapi/standard-server/blob/main/packages/aws-lambda/README.md) | AWS Lambda adapter with response streaming                                  |
| [`@standard-server/peer`](https://github.com/middleapi/standard-server/blob/main/packages/peer/README.md)             | Message-based adapter for WebSocket, MessagePort, and custom transports     |
| [`@standard-server/shared`](https://github.com/middleapi/standard-server/blob/main/packages/shared/README.md)         | Internal utilities shared across the ecosystem                              |

This package is the foundation of that model. It defines the request and response types every adapter converts to and from, the body parsing rules they all share, runtime validators, header and URL utilities, and event stream (SSE) helpers.

## Request and response types

The package exposes four transport-agnostic shapes:

| Export                 | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `StandardRequest`      | Eager request object with a parsed `body`                       |
| `StandardLazyRequest`  | Request object with `resolveBody(hint?)` for lazy body parsing  |
| `StandardResponse`     | Eager response object with a parsed `body`                      |
| `StandardLazyResponse` | Response object with `resolveBody(hint?)` for lazy body parsing |

Supporting primitives:

| Export             | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `StandardMethod`   | Common HTTP verbs plus any custom string value                |
| `StandardUrl`      | A request URL that must start with `/` and exclude the origin |
| `StandardHeaders`  | `Record<string, string \| string[] \| undefined>`             |
| `StandardBodyHint` | Parsing hint for lazy body resolution                         |
| `StandardBody`     | Shared body union used by requests and responses              |

By convention, adapters normalize headers to lowercase keys. `signal` is part of `StandardRequest` only and is used to propagate request cancellation.

```ts
import type { StandardLazyRequest, StandardResponse } from '@standard-server/core'

export async function handle(request: StandardLazyRequest): Promise<StandardResponse> {
  const body = await request.resolveBody()

  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      ok: true,
      method: request.method,
      url: request.url,
      received: body,
    },
  }
}
```

## Body types

`StandardBodyHint` and `StandardBody` describe the shared body contract used across adapters:

| Hint                | `StandardBody` value           | Typical content type                | Notes                                                 |
| ------------------- | ------------------------------ | ----------------------------------- | ----------------------------------------------------- |
| `json`              | `unknown`                      | `application/json`                  | Primitives, objects, and arrays                       |
| `form-data`         | `FormData`                     | `multipart/form-data`               | Multipart form submissions                            |
| `url-search-params` | `URLSearchParams`              | `application/x-www-form-urlencoded` | URL-encoded forms                                     |
| `event-stream`      | `AsyncIteratorObject<unknown>` | `text/event-stream`                 | Server-Sent Events (SSE)                              |
| `octet-stream`      | `ReadableStream<Uint8Array>`   | any                                 | Binary streaming                                      |
| `file`              | `File`                         | any                                 | Fixed-size binary payloads for both `File` and `Blob` |
| `none`              | `undefined`                    |                                     | Empty body                                            |

### JSON body

Standard Server treats primitive values, objects, and arrays as JSON.

```ts
import type { StandardRequest } from '@standard-server/core'

const request: StandardRequest = {
  method: 'POST',
  url: '/submit',
  headers: {},
  body: { name: 'John Doe', email: 'john.doe@example.com' },
}
```

### FormData and URLSearchParams body

Standard Server treats [FormData](https://developer.mozilla.org/en-US/docs/Web/API/FormData) and [URLSearchParams](https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams) as form submissions.

```ts
import type { StandardRequest } from '@standard-server/core'

const requestWithURLSearchParams: StandardRequest = {
  method: 'POST',
  url: '/submit',
  headers: {},
  body: new URLSearchParams({ name: 'John Doe', email: 'john.doe@example.com' }),
}

const formData = new FormData()
formData.append('name', 'John Doe')
formData.append('file', new Blob(['Hello, World!'], { type: 'text/plain' }), 'hello.txt')

const requestWithFormData: StandardRequest = {
  method: 'POST',
  url: '/submit',
  headers: {},
  body: formData,
}
```

> [!TIP]
> HTML forms submit data as `application/x-www-form-urlencoded` or `multipart/form-data`, so these body types are especially helpful there.

### File and Blob body

Standard Server treats [File](https://developer.mozilla.org/en-US/docs/Web/API/File) and [Blob](https://developer.mozilla.org/en-US/docs/Web/API/Blob) as fixed-size binary payloads.

> [!NOTE]
> Since `File` extends `Blob`, `resolveBody` always returns a `File` when representing either `File` or `Blob` bodies.

```ts
import type { StandardResponse } from '@standard-server/core'

const response: StandardResponse = {
  status: 200,
  headers: {
    'content-disposition': [], // <- remove auto-set header
  },
  body: new File(['Hello, World!'], 'hello.txt', { type: 'text/plain' }),
}
```

When sending a file or blob body, adapters automatically set the `content-length`, `content-type`, `content-disposition`, and `standard-server` headers based on the provided body. You can override any of them by explicitly providing a header value, or remove one entirely by assigning an empty array.

### Event-stream body

Standard Server uses [AsyncIteratorObject](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncIterator) to represent an event stream body, and you can use `withEventMeta()` to attach additional [SSE event metadata](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#event_stream_format) to each emitted event.

```ts
import type { StandardResponse } from '@standard-server/core'
import { ErrorEvent, withEventMeta } from '@standard-server/core'

const response: StandardResponse = {
  status: 200,
  headers: {},
  async* body() {
    yield withEventMeta(
      { message: 'Hello, World!' },
      { id: '1', retry: 3000, comments: ['hidden'] },
    )

    throw new ErrorEvent({ message: 'Something went wrong' })

    return { message: 'This is the end of the stream' }
  },
}
```

Events are interpreted as follows: `yield` emits a `message`, `throw` emits an `error`, and `return` emits a `close` event. Note that `close` does not cause [EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource) to close the connection because it is not part of the SSE specification. However, when using Standard Server for client-side streaming, `close` is treated as the end of the stream, so the connection is closed and no reconnection is attempted.

For explicit SSE encoding, decoding, and metadata handling, see the [Event-Stream Helpers](#event-stream-helpers) below.

### Octet-stream body

Standard Server uses [ReadableStream<Uint8Array>](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream) to represent a binary streaming body.

```ts
import type { StandardResponse } from '@standard-server/core'

const response: StandardResponse = {
  status: 200,
  headers: {
    'content-type': 'application/octet-stream',
  },
  body: new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode('Hello, World!'))
      controller.close()
    },
  }),
}
```

When sending a binary streaming body, adapters automatically set the `content-type` and `standard-server` headers. You can override `content-type` by providing an explicit header value, or remove it entirely by assigning an empty array.

## How body parsing works

> [!NOTE]
> This section applies to the HTTP adapters (Fetch, Node.js, Fastify, AWS Lambda). It does not apply to the [peer adapter](https://github.com/middleapi/standard-server/blob/main/packages/peer/README.md#body-resolution), which identifies body types through its own message protocol — a different but fairly similar mechanism.

`resolveBody(hint?)` on `StandardLazyRequest` and `StandardLazyResponse` resolves the body lazily — the underlying stream is only consumed once you call it. The `StandardBodyHint` that decides how the raw body is parsed comes from three places: an explicit `hint` argument, the `standard-server` header, or inference from the content headers.

### The `standard-server` header

A `StandardBody` is richer than what HTTP content headers can describe. `content-type` tells the receiver the _media type_ of the bytes, but not which `StandardBody` representation the sender intended:

- A file upload can legitimately carry `content-type: application/json`. Without more information, the receiver would parse it into a JSON value when the sender meant a `File` to be stored as-is.
- A fixed-size binary payload (`file`) and a binary stream (`octet-stream`) can share any content type. Telling them apart otherwise depends on `content-length`, which proxies may rewrite and some runtimes drop when the payload is empty.

The `standard-server` header closes this gap. It carries the sender's `StandardBodyHint` verbatim — `json`, `form-data`, `url-search-params`, `event-stream`, `octet-stream`, `file`, or `none` — so the receiver reconstructs exactly the body representation the sender had.

Adapters set the header automatically for the ambiguous body types: a `Blob` or `File` body is sent with `standard-server: file`, and a `ReadableStream` body with `standard-server: octet-stream`, alongside the usual content headers. A header you set yourself always wins, and assigning an empty array removes it entirely. For the other body types, the content headers are enough, so adapters clear it.

The header is optional: when it is absent or invalid, the receiver falls back to content-header inference, so plain HTTP clients work as-is. Just set the header yourself whenever the content type alone could be misread:

```ts
const response = await fetch('/upload', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'standard-server': 'file', // <- keep the payload a File on the server
  },
  body: new Blob(['{"message": "Hello, world!"}'], { type: 'application/json' }),
})
```

### Resolution order

The hint is chosen in this order:

1. **Explicit `hint` argument.** If you pass a hint to `resolveBody(hint)`, it always wins.
2. **The `standard-server` header.** If present and holding a valid hint value, it is used verbatim. Unknown values are ignored.
3. **Content-header inference:**
   1. No `content-type`, and `content-length` absent or `0` → `none`.
   2. A common `content-type` → `application/json` parses as `json`, `multipart/form-data` as `form-data`, `application/x-www-form-urlencoded` as `url-search-params`, and `text/event-stream` as `event-stream`. Media type casing and parameters such as `; charset=utf-8` are ignored.
   3. A `content-disposition` carrying a filename, or any `content-length` → `file`.
   4. Anything else → `octet-stream`.

This resolution is implemented once in this package as `resolveStandardBodyHint(headers)` and shared by every HTTP adapter, so the same body parses the same way regardless of which HTTP transport carried it:

```ts
import { resolveStandardBodyHint } from '@standard-server/core'

resolveStandardBodyHint({ 'content-type': 'application/json' })
// 'json'

resolveStandardBodyHint({
  'content-type': 'application/json',
  'standard-server': 'file',
})
// 'file'

resolveStandardBodyHint({})
// 'none'
```

Use it when building a custom adapter, or when you need to know how a body will parse without consuming it.

## Utilities

The package also exports a small set of helpers for common header and URL operations.

### Content-Disposition helpers

Use `generateContentDisposition()` to produce a safe `Content-Disposition` value and `getFilenameFromContentDisposition()` to read a filename back from an existing header.

```ts
import {
  generateContentDisposition,
  getFilenameFromContentDisposition,
} from '@standard-server/core'

const disposition = generateContentDisposition('report "Q2".csv')
// inline; filename="report \"Q2\".csv"; filename*=utf-8''report%20%22Q2%22.csv

const filename = getFilenameFromContentDisposition(disposition)
// 'report "Q2".csv'
```

`generateContentDisposition()` preserves an ASCII-safe `filename="..."` value and also emits `filename*=` for UTF-8 aware clients.

### Header helpers

`mergeStandardHeaders()` combines two `StandardHeaders` objects while preserving duplicate values, and `flattenStandardHeader()` turns a single header value into a plain string when needed.

```ts
import {
  flattenStandardHeader,
  mergeStandardHeaders,
} from '@standard-server/core'

const headers = mergeStandardHeaders(
  { 'accept': 'application/json', 'set-cookie': ['a=1'] },
  { 'set-cookie': 'b=2', 'vary': 'accept', 'warning': undefined },
)
// {
//   accept: 'application/json',
//   'set-cookie': ['a=1', 'b=2'],
//   vary: 'accept',
// }

const cookieHeader = flattenStandardHeader(headers['set-cookie'])
// 'a=1, b=2'
```

### URL parsing

`parseStandardUrl()` splits a `StandardUrl` into `[pathname, search, hash]` without requiring a full origin.

```ts
import { parseStandardUrl } from '@standard-server/core'

const [pathname, search, hash] = parseStandardUrl('/users/123?tab=settings#profile')
// pathname => '/users/123'
// search => '?tab=settings'
// hash => '#profile'
```

## Validators

Runtime type guards are useful when requests or responses cross process, transport, or message boundaries.

| Export                 | Checks                                                 |
| ---------------------- | ------------------------------------------------------ |
| `isStandardMethod()`   | Any string value                                       |
| `isStandardUrl()`      | A string starting with `/`                             |
| `isStandardHeaders()`  | Object values are `string`, `string[]`, or `undefined` |
| `isStandardRequest()`  |                                                        |
| `isStandardResponse()` |                                                        |

```ts
import { isStandardRequest } from '@standard-server/core'

export function expectStandardRequest(input: unknown) {
  if (!isStandardRequest(input)) {
    throw new TypeError('Expected a StandardRequest-compatible value')
  }

  return input
}
```

## Event-Stream Helpers

Use Event-Stream Helpers when you need explicit SSE encoding, decoding, or metadata handling.

### Message types and codecs

The event-stream helpers include:

- `EventMeta` for `id`, `retry`, and `comments`
- `EventStreamMessage` for complete SSE messages
- `encodeEventStreamMessage()` and `decodeEventStreamMessage()` for single-message codec operations
- `EventStreamDecoder` and `EventStreamDecoderStream` for chunked stream decoding

```ts
import {
  decodeEventStreamMessage,
  encodeEventStreamMessage,
} from '@standard-server/core'

const encoded = encodeEventStreamMessage({
  comments: ['bootstrap'],
  event: 'message',
  id: '42',
  retry: 3000,
  data: 'hello\nworld',
})

const decoded = decodeEventStreamMessage(encoded)
// {
//   comments: ['bootstrap'],
//   event: 'message',
//   id: '42',
//   retry: 3000,
//   data: 'hello\nworld',
// }
```

For streaming decode, pipe text chunks through `EventStreamDecoderStream`:

```ts
import { EventStreamDecoderStream } from '@standard-server/core'

const messages = response.body!
  .pipeThrough(new TextDecoderStream())
  .pipeThrough(new EventStreamDecoderStream())
```

### Iterator metadata helpers

`StandardBody` uses async iterators for event-stream bodies. To attach SSE metadata to a yielded value without changing its visible shape, use `withEventMeta()`.

```ts
import type { StandardResponse } from '@standard-server/core'
import { getEventMeta, unwrapEvent, withEventMeta } from '@standard-server/core'

const event = withEventMeta(
  { message: 'hello' },
  { id: '1', retry: 3000, comments: ['bootstrap'] },
)

const [data, meta] = unwrapEvent(event)
// data => { message: 'hello' }
// meta => { id: '1', retry: 3000, comments: ['bootstrap'] }

const extractedMeta = getEventMeta(event)
// { id: '1', retry: 3000, comments: ['bootstrap'] }

const response: StandardResponse = {
  status: 200,
  headers: {},
  async* body() {
    yield event
  },
}
```

> [!WARNING]
> Metadata is validated before it is attached: `id`, `event`, and comments must not contain line breaks, and `retry` must be a non-negative integer.

### Errors and low-level assertions

The package also exports:

- `EventStreamEncoderError` for invalid outbound SSE messages
- `EventStreamDecoderError` for incomplete or invalid inbound stream decoding
- `ErrorEvent` for wrapping structured event-stream error payloads in an `Error`
- `assertEventStreamMessageId()`, `assertEventStreamMessageName()`, `assertEventStreamMessageRetry()`, and `assertEventStreamMessageComment()` for low-level validation when building custom SSE tooling

```ts
import { ErrorEvent } from '@standard-server/core'

const error = new ErrorEvent(
  { code: 'E_STREAM', detail: 'Connection lost' },
  { message: 'stream error' },
)

error.message
// 'stream error'

error.data
// { code: 'E_STREAM', detail: 'Connection lost' }
```

## Learn more

For transport-specific quick-starts and options, see the adapter documentation: [Fetch](https://github.com/middleapi/standard-server/blob/main/packages/fetch/README.md) · [Node.js](https://github.com/middleapi/standard-server/blob/main/packages/node/README.md) · [Fastify](https://github.com/middleapi/standard-server/blob/main/packages/fastify/README.md) · [AWS Lambda](https://github.com/middleapi/standard-server/blob/main/packages/aws-lambda/README.md) · [Peer](https://github.com/middleapi/standard-server/blob/main/packages/peer/README.md)

## Sponsors

Like what we build over at [middleapi](https://github.com/middleapi)? You can help keep it going through [GitHub Sponsors](https://github.com/sponsors/dinwwwh) or [Open Collective](https://opencollective.com/middleapi). Every bit helps! 🚀

<table>
  <tr>
   <td width="2000"><a href="https://screenshotone.com/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener" title="The screenshot API for developers"><img src="https://avatars.githubusercontent.com/u/97035603?v=4" width="64" align="left" hspace="12" alt="ScreenshotOne.com"/><b>ScreenshotOne.com</b></a><br /><sub>The screenshot API for developers</sub></td>
  </tr>
  <tr>
   <td width="2000"><a href="https://yuzu.health/careers?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="We&#39;re hiring NYC based engineers"><img src="https://avatars.githubusercontent.com/u/102488956?v=4" width="64" align="left" hspace="12" alt="Yuzu"/><b>Yuzu</b></a><br /><sub>We&#39;re hiring NYC based engineers</sub></td>
  </tr>
  <tr>
   <td width="2000"><a href="https://misskey.io/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Decentralized microblogging SNS born on Earth"><img src="https://github.com/MisskeyIO.png" width="64" align="left" hspace="12" alt="MisskeyHQ"/><b>MisskeyHQ</b></a><br /><sub>Decentralized microblogging SNS born on Earth</sub></td>
  </tr>
</table>

### Special Sponsors

<table>
  <tr>
   <td align="center"><a href="http://twitter.com/rauchg?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Guillermo Rauch"><img src="https://avatars.githubusercontent.com/u/13041?u=1ee8d111657cdd02ff6d253df00978d17ee6d722&amp;v=4" width="279" alt="Guillermo Rauch"/><br />Guillermo Rauch</a></td>
  </tr>
</table>

### Organization Sponsors

<table>
  <tr>
   <td align="center"><a href="https://lnmarkets.com/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="LN Markets"><img src="https://avatars.githubusercontent.com/u/70597625?v=4" width="167" alt="LN Markets"/><br />LN Markets</a></td>
  </tr>
</table>

### Sponsors

<table>
  <tr>
   <td align="center"><a href="https://github.com/hrmcdonald?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Reece McDonald"><img src="https://avatars.githubusercontent.com/u/39349270?v=4" width="139" alt="Reece McDonald"/><br />Reece McDonald</a></td>
   <td align="center"><a href="https://soymilk.party/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="あわわわとーにゅ"><img src="https://avatars.githubusercontent.com/u/17376330?u=de3353804be889f009f7e0a1582daf04d0ab292d&amp;v=4" width="139" alt="あわわわとーにゅ"/><br />あわわわとーにゅ</a></td>
   <td align="center"><a href="https://github.com/nicognaW?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="nk"><img src="https://avatars.githubusercontent.com/u/66731869?u=4699bda3a9092d3ec34fbd959450767bcc8b8b6d&amp;v=4" width="139" alt="nk"/><br />nk</a></td>
   <td align="center"><a href="https://supastarter.dev/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="supastarter"><img src="https://avatars.githubusercontent.com/u/110960143?v=4" width="139" alt="supastarter"/><br />supastarter</a></td>
   <td align="center"><a href="https://github.com/divmgl?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Dexter Miguel"><img src="https://avatars.githubusercontent.com/u/5452298?u=645993204be8696c085ecf0d228c3062efe2ed65&amp;v=4" width="139" alt="Dexter Miguel"/><br />Dexter Miguel</a></td>
   <td align="center"><a href="https://github.com/herrfugbaum?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="herrfugbaum"><img src="https://avatars.githubusercontent.com/u/12859776?u=644dc1666d0220bc0468eb0de3c56b919f635b16&amp;v=4" width="139" alt="herrfugbaum"/><br />herrfugbaum</a></td>
  </tr>
  <tr>
   <td align="center"><a href="https://laststance.io/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Ryota Murakami"><img src="https://avatars.githubusercontent.com/u/5501268?u=599389e03340734325726ca3f8f423c021d47d7f&amp;v=4" width="139" alt="Ryota Murakami"/><br />Ryota Murakami</a></td>
   <td align="center"><a href="https://cra.mr/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="David Cramer"><img src="https://avatars.githubusercontent.com/u/23610?v=4" width="139" alt="David Cramer"/><br />David Cramer</a></td>
   <td align="center"><a href="https://valerii15298.github.io/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Valerii Petryniak"><img src="https://avatars.githubusercontent.com/u/44531564?u=88ac74d9bacd20401518441907acad21063cd397&amp;v=4" width="139" alt="Valerii Petryniak"/><br />Valerii Petryniak</a></td>
   <td align="center"><a href="https://letstri.dev/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Valerii Strilets"><img src="https://avatars.githubusercontent.com/u/13253748?u=c7b10399ccc8f8081e24db94ec32cd9858e86ac3&amp;v=4" width="139" alt="Valerii Strilets"/><br />Valerii Strilets</a></td>
   <td align="center"><a href="https://blacklight.sh/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Kyle Mistele"><img src="https://avatars.githubusercontent.com/u/18430555?u=3afebeb81de666e35aaac3ed46f14159d7603ffb&amp;v=4" width="139" alt="Kyle Mistele"/><br />Kyle Mistele</a></td>
   <td align="center"><a href="https://github.com/christ12938?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="christ12938"><img src="https://avatars.githubusercontent.com/u/25758598?v=4" width="139" alt="christ12938"/><br />christ12938</a></td>
  </tr>
  <tr>
   <td align="center"><a href="https://github.com/Ryanjso?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Ryan Soderberg"><img src="https://avatars.githubusercontent.com/u/39172778?u=5ed913c31d57e7221b75784abcad48c7ebddde27&amp;v=4" width="139" alt="Ryan Soderberg"/><br />Ryan Soderberg</a></td>
   <td align="center"><a href="https://github.com/itigoore01?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="shota"><img src="https://avatars.githubusercontent.com/u/11831107?u=c976a6dc7e055eb026304c46c99100ed22b0c8e0&amp;v=4" width="139" alt="shota"/><br />shota</a></td>
   <td align="center"><a href="https://github.com/ellis-driscoll?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Ellis Driscoll"><img src="https://avatars.githubusercontent.com/u/70685966?u=c5f95bc33b5991d9744abe00052542e4a2ed3cb9&amp;v=4" width="139" alt="Ellis Driscoll"/><br />Ellis Driscoll</a></td>
   <td align="center"><a href="https://github.com/hoangbn?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Hoang Nguyen"><img src="https://avatars.githubusercontent.com/u/38968280?u=c90084c6de65c56facabab7ba13a72a49ddbc3e4&amp;v=4" width="139" alt="Hoang Nguyen"/><br />Hoang Nguyen</a></td>
   <td align="center"><a href="https://opencollective.com/guest-ac41de3b?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Orestis Ioannou"><img src="https://images.opencollective.com/guest-ac41de3b/avatar/460.png" width="139" alt="Orestis Ioannou"/><br />Orestis Ioannou</a></td>
   <td align="center"><a href="https://automatio.ai/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Stefan Smiljkovic"><img src="https://avatars.githubusercontent.com/u/1984909?u=b7bf5bc40ed49df3c22f69d2da7b8d78709c49ed&amp;v=4" width="139" alt="Stefan Smiljkovic"/><br />Stefan Smiljkovic</a></td>
  </tr>
</table>

### Backers

<table>
  <tr>
   <td align="center"><a href="https://github.com/rhinodavid?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="David Walsh"><img src="https://avatars.githubusercontent.com/u/5778036?u=b5521f07d2f88c3db2a0dae62b5f2f8357214af0&amp;v=4" width="119" alt="David Walsh"/><br />David Walsh</a></td>
   <td align="center"><a href="https://github.com/IPv4Addr?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="IPv4Addr"><img src="https://avatars.githubusercontent.com/u/100147665?u=59996b72f69bb53063cb7e9ff8b8f898616cd94d&amp;v=4" width="119" alt="IPv4Addr"/><br />IPv4Addr</a></td>
   <td align="center"><a href="https://robbevaes.be/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Robbe Vaes"><img src="https://avatars.githubusercontent.com/u/44748019?u=e0232402c045ad4eac7cbd217f1f47e083103b89&amp;v=4" width="119" alt="Robbe Vaes"/><br />Robbe Vaes</a></td>
   <td align="center"><a href="https://github.com/aidansunbury?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Aidan Sunbury"><img src="https://avatars.githubusercontent.com/u/64103161?v=4" width="119" alt="Aidan Sunbury"/><br />Aidan Sunbury</a></td>
   <td align="center"><a href="https://github.com/soonoo?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="soonoo"><img src="https://avatars.githubusercontent.com/u/5436405?u=5d0b4aa955c87e30e6bda7f0cccae5402da99528&amp;v=4" width="119" alt="soonoo"/><br />soonoo</a></td>
   <td align="center"><a href="https://kevinporten.dev/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Kevin Porten"><img src="https://avatars.githubusercontent.com/u/1839345?u=dc2263d5cfe0d927ce1a0be04a1d55dd6b55405c&amp;v=4" width="119" alt="Kevin Porten"/><br />Kevin Porten</a></td>
   <td align="center"><a href="https://github.com/pumpkinlink?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Denis"><img src="https://avatars.githubusercontent.com/u/11864620?u=5f47bbe6c65d0f6f5cf011021490238e4b0593d0&amp;v=4" width="119" alt="Denis"/><br />Denis</a></td>
  </tr>
  <tr>
   <td align="center"><a href="https://github.com/christopher-kapic?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Christopher Kapic"><img src="https://avatars.githubusercontent.com/u/59740769?u=e7ad4b72b5bf6c9eb1644c26dbf3332a8f987377&amp;v=4" width="119" alt="Christopher Kapic"/><br />Christopher Kapic</a></td>
   <td align="center"><a href="http://ballingt.com/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Tom Ballinger"><img src="https://avatars.githubusercontent.com/u/458879?u=4b045ac75d721b6ac2b42a74d7d37f61f0414031&amp;v=4" width="119" alt="Tom Ballinger"/><br />Tom Ballinger</a></td>
   <td align="center"><a href="https://lee-sam.com/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Sam"><img src="https://avatars.githubusercontent.com/u/102863520?u=3c89611f549d5070be232eb4532f690c8f2e7a65&amp;v=4" width="119" alt="Sam"/><br />Sam</a></td>
   <td align="center"><a href="https://github.com/Titoine?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Titoine"><img src="https://avatars.githubusercontent.com/u/3514286?u=1bb1e86b0c99c8a1121372e56d51a177eea12191&amp;v=4" width="119" alt="Titoine"/><br />Titoine</a></td>
   <td align="center"><a href="https://rigtch.fm/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Igor Makowski"><img src="https://avatars.githubusercontent.com/u/56691628?u=ee8c879478f7c151b9156aef6c74243fa3e247a8&amp;v=4" width="119" alt="Igor Makowski"/><br />Igor Makowski</a></td>
   <td align="center"><a href="https://blog.cwang.io/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="hanayashiki"><img src="https://avatars.githubusercontent.com/u/26056783?u=06c3b9205a16fd41a871e82da1cc2a09306d53f5&amp;v=4" width="119" alt="hanayashiki"/><br />hanayashiki</a></td>
   <td align="center"><a href="https://dubinets.io/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Lev Dubinets"><img src="https://avatars.githubusercontent.com/u/3114081?u=f547f5d5012cab54851f1b1ad72d10e537f78fc2&amp;v=4" width="119" alt="Lev Dubinets"/><br />Lev Dubinets</a></td>
  </tr>
  <tr>
   <td align="center"><a href="https://kellychan.im/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Kelly Peilin Chan"><img src="https://avatars.githubusercontent.com/u/520852?u=6b0f7105f694e7b5cacf410a3f04c7044b469dc8&amp;v=4" width="119" alt="Kelly Peilin Chan"/><br />Kelly Peilin Chan</a></td>
   <td align="center"><a href="https://guyariely.com/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Guy Ariely"><img src="https://avatars.githubusercontent.com/u/42813496?u=edb6b7f563bf28e160a290832e7da57c0506f8ca&amp;v=4" width="119" alt="Guy Ariely"/><br />Guy Ariely</a></td>
   <td align="center"><a href="https://paulsenon.com/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="PaulSenon"><img src="https://avatars.githubusercontent.com/u/19531087?u=6385741eb91d200b8c513ec6045482e301767ca6&amp;v=4" width="119" alt="PaulSenon"/><br />PaulSenon</a></td>
   <td align="center"><a href="https://piscis.dev/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Alex"><img src="https://avatars.githubusercontent.com/u/326163?u=b245f368bd940cf51d08c0b6bf55f8257f359437&amp;v=4" width="119" alt="Alex"/><br />Alex</a></td>
   <td align="center"><a href="https://opensource.gubanov.eu/?ref=middleapi&amp;utm_source=middleapi&amp;utm_medium=sponsor" target="_blank" rel="noopener sponsored" title="Andrey Gubanov"><img src="https://avatars.githubusercontent.com/u/1082083?u=c5f2daf7ebece498e85c83367bb37b4e10e2649d&amp;v=4" width="119" alt="Andrey Gubanov"/><br />Andrey Gubanov</a></td>
  </tr>
</table>

With thanks to [36 past sponsors](https://htmlpreview.github.io/?https://github.com/middleapi/static/blob/main/sponsors.svg) who helped get us here.

## License

Distributed under the MIT License. See [LICENCE](https://github.com/middleapi/standard-server/blob/main/LICENCE) for more information.
