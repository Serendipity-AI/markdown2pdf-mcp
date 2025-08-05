#!/usr/bin/env node
import fetch from 'node-fetch';

// JSON-RPC 2.0 error codes
const RPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: "Parse error" },
  INVALID_REQUEST: { code: -32600, message: "Invalid Request" },  
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS: { code: -32602, message: "Invalid params" },
  INTERNAL_ERROR: { code: -32603, message: "Internal error" },
} as const;

// JSON-RPC 2.0 interfaces
interface McpRequest {
  jsonrpc: "2.0";
  method: string;
  params?: any;
  id: string | number | null;
}

interface McpError {
  code: number;
  message: string;
  data?: any;
}

interface McpResponse {
  jsonrpc: "2.0";
  result?: any;
  error?: McpError;
  id: string | number | null;
}

// Helper to create JSON-RPC 2.0 responses
function createResponse(id: string | number | null, result?: any): McpResponse {
  return {
    jsonrpc: "2.0",
    result,
    id
  };
}

function createErrorResponse(id: string | number | null, error: McpError): McpResponse {
  return {
    jsonrpc: "2.0",
    error,
    id
  };
}

// Add debug logging
function debug(msg: string) {
  console.error(`[DEBUG] ${msg}`);
}

async function handleRequest(req: McpRequest): Promise<McpResponse> {
  if (!req.method) {
    return createErrorResponse(req.id, RPC_ERRORS.INVALID_REQUEST);
  }

  if (req.method !== 'markdown2pdf') {
    return createErrorResponse(req.id, RPC_ERRORS.METHOD_NOT_FOUND);
  }

  const { text_body, title } = req.params ?? {};
  if (!text_body || !title) {
    return createErrorResponse(req.id, {
      code: RPC_ERRORS.INVALID_PARAMS.code,
      message: "Invalid params: text_body and title are required"
    });
  }

  const today = req.params?.date || new Date().toISOString().split('T')[0];
  const payload = {
    data: {
      text_body,
      meta: { title, date: today }
    },
    options: { document_name: title }
  };

  let response;
  let pollUrl = 'https://api.markdown2pdf.ai/markdown';
  let headers = { 'Content-Type': 'application/json' };

  // Payment loop
  while (true) {
    try {
      response = await fetch(pollUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      
      if (response.status === 402) {
        const resJson = await response.json();

        const payment_request_url = resJson.payment_request_url
        const payment_context_token = resJson.payment_context_token;
        const offers = resJson.offers || [];
        const offer_id = offers.length > 0 ? offers[0].id : null;
        const offer_amount = offers.length > 0 ? offers[0].amount : null;
        const offer_currency = offers.length > 0 ? offers[0].currency : null;
        const description = offers.length > 0 ? offers[0].description : "Markdown to PDF conversion";
        
        const payment_request_payload = {
          payment_context_token: payment_context_token,
          offer_id: offer_id
        }
        
        let payment_request_response = await fetch(payment_request_url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payment_request_payload)
        });

        const payment_request_json = await payment_request_response.json();
        debug("Payment request response: `${payment_request_json}`");
        debug("Payment request status: `${payment_request_response.status}`");
        debug("Payment request headers: `${payment_request_response.status}`");
        debug("Payment request URL: `${payment_request_url}`");
        debug("Payment request payload: `${payment_request_payload}`");
        const lightning_invoice = payment_request_json.payment_request.payment_request;
        const lightning_invoice_qr = payment_request_json.payment_request.payment_qr_svg;

        return createResponse(req.id, {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "Payment required. Please pay the invoice and try the same request again to continue.",
              qr_svg_url: lightning_invoice_qr,
              payment_request: lightning_invoice,
              detail: description
            })
          }]
          
        });
      } else if (response.status === 200) {
        const resJson = await response.json();
        if (resJson.path) {
          pollUrl = resJson.path;
          break;
        }
      } else {
        throw new Error(`Unexpected response: ${response.status}`);
      }
    } catch (err) {
      return createErrorResponse(req.id, {
        code: RPC_ERRORS.INTERNAL_ERROR.code,
        message: `Request failed: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }

  // Poll status
  while (true) {
    try {
      response = await fetch(pollUrl, { method: 'GET', headers });
      const resJson = await response.json();
      if (resJson.status === 'Done' && resJson.path) {
        pollUrl = resJson.path;
        break;
      }
      await new Promise(res => setTimeout(res, 3000));
    } catch (err) {
      return createErrorResponse(req.id, {
        code: RPC_ERRORS.INTERNAL_ERROR.code,
        message: `Polling failed: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }

  // Fetch final output
  try {
    response = await fetch(pollUrl, { method: 'GET', headers });
    const resJson = await response.json();
    if (resJson.url) {
      return createResponse(req.id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "complete",
            url: resJson.url
          })
        }]
      });
    } else {
      return createErrorResponse(req.id, {
        code: RPC_ERRORS.INTERNAL_ERROR.code,
        message: "PDF URL not found in response"
      });
    }
  } catch (err) {
    return createErrorResponse(req.id, {
      code: RPC_ERRORS.INTERNAL_ERROR.code,
      message: `Failed to fetch PDF: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

// MCP server main loop
process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let boundary;
  while ((boundary = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 1);
    if (!line.trim()) continue;

    let req: McpRequest;
    try {
      req = JSON.parse(line);
    } catch (e) {
      process.stdout.write(JSON.stringify(createErrorResponse(null, RPC_ERRORS.PARSE_ERROR)) + '\n');
      continue;
    }

    // Skip notifications/initialized messages - no response needed
    if (req.method === 'notifications/initialized') {
      continue;
    }

    // Validate JSON-RPC 2.0
    if (req.jsonrpc !== "2.0") {
      process.stdout.write(JSON.stringify(createErrorResponse(null, RPC_ERRORS.INVALID_REQUEST)) + '\n');
      continue;
    }

    if (!req.method || typeof req.method !== 'string') {
      process.stdout.write(JSON.stringify(createErrorResponse(req.id, RPC_ERRORS.INVALID_REQUEST)) + '\n');
      continue;
    }

    // Protocol methods
    if (req.method === 'initialize') {
      debug(`Received initialize request: ${JSON.stringify(req)}`);
      const response = createResponse(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: {
            tools: {
                listChanged: true
            },
            prompts: {
                listChanged: true
            },
            resources: {}
        },
        serverInfo: {
          name: "markdown2pdf",
          version: "0.1.0"
        }
      });
      debug(`Sending initialize response: ${JSON.stringify(response)}`);
      process.stdout.write(JSON.stringify(response) + '\n');
      continue;
    }
    if (req.method === 'resources/list') {
        process.stdout.write(JSON.stringify(createResponse(req.id, {
            resources: []
        })) + '\n');
        continue;
    }
    if (req.method === 'prompts/list') {
        process.stdout.write(JSON.stringify(createResponse(req.id, {
            prompts: [{
                name: 'convert_markdown',
                description: 'Convert markdown to PDF'
            }]
        })) + '\n');
        continue;
    }

    if (req.method === 'prompts/get'){
      if (!req.params?.name || req.params.name !== 'convert_markdown') {
        process.stdout.write(JSON.stringify(createErrorResponse(req.id, {
          code: RPC_ERRORS.INVALID_PARAMS.code,
          message: "Invalid prompt name"
        })) + '\n');
        continue;
      }

    }

    if (req.method === 'tools/list') {
      process.stdout.write(JSON.stringify(createResponse(req.id, {
        tools: [{
          name: 'markdown2pdf',
          description: 'Convert markdown to PDF, and pay with Lightning',
          inputSchema: {
            type: 'object',
            required: ['text_body', 'title'],
            properties: {
              text_body: {
                type: 'string',
                description: 'Markdown text to convert'
              },
              title: {
                type: 'string',
                description: 'Document title'
              },
              date: {
                type: 'string',
                description: 'Document date (YYYY-MM-DD)'
              }
            }
          }
        }]
      })) + '\n');
      continue;
    }

    if (req.method === 'tools/call') {
      if (!req.params?.name || req.params.name !== 'markdown2pdf') {
        process.stdout.write(JSON.stringify(createErrorResponse(req.id, {
          code: RPC_ERRORS.INVALID_PARAMS.code,
          message: "Invalid tool name"
        })) + '\n');
        continue;
      }

      // Forward the parameters to our existing handler
      const toolRequest: McpRequest = {
        jsonrpc: "2.0",
        method: 'markdown2pdf',
        params: req.params.arguments,
        id: req.id
      };
      const result = await handleRequest(toolRequest);

      process.stdout.write(JSON.stringify(result) + '\n');
      continue;
    }

    if (req.method === 'ping') {
      process.stdout.write(JSON.stringify(createResponse(req.id, null)) + '\n');
      continue;
    }

    // Handle markdown2pdf or report method not found
    const result = await handleRequest(req);
    process.stdout.write(JSON.stringify(result) + '\n');
  }
});
