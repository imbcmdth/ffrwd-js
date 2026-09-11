# ffrwd-js

A client for the ffrwd job API, for a web app or a Node service. The
API was shaped for the CLI: a submit answers presigned urls, the bytes
go to those, a second call queues the job, a third signs the outputs.
This library folds that into one `submit` that returns a job you can
wait on and download from, and puts the public registry beside it, so
a query can run an installed package's recipe by name and pin the
packages it needs without an `ffrwd` install anywhere.

```ts
import { Ffrwd } from "ffrwd-js";

const ffrwd = new Ffrwd({ token: "ffrwd_…" });
const job = await ffrwd.submit({
  recipe: "ffrwd/faceage:blur-children",
  variables: { source: "class.mp4", max_age: "16", dest: "blurred.mp4" },
  inputs: { "class.mp4": file },
});
const done = await job.wait({ onUpdate: (d) => console.log(d.state, d.progress_pct) });
const blurred = await job.download("blurred.mp4");
```

Zero dependencies, ESM only, TypeScript types included. Needs `fetch`,
`crypto.subtle` and `ReadableStream`: any browser, Node 18 or later.

## What a submit does

1. **The query.** `query` is SQL with psql-style variables; `recipe`
   is `ns/pkg:name`, whose SQL comes from the registry. Either is
   substituted with `variables` the way the CLI does: `:'name'` a
   string literal, `:"name"` an identifier, `:name` raw text, list
   subscripts, and an unset variable becomes `NULL`. A recipe's
   required variables are checked first, and a missing one is refused
   by name.
2. **The lock.** The runner installs exactly what the lock pins. A
   recipe's package, plus anything in `packages`, is resolved against
   the public index into a lock document: each package at its highest
   published version, or the one an `@version` names, and everything
   it depends on the same way, in the order the runner installs them.
   Pass `lock` to send one built elsewhere instead.
3. **Inputs.** `inputs` maps each path the query names to its bytes, a
   `Blob` or a `Uint8Array`, or to `{ url }` for something the runner
   fetches itself. A file is named in the submit by its position and
   size, nothing is hashed, and it is PUT to the url the answer signs
   for that position, with nothing but its length. A position the
   answer leaves out is refused before a byte is sent.
4. **Ready.** Once every upload is in, the job is marked ready and
   joins the queue. The `Job` that comes back carries the id and what
   the submit said about the account's remaining credit.

`outputs` defaults to the paths the query's `COPY ... TO '<path>'`
clauses name, a pre-flight view the run itself settles; pass them when
a destination is computed.

## The job

- `job.wait()` polls the detail until the job ends. Every state is
  passed to `onUpdate` as it changes, `submitted, queued, starting,
  running, finalizing`, then one of `succeeded, failed, cancelled`. A
  failed or cancelled job rejects with an `FfrwdError` carrying the
  row, its `error` and `log_tail`.
- `job.outputs()` signs one url per output, good an hour, and
  `job.download(path)` fetches one as a `Blob` and checks its digest
  against what the job recorded. A `tree` output is one tar.
- `job.detail()`, `job.cancel()`, `job.pin()` are the same calls the
  site makes. `ffrwd.job(id)` reaches a job submitted elsewhere, and
  `ffrwd.list()` pages the account's jobs with the site's filters.

Every refusal, at any step, is an `FfrwdError` with the status and the
server's own `error` and `hint`. An answer the client cannot read is
one with status 0. A `signal` on any call aborts it.

## The registry

`Registry` reads the public index, which needs no auth: `package(name)`
for the detail document, `version("ns/pkg@1.2.3")` for one release,
`recipe(spec, name)` for a recipe's SQL with its declared variables,
`resolve(specs)` for a lock. `Ffrwd` holds one and uses it for
`recipe` and `packages`; give it your own to point at another index or
to share a cache.

`substitute`, `referenced` and `declaredVariables` are exported for a
web app that wants to show a recipe's variables or preview the query
before submitting. They match the CLI's implementation case for case;
the test fixture was generated from it.

## A server and a browser

`submit` is three calls, and each is public, because the natural web
shape is a server that holds the token and a browser that holds the
file:

```ts
// on the server: substitute, resolve the lock, submit; needs only each file's size
const prepared = await ffrwd.prepare({ query, inputs: { "in.mp4": { bytes: file.size } } });
res.json(prepared);                       // plain data; survives JSON

// in the browser: no token, just the signed url
await upload(prepared.uploads[0], file, { onProgress });

// on the server again: queue it
const job = await ffrwd.ready(prepared);
```

`prepare` never reads the file: the API names an input by its position
in the submit, so the server needs the size and nothing else, and the
upload can start the moment a file is chosen. `upload` takes any
`{ url }`, sets only the length, and sends no credential.

## Progress

In a browser an `onProgress` callback on `submit` or `upload` gets
real upload progress per chunk, `{ path, sent, total }` from `submit`
and `{ sent, total }` from `upload`, through `XMLHttpRequest`. In
Node, or without a callback, the upload is one `fetch` PUT and
progress fires once when it lands. `hasUploadProgress()` says which
you have.

## Using it from a browser

Two things sit on the operator's side of the API, not in this library:

- **The functions' allowed origins.** The API answers cross-origin
  requests only from the origins its `SITE_ORIGIN` names, the ffrwd
  site by default. A web app on another origin needs its origin added
  there, or a server of its own in front of the API.
- **The bucket's CORS rule.** Uploads and downloads go straight to the
  storage bucket by presigned url. The bucket carries lifecycle rules
  and no CORS rule, so a browser's `PUT` and `GET` to it are refused
  at the preflight until one is added: `PUT` and `GET` for the app's
  origins, and `Content-Type` exposed if you want it.

Neither concerns a Node service, which is also where an `ffrwd_` token
belongs. In a browser use the signed-in session's JWT as `session`
rather than shipping a token to the client.

## Building

```
npm install
npm test
npm run build
```

`npm run smoke -- <input.mp4> <output dir>` runs one real job with the
token in this machine's `ffrwd` credentials file, printing the states
it passes through and the bytes it wrote, and never the token.

## License

Apache-2.0.
