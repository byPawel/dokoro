# Security Policy

Thank you for helping keep `devlog-mcp` and its users secure.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/byPawel/devlog-mcp/security) of this repository.
2. Click **"Report a vulnerability"** to open a private advisory.

Include as much of the following as you can:

- The type of issue and the affected component (server, tool, storage layer).
- Steps to reproduce, or a proof-of-concept.
- The potential impact.

We will acknowledge your report and keep you updated on the fix.

## Scope

`devlog-mcp` is an MCP server that reads and writes a local SQLite database, LanceDB vectors, and a file-backed workspace. Of particular interest:

- Path traversal or arbitrary file read/write via tool inputs.
- SQL injection in the entity/feedback/session queries.
- Unsafe handling of untrusted document content during entity extraction.

## Upstream

`devlog-mcp` builds on the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). Vulnerabilities in the SDK itself should be reported to Anthropic via their [HackerOne program](https://hackerone.com/anthropic-vdp).
