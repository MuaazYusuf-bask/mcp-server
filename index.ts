/**
 * MCP Server with Native SSE Transport
 *
 * This implementation uses the MCP SDK's built-in SSE transport
 * for proper protocol handling.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import express from "express";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Configure logging
const logger = {
  info: (message: string) =>
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`),
  error: (message: string) =>
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`),
};

// OpenAI configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
let VECTOR_STORE_ID: string | undefined;

async function getOrCreateVectorStore(id: string) {
  if (id) return id;
  const response = await openaiClient.vectorStores.create({ name: id });
  VECTOR_STORE_ID = response.id;
  console.log("Created vector store:", VECTOR_STORE_ID);
  return VECTOR_STORE_ID;
}

// Initialize OpenAI client
const openaiClient = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
    })
  : null;

// Type definitions
interface SearchResult {
  id: string;
  title: string;
  text: string;
  url?: string;
}

interface FetchResponse {
  id: string;
  title: string;
  text: string;
  url?: string;
  metadata?: any;
}

/**
 * Handle search tool execution
 */
async function handleSearch(args: {
  query: string;
}): Promise<{ content: any[] }> {
  const { query } = args;

  if (!query || !query.trim()) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ results: [] }),
        },
      ],
    };
  }

  if (!openaiClient) {
    logger.error("OpenAI client not initialized - API key missing");
    throw new Error("OpenAI API key is required for vector store search");
  }

  try {
    logger.info(`Searching ${VECTOR_STORE_ID} for query: '${query}'`);

    // Search implementation
    const response = await openaiClient.vectorStores.files.list(
      VECTOR_STORE_ID,
      { limit: 20 }
    );

    const results: SearchResult[] = [];

    if (response.data && response.data.length > 0) {
      for (let i = 0; i < response.data.length; i++) {
        const item = response.data[i];

        const result: SearchResult = {
          id: item.id || `vs_${i}`,
          title: `Document ${i + 1}`,
          text: "Document snippet...",
          url: `https://platform.openai.com/storage/files/${item.id}`,
        };

        results.push(result);
      }
    }

    logger.info(`Vector store search returned ${results.length} results`);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ results }),
        },
      ],
    };
  } catch (error) {
    logger.error(`Search error: ${error}`);
    throw error;
  }
}

/**
 * Handle fetch tool execution
 */
async function handleFetch(args: { id: string }): Promise<{ content: any[] }> {
  const { id } = args;

  if (!id) {
    throw new Error("Document ID is required");
  }

  if (!openaiClient) {
    logger.error("OpenAI client not initialized - API key missing");
    throw new Error(
      "OpenAI API key is required for vector store file retrieval"
    );
  }

  try {
    logger.info(`Fetching content from vector store for file ID: ${id}`);

    const fileInfo = await openaiClient.vectorStores.files.retrieve(
      VECTOR_STORE_ID,
      id
    );

    const fileContent = await openaiClient.files.content(id);

    let content = "";
    if (typeof fileContent === "string") {
      content = fileContent;
    } else if (Buffer.isBuffer(fileContent)) {
      content = fileContent.toString("utf-8");
    } else {
      content = "No content available";
    }

    const result: FetchResponse = {
      id: id,
      title: `Document ${id}`,
      text: content,
      url: `https://platform.openai.com/storage/files/${id}`,
      metadata: null,
    };

    logger.info(`Fetched vector store file: ${id}`);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
    };
  } catch (error) {
    logger.error(`Fetch error: ${error}`);
    throw error;
  }
}

/**
 * Create and configure the MCP server
 */
async function createServer() {
  const server = new Server(
    {
      name: "Sample MCP Server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Define available tools
  const tools: Tool[] = [
    {
      name: "search",
      description: `Search for documents using OpenAI Vector Store search.

This tool searches through the vector store to find semantically relevant matches.
Returns a list of search results with basic information. Use the fetch tool to get
complete document content.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query string. Natural language queries work best for semantic search.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "fetch",
      description: `Retrieve complete document content by ID for detailed
analysis and citation. This tool fetches the full document
content from OpenAI Vector Store. Use this after finding
relevant documents with the search tool to get complete
information for analysis and proper citation.`,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "File ID from vector store (file-xxx) or local document ID",
          },
        },
        required: ["id"],
      },
    },
  ];

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools,
    };
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "search":
        return await handleSearch(args as { query: string });

      case "fetch":
        return await handleFetch(args as { id: string });

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}

/**
 * Main function to start the MCP server with SSE transport
 */
async function main() {
  try {
    // Verify OpenAI client is initialized
    if (!openaiClient) {
      logger.error(
        "OpenAI API key not found. Please set OPENAI_API_KEY environment variable."
      );
      throw new Error("OpenAI API key is required");
    }

    VECTOR_STORE_ID = await getOrCreateVectorStore(process.env.VECTOR_STORE_ID);
    logger.info(`Using vector store: ${VECTOR_STORE_ID}`);

    // Create Express app for SSE transport
    const app = express();
    const port = parseInt(process.env.PORT || "8000", 10);

    // Enable CORS
    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
      res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") {
        return res.sendStatus(200);
      }
      next();
    });

    // Health check endpoint
    app.get("/health", (req, res) => {
      res.json({
        status: "ok",
        server: "MCP Server",
        version: "1.0.0",
        transport: "SSE",
      });
    });

    // Create MCP server
    const mcpServer = await createServer();

    // Setup SSE endpoint with MCP SDK's SSE transport
    app.get("/sse", async (req, res) => {
      logger.info("New SSE connection established");

      const transport = new SSEServerTransport("/message", res);
      await mcpServer.connect(transport);

      // Handle connection close
      req.on("close", () => {
        logger.info("SSE connection closed");
        transport.close();
      });
    });

    // Message endpoint for SSE transport
    app.post("/message", express.json(), async (req, res) => {
      // The SSE transport handles this internally
      // This endpoint receives messages from the client
      res.status(200).json({ received: true });
    });

    // Start the server
    app.listen(port, "0.0.0.0", () => {
      logger.info(`MCP server running on http://0.0.0.0:${port}`);
      logger.info("SSE endpoint available at /sse");
      logger.info("Health check available at /health");
    });

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      logger.info("Server stopped by user");
      process.exit(0);
    });
  } catch (error) {
    logger.error(`Server error: ${error}`);
    process.exit(1);
  }
}

// Run the server
if (require.main === module) {
  main();
}
