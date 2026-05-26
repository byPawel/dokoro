# Contributing to devlog-mcp

Thanks for your interest in contributing to `devlog-mcp` — a multi-layer agent-memory MCP server. This document outlines how to get set up and submit changes.

## Getting Started

1. Fork the repository.
2. Clone your fork: `git clone https://github.com/YOUR-USERNAME/devlog-mcp.git`
3. Install dependencies: `npm install`
4. Build the project: `npm run build`
5. Run the tests: `npm test`

Node.js >= 18 is required.

## Development Process

1. Create a new branch for your changes.
2. Make your changes, following the conventions in [CLAUDE.md](CLAUDE.md).
3. Run `npm run lint` to ensure code style compliance.
4. Run `npm test` to verify all tests pass.
5. Submit a pull request against `main`.

### Running a server locally

```bash
npm run dev:core        # core server (workspace, sessions, entities, plans, feedback)
npm run dev:search      # search server
npm run dev:planning    # planning server
npm run dev:analytics   # analytics server (adds devlog_compress_week)
```

## Pull Request Guidelines

- Follow the existing code style (TypeScript strict, ES modules, `.js` import extensions).
- Co-locate tests with source as `*.test.ts` and include tests for new functionality.
- Update documentation (README, tool descriptions) as needed.
- Keep changes focused and atomic.
- Provide a clear description of what changed and why.

## Code of Conduct

This project follows our [Code of Conduct](CODE_OF_CONDUCT.md). Please review it before contributing.

## Reporting Issues

- Use the [GitHub issue tracker](https://github.com/byPawel/devlog-mcp/issues).
- Search existing issues before creating a new one.
- Provide clear reproduction steps.

## Security Issues

Please review our [Security Policy](SECURITY.md) for reporting vulnerabilities — do not file them as public issues.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
