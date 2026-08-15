# Distribution runtime

The shipped CLI and stdio MCP entrypoints create the same local project runtime.
It wires Core parsing and hashes, federation resolution, retrieval authorization,
and Lifecycle filesystem coordination. MCP tools are advertised only when that
runtime has a callable handler for the authenticated principal.

Durable operations use at-least-once crash recovery. Each attempt records its
lease, process, timestamps, state, and result hash. The filesystem lease is
heartbeated while its process is live and can be recovered only after that
process dies and the lease expires. A crash can therefore replay a handler after
an external side effect but before its result is journaled. Handlers receive the
durable idempotency key and the `JobRegistry` contract name and must pass that
key to every external side effect. Cancellation is a coordinated checkpoint;
once requested, finalization records `cancelled` and cannot overwrite it with a
late successful result.
