import { createQueue } from "./queue";

// One queue for the whole process. Conversions are serial by design (see
// queue.ts), so this is deliberately a singleton rather than per-request.
export const queue = createQueue((message) => console.log(message));
