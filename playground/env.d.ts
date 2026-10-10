// vscode-jsonrpc's browser types name the worker scope, which only the WebWorker lib
// declares. That lib conflicts with DOM, and a worker's self has the same messaging surface.
interface DedicatedWorkerGlobalScope extends Worker {}

// Served by vite.config.ts: parserator's package.json and declarations, by path.
declare module "virtual:parserator-typings" {
  const typings: Readonly<Record<string, string>>;
  export default typings;
}
