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

  // Fix 1: Correct Content-Type for Server-Sent Events
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Content-Type-Options", "nosniff");

  return stream(c, async (stream) => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

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

      // Fix 2: Add timeout and better error handling for long-running requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minute timeout (300 seconds)

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
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!langGraphResponse.ok || !langGraphResponse.body) {
        const errText = langGraphResponse.body
          ? await langGraphResponse.text()
          : langGraphResponse.statusText;
        console.error("LangGraph agent error:", errText);
        throw new Error(
          `LangGraph agent error: ${langGraphResponse.status} ${errText}`
        );
      }

      reader = langGraphResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let hasValidContent = false;

      stream.write(createTextEvent(`Hi ${userLogin}! 🤖\n\nStarting your request... This may take up to 3 minutes depending on the model complexity.\n\n`));

      // Fix 3: Improved streaming logic for long-running requests
      let consecutiveEmptyReads = 0;
      const maxEmptyReads = 50; // Increased for long-running requests
      let lastActivityTime = Date.now();
      const maxInactivityTime = 60000; // 60 seconds of no activity before warning

      while (true) {
        try {
          const { value, done } = await reader.read();

          if (done) {
            console.log("Stream completed normally");
            break;
          }

          if (!value || value.length === 0) {
            consecutiveEmptyReads++;

            // Check for inactivity timeout
            const now = Date.now();
            if (now - lastActivityTime > maxInactivityTime) {
              // Send keep-alive message to prevent timeout
              stream.write(createTextEvent("⏳ Processing your request...\n"));
              lastActivityTime = now;
              consecutiveEmptyReads = 0; // Reset counter after keep-alive
            }

            if (consecutiveEmptyReads >= maxEmptyReads) {
              console.warn("Too many consecutive empty reads, ending stream");
              break;
            }

            // Small delay to prevent tight polling
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
          }

          consecutiveEmptyReads = 0;
          lastActivityTime = Date.now(); // Update activity time
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;

          // Fix 4: Better line splitting and processing
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            const trimmedLine = line.trim();

            if (!trimmedLine) continue;

            // Handle different SSE event formats
            if (trimmedLine.startsWith('data: ')) {
              const data = trimmedLine.slice(6).trim();

              // Skip keep-alive pings
              if (data === '' || data === 'ping') continue;

              // Handle JSON data
              if (data.startsWith('{')) {
                try {
                  const eventObj = JSON.parse(data);

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

                  // Handle other potential message formats
                  if (eventObj.content && typeof eventObj.content === 'string') {
                    stream.write(createTextEvent(eventObj.content));
                    hasValidContent = true;
                  }

                } catch (parseError) {
                  console.warn("JSON parse error (ignoring):", parseError.message, "Data:", data);
                }
              }
            }
          }
        } catch (readError) {
          console.error("Error reading from stream:", readError);
          break;
        }
      }

      // Fix 5: Always ensure we send some content
      if (!hasValidContent) {
        console.warn("No valid content was streamed, sending fallback");
        stream.write(createTextEvent("I received your request but couldn't generate a proper response. Please try again."));
      }

      // Fix 6: Ensure done event is always sent
      stream.write(createDoneEvent());
      console.log("Stream completed successfully");

    } catch (error) {
      console.error("Error processing Copilot extension request:", error);

      // Fix 7: Better error handling and cleanup
      try {
        stream.write(
          createErrorsEvent([
            {
              type: "agent",
              message: error instanceof Error ? error.message : "Unknown error occurred",
              code: "PROCESSING_ERROR",
              identifier: "processing_error",
            },
          ])
        );
      } catch (writeError) {
        console.error("Failed to write error event:", writeError);
      }
    } finally {
      // Fix 8: Proper cleanup
      if (reader) {
        try {
          await reader.cancel();
        } catch (cancelError) {
          console.warn("Error canceling reader:", cancelError);
        }
      }
    }
  });
});

// Fix 9: Add graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

const port = 3000;
console.log(`Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});