import type { Request, Response } from "express";

export type FlowEventPayload = Record<string, unknown>;

export class FlowEventStream {
  private readonly clients = new Set<Response>();
  private readonly role: string;

  constructor(role: string) {
    this.role = role;
  }

  subscribe(req: Request, res: Response): void {
    res.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    });
    res.write("retry: 1000\n\n");
    this.clients.add(res);
    this.publishTo(res, "connected", { role: this.role });
    req.on("close", () => {
      this.clients.delete(res);
    });
  }

  publish(type: string, payload: FlowEventPayload = {}): void {
    for (const client of this.clients) {
      this.publishTo(client, type, payload);
    }
  }

  private publishTo(client: Response, type: string, payload: FlowEventPayload): void {
    client.write(`event: ${type}\n`);
    client.write(`data: ${JSON.stringify({ ...payload, type, role: this.role, at: new Date().toISOString() })}\n\n`);
  }
}
