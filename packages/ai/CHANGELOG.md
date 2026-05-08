# @repo/ai

## [Unreleased]

### Added

- Unified LLM API with automatic provider detection from model names
- Azure OpenAI provider with streaming, tool calling, and SSE parsing
- Model registry with capabilities, context windows, and pricing for 8 Azure OpenAI models (gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-4o, gpt-4o-mini, o1, o1-mini, o3-mini)
- Token cost tracking via `calculateCost()` and automatic cost in `StreamResult`
- `Conversation` class for message history, usage accumulation, serialization, and model hand-off
- `stream()` for async generator-based streaming
- `collectStream()` to accumulate events into a single result
- `streamSimple()` for prompt-in, result-out usage
- Environment variable credential detection (`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_VERSION`)
- Model generation script (`scripts/generate-models.ts`)
- Support for vision (image content parts) and thinking/reasoning events
