import type { MissionControlConfig, MissionControlRuntimeSecrets } from "./types.js"

export interface SemanticEmbeddingProvider {
  readonly name: "jina"

  isAvailable(): boolean
  availabilityWarning(): string | undefined
  signature(): string
  embedQuery(text: string): Promise<number[]>
  embedPassages(texts: string[]): Promise<number[][]>
}

type JinaEmbeddingsResponse = {
  data?: Array<{
    index: number
    embedding: number[]
  }>
  error?: {
    message?: string
  }
}

class JinaEmbeddingProvider implements SemanticEmbeddingProvider {
  readonly name = "jina" as const

  constructor(
    private readonly config: MissionControlConfig,
    private readonly apiKey?: string,
  ) {}

  isAvailable() {
    return Boolean(this.apiKey && this.config.search.semanticEnabled)
  }

  availabilityWarning() {
    if (!this.config.search.semanticEnabled) {
      return "Semantic search is disabled in the current plugin configuration."
    }

    if (!this.apiKey) {
      return "Jina API key is not configured, so semantic search is falling back to lexical mode."
    }

    return undefined
  }

  signature() {
    return JSON.stringify({
      provider: this.name,
      model: this.config.search.semanticModel,
      dimensions: this.config.search.semanticDimensions,
      normalized: this.config.search.semanticNormalized,
      endpoint: this.config.search.semanticEndpoint,
    })
  }

  async embedQuery(text: string) {
    return this.embedBatch([text], "retrieval.query").then((vectors) => vectors[0] ?? [])
  }

  async embedPassages(texts: string[]) {
    return this.embedBatch(texts, "retrieval.passage")
  }

  private async embedBatch(texts: string[], task: "retrieval.query" | "retrieval.passage") {
    if (!this.apiKey) {
      throw new Error("Jina API key is not configured")
    }

    const batches = chunk(texts, 64)
    const vectors: number[][] = []

    for (const batch of batches) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.config.search.semanticRequestTimeoutMs)

      try {
        const response = await fetch(this.config.search.semanticEndpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.search.semanticModel,
            input: batch,
            embedding_type: "float",
            task,
            normalized: this.config.search.semanticNormalized,
            truncate: true,
            ...(typeof this.config.search.semanticDimensions === "number"
              ? { dimensions: this.config.search.semanticDimensions }
              : {}),
          }),
          signal: controller.signal,
        })

        const payload = (await response.json()) as JinaEmbeddingsResponse
        if (!response.ok) {
          throw new Error(payload.error?.message ?? `Jina embeddings request failed with ${response.status}`)
        }

        const batchVectors = (payload.data ?? [])
          .slice()
          .sort((left, right) => left.index - right.index)
          .map((entry) => entry.embedding)

        if (batchVectors.length !== batch.length || batchVectors.some((embedding) => !Array.isArray(embedding))) {
          throw new Error("Jina embeddings response did not return one embedding per input")
        }

        vectors.push(...batchVectors)
      } finally {
        clearTimeout(timeout)
      }
    }

    return vectors
  }
}

export const createSemanticProvider = (
  config: MissionControlConfig,
  secrets: MissionControlRuntimeSecrets,
): SemanticEmbeddingProvider | undefined => {
  if (config.search.semanticProvider !== "jina") {
    return undefined
  }

  return new JinaEmbeddingProvider(config, secrets.search.jinaApiKey)
}

const chunk = <T>(values: T[], size: number) => {
  const output: T[][] = []

  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size))
  }

  return output
}
