### 5.3 Request path

client -> router -> API thread -> inbound queue -> ENGINE THREAD -> output queue -> API thread -> SSE -> client

ENGINE THREAD, one step, forever:
  1. drain the inbound queue (new tickets, abort tickets); never wait
  2. nothing to do -> sleep until a ticket arrives (no busy spin)
  3. scheduler: remove finished, make room for running, admit waiting (FCFS), choose prefill or decode
  4. runner: one forward pass, sample, mx.eval
  5. push text chunks to output queues; append telemetry events
