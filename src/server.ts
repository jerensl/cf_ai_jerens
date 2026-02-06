import {
  routeAgentRequest,
  type Connection,
  type Schedule,
  type WSMessage
} from "agents";

import { getSchedulePrompt } from "agents/schedule";

import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  generateId,
  streamText,
  type StreamTextOnFinishCallback,
  stepCountIs,
  createUIMessageStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  type ToolSet
} from "ai";
import { google } from "@ai-sdk/google";
import { processToolCalls, cleanupMessages } from "./utils";
import { tools, executions } from "./tools";
// import { env } from "cloudflare:workers";

const model = google("gemini-2.5-flash-lite");
// Cloudflare AI Gateway
// const openai = createOpenAI({
//   apiKey: env.OPENAI_API_KEY,
//   baseURL: env.GATEWAY_BASE_URL,
// });

/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class Chat extends AIChatAgent<Env> {
  async onStart(): Promise<void> {
    this.sql`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        action TEXT,
        title TEXT NOT NULL,
        description TEXT,
        url TEXT,
        actor TEXT,
        payload TEXT,
        timestamp TEXT NOT NULL
      )
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_events_timestamp
      ON events(timestamp DESC)
    `;
  }
  async onRequest(request: Request): Promise<Response> {
    // 1. Validate method
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // 2. Get event type from headers
    const eventType = request.headers.get("X-Event-Type");

    // 3. Verify signature
    const signature = request.headers.get("X-Signature");
    const body = await request.text();

    if (!(await this.verifySignature(body, signature))) {
      return new Response("Invalid signature", { status: 401 });
    }

    // 4. Parse and process
    const payload = JSON.parse(body);
    await this.handleEvent(eventType, payload);

    // 5. Respond quickly
    return new Response("OK", { status: 200 });
  }

  private async handleEvent(type: string, payload: unknown) {
    // Check if already processed
    const existing = [
      ...this.sql`
      SELECT id FROM events WHERE id = ${eventId}
    `
    ];

    if (existing.length > 0) {
      console.log(`Event ${eventId} already processed, skipping`);
      return;
    }

    // Process and store
    await this.processPayload(payload);
    this.sql`INSERT INTO events (id, ...) VALUES (${eventId}, ...)`;
  }
  async onError(error: unknown) {
    console.error(`Chat Agent Error:`, error);
  }

  async onClose(
    connection: Connection,
    code: number,
    reason: string,
    _wasClean: boolean
  ) {
    console.log(`Connection ${connection.id} closed: ${code} ${reason}`);

    // Notify other clients
    this.broadcast(
      JSON.stringify({
        event: "user-left",
        userId: (connection.state as any)?.userId
      })
    );
  }

  async onMessage(connection: Connection, message: WSMessage) {
    console.log("OnMessage:", message);
    if (typeof message === "string") {
      // Handle text message
      const data = JSON.parse(message);
      connection.send(JSON.stringify({ received: data }));
    }
  }
  /**
   * Handles incoming chat messages and manages the response stream
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal?: AbortSignal }
  ) {
    // const mcpConnection = await this.mcp.connect(
    //   "https://path-to-mcp-server/sse"
    // );

    // Collect all tools, including MCP tools
    const allTools = {
      ...tools,
      ...this.mcp.getAITools()
    };

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Clean up incomplete tool calls to prevent API errors
        const cleanedMessages = cleanupMessages(this.messages);

        // Process any pending tool calls from previous messages
        // This handles human-in-the-loop confirmations for tools
        const processedMessages = await processToolCalls({
          messages: cleanedMessages,
          dataStream: writer,
          tools: allTools,
          executions
        });

        const result = streamText({
          system: `You are a helpful assistant that can do various tasks... 

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the schedule tool to schedule the task.
`,

          messages: await convertToModelMessages(processedMessages),
          model,
          tools: allTools,
          // Type boundary: streamText expects specific tool types, but base class uses ToolSet
          // This is safe because our tools satisfy ToolSet interface (verified by 'satisfies' in tools.ts)
          onFinish: onFinish as unknown as StreamTextOnFinishCallback<
            typeof allTools
          >,
          stopWhen: stepCountIs(10),
          abortSignal: options?.abortSignal
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
  async executeTask(description: string, _task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        parts: [
          {
            type: "text",
            text: `Running scheduled task: ${description}`
          }
        ],
        metadata: {
          createdAt: new Date()
        }
      }
    ]);
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/check-open-ai-key") {
      const hasOpenAIKey = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      return Response.json({
        success: hasOpenAIKey
      });
    }
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      console.error(
        "GOOGLE_GENERATIVE_AI_API_KEY is not set, don't forget to set it locally in .dev.vars, and use `wrangler secret bulk .dev.vars` to upload it to production"
      );
    }
    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
