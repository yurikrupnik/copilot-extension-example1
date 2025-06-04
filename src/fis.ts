import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { Octokit } from "@octokit/core";
import {
  createAckEvent,
  createDoneEvent,
  createErrorsEvent,
  createTextEvent,
  getUserMessage,
  verifyAndParseRequest,
} from "@copilot-extensions/preview-sdk";

// In-memory user-to-thread mapping (for demo; use persistent storage for production)
const userThreads = new Map<string, string>();

const app = new Hono();

app.get("/", (c) => {
  return c.text("Welcome to the Copilot Extension template! 👋");
});

app.get("/callback", (c) => {
  return c.text("Welcome to the Copilot Extension template! 👋");
});

app.post("/", async (c) => {
  const tokenForUser = c.req.header("X-GitHub-Token") ?? "";
  const body = await c.req.text();
  const signature = c.req.header("x-github-public-key-signature") ?? "";
  const keyID = c.req.header("x-github-public-key-identifier") ?? "";

  if (!tokenForUser) {
    return c.text(
      createErrorsEvent([
        {
          type: "agent",
          message: "No GitHub token provided in the request headers.",
          code: "MISSING_GITHUB_TOKEN",
          identifier: "missing_github_token",
        },
      ])
    );
  }

  const { isValidRequest, payload } = await verifyAndParseRequest(
    body,
    signature,
    keyID,
    { token: tokenForUser }
  );

  if (!isValidRequest) {
    console.error("Request verification failed");
    c.header("Content-Type", "text/plain");
    c.status(401);
    return c.text("Request could not be verified");
  }

  c.header("Content-Type", "text/html");
  c.header("X-Content-Type-Options", "nosniff");

  return stream(c, async (stream) => {
    try {
      stream.write(createAckEvent());

      // Identify the user
      const octokit = new Octokit({ auth: tokenForUser });
      const user = await octokit.request("GET /user");
      const userLogin = user.data.login;
      const userPrompt = getUserMessage(payload);

      // Get or create thread ID for this user
      let threadId = userThreads.get(userLogin);
      if (!threadId) {
        // Create thread via LangGraph API
        const threadResponse = await fetch("http://localhost:2024/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}), // (Add any required initial data here)
        });
        if (!threadResponse.ok) {
          const errText = await threadResponse.text();
          console.error("LangGraph thread creation failed:", errText);
          throw new Error(`Failed to create thread: ${errText}`);
        }
        const threadData = await threadResponse.json();
        // Use the correct property from your backend: thread_id, id, or uuid
        threadId = threadData.thread_id || threadData.id || threadData.uuid;
        if (!threadId) {
          throw new Error("Thread creation response missing thread_id");
        }
        userThreads.set(userLogin, threadId);
      }

      const assistantId = "agent";

      const endpoint = `http://localhost:2024/threads/${threadId}/runs/stream`;

      const langGraphResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          assistant_id: assistantId,
          input: {
            messages: [
              {
                role: "user",
                content: userPrompt,
              },
            ],
          },
        }),
      });

      if (!langGraphResponse.ok || !langGraphResponse.body) {
        const errText = langGraphResponse.body
          ? await langGraphResponse.text()
          : langGraphResponse.statusText;
        console.error("LangGraph agent error:", errText);
        throw new Error(
          `LangGraph agent error: ${langGraphResponse.status} ${errText}`
        );
      }

      const reader = langGraphResponse.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let buffer = "";

      stream.write(createTextEvent(`Hi ${userLogin}! `));

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          // Process complete lines (SSE spec: events are separated by double newlines)
          let lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (let line of lines) {
            line = line.trim();
            // Only process "event: values" lines (ignore heartbeats, metadata, etc.)
            if (line.startsWith("event: values")) {
              // Next line should have 'data: ...'
              // Find the data line
              let dataLine = line;
              if (!dataLine.startsWith("data: ")) {
                // If line isn't the data line, skip
                continue;
              }
              const jsonPart = dataLine.slice(6); // after 'data: '
              try {
                const eventObj = JSON.parse(jsonPart);
                const msgs = eventObj.messages ?? [];
                for (const msg of msgs) {
                  if (
                    msg.type === "ai" &&
                    msg.content &&
                    (!msg.tool_calls || msg.tool_calls.length === 0)
                  ) {
                    stream.write(createTextEvent(msg.content));
                  }
                }
              } catch (e) {
                console.error("Failed to parse values event data:", e, jsonPart);
              }
            } else if (line.startsWith("data: {") && buffer.length < 4096) {
              // fallback: if raw data lines, try to parse JSON
              try {
                const eventObj = JSON.parse(line.slice(6));
                const msgs = eventObj.messages ?? [];
                for (const msg of msgs) {
                  if (
                    msg.type === "ai" &&
                    msg.content &&
                    (!msg.tool_calls || msg.tool_calls.length === 0)
                  ) {
                    stream.write(createTextEvent(msg.content));
                  }
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
            // Ignore heartbeats and other events
          }
        }
        done = streamDone;
      }

      stream.write(createDoneEvent());
    } catch (error) {
      console.error("Error processing Copilot extension request:", error);
      stream.write(
        createErrorsEvent([
          {
            type: "agent",
            message:
              error instanceof Error
                ? error.message
                : JSON.stringify(error),
            code: "PROCESSING_ERROR",
            identifier: "processing_error",
          },
        ])
      );
    }
  });
});

const port = 3000;
console.log(`Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});