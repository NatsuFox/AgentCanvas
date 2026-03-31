import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ApproveGateInput,
  CreateAgentProfileInput,
  CreateDependencyEdgeInput,
  CreateHelperNodeInput,
  CreateMessageEdgeInput,
  CreateRunnerFromCheckpointInput,
  CreateRunnerInput,
  DispatchTextNodeInput,
  MarkRunnerCompleteInput,
  ResetAllWorkflowsInput,
  ResetWorkflowFromRunnerInput,
  RunnerExitEvent,
  RunnerOutputEvent,
  RunnerResizeInput,
  RunnerUpdatedEvent,
  UpdateAgentProfileInput,
  UpdatePanelGeometryInput,
  UpdateTextNodeInput
} from "@shared/ipc";

import { AgentCanvasRuntime } from "../main/services/agent-canvas-runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");
const webOutputRoot = path.join(projectRoot, "out", "web");
const port = Number(process.env.AGENTCANVAS_WEB_PORT ?? 4783);
const apiOnly = process.env.AGENTCANVAS_WEB_API_ONLY === "1";

process.env.AGENTCANVAS_STATE_DIRNAME ??= ".agentcanvas-web-preview";

const eventClients = new Set<ServerResponse>();

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function sendNoContent(response: ServerResponse): void {
  response.writeHead(204);
  response.end();
}

function sendText(response: ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8"
  });
  response.end(message);
}

function broadcastEvent(eventName: string, payload: RunnerOutputEvent | RunnerUpdatedEvent | RunnerExitEvent): void {
  const serialized = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const client of eventClients) {
    client.write(serialized);
  }
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  return "application/octet-stream";
}

function serveStaticAsset(requestPath: string, response: ServerResponse): boolean {
  if (apiOnly || !existsSync(webOutputRoot)) {
    return false;
  }

  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  const candidate = path.join(webOutputRoot, normalized);
  const safeCandidate = path.resolve(candidate);

  if (!safeCandidate.startsWith(path.resolve(webOutputRoot))) {
    sendText(response, 403, "Forbidden");
    return true;
  }

  const fileToServe =
    existsSync(safeCandidate) && statSync(safeCandidate).isFile() ? safeCandidate : path.join(webOutputRoot, "index.html");

  if (!existsSync(fileToServe)) {
    return false;
  }

  response.writeHead(200, {
    "content-type": contentTypeFor(fileToServe)
  });
  createReadStream(fileToServe).pipe(response);
  return true;
}

const runtime = new AgentCanvasRuntime({
  emitRunnerOutput: (event) => broadcastEvent("runner-output", event),
  emitRunnerUpdated: (event) => broadcastEvent("runner-updated", event),
  emitRunnerExit: (event) => broadcastEvent("runner-exit", event)
});

