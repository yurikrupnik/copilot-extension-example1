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

const userThreads = new Map<string, string>();
const app = new Hono();

app.get("/", (c) => {
  return c.text("Welcome to the Copilot Extension template! 👋");
});

app.get("/callback", (c) => {
  return c.text("Welcome to the Copilot Extension Callback! 👋");
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

      const octokit = new Octokit({ auth: tokenForUser });
      const user = await octokit.request("GET /user");
      const userLogin = user.data.login;
      const userPrompt = getUserMessage(payload);

      let threadId = userThreads.get(userLogin);
      if (!threadId) {
        const threadResponse = await fetch("http://localhost:2024/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!threadResponse.ok) {
          const errText = await threadResponse.text();
          console.error("LangGraph thread creation failed:", errText);
          throw new Error(`Failed to create thread: ${errText}`);
        }
        const threadData = await threadResponse.json();
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
      let buffer = "";
      let hasValidContent = false;

      stream.write(createTextEvent(`Hi ${userLogin}!\n\n`));

      let done = false;
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (!value && streamDone) {
          throw new Error("LangGraph stream closed before any data was sent.");
        }
        done = streamDone;

        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;

          // Split on lines and process
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Look for data lines that contain JSON
            if (line.startsWith('data: {')) {
              try {
                const jsonData = line.slice(6); // Remove 'data: ' prefix
                const eventObj = JSON.parse(jsonData);

                if (eventObj.messages && Array.isArray(eventObj.messages)) {
                  for (const msg of eventObj.messages) {
                    // Extract AI content without tool calls
                    if (
                      msg.type === "ai" &&
                      msg.content &&
                      typeof msg.content === 'string' &&
                      msg.content.trim() &&
                      (!msg.tool_calls || msg.tool_calls.length === 0)
                    ) {
                      stream.write(createTextEvent(msg.content));
                      hasValidContent = true;
                    }
                  }
                }
              } catch (parseError) {
                // Ignore JSON parse errors - some data lines might not be valid JSON
                console.error("JSON parse error (ignoring):", parseError.message);
              }
            }
          }
        }
      }

      // If no valid content was streamed, provide a fallback
      if (!hasValidContent) {
        stream.write(createTextEvent("I received your request but couldn't generate a proper response. Please try again."));
      }

      stream.write(createDoneEvent());

    } catch (error) {
      console.error("Error processing Copilot extension request:", error);
      stream.write(
        createErrorsEvent([
          {
            type: "agent",
            message: error instanceof Error ? error.message : JSON.stringify(error),
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