runtime.initialize();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive"
      });
      response.write(": connected\n\n");
      eventClients.add(response);

      request.on("close", () => {
        eventClients.delete(response);
      });

      return;
    }

    if (request.method === "GET" && url.pathname === "/api/workspace") {
      sendJson(response, 200, runtime.getWorkspaceState());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/debug/runtime") {
      sendJson(response, 200, runtime.getDebugInfo());
      return;
    }

    const runnerDebugMatch =
      request.method === "GET" ? url.pathname.match(/^\/api\/debug\/runners\/([^/]+)$/) : null;
    if (runnerDebugMatch) {
      sendJson(response, 200, runtime.getRunnerDebug(decodeURIComponent(runnerDebugMatch[1])));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/runners") {
      const body = await readJsonBody<CreateRunnerInput>(request);
      sendJson(response, 200, runtime.createRunner(body));
      return;
    }

    const runnerWriteMatch = request.method === "POST" ? url.pathname.match(/^\/api\/runners\/([^/]+)\/write$/) : null;
    if (runnerWriteMatch) {
      const body = await readJsonBody<{ data: string }>(request);
      runtime.writeToRunner(decodeURIComponent(runnerWriteMatch[1]), body.data);
      sendNoContent(response);
      return;
    }

    const runnerResizeMatch = request.method === "POST" ? url.pathname.match(/^\/api\/runners\/([^/]+)\/resize$/) : null;
    if (runnerResizeMatch) {
      const body = await readJsonBody<RunnerResizeInput>(request);
      runtime.resizeRunner(decodeURIComponent(runnerResizeMatch[1]), body.cols, body.rows);
      sendNoContent(response);
      return;
    }

    const runnerHibernateMatch = request.method === "POST" ? url.pathname.match(/^\/api\/runners\/([^/]+)\/hibernate$/) : null;
    if (runnerHibernateMatch) {
      sendJson(response, 200, runtime.hibernateRunner(decodeURIComponent(runnerHibernateMatch[1])));
      return;
    }

    const runnerRelaunchMatch = request.method === "POST" ? url.pathname.match(/^\/api\/runners\/([^/]+)\/relaunch$/) : null;
    if (runnerRelaunchMatch) {
      sendJson(response, 200, runtime.relaunchRunner(decodeURIComponent(runnerRelaunchMatch[1])));
      return;
    }

    const runnerCloseMatch = request.method === "POST" ? url.pathname.match(/^\/api\/runners\/([^/]+)\/close$/) : null;
    if (runnerCloseMatch) {
      sendJson(response, 200, runtime.closeRunner(decodeURIComponent(runnerCloseMatch[1])));
      return;
    }

    const runnerRemoveMatch = request.method === "POST" ? url.pathname.match(/^\/api\/runners\/([^/]+)\/remove$/) : null;
    if (runnerRemoveMatch) {
      sendJson(response, 200, runtime.removeRunner(decodeURIComponent(runnerRemoveMatch[1])));
      return;
    }

    const runnerSealMatch = request.method === "POST" ? url.pathname.match(/^\/api\/runners\/([^/]+)\/seal$/) : null;
    if (runnerSealMatch) {
      const body = await readJsonBody<{ title?: string }>(request);
      sendJson(response, 200, runtime.sealRunnerCheckpoint(decodeURIComponent(runnerSealMatch[1]), body.title));
      return;
    }

    const checkpointBranchMatch =
      request.method === "POST" ? url.pathname.match(/^\/api\/checkpoints\/([^/]+)\/branch$/) : null;
    if (checkpointBranchMatch) {
      const body = await readJsonBody<CreateRunnerFromCheckpointInput>(request);
      sendJson(response, 200, runtime.createRunnerFromCheckpoint({
        checkpointId: decodeURIComponent(checkpointBranchMatch[1]),
        branchMode: body.branchMode,
        x: body.x,
        y: body.y
      }));
      return;
    }

    const panelGeometryMatch =
      request.method === "POST" ? url.pathname.match(/^\/api\/panels\/([^/]+)\/geometry$/) : null;
    if (panelGeometryMatch) {
      const body = await readJsonBody<UpdatePanelGeometryInput>(request);
      runtime.updatePanelGeometry({
        ...body,
        panelId: decodeURIComponent(panelGeometryMatch[1])
      });
      sendNoContent(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workflows/edges") {
      const body = await readJsonBody<CreateDependencyEdgeInput>(request);
      sendJson(response, 200, runtime.createDependencyEdge(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/message-edges") {
      const body = await readJsonBody<CreateMessageEdgeInput>(request);
      sendJson(response, 200, runtime.createMessageEdge(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workflows/complete") {
      const body = await readJsonBody<MarkRunnerCompleteInput>(request);
      sendJson(response, 200, runtime.markRunnerComplete(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workflows/reset") {
      await readJsonBody<ResetAllWorkflowsInput>(request);
      sendJson(response, 200, runtime.resetAllWorkflows());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workflows/reset-from-runner") {
      const body = await readJsonBody<ResetWorkflowFromRunnerInput>(request);
      sendJson(response, 200, runtime.resetWorkflowFromRunner(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profiles") {
      const body = await readJsonBody<CreateAgentProfileInput>(request);
      sendJson(response, 200, runtime.createAgentProfile(body));
      return;
    }

    const profileMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/);
    if (request.method === "PATCH" && profileMatch) {
      const body = await readJsonBody<UpdateAgentProfileInput>(request);
      sendJson(response, 200, runtime.updateAgentProfile({
        ...body,
        profileId: decodeURIComponent(profileMatch[1])
      }));
      return;
    }

    if (request.method === "DELETE" && profileMatch) {
      sendJson(response, 200, runtime.deleteAgentProfile(decodeURIComponent(profileMatch[1])));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/helpers") {
      const body = await readJsonBody<CreateHelperNodeInput>(request);
      sendJson(response, 200, runtime.createHelperNode(body));
      return;
    }

    const textNodeMatch = url.pathname.match(/^\/api\/text-nodes\/([^/]+)$/);
    if (request.method === "PATCH" && textNodeMatch) {
      const body = await readJsonBody<UpdateTextNodeInput>(request);
      sendJson(response, 200, runtime.updateTextNode({
        ...body,
        runnerId: decodeURIComponent(textNodeMatch[1])
      }));
      return;
    }

    const textNodeDispatchMatch = request.method === "POST" ? url.pathname.match(/^\/api\/text-nodes\/([^/]+)\/dispatch$/) : null;
    if (textNodeDispatchMatch) {
      await readJsonBody<DispatchTextNodeInput>(request);
      sendJson(response, 200, runtime.dispatchTextNode({
        runnerId: decodeURIComponent(textNodeDispatchMatch[1])
      }));
      return;
    }

    const helperApproveMatch = request.method === "POST" ? url.pathname.match(/^\/api\/helpers\/([^/]+)\/approve$/) : null;
    if (helperApproveMatch) {
      sendJson(response, 200, runtime.approveGate({
        runnerId: decodeURIComponent(helperApproveMatch[1])
      } satisfies ApproveGateInput));
      return;
    }

    if (request.method === "GET" && serveStaticAsset(url.pathname, response)) {
      return;
    }

    sendText(response, 404, "Not found");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    sendText(response, 500, message);
  }
});

function shutdown() {
  for (const client of eventClients) {
    client.end();
  }
  eventClients.clear();
  runtime.shutdown();
  server.close(() => {
    process.exit(0);
  });
}

server.listen(port, "127.0.0.1", () => {
  const modeLabel = apiOnly ? "API-only" : "API + static";
  console.log(`[AgentCanvas Web Preview] ${modeLabel} server listening on http://127.0.0.1:${port}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